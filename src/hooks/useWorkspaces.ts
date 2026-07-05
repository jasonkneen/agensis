import { useState, useEffect, useCallback } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert } from '../lib/offlineBackend';
import type { Workspace } from '../types';

export function useWorkspaces(userId: string | undefined) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchWorkspaces = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    const data = await cachedFetch<Workspace[]>('workspaces', async () => {
      const response = await fetch(apiUrl('/backend/workspaces'), {
        headers: apiAuthHeaders(),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || `Workspaces HTTP ${response.status}`);
      return payload?.data ?? [];
    });
    if (data) setWorkspaces(data);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const createWorkspace = useCallback(async (
    name: string,
    icon: string = '🗂️',
    description: string = ''
  ) => {
    if (!userId) return null;
    const data = await offlineInsert('workspaces', { name, icon, description, user_id: userId }, 'workspaces');
    if (data) {
      const ws = data as unknown as Workspace;
      setWorkspaces(prev => [...prev, ws]);
      return ws;
    }
    return null;
  }, [userId]);

  const updateWorkspace = useCallback(async (id: string, updates: Partial<Workspace>) => {
    const { data } = await backendClient
      .from('workspaces')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (data) setWorkspaces(prev => prev.map(w => w.id === id ? data : w));
  }, []);

  return { workspaces, loading, createWorkspace, updateWorkspace };
}
