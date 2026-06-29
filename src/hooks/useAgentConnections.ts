import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
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

export function useAgentConnections(workspaceId: string | null) {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [realtimeWorkspaceId, setRealtimeWorkspaceId] = useState<string | null>(null);
  const workspaceKey = normalizeWorkspaceId(workspaceId);

  const fetchConnections = useCallback(async () => {
    if (!workspaceKey) {
      setConnections([]);
      setRealtimeWorkspaceId(null);
      setLoading(false);
      return;
    }
    setRealtimeWorkspaceId(prev => prev === workspaceKey ? prev : null);
    setLoading(true);
    try {
      const response = await fetch(apiUrl(`/backend/agents/connections?workspaceId=${encodeURIComponent(workspaceKey)}`), {
        headers: apiAuthHeaders(),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && Array.isArray(payload?.data)) {
        setConnections(payload.data);
        setRealtimeWorkspaceId(workspaceKey);
        return;
      }
      setConnections([]);
      setRealtimeWorkspaceId(null);
    } catch {
      setConnections([]);
      setRealtimeWorkspaceId(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceKey]);

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
