import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { useTableSubscription } from './useTableSubscription';
import {
  decideReceiptEmit,
  initialReceiptEmitState,
  noteReceiptSent,
  readersOf,
  receiptAnchorIds,
  type ReceiptMessage,
  type SessionReadMarker,
} from '../lib/readReceipts';

// Read receipts for ONE conversation: the markers, and the write that advances
// yours. Every decision about WHEN to write is in src/lib/readReceipts.ts, which
// has no React and no transport — this hook is the wiring.
//
// The markers ride the same db_changes lane as everything else, filtered by
// session_id. That filter is not a convenience: `session_read_state` has no
// workspace_id column, so it is the only subscription that can be expressed at
// all, and naming a private session has to clear the DM gate at subscribe time.
// A non-member therefore cannot hold this subscription. See
// shared/read-receipts.cjs.

export interface UseReadReceiptsOptions {
  sessionId: string | null;
  currentUserId: string | null;
  /**
   * False when this conversation is not the one being looked at. Nothing is
   * fetched, subscribed or written — a background window has been read by
   * nobody, and the indicator is only drawn where it is focused.
   */
  active?: boolean;
  /**
   * The user's own reciprocal opt-out. The SERVER enforces both halves (an
   * opted-out marker is never stored, and the read returns nothing); this stops
   * the client asking at all.
   */
  enabled?: boolean;
}

export interface UseReadReceiptsResult {
  markers: SessionReadMarker[];
  /** Who has read this message, excluding its author. */
  readersOfMessage: (message: ReceiptMessage) => string[];
  /** The ids of your messages that should carry an indicator (run ends only). */
  anchorIds: (messages: readonly ReceiptMessage[]) => Set<string>;
  /** Call with the newest message on screen; the policy decides whether to write. */
  noteVisible: (newest: ReceiptMessage | null, options?: { flush?: boolean }) => void;
}

const NO_MARKERS: SessionReadMarker[] = [];

export function useReadReceipts({
  sessionId,
  currentUserId,
  active = true,
  enabled = true,
}: UseReadReceiptsOptions): UseReadReceiptsResult {
  const [markers, setMarkers] = useState<SessionReadMarker[]>(NO_MARKERS);
  const emitState = useRef(initialReceiptEmitState());
  const inFlight = useRef(false);

  const on = Boolean(sessionId) && active && enabled;

  // Reset on a session change, before anything else runs. Carrying the previous
  // conversation's markers over for even one render would draw an eye sourced
  // from a different room.
  useEffect(() => {
    setMarkers(NO_MARKERS);
    emitState.current = initialReceiptEmitState();
  }, [sessionId]);

  useEffect(() => {
    if (!on || !sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          apiUrl(`/backend/sessions/${encodeURIComponent(sessionId)}/read-state`),
          { headers: apiAuthHeaders() },
        );
        const body = await res.json().catch(() => null);
        if (cancelled || !res.ok || !Array.isArray(body?.data?.markers)) return;
        setMarkers(body.data.markers as SessionReadMarker[]);
      } catch {
        // A failed fetch means no indicator, which is the same as no receipts —
        // never a wrong one. Realtime still fills it in as people read.
      }
    })();
    return () => { cancelled = true; };
  }, [on, sessionId]);

  useTableSubscription<SessionReadMarker>(
    {
      enabled: on,
      channelName: `session_read_state:${sessionId || 'none'}`,
      table: 'session_read_state',
      filter: `session_id=eq.${sessionId || ''}`,
    },
    (payload) => {
      const row = payload.new as SessionReadMarker | undefined;
      if (!row || !row.user_id) return;
      // The fanout does not exclude the writer, so your own marker comes back.
      // Upsert by user_id rather than appending: a marker is a POSITION, and the
      // list must hold at most one per person or `readersOf` counts them twice.
      setMarkers(prev => {
        const next = prev.filter(marker => marker.user_id !== row.user_id);
        next.push({ session_id: String(row.session_id), user_id: String(row.user_id), read_at: String(row.read_at) });
        return next;
      });
    },
  );

  const noteVisible = useCallback((newest: ReceiptMessage | null, options: { flush?: boolean } = {}) => {
    if (!on || !sessionId) return;
    const decision = decideReceiptEmit({
      newestVisible: newest,
      currentUserId,
      visibility: typeof document === 'undefined' ? 'visible' : document.visibilityState,
      state: emitState.current,
      now: Date.now(),
      flush: options.flush,
      enabled,
    });
    if (!decision.messageId || inFlight.current) return;

    // Recorded BEFORE the request, so a slow network cannot let a burst of
    // scroll events queue several writes for the same position.
    emitState.current = noteReceiptSent(emitState.current, decision.messageId, Date.now());
    inFlight.current = true;
    void fetch(apiUrl(`/backend/sessions/${encodeURIComponent(sessionId)}/read`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({ lastSeenMessageId: decision.messageId }),
      // Survives the page unloading, which is the whole point of the flush.
      keepalive: Boolean(options.flush),
    }).catch(() => {
      // Silent: a marker is monotonic and self-healing. The next scroll writes a
      // position at least as new, so a dropped write costs nothing but latency.
    }).finally(() => { inFlight.current = false; });
  }, [on, sessionId, currentUserId, enabled]);

  const readersOfMessage = useCallback(
    (message: ReceiptMessage) => (on ? readersOf(message, markers) : []),
    [on, markers],
  );

  const anchorIds = useCallback(
    (messages: readonly ReceiptMessage[]) => (on ? receiptAnchorIds(messages, currentUserId) : new Set<string>()),
    [on, currentUserId],
  );

  return { markers, readersOfMessage, anchorIds, noteVisible };
}
