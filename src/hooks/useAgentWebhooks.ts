import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import type { AgentWebhook } from '../types';

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
    // Keep a one-time plaintext token in memory for the rest of this page
    // session. Generic UPDATE responses deliberately omit it; replacing the row
    // would make the copy button disappear immediately after an enable toggle.
    if (data) setWebhooks(prev => prev.map(webhook => webhook.id === id ? { ...webhook, ...data } : webhook));
    return data as AgentWebhook | null;
  }, []);

  return { webhooks, loading, createWebhook, updateWebhook, refetch: fetchWebhooks };
}
