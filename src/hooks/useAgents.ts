import { useState, useEffect, useCallback } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { cachedFetch, offlineInsertResult, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import { WORKSPACE_UNAVAILABLE, classifyWriteFailure, type WriteFailure } from '../lib/writeFeedback';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { WorkspaceAgent } from '../types';
import type { AgentPurpose, ResourceFacet } from '../lib/agentPurpose';

export interface CreateAgentResult {
  agent: WorkspaceAgent | null;
  failure: WriteFailure | null;
}

export interface CreateAgentInput {
  name: string;
  avatar?: string;
  openpet_avatar_id?: string | null;
  accent_color?: string | null;
  description?: string;
  system_prompt: string;
  soul?: string;
  instructions?: string;
  tools?: string[];
  skills?: string[];
  purpose?: AgentPurpose;
  resource_facets?: ResourceFacet[];
  ambient_replies?: boolean;
  metadata?: Record<string, unknown>;
  handle?: string;
  model?: string;
  run_mode?: 'builtin' | 'daemon' | 'sandbox';
  sandbox_provider?: string | null;
  sandbox_config?: Record<string, unknown>;
}

function agentHandle(value: string) {
  return value
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

export function useAgents(workspaceId: string | null, userId?: string, seed?: WorkspaceAgent[] | null) {
  const [agents, setAgents] = useState<WorkspaceAgent[]>(() => seed || []);
  const [loading, setLoading] = useState(!seed?.length);

  useEffect(() => {
    if (seed) setAgents(seed);
  }, [seed]);

  const fetchAgents = useCallback(async () => {
    if (!workspaceId) {
      setAgents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<WorkspaceAgent[]>(`agents_${workspaceId}`, async () => {
      const response = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/agents`), {
        headers: apiAuthHeaders(),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || `Agents HTTP ${response.status}`);
      return payload?.data ?? [];
    });
    if (data) setAgents(data);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<WorkspaceAgent>(
    {
      enabled: !!workspaceId,
      channelName: `workspace_agents:${workspaceId}`,
      table: 'workspace_agents',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
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
  );

  // Returns the failure alongside the row so the create form can stay open with
  // the filled-in fields when the insert is rejected. `!workspaceId` is its own
  // outcome: the workspace never loaded, so no request is even made — a case
  // that previously looked identical to success from the form's side.
  const createAgent = useCallback(async (input: CreateAgentInput): Promise<CreateAgentResult> => {
    if (!workspaceId) return { agent: null, failure: WORKSPACE_UNAVAILABLE };
    const { data, error } = await offlineInsertResult('workspace_agents', {
      workspace_id: workspaceId,
      created_by: userId ?? null,
      name: input.name,
      avatar: input.avatar ?? 'AI',
      openpet_avatar_id: input.openpet_avatar_id ?? '',
      accent_color: input.accent_color ?? '#00a95c',
      description: input.description ?? '',
      system_prompt: input.system_prompt,
      soul: input.soul ?? '',
      instructions: input.instructions ?? '',
      tools: input.tools ?? [],
      skills: input.skills ?? [],
      purpose: input.purpose ?? 'collaborator',
      resource_facets: input.resource_facets ?? [],
      metadata: input.metadata ?? {},
      handle: input.handle ?? agentHandle(input.name),
      model: input.model ?? 'auto',
      run_mode: input.run_mode ?? 'builtin',
      sandbox_provider: input.sandbox_provider ?? null,
      sandbox_config: input.sandbox_config ?? {},
      enabled: true,
      ambient_replies: input.ambient_replies ?? true,
    }, `agents_${workspaceId}`);
    if (data) {
      const agent = data as unknown as WorkspaceAgent;
      setAgents(prev => prev.some(a => a.id === agent.id) ? prev : [...prev, agent]);
      return { agent, failure: null };
    }
    return { agent: null, failure: classifyWriteFailure(error, { online: navigator.onLine }) };
  }, [workspaceId, userId]);

  const updateAgent = useCallback(async (id: string, updates: Partial<WorkspaceAgent>) => {
    const result = await offlineUpdate('workspace_agents', id, updates as Record<string, unknown>, `agents_${workspaceId}`);
    if (result) {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...result } as WorkspaceAgent : a));
    }
    return result;
  }, [workspaceId]);

  const deleteAgent = useCallback(async (id: string) => {
    await offlineDelete('workspace_agents', id, `agents_${workspaceId}`);
    setAgents(prev => prev.filter(a => a.id !== id));
    return true;
  }, [workspaceId]);

  const disconnectAgent = useCallback(async (id: string) => {
    const response = await fetch(apiUrl(`/backend/agents/${encodeURIComponent(id)}/disconnect`), {
      method: 'POST',
      headers: apiAuthHeaders(),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `Disconnect HTTP ${response.status}`);
    return payload?.data ?? null;
  }, []);

  return {
    agents,
    loading,
    createAgent,
    updateAgent,
    deleteAgent,
    disconnectAgent,
    refetch: fetchAgents,
  };
}
