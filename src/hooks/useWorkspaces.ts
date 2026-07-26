import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsertResult } from '../lib/offlineBackend';
import { WORKSPACE_UNAVAILABLE, classifyWriteFailure, type WriteFailure } from '../lib/writeFeedback';
import { describeWorkspaceReadiness } from '../lib/workspaceReadiness';
import type { Workspace } from '../types';

export interface CreateWorkspaceResult {
  workspace: Workspace | null;
  failure: WriteFailure | null;
}

// The two workspaces every account starts with. Seeding used to live in
// useAuth's signUp, running CONCURRENTLY with this hook's first fetch — the
// fetch won, cached an empty list, and nobody ever refetched, so the account had
// no usable workspace for the rest of the session. It belongs here instead:
// this hook is the only place that knows the list has settled and come back
// empty, which is also the only moment at which seeding is provably needed.
// Doing it here fixes the sign-IN path too, which never seeded at all.
const STARTER_WORKSPACES = [
  { name: 'Personal', description: 'Your personal workspace', icon: '🌱' },
  { name: 'Work', description: 'Professional workspace', icon: '💼' },
];

export function useWorkspaces(userId: string | undefined) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [seedFailure, setSeedFailure] = useState<WriteFailure | null>(null);
  // One automatic attempt per signed-in user. Without this the seed would fire
  // again on every render that still sees an empty list — including the renders
  // that happen while the insert is in flight.
  const seedAttemptedForRef = useRef<string | null>(null);

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

  // Create the starter workspaces for an account that has none. Unlike the old
  // seeding this checks its own result: a rejected insert becomes a real,
  // reportable failure instead of leaving the user permanently workspace-less
  // with no explanation.
  const seedStarterWorkspaces = useCallback(async () => {
    if (!userId) return;
    setSeeding(true);
    setSeedFailure(null);
    const { data, error } = await backendClient
      .from('workspaces')
      .insert(STARTER_WORKSPACES.map(w => ({ ...w, user_id: userId })))
      .select();
    if (error) {
      setSeedFailure(classifyWriteFailure(error, { online: navigator.onLine }));
      setSeeding(false);
      return;
    }
    // Read the list back rather than trusting the insert's echo: the list route
    // is what every other consumer of this hook sees, and a workspace created
    // in another tab in the meantime should show up too.
    await fetchWorkspaces();
    if (Array.isArray(data) && data.length > 0) {
      setWorkspaces(prev => (prev.length > 0 ? prev : (data as unknown as Workspace[])));
    }
    setSeeding(false);
  }, [userId, fetchWorkspaces]);

  const readiness = useMemo(
    () => describeWorkspaceReadiness({
      loading,
      workspaceCount: workspaces.length,
      repairing: seeding,
      repairFailure: seedFailure,
    }),
    [loading, workspaces.length, seeding, seedFailure],
  );

  useEffect(() => {
    if (!userId || !readiness.shouldRepair) return;
    if (seedAttemptedForRef.current === userId) return;
    seedAttemptedForRef.current = userId;
    void seedStarterWorkspaces();
  }, [userId, readiness.shouldRepair, seedStarterWorkspaces]);

  /** Re-run the setup the user just watched fail. */
  const retryWorkspaceSetup = useCallback(async () => {
    if (!userId || seeding) return;
    seedAttemptedForRef.current = userId;
    await seedStarterWorkspaces();
  }, [userId, seeding, seedStarterWorkspaces]);

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

  return { workspaces, loading, createWorkspace, updateWorkspace, readiness, retryWorkspaceSetup };
}
