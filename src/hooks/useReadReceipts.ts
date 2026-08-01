import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl, onRealtimeUnsubscribed } from '../lib/backendClient';
import { useTableSubscription } from './useTableSubscription';
import {
  RECEIPT_REARM_MS,
  decideReceiptEmit,
  initialReceiptEmitState,
  noteReceiptSent,
  readersOf,
  receiptAnchorIds,
  type ReceiptEmitState,
  type ReceiptMessage,
  type SessionReadMarker,
} from '../lib/readReceipts';

export interface UseReadReceiptsOptions {
  sessionId: string | null;
  currentUserId: string | null;
  /** False unless this exact surface is the focused window. */
  active?: boolean;
  /** Reciprocal account-level opt-out. */
  enabled?: boolean;
  /** Null for the channel timeline; otherwise one thread root. */
  threadParentId?: string | null;
  /** Chronological rows currently rendered, for exact equal-time ordering. */
  orderedMessages?: readonly ReceiptMessage[];
}

export interface UseReadReceiptsResult {
  markers: SessionReadMarker[];
  readersOfMessage: (message: ReceiptMessage) => string[];
  anchorIds: (messages: readonly ReceiptMessage[]) => Set<string>;
  noteVisible: (newest: ReceiptMessage | null, options?: { flush?: boolean }) => void;
}

type RawMarker = Partial<SessionReadMarker> & {
  user_id?: string | null;
  agent_id?: string | null;
};

type MarkerState = {
  key: string;
  markers: SessionReadMarker[];
};

type MarkerChange = {
  revision: number;
  deleted: boolean;
  marker: SessionReadMarker;
};

type PendingWrite = {
  key: string;
  sessionId: string;
  threadParentId: string | null;
  messageId: string;
  flush: boolean;
  attempt: number;
};

const NO_MARKERS: SessionReadMarker[] = [];
const NO_MESSAGES: readonly ReceiptMessage[] = [];

function scopeValue(value: unknown): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function scopeKey(sessionId: string | null, threadParentId: string | null): string {
  return `${sessionId || 'none'}::${threadParentId || 'channel'}`;
}

function markerReaderId(row: RawMarker): string {
  return String(row.reader_id || row.user_id || row.agent_id || '');
}

function normalizeMarker(row: RawMarker): SessionReadMarker | null {
  const readerId = markerReaderId(row);
  const markerId = String(row.marker_id || '');
  const sessionId = String(row.session_id || '');
  const lastSeenMessageId = String(row.last_seen_message_id || '');
  const readAt = String(row.read_at || '');
  if (!readerId || !markerId || !sessionId || !lastSeenMessageId || !readAt) return null;
  return {
    marker_id: markerId,
    event_version: String(row.event_version || '0'),
    session_id: sessionId,
    reader_id: readerId,
    reader_kind: row.reader_kind || (row.agent_id ? 'agent' : 'human'),
    thread_parent_id: scopeValue(row.thread_parent_id),
    last_seen_message_id: lastSeenMessageId,
    read_at: readAt,
  };
}

function markerTime(marker: SessionReadMarker): number {
  return Date.parse(String(marker.read_at));
}

function markerVersion(marker: SessionReadMarker): bigint {
  try {
    return BigInt(String(marker.event_version || '0'));
  } catch {
    return 0n;
  }
}

function isMarkerLater(left: SessionReadMarker, right: SessionReadMarker): boolean {
  const leftTime = markerTime(left);
  const rightTime = markerTime(right);
  if (!Number.isFinite(leftTime)) return false;
  if (!Number.isFinite(rightTime)) return true;
  if (leftTime !== rightTime) return leftTime > rightTime;
  return String(left.last_seen_message_id) > String(right.last_seen_message_id);
}

function applyMarkerChange(
  markers: readonly SessionReadMarker[],
  change: Pick<MarkerChange, 'deleted' | 'marker'>,
): SessionReadMarker[] {
  const { marker, deleted } = change;
  const index = markers.findIndex(row => row.reader_id === marker.reader_id);
  const current = index >= 0 ? markers[index] : null;
  const currentVersion = current ? markerVersion(current) : 0n;
  const incomingVersion = markerVersion(marker);
  if (current && incomingVersion < currentVersion) return [...markers];
  if (deleted) {
    // A DELETE describes one physical row. Re-enabling receipts creates a new
    // marker_id, so a delayed delete of the old row cannot erase the new one,
    // even when both point at the exact same message.
    if (!current || current.marker_id !== marker.marker_id) return [...markers];
    return markers.filter((_, candidate) => candidate !== index);
  }
  if (
    current
    && incomingVersion === currentVersion
    && current.marker_id === marker.marker_id
    && !isMarkerLater(marker, current)
  ) {
    return [...markers];
  }
  if (
    current
    && incomingVersion === currentVersion
    && current.marker_id !== marker.marker_id
    && isMarkerLater(current, marker)
  ) {
    return [...markers];
  }
  const next = markers.filter(row => row.reader_id !== marker.reader_id);
  next.push(marker);
  return next;
}

