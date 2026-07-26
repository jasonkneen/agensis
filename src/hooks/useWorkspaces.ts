import { useState, useEffect, useCallback } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsertResult } from '../lib/offlineBackend';
import { WORKSPACE_UNAVAILABLE, classifyWriteFailure, type WriteFailure } from '../lib/writeFeedback';
import type { Workspace } from '../types';

export interface CreateWorkspaceResult {
  workspace: Workspace | null;
  failure: WriteFailure | null;
}

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

  // Returns the failure as well as the row: the dialog must stay open (with the
  // typed name intact) and say why when the insert is rejected, instead of
  // sitting there looking like the button did nothing.
  const createWorkspace = useCallback(async (
    name: string,
    icon: string = '🗂️',
    description: string = ''
  ): Promise<CreateWorkspaceResult> => {
    if (!userId) return { workspace: null, failure: WORKSPACE_UNAVAILABLE };
    const { data, error } = await offlineInsertResult('workspaces', { name, icon, description, user_id: userId }, 'workspaces');
    if (data) {
      const ws = data as unknown as Workspace;
      setWorkspaces(prev => [...prev, ws]);
      return { workspace: ws, failure: null };
    }
    return { workspace: null, failure: classifyWriteFailure(error, { online: navigator.onLine }) };
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
