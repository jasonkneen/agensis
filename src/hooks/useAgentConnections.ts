import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState } from './useWorkspaceState';
import type { AgentConnection } from '../types';

// The daemon heartbeats every 15s (AGENSIS_HEARTBEAT_MS). A connection whose
// last_seen_at is older than this is treated as offline regardless of its stored
// `status`, so the UI stops showing a dead daemon as "online" even if the
// lifecycle event that flips the DB row never reaches us. 3x the heartbeat gives
// margin for a single missed beat / network jitter.
const STALE_AFTER_MS = 45_000;
// Refetch cadence so a frozen last_seen_at is re-evaluated even when realtime
// UPDATEs aren't arriving (the failure mode that makes lights "stay green").
const POLL_INTERVAL_MS = 15_000;

function isConnectionStale(connection: AgentConnection, nowMs: number): boolean {
  const seen = connection.last_seen_at ? new Date(connection.last_seen_at).getTime() : NaN;
  if (Number.isNaN(seen)) return false; // unparseable timestamp: trust stored status
  return nowMs - seen > STALE_AFTER_MS;
}

// Coerce a connection's status to 'offline' when its heartbeat has gone stale.
function withEffectiveStatus(connection: AgentConnection, nowMs: number): AgentConnection {
  if (connection.status !== 'offline' && isConnectionStale(connection, nowMs)) {
    return { ...connection, status: 'offline' };
  }
  return connection;
}

export function useAgentConnections(workspaceId: string | null, seed?: AgentConnection[] | null) {
  const workspaceKey = normalizeWorkspaceId(workspaceId);
  const [connections, setConnections] = useWorkspaceListState<AgentConnection>(
    workspaceKey || null,
    (seed || []).filter(connection => connection.workspace_id === workspaceKey),
  );
  const [loading, setLoading] = useState(false);
  const [realtimeWorkspaceId, setRealtimeWorkspaceId] = useState<string | null>(null);
  const workspaceRequestRef = useRef({ workspaceKey, generation: 0 });
  if (workspaceRequestRef.current.workspaceKey !== workspaceKey) {
    workspaceRequestRef.current = {
      workspaceKey,
      generation: workspaceRequestRef.current.generation + 1,
    };
  }
  // Bootstrap seed is a one-shot cold paint. Once the dedicated connections
  // endpoint has answered for this workspace, it is authoritative (it reconciles
  // against live sockets). Letting seed re-apply after that fetch was the
  // "green for ~10s then offline" flash: bootstrap painted DB-online rows, then
  // the poll/reconcile corrected them — or worse, a late seed stomped a correct
  // offline fetch back to green until the next poll.
  const fetchedForWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    fetchedForWorkspaceRef.current = null;
  }, [workspaceKey]);

  useEffect(() => {
    if (!seed) return;
    if (fetchedForWorkspaceRef.current === workspaceKey) return;
    setConnections(seed.filter(connection => connection.workspace_id === workspaceKey));
  }, [seed, setConnections, workspaceKey]);

  const fetchConnections = useCallback(async () => {
    const request = workspaceRequestRef.current;
    const isCurrent = () => workspaceRequestRef.current === request;
    if (!workspaceKey) {
      setConnections([]);
      setRealtimeWorkspaceId(null);
      setLoading(false);
      fetchedForWorkspaceRef.current = null;
      return;
    }
    setRealtimeWorkspaceId(prev => prev === workspaceKey ? prev : null);
    setLoading(true);
    try {
      const response = await fetch(apiUrl(`/backend/agents/connections?workspaceId=${encodeURIComponent(workspaceKey)}`), {
        headers: apiAuthHeaders(),
      });
      const payload = await response.json().catch(() => null);
      if (!isCurrent()) return;
      if (response.ok && Array.isArray(payload?.data)) {
        fetchedForWorkspaceRef.current = workspaceKey;
        setConnections(payload.data);
        setRealtimeWorkspaceId(workspaceKey);
        return;
      }
      fetchedForWorkspaceRef.current = workspaceKey;
      setConnections([]);
      setRealtimeWorkspaceId(null);
    } catch {
      if (!isCurrent()) return;
      // Keep seed / last good paint on transient network errors — do not mark
      // fetched, so a later seed can still apply if we never got a 2xx.
      setRealtimeWorkspaceId(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [setConnections, workspaceKey]);

  useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);

  // Poll so a daemon that died without delivering an offline UPDATE still has its
  // last_seen_at re-read; the staleness derivation below then flips it to offline.
  useEffect(() => {
    if (!workspaceKey) return;
    const id = window.setInterval(() => { void fetchConnections(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [workspaceKey, fetchConnections]);

  // A monotonically advancing tick drives re-derivation of staleness between
  // fetches/events, so a light goes out on schedule even with no incoming data.
  const [staleTick, setStaleTick] = useState(0);
  useEffect(() => {
    if (!workspaceKey) return;
    const id = window.setInterval(() => setStaleTick(tick => tick + 1), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [workspaceKey]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<AgentConnection>(
    {
      enabled: !!workspaceKey && realtimeWorkspaceId === workspaceKey,
      channelName: `agent_connections:${workspaceKey}`,
      table: 'agent_connections',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceKey}`,
    },
    (payload) => {
      if (workspaceRequestRef.current.workspaceKey !== workspaceKey) return;
      const rowWorkspaceId = payload.new?.workspace_id || payload.old?.workspace_id;
      if (rowWorkspaceId !== workspaceKey) return;
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT') {
        const row = payload.new;
        if (!row) return;
        setConnections(prev => [row, ...prev.filter(connection => connection.id !== row.id)]);
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new;
        if (!row) return;
        setConnections(prev => prev.map(connection => connection.id === row.id ? row : connection));
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.id) return;
        setConnections(prev => prev.filter(connection => connection.id !== row.id));
      }
    },
  );

  // Expose connections with heartbeat-derived status so every consumer (sidebar
  // status dot, presence list, chat participant chip) reflects real liveness.
  const effectiveConnections = useMemo(() => {
    void staleTick; // recompute on each tick
    const nowMs = Date.now();
    return connections.map(connection => withEffectiveStatus(connection, nowMs));
  }, [connections, staleTick]);

  return { connections: effectiveConnections, loading, refetch: fetchConnections };
}

function normalizeWorkspaceId(value: string | null) {
  return typeof value === 'string' ? value.trim() : '';
}
