import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import type { WorkspaceAgent } from '../types';

type AgentRealtimePayload = {
  eventType?: string;
  new?: WorkspaceAgent;
  old?: Partial<WorkspaceAgent>;
};

export interface CreateAgentInput {
  name: string;
  avatar?: string;
  openpet_avatar_id?: string | null;
  description?: string;
  system_prompt: string;
  soul?: string;
  instructions?: string;
  tools?: string[];
  skills?: string[];
  handle?: string;
  model?: string;
  run_mode?: 'builtin' | 'daemon';
}

function agentHandle(value: string) {
  return value
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

type AgentChangePayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new?: WorkspaceAgent;
  old?: WorkspaceAgent;
};

export function useAgents(workspaceId: string | null, userId?: string) {
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAgents = useCallback(async () => {
    if (!workspaceId) {
      setAgents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<WorkspaceAgent[]>(`agents_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('workspace_agents')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true });
      return data;
    });
    if (data) setAgents(data);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    if (!workspaceId) return;
    const channel = backendClient
      .channel(`workspace_agents:${workspaceId}`)
      .on(
        'db_changes',
        { event: '*', schema: 'public', table: 'workspace_agents', filter: `workspace_id=eq.${workspaceId}` },
        (payload: AgentRealtimePayload) => {
          if (payload.eventType === 'INSERT') {
            const row = payload.new;
            if (!row) return;
            setAgents(prev => prev.some(a => a.id === row.id) ? prev : [...prev, row]);
          } else if (payload.eventType === 'UPDATE') {
            const row = payload.new;
            if (!row) return;
            setAgents(prev => prev.map(a => a.id === row.id ? row : a));
          } else if (payload.eventType === 'DELETE') {
            const row = payload.old;
            if (!row?.id) return;
            setAgents(prev => prev.filter(a => a.id !== row.id));
          }
        },
      )
      .subscribe();
    return () => {
      backendClient.removeChannel(channel);
    };
  }, [workspaceId]);

  const createAgent = useCallback(async (input: CreateAgentInput) => {
    if (!workspaceId) return null;
    const data = await offlineInsert('workspace_agents', {
      workspace_id: workspaceId,
      created_by: userId ?? null,
      name: input.name,
      avatar: input.avatar ?? 'AI',
      openpet_avatar_id: input.openpet_avatar_id ?? '',
      description: input.description ?? '',
      system_prompt: input.system_prompt,
      soul: input.soul ?? '',
      instructions: input.instructions ?? '',
      tools: input.tools ?? [],
      skills: input.skills ?? [],
      handle: input.handle ?? agentHandle(input.name),
      model: input.model ?? 'auto',
      run_mode: input.run_mode ?? 'builtin',
    });
    if (data) {
      const agent = data as unknown as WorkspaceAgent;
      setAgents(prev => prev.some(a => a.id === agent.id) ? prev : [...prev, agent]);
      return agent;
    }
    return null;
  }, [workspaceId, userId]);

  const updateAgent = useCallback(async (id: string, updates: Partial<WorkspaceAgent>) => {
    const result = await offlineUpdate('workspace_agents', id, updates as Record<string, unknown>);
    if (result) {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...result } as WorkspaceAgent : a));
    }
    return result;
  }, []);

  const deleteAgent = useCallback(async (id: string) => {
    await offlineDelete('workspace_agents', id);
    setAgents(prev => prev.filter(a => a.id !== id));
    return true;
  }, []);

  return {
    agents,
    loading,
    createAgent,
    updateAgent,
    deleteAgent,
    refetch: fetchAgents,
  };
}
