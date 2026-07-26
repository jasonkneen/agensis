import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import type { AgentWebhook, OrbConfigInput } from '../types';

export function useAgentWebhooks(workspaceId: string | null) {
  const [webhooks, setWebhooks] = useState<AgentWebhook[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchWebhooks = useCallback(async () => {
    if (!workspaceId) {
      setWebhooks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await backendClient
      .from('agent_webhooks')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });
    setWebhooks((data || []) as AgentWebhook[]);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => { fetchWebhooks(); }, [fetchWebhooks]);

  const createWebhook = useCallback(async (input: { agent_id?: string | null; name: string }) => {
    if (!workspaceId) return null;
    const response = await fetch(apiUrl('/backend/agent-webhooks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({
        workspace_id: workspaceId,
        agent_id: input.agent_id || null,
        name: input.name,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) return null;
    const webhook = payload.data as AgentWebhook;
    setWebhooks(prev => [webhook, ...prev]);
    return webhook;
  }, [workspaceId]);

  const updateWebhook = useCallback(async (id: string, updates: Partial<AgentWebhook>) => {
    const { data } = await backendClient
      .from('agent_webhooks')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (data) setWebhooks(prev => prev.map(webhook => webhook.id === id ? data : webhook));
    return data as AgentWebhook | null;
  }, []);

  // Orb config (plans/021) goes through the dedicated route, not the generic /db
  // update path: the route validates the provider/routing enums (an unknown value
  // is rejected rather than coerced to "generic", which would mean unsigned), and
  // it is the only writer allowed to touch the signing secret — which is stored in
  // the workspace vault and never returned here.
  const configureWebhook = useCallback(async (id: string, config: OrbConfigInput) => {
    const response = await fetch(apiUrl(`/backend/agent-webhooks/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify(config),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      return { webhook: null, error: String(payload.error || 'Could not save this orb') };
    }
    const webhook = payload.data as AgentWebhook;
    setWebhooks(prev => prev.map(existing => existing.id === id ? webhook : existing));
    return { webhook, error: null };
  }, []);

  return { webhooks, loading, createWebhook, updateWebhook, configureWebhook, refetch: fetchWebhooks };
}
