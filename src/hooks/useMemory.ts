import { useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import { useWorkspaceListState, useWorkspaceState } from './useWorkspaceState';
import type { MemoryFact } from '../types';

export function useMemory(workspaceId: string | null) {
  const [facts, setFacts, beginFactsRequest] = useWorkspaceListState<MemoryFact>(workspaceId, []);
  const [loading, setLoading] = useWorkspaceState(workspaceId, true, Boolean(workspaceId));

  const fetchFacts = useCallback(async () => {
    const isCurrent = beginFactsRequest();
    if (!workspaceId) {
      setFacts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await cachedFetch<MemoryFact[]>(`memory_${workspaceId}`, async () => {
        const { data } = await backendClient
          .from('memory_facts')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false });
        return data;
      });
      if (isCurrent() && data) setFacts(data);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginFactsRequest, setFacts, setLoading, workspaceId]);

  useEffect(() => {
    fetchFacts();
  }, [fetchFacts]);

  const addFact = useCallback(async (fact: string, category = 'general') => {
    if (!workspaceId || !fact.trim()) return;
    const data = await offlineInsert('memory_facts', {
      workspace_id: workspaceId,
      fact: fact.trim(),
      category,
    }, `memory_${workspaceId}`);
    if (data) {
      setFacts(prev => [data as unknown as MemoryFact, ...prev]);
    }
  }, [setFacts, workspaceId]);

  const updateFact = useCallback(async (id: string, fact: string, category: string) => {
    if (!workspaceId) return null;
    const result = await offlineUpdate('memory_facts', id, {
      fact,
      category,
      updated_at: new Date().toISOString(),
    }, `memory_${workspaceId}`);
    if (result) {
      setFacts(prev => prev.map(f => f.id === id ? { ...f, ...result } as MemoryFact : f));
    }
  }, [setFacts, workspaceId]);

  const deleteFact = useCallback(async (id: string) => {
    if (!workspaceId) return false;
    const deleted = await offlineDelete('memory_facts', id, `memory_${workspaceId}`);
    if (deleted) setFacts(prev => prev.filter(f => f.id !== id));
    return deleted;
  }, [setFacts, workspaceId]);

  const categories = [...new Set(facts.map(f => f.category))];

  return { facts, categories, loading, addFact, updateFact, deleteFact };
}
