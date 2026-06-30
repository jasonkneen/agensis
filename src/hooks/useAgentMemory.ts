import { useState, useEffect, useCallback } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { AgentMemoryFile } from '../types';

/**
 * Read-only mirror of every agent's file-backed memory in the workspace. The daemon
 * pushes file rows up; we just read the table and subscribe for changes. `refresh`
 * fires a fire-and-forget nudge — the answer arrives as a realtime change, not a
 * synchronous response, so the UI never blocks on the daemon being online.
 */
export function useAgentMemory(workspaceId: string | null) {
  const [files, setFiles] = useState<AgentMemoryFile[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFiles = useCallback(async () => {
    if (!workspaceId) {
      setFiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<AgentMemoryFile[]>(`agent_memory_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('agent_memory_files')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('path', { ascending: true });
      return data as unknown as AgentMemoryFile[];
    });
    if (data) setFiles(data);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<AgentMemoryFile>(
    {
      enabled: !!workspaceId,
      channelName: `agent-memory:${workspaceId}`,
      table: 'agent_memory_files',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      // Re-syncs UPSERT in place (same row id, never delete+reinsert) but the server
      // emits them as INSERT. Replace-or-append by id so changed content_cache lands —
      // a skip-if-exists handler would make the Refresh button silently do nothing.
      if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
        const row = payload.new;
        if (!row) return;
        setFiles(prev => prev.some(f => f.id === row.id)
          ? prev.map(f => f.id === row.id ? row : f)
          : [...prev, row]);
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.id) return;
        setFiles(prev => prev.filter(f => f.id !== row.id));
      }
    },
  );

  const refresh = useCallback(async (agentId: string) => {
    if (!agentId) return false;
    try {
      const res = await fetch(apiUrl(`/backend/agents/${encodeURIComponent(agentId)}/memory-refresh`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => null);
      return Boolean(body?.data?.nudged);
    } catch {
      return false;
    }
  }, []);

  return { files, loading, refresh, refetch: fetchFiles };
}
