import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { foldHuddleState } from '../lib/huddleState';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { Huddle, HuddleEvent, HuddleState } from '../types';

/** Everything the in-call bar needs to connect. Held in memory only — never persisted. */
export interface HuddleConnection {
  token: string;
  url: string;
  identity: string;
  roomName: string;
  huddleId: string;
  /**
   * When THIS browser joined. Voice output reads only messages written after
   * it, so joining a busy channel never reads the backlog aloud.
   *
   * Doubles as the connection epoch the server keys presence on: a retry is
   * the same connection, a rejoin is a new one.
   */
  joinedAtMs: number;
  /** How often to say "still here". Named by the SERVER — see useHuddleHeartbeat. */
  heartbeatIntervalMs: number;
}

interface HuddlePayload {
  huddle: Huddle | null;
  events: HuddleEvent[];
  configured?: boolean;
  token?: string;
  url?: string;
  identity?: string;
  roomName?: string;
  heartbeatIntervalMs?: number;
}

/**
 * Fallback beat interval, used only if the server did not name one (an older
 * backend). Must stay <= the server's staleness threshold with room for several
 * misses; the server's own value always wins.
 */
export const DEFAULT_HUDDLE_HEARTBEAT_MS = 30_000;
const MAX_CONNECTION_EPOCH = Number.MAX_SAFE_INTEGER;

/**
 * Give each local connection a strictly newer epoch, even when the wall clock
 * moves backwards or two joins complete in the same millisecond. The server
 * treats this as an ordering token, not as a trusted timestamp.
 */
export function nextHuddleConnectionEpoch(previous: number, now = Date.now()): number {
  const prior = Number.isSafeInteger(previous) && previous >= 0 ? previous : 0;
  const clock = Number.isSafeInteger(now) && now >= 0 ? now : 0;
  if (prior >= MAX_CONNECTION_EPOCH) return MAX_CONNECTION_EPOCH;
  return Math.min(MAX_CONNECTION_EPOCH, Math.max(clock, prior + 1));
}

/**
 * Say "still here" for as long as this browser holds a huddle connection.
 *
 * WHY THIS EXISTS: presence is self-reported, and a browser that crashes, loses
 * power or is force-quit never posts its /leave — so it would stay in the
 * roster forever. Presence therefore expires on the server unless it is
 * refreshed, and this is the refresh.
 *
 * PRIMITIVE PROPS ONLY, on purpose. The huddle hook returns a fresh object
 * every render; an effect that depended on it would clear and restart this
 * interval before it ever fired, and fire an immediate beat on every render
 * instead — the same feedback loop that once had HuddleBar reconnecting to
 * LiveKit eighty times in a few seconds.
 *
 * A hidden tab is throttled to roughly one timer wake per minute, which the
 * server's threshold is sized for; the visibilitychange beat is what makes
 * coming BACK to the tab instant rather than waiting out a throttled interval.
 */
export function useHuddleHeartbeat(
  workspaceId: string | null,
  huddleId: string,
  connectionEpoch: number,
  intervalMs: number,
  enabled: boolean,
) {
  // A 409 means the huddle is over. Stop beating into it — the roster update
  // arrives over the websocket, but a browser whose socket died would otherwise
  // beat at a dead huddle for as long as the tab stayed open.
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    if (!enabled || !workspaceId || !huddleId) return;
    let cancelled = false;

    const beat = async () => {
      if (cancelled || stoppedRef.current) return;
      const path = `/backend/workspaces/${encodeURIComponent(workspaceId)}/huddles/${encodeURIComponent(huddleId)}/heartbeat`;
      try {
        const response = await fetch(apiUrl(path), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({ connectionEpoch }),
        });
        if (response.status === 409) stoppedRef.current = true;
      } catch {
        // A missed beat is not an error: the whole design tolerates several,
        // and the next one refreshes presence with no visible flicker.
      }
    };

    // Immediately, so a browser that dies seconds after connecting is still on
    // a clock — presence is not reapable until it has beaten at least once.
    void beat();
    const period = Math.max(5_000, intervalMs || DEFAULT_HUDDLE_HEARTBEAT_MS);
    const timer = window.setInterval(() => { void beat(); }, period);
    const onVisibility = () => { if (document.visibilityState === 'visible') void beat(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [workspaceId, huddleId, connectionEpoch, intervalMs, enabled]);
}

