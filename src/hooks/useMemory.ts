import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import type { MemoryFact } from '../types';

export function useMemory(workspaceId: string | null) {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFacts = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    const data = await cachedFetch<MemoryFact[]>(`memory_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('memory_facts')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });
      return data;
    });
    if (data) setFacts(data);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchFacts();
  }, [fetchFacts]);

  const addFact = useCallback(async (fact: string, category = 'general') => {
    if (!workspaceId || !fact.trim()) return;
    const data = await offlineInsert('memory_facts', {
      workspace_id: workspaceId,
      fact: fact.trim(),
      category,
    });
    if (data) {
      setFacts(prev => [data as unknown as MemoryFact, ...prev]);
    }
  }, [workspaceId]);

  const updateFact = useCallback(async (id: string, fact: string, category: string) => {
    const result = await offlineUpdate('memory_facts', id, {
      fact,
      category,
      updated_at: new Date().toISOString(),
    });
    if (result) {
      setFacts(prev => prev.map(f => f.id === id ? { ...f, ...result } as MemoryFact : f));
    }
  }, []);

  const deleteFact = useCallback(async (id: string) => {
    await offlineDelete('memory_facts', id);
    setFacts(prev => prev.filter(f => f.id !== id));
  }, []);

  const categories = [...new Set(facts.map(f => f.category))];

  return { facts, categories, loading, addFact, updateFact, deleteFact };
}
