import { useCallback, useEffect, useMemo, useState } from 'react';
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
   */
  joinedAtMs: number;
}

interface HuddlePayload {
  huddle: Huddle | null;
  events: HuddleEvent[];
  configured?: boolean;
  token?: string;
  url?: string;
  identity?: string;
  roomName?: string;
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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    if (!workspaceId || !huddleId) return;
    setLoading(true);
    const path = `/backend/workspaces/${encodeURIComponent(workspaceId)}/huddles/${encodeURIComponent(huddleId)}`;
    void fetch(apiUrl(path), { headers: apiAuthHeaders() })
      .then(async (response) => (response.ok ? response.json().catch(() => null) : null))
      .then((payload) => {
        if (cancelled) return;
        const data = payload?.data as HuddlePayload | undefined;
        setState(foldHuddleState(data?.huddle ?? null, Array.isArray(data?.events) ? data.events : []));
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [workspaceId, huddleId]);

  return { state, loading };
}

/**
 * The huddle for one channel.
 *
 * State model (copied from a prior hand-rolled implementation that got this
 * part right): the server owns an APPEND-ONLY event log and this hook folds it.
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

  const applyPayload = useCallback((payload: HuddlePayload | null) => {
    setHuddle(payload?.huddle ?? null);
    setEvents(Array.isArray(payload?.events) ? payload.events : []);
    if (typeof payload?.configured === 'boolean') setConfigured(payload.configured);
  }, []);

  const refetch = useCallback(async () => {
    if (!base) {
      applyPayload(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(apiUrl(base), { headers: apiAuthHeaders() });
      const payload = await response.json().catch(() => null);
      if (response.ok) applyPayload(payload?.data ?? null);
    } finally {
      setLoading(false);
    }
  }, [base, applyPayload]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Two subscriptions, both filtered on session_id (the RBAC gate resolves a
  // session's workspace, so this stays membership-checked server-side).
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

  const post = useCallback(async (path: string): Promise<HuddlePayload | null> => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(apiUrl(path), { method: 'POST', headers: apiAuthHeaders() });
      const payload = await response.json().catch(() => null);
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
    const data = await post(base);
    if (data?.token && data.url && data.roomName && data.huddle?.id) {
      const next: HuddleConnection = {
        token: data.token,
        url: data.url,
        identity: data.identity || '',
        roomName: data.roomName,
        huddleId: data.huddle.id,
        joinedAtMs: Date.now(),
      };
      setConnection(next);
      return next;
    }
    return null;
  }, [base, post]);

  /** End the huddle for everyone. */
  const end = useCallback(async () => {
    if (!workspaceId || !state?.id) return;
    setConnection(null);
    await post(`/backend/workspaces/${encodeURIComponent(workspaceId)}/huddles/${encodeURIComponent(state.id)}/end`);
  }, [workspaceId, state?.id, post]);

  /** Leave without ending it for anyone else. LiveKit's webhook records the leave. */
  const leave = useCallback(() => setConnection(null), []);

  return {
    state,
    huddle,
    events,
    configured,
    loading,
    busy,
    error,
    connection,
    startOrJoin,
    end,
    leave,
    refetch,
  };
}