/**
 * ONE huddle by id, live or long finished — what a channel marker links to.
 *
 * Read-only and un-subscribed on purpose. This exists so "You were in a huddle"
 * still opens its transcript months later, when the per-channel lookup below
 * would answer with a completely different, newer huddle. A finished huddle
 * cannot change, so there is nothing to watch; a live one reached this way is
 * already being watched by useHuddle in the same channel.
 */
export function useHuddleRecord(workspaceId: string | null, huddleId: string | null) {
  const [state, setState] = useState<HuddleState | null>(null);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setNotes('');
    if (!workspaceId || !huddleId) return;
    setLoading(true);
    const path = `/backend/workspaces/${encodeURIComponent(workspaceId)}/huddles/${encodeURIComponent(huddleId)}`;
    void fetch(apiUrl(path), { headers: apiAuthHeaders() })
      .then(async (response) => (response.ok ? response.json().catch(() => null) : null))
      .then((payload) => {
        if (cancelled) return;
        const data = payload?.data as HuddlePayload | undefined;
        setState(foldHuddleState(data?.huddle ?? null, Array.isArray(data?.events) ? data.events : []));
        setNotes(data?.huddle?.notes ?? '');
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [workspaceId, huddleId]);

  // Notes can still be added to a huddle that has already ended — "drop a
  // note about what was decided" does not require the call to still be live.
  // Un-subscribed like the rest of this hook (a record is read by one person
  // at a time in practice), so the save just updates the local copy rather
  // than waiting on a realtime echo.
  const saveNotes = useCallback(async (next: string): Promise<boolean> => {
    if (!workspaceId || !huddleId) return false;
    setSavingNotes(true);
    try {
      const path = `/backend/workspaces/${encodeURIComponent(workspaceId)}/huddles/${encodeURIComponent(huddleId)}/notes`;
      const response = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ notes: next }),
      });
      if (!response.ok) return false;
      const payload = await response.json().catch(() => null);
      const saved = (payload?.data as HuddlePayload | undefined)?.huddle?.notes;
      setNotes(typeof saved === 'string' ? saved : next);
      return true;
    } catch {
      return false;
    } finally {
      setSavingNotes(false);
    }
  }, [workspaceId, huddleId]);

  return { state, notes, loading, savingNotes, saveNotes };
}

/**
 * The huddle for one channel.
 *
 * State model: the server owns an APPEND-ONLY event log and this hook folds it.
 * Realtime `huddle_events` INSERTs are appended to the local log and the state
 * is re-derived, so:
 *   - a duplicate/redelivered event is a no-op,
 *   - an out-of-order event still folds correctly (the fold sorts by the
 *     event's own timestamp),
 *   - a reconnect just refetches the log — there is no diff to reconcile.
 *
 * Authority is server-side. This hook can ask for a token for the CURRENT user
 * and nothing else; who was actually in the room comes from LiveKit's signed
 * webhook, never from a browser claim.
 *
 * NOTE the two session ids on the state it returns. `sessionId` is this
 * channel — the huddle was called from here. `transcriptSessionId` is the
 * huddle's OWN conversation, and it is where the transcript goes; see
 * lib/huddleTranscript.
 */
