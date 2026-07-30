import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { GatewayConfig } from '../types';

// Workspace inference gateways (external OpenAI-compatible endpoints). The API
// key is never returned by the backend — only `has_key` — so this hook holds
// safe metadata for the chat model selector and the settings manager.
export function useGateways(workspaceId: string | null) {
  const [gateways, setGateways] = useState<GatewayConfig[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchGateways = useCallback(async () => {
    if (!workspaceId) {
      setGateways([]);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/gateways`), {
        headers: apiAuthHeaders(),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok) setGateways(Array.isArray(payload?.data) ? payload.data : []);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchGateways();
  }, [fetchGateways]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<GatewayConfig>(
    {
      enabled: !!workspaceId,
      channelName: `gateway_configs:${workspaceId}`,
      table: 'gateway_configs',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      // The realtime row carries only ids for DELETE and safe metadata otherwise;
      // refetch to stay authoritative rather than trusting a partial row shape.
      void fetchGateways();
    },
  );

  const createGateway = useCallback(async (input: {
    name: string;
    base_url: string;
    model: string;
    api_key?: string;
    headers?: Record<string, unknown>;
  }) => {
    if (!workspaceId) return null;
    const response = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/gateways`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.data) {
      setGateways(prev => [...prev, payload.data]);
      return payload.data as GatewayConfig;
    }
    return null;
  }, [workspaceId]);

  const updateGateway = useCallback(async (id: string, updates: {
    name?: string;
    base_url?: string;
    model?: string;
    api_key?: string;
    headers?: Record<string, unknown>;
  }) => {
    if (!workspaceId) return null;
    const response = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/gateways/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify(updates),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.data) {
      setGateways(prev => prev.map(g => g.id === id ? payload.data : g));
      return payload.data as GatewayConfig;
    }
    return null;
  }, [workspaceId]);

  const deleteGateway = useCallback(async (id: string) => {
    if (!workspaceId) return false;
    const response = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/gateways/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: apiAuthHeaders(),
    });
    if (response.ok) {
      setGateways(prev => prev.filter(g => g.id !== id));
      return true;
    }
    return false;
  }, [workspaceId]);

  return { gateways, loading, fetchGateways, createGateway, updateGateway, deleteGateway };
}
