import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import type { AgentConnection } from '../types';

type AgentConnectionRealtimePayload = {
  eventType?: string;
  new?: AgentConnection;
  old?: Partial<AgentConnection>;
};

export function useAgentConnections(workspaceId: string | null) {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchConnections = useCallback(async () => {
    if (!workspaceId) {
      setConnections([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(apiUrl(`/backend/agents/connections?workspaceId=${encodeURIComponent(workspaceId)}`), {
        headers: apiAuthHeaders(),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && Array.isArray(payload?.data)) {
        setConnections(payload.data);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    if (!workspaceId) return;
    const channel = backendClient
      .channel(`agent_connections:${workspaceId}`)
      .on(
        'db_changes',
        { event: '*', schema: 'public', table: 'agent_connections', filter: `workspace_id=eq.${workspaceId}` },
        (payload: AgentConnectionRealtimePayload) => {
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
      )
      .subscribe();
    return () => {
      backendClient.removeChannel(channel);
    };
  }, [workspaceId]);

  return { connections, loading, refetch: fetchConnections };
}