export function useHuddle(workspaceId: string | null, sessionId: string | null) {
  const [huddle, setHuddle] = useState<Huddle | null>(null);
  const [events, setEvents] = useState<HuddleEvent[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<HuddleConnection | null>(null);

  const base = workspaceId && sessionId
    ? `/backend/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/huddle`
    : '';
  // One hook instance serves the app-level dock. A POST for conversation A can
  // resolve after the target has switched to B; its token/connection must never
  // be installed into B's room. Advance this epoch during render so even a
  // same-tick response sees the new request generation.
  const baseRef = useRef(base);
  const baseEpochRef = useRef(0);
  const connectionEpochRef = useRef(0);
  if (baseRef.current !== base) {
    baseRef.current = base;
    baseEpochRef.current += 1;
  }

  const applyPayload = useCallback((payload: HuddlePayload | null) => {
    setHuddle(payload?.huddle ?? null);
    setEvents(Array.isArray(payload?.events) ? payload.events : []);
    if (typeof payload?.configured === 'boolean') setConfigured(payload.configured);
  }, []);

  useEffect(() => {
    // Drop the old grant immediately when the dock re-keys this hook. The
    // request epoch below handles the in-flight response that would otherwise
    // resurrect it after this cleanup.
    setConnection(null);
    setHuddle(null);
    setEvents([]);
    setError('');
  }, [base]);

  const refetch = useCallback(async () => {
    const requestEpoch = baseEpochRef.current;
    if (!base) {
      if (baseEpochRef.current === requestEpoch) applyPayload(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(apiUrl(base), { headers: apiAuthHeaders() });
      const payload = await response.json().catch(() => null);
      if (response.ok && baseEpochRef.current === requestEpoch) applyPayload(payload?.data ?? null);
    } finally {
      setLoading(false);
    }
  }, [base, applyPayload]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Two subscriptions, both filtered on session_id (the RBAC gate resolves a
  // session's workspace, so this stays membership-checked server-side).
  // Keep the epoch captured by each callback so a late frame from A cannot
  // overwrite the dock state after it has moved to B.
  const subscriptionEpoch = baseEpochRef.current;
  const huddleDeduper = useRealtimeDeduper();
  useTableSubscription<Huddle>(
    {
      enabled: !!workspaceId && !!sessionId,
      channelName: `huddles:${sessionId}`,
      table: 'huddles',
      event: '*',
      schema: 'public',
      filter: `session_id=eq.${sessionId}`,
    },
    (payload) => {
      if (baseEpochRef.current !== subscriptionEpoch) return;
      if (!huddleDeduper.shouldProcess(payload)) return;
      const row = payload.new;
      if (payload.eventType === 'DELETE') {
        if (payload.old?.id && payload.old.id === huddle?.id) applyPayload(null);
        return;
      }
      if (!row?.id) return;
      // A NEW huddle in this channel arrives with an empty log — fetch it rather
      // than rendering a row whose events we have never seen.
      if (row.id !== huddle?.id) {
        void refetch();
        return;
      }
      setHuddle(row);
    },
  );

  const eventDeduper = useRealtimeDeduper();
  useTableSubscription<HuddleEvent>(
    {
      enabled: !!workspaceId && !!sessionId,
      channelName: `huddle_events:${sessionId}`,
      table: 'huddle_events',
      event: 'INSERT',
      schema: 'public',
      filter: `session_id=eq.${sessionId}`,
    },
    (payload) => {
      if (baseEpochRef.current !== subscriptionEpoch) return;
      if (!eventDeduper.shouldProcess(payload)) return;
      const row = payload.new;
      if (!row?.id) return;
      // Append-only: dedupe by row id and let the fold sort it into place. No
      // ordering assumption is made about delivery.
      setEvents(prev => (prev.some(e => e.id === row.id) ? prev : [...prev, row]));
    },
  );

  const state: HuddleState | null = useMemo(() => foldHuddleState(huddle, events), [huddle, events]);

  // Drop a stale connection if the huddle we are connected to has ended (e.g.
  // someone else pressed End, or LiveKit finished the room).
  useEffect(() => {
    if (!connection) return;
    if (state && state.id === connection.huddleId && !state.active) setConnection(null);
  }, [state, connection]);

  const post = useCallback(async (path: string, body?: Record<string, unknown>, requestEpoch = baseEpochRef.current): Promise<HuddlePayload | null> => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(apiUrl(path), {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json', ...apiAuthHeaders() } : apiAuthHeaders(),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (baseEpochRef.current !== requestEpoch) return null;
      if (!response.ok) {
        // jsonError() wraps the message in { message, code } — matches useInbox etc.
        setError(String(payload?.error?.message || `Huddle request failed (${response.status})`));
        return null;
      }
      applyPayload(payload?.data ?? null);
      return (payload?.data ?? null) as HuddlePayload | null;
    } finally {
      setBusy(false);
    }
  }, [applyPayload]);

  /**
   * Start a huddle here, or join the one already running. Same call either way.
   *
   * Starting IS joining: the POST response carries this user's join token, and
   * holding on to it is what mounts the in-call bar. Without that the starter
   * would stand outside their own huddle waiting for someone else to connect.
   */
  const startOrJoin = useCallback(async () => {
    if (!base) return null;
    const requestEpoch = baseEpochRef.current;
    const data = await post(base, undefined, requestEpoch);
    if (baseEpochRef.current !== requestEpoch) return null;
    if (data?.token && data.url && data.roomName && data.huddle?.id) {
      const joinedAtMs = nextHuddleConnectionEpoch(connectionEpochRef.current);
      connectionEpochRef.current = joinedAtMs;
      const next: HuddleConnection = {
        token: data.token,
        url: data.url,
        identity: data.identity || '',
        roomName: data.roomName,
        huddleId: data.huddle.id,
        joinedAtMs,
        heartbeatIntervalMs: data.heartbeatIntervalMs || DEFAULT_HUDDLE_HEARTBEAT_MS,
      };
      setConnection(next);
      return next;
    }
    return null;
  }, [base, post]);

  /**
   * Tell the server this browser's connection is actually UP. The roster was
   * fed only by LiveKit's webhook — an external dashboard step that in 48
   * huddles never delivered one event, so every roster read "Waiting for the
   * first person to connect" while that person was live and talking. The
   * client reports its OWN join; the webhook stays the authority for everyone
   * this client cannot see.
   */
  const confirmJoin = useCallback(async (conn: HuddleConnection) => {
    if (!workspaceId || !conn.huddleId || connection?.joinedAtMs !== conn.joinedAtMs) return;
    const requestEpoch = baseEpochRef.current;
    await post(
      `/backend/workspaces/${encodeURIComponent(workspaceId)}/huddles/${encodeURIComponent(conn.huddleId)}/confirm`,
      { connectionEpoch: conn.joinedAtMs },
      requestEpoch,
    );
  }, [connection?.joinedAtMs, workspaceId, post]);

  /** End the huddle for everyone. */
  const end = useCallback(async () => {
    if (!workspaceId || !state?.id) return;
    setConnection(null);
    await post(`/backend/workspaces/${encodeURIComponent(workspaceId)}/huddles/${encodeURIComponent(state.id)}/end`);
  }, [workspaceId, state?.id, post]);

  /** Leave without ending it for anyone else, and say so — see confirmJoin. */
  const leave = useCallback(() => {
    const current = connection;
    const requestEpoch = baseEpochRef.current;
    if (!current) return;
    // Never perform network work inside a state updater: React may invoke an
    // updater more than once under Strict Mode/concurrent rendering. Capture
    // the connection first, drop the UI immediately, then send one best-effort
    // epoch-checked leave.
    setConnection(null);
    if (workspaceId && current.huddleId) {
      void post(
        `/backend/workspaces/${encodeURIComponent(workspaceId)}/huddles/${encodeURIComponent(current.huddleId)}/leave`,
        { connectionEpoch: current.joinedAtMs },
        requestEpoch,
      );
    }
  }, [connection, workspaceId, post]);

  /**
   * Save the Notes tab's text. Keyed on the huddle itself, not the connection —
   * notes can be jotted before anyone's mic is even on, or after the call ends
   * but before the dock is closed. The realtime `huddles` subscription above
   * already applies OTHER browsers' saves to `huddle` (and so to `notes`
   * below); this is only the write side.
   */
  const saveNotes = useCallback(async (next: string): Promise<boolean> => {
    if (!workspaceId || !huddle?.id) return false;
    const data = await post(
      `/backend/workspaces/${encodeURIComponent(workspaceId)}/huddles/${encodeURIComponent(huddle.id)}/notes`,
      { notes: next },
    );
    return !!data;
  }, [workspaceId, huddle?.id, post]);

  return {
    state,
    huddle,
    notes: huddle?.notes ?? '',
    events,
    configured,
    loading,
    busy,
    error,
    connection,
    startOrJoin,
    confirmJoin,
    end,
    leave,
    saveNotes,
    refetch,
  };
}