function receiptStateUrl(sessionId: string, threadParentId: string | null): string {
  const base = `/backend/sessions/${encodeURIComponent(sessionId)}/read-state`;
  if (!threadParentId) return apiUrl(base);
  return apiUrl(`${base}?thread_parent_id=${encodeURIComponent(threadParentId)}`);
}

async function postReceipt(request: PendingWrite): Promise<boolean> {
  try {
    const response = await fetch(
      apiUrl(`/backend/sessions/${encodeURIComponent(request.sessionId)}/read`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({
          lastSeenMessageId: request.messageId,
          ...(request.threadParentId ? { threadParentId: request.threadParentId } : {}),
        }),
        keepalive: request.flush,
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export function useReadReceipts({
  sessionId,
  currentUserId,
  active = true,
  enabled = true,
  threadParentId = null,
  orderedMessages = NO_MESSAGES,
}: UseReadReceiptsOptions): UseReadReceiptsResult {
  const normalizedScope = scopeValue(threadParentId);
  const key = scopeKey(sessionId, normalizedScope);
  const channelName = `session_read_state:${sessionId || 'none'}`;
  const [markerState, setMarkerState] = useState<MarkerState>({ key, markers: NO_MARKERS });
  const [revokedChannel, setRevokedChannel] = useState<string | null>(null);
  const currentKeyRef = useRef(key);
  const revokedChannelRef = useRef<string | null>(null);
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(true);
  const emitStatesRef = useRef(new Map<string, ReceiptEmitState>());
  const inFlightRef = useRef(new Set<string>());
  const pendingRef = useRef(new Map<string, PendingWrite>());
  const waitersRef = useRef(new Map<string, { timer: number; resolve: () => void }>());
  const eventRevisionRef = useRef(0);
  const changesRef = useRef(new Map<string, Map<string, MarkerChange>>());
  const wasEnabledRef = useRef(enabled);

  currentKeyRef.current = key;
  enabledRef.current = enabled;
  const on = Boolean(sessionId) && active && enabled && revokedChannel !== channelName;
  const onRef = useRef(on);
  onRef.current = on;

  useEffect(() => {
    const waiters = waitersRef.current;
    const pending = pendingRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const waiter of waiters.values()) {
        window.clearTimeout(waiter.timer);
        waiter.resolve();
      }
      waiters.clear();
      pending.clear();
    };
  }, []);

  // State is keyed, so the render that changes session/scope synchronously sees
  // an empty list; this effect only establishes the next storage bucket.
  useEffect(() => {
    setMarkerState({ key, markers: NO_MARKERS });
    setRevokedChannel(null);
    revokedChannelRef.current = null;
  }, [key]);

  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      revokedChannelRef.current = null;
      setRevokedChannel(null);
    }
    if (!enabled) {
      setMarkerState({ key, markers: NO_MARKERS });
      emitStatesRef.current.clear();
      pendingRef.current.clear();
    }
    wasEnabledRef.current = enabled;
  }, [enabled, key]);

  useEffect(() => onRealtimeUnsubscribed(({ channel, reason }) => {
    if ((reason !== 'access_revoked' && reason !== 'read_receipts_disabled') || channel !== channelName) return;
    revokedChannelRef.current = channel;
    setRevokedChannel(channel);
    setMarkerState(prev => (prev.key === key ? { key, markers: NO_MARKERS } : prev));
    emitStatesRef.current.delete(key);
    pendingRef.current.delete(key);
  }), [channelName, key]);

  useEffect(() => {
    if (!on || !sessionId) return;
    let cancelled = false;
    const startedAtRevision = eventRevisionRef.current;
    void (async () => {
      try {
        const response = await fetch(
          receiptStateUrl(sessionId, normalizedScope),
          { headers: apiAuthHeaders() },
        );
        const body = await response.json().catch(() => null);
        if (cancelled || !response.ok || !Array.isArray(body?.data?.markers)) return;
        let snapshot = (body.data.markers as RawMarker[])
          .map(normalizeMarker)
          .filter((marker): marker is SessionReadMarker => marker !== null)
          .filter(marker => (
            marker.session_id === sessionId
            && scopeValue(marker.thread_parent_id) === normalizedScope
          ));
        const changes = changesRef.current.get(key);
        if (changes) {
          for (const change of changes.values()) {
            if (change.revision > startedAtRevision) snapshot = applyMarkerChange(snapshot, change);
          }
        }
        if (currentKeyRef.current !== key) return;
        setMarkerState({ key, markers: snapshot });
      } catch {
        // Fail closed: no snapshot is safer than a stale social signal.
      }
    })();
    return () => { cancelled = true; };
  }, [key, normalizedScope, on, sessionId]);

  useTableSubscription<SessionReadMarker>(
    {
      enabled: on,
      channelName,
      table: 'session_read_state',
      filter: `session_id=eq.${sessionId || ''}`,
    },
    (payload) => {
      if (
        !onRef.current
        || currentKeyRef.current !== key
        || revokedChannelRef.current === channelName
      ) return;
      const deleted = payload.eventType === 'DELETE';
      const raw = (deleted ? payload.old : payload.new) as RawMarker | undefined;
      const marker = raw ? normalizeMarker(raw) : null;
      if (
        !marker
        || marker.session_id !== sessionId
        || scopeValue(marker.thread_parent_id) !== normalizedScope
      ) return;
      eventRevisionRef.current += 1;
      const change: MarkerChange = {
        revision: eventRevisionRef.current,
        deleted,
        marker,
      };
      const byReader = changesRef.current.get(key) || new Map<string, MarkerChange>();
      const prior = byReader.get(marker.reader_id);
      // Keep a delete tombstone for this exact row, and otherwise retain the
      // newest position. Out-of-order async fanout cannot move a marker back.
      const accepted = (
        !prior
        || markerVersion(marker) > markerVersion(prior.marker)
        || (
          markerVersion(marker) === markerVersion(prior.marker)
          && (
            (deleted && !prior.deleted)
            || (!deleted && !prior.deleted && isMarkerLater(marker, prior.marker))
          )
        )
      );
      if (accepted) {
        byReader.set(marker.reader_id, change);
        setMarkerState(prev => {
          const base = prev.key === key ? prev.markers : NO_MARKERS;
          return { key, markers: applyMarkerChange(base, change) };
        });
      }
      changesRef.current.set(key, byReader);
    },
  );

  const launchWrite = useCallback((request: PendingWrite) => {
    if (inFlightRef.current.has(request.key)) {
      pendingRef.current.set(request.key, request);
      return;
    }
    inFlightRef.current.add(request.key);
    void (async () => {
      let current: PendingWrite | undefined = request;
      try {
        while (current && mountedRef.current && enabledRef.current) {
          const succeeded = await postReceipt(current);
          if (succeeded) {
            emitStatesRef.current.set(
              current.key,
              noteReceiptSent(
                emitStatesRef.current.get(current.key) || initialReceiptEmitState(),
                current.messageId,
                Date.now(),
              ),
            );
          }

          let next = pendingRef.current.get(current.key);
          pendingRef.current.delete(current.key);
          if (!next && !succeeded && current.attempt < 2) {
            next = { ...current, attempt: current.attempt + 1 };
          }
          if (!next) break;
          const state = emitStatesRef.current.get(current.key) || initialReceiptEmitState();
          const delay = !succeeded
            ? 250 * (2 ** current.attempt)
            : !next.flush
              ? Math.max(0, state.lastSentAt + RECEIPT_REARM_MS - Date.now())
              : 0;
          if (delay > 0) {
            const waitKey = current.key;
            await new Promise<void>(resolve => {
              const timer = window.setTimeout(() => {
                waitersRef.current.delete(waitKey);
                resolve();
              }, delay);
              waitersRef.current.set(waitKey, { timer, resolve });
            });
            next = pendingRef.current.get(current.key) || next;
            pendingRef.current.delete(current.key);
          }
          current = next;
        }
      } finally {
        inFlightRef.current.delete(request.key);
      }
    })();
  }, []);

  const noteVisible = useCallback((
    newest: ReceiptMessage | null,
    options: { flush?: boolean } = {},
  ) => {
    if (!on || !sessionId) return;
    const state = emitStatesRef.current.get(key) || initialReceiptEmitState();
    const decision = decideReceiptEmit({
      newestVisible: newest,
      currentUserId,
      visibility: typeof document === 'undefined' ? 'visible' : document.visibilityState,
      state,
      now: Date.now(),
      flush: options.flush,
      enabled,
    });
    if (!decision.messageId) return;
    const request: PendingWrite = {
      key,
      sessionId,
      threadParentId: normalizedScope,
      messageId: decision.messageId,
      flush: Boolean(options.flush),
      attempt: 0,
    };
    if (request.flush && inFlightRef.current.has(key)) {
      // pagehide cannot wait behind an ordinary fetch: the browser may cancel
      // that request before the queue gets another turn. A direct keepalive
      // write is safe because the database marker is monotonic.
      void postReceipt(request).then(succeeded => {
        if (!succeeded) return;
        emitStatesRef.current.set(
          key,
          noteReceiptSent(
            emitStatesRef.current.get(key) || initialReceiptEmitState(),
            request.messageId,
            Date.now(),
          ),
        );
      });
      return;
    }
    launchWrite(request);
  }, [currentUserId, enabled, key, launchWrite, normalizedScope, on, sessionId]);

  const markers = markerState.key === key ? markerState.markers : NO_MARKERS;
  const readersOfMessage = useCallback(
    (message: ReceiptMessage) => (
      on ? readersOf(message, markers, normalizedScope, orderedMessages) : []
    ),
    [markers, normalizedScope, on, orderedMessages],
  );
  const anchorIds = useCallback(
    (messages: readonly ReceiptMessage[]) => (
      on ? receiptAnchorIds(messages, currentUserId) : new Set<string>()
    ),
    [currentUserId, on],
  );

  return useMemo(
    () => ({ markers, readersOfMessage, anchorIds, noteVisible }),
    [anchorIds, markers, noteVisible, readersOfMessage],
  );
}
