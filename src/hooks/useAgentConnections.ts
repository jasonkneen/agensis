import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { AgentConnection } from '../types';

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

  return { connections, loading, refetch: fetchConnections };
}

function normalizeWorkspaceId(value: string | null) {
  return typeof value === 'string' ? value.trim() : '';
}
