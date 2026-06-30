import { useCallback, useEffect, useState } from 'react';
import type { AgentRuntime } from '../types';
import {
  fetchRuntimes,
  setRuntimeStatus,
  setRuntimeAutoApprove,
  createJoinToken,
  type JoinTokenResult,
} from '../lib/runtimes';

// Loads and manages the workspace's external runtimes (the "club"). Polls on an
// interval so presence (online/offline) stays fresh without a realtime subscription.
export function useRuntimes(workspaceId: string | null, { pollMs = 15_000 } = {}) {
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) { setRuntimes([]); return; }
    try {
      setError(null);
      const list = await fetchRuntimes(workspaceId);
      setRuntimes(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runtimes');
    }
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refresh().finally(() => { if (!cancelled) setLoading(false); });
    if (!workspaceId || !pollMs) return () => { cancelled = true; };
    const id = setInterval(() => { void refresh(); }, pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [workspaceId, pollMs, refresh]);

  const approve = useCallback(async (runtimeId: string) => {
    await setRuntimeStatus(runtimeId, 'approve');
    await refresh();
  }, [refresh]);

  const revoke = useCallback(async (runtimeId: string) => {
    await setRuntimeStatus(runtimeId, 'revoke');
    await refresh();
  }, [refresh]);

  const setAutoApprove = useCallback(async (on: boolean) => {
    if (!workspaceId) return false;
    const result = await setRuntimeAutoApprove(workspaceId, on);
    return result;
  }, [workspaceId]);

  const generateJoinToken = useCallback(async (): Promise<JoinTokenResult | null> => {
    if (!workspaceId) return null;
    return createJoinToken(workspaceId);
  }, [workspaceId]);

  return { runtimes, loading, error, refresh, approve, revoke, setAutoApprove, generateJoinToken };
}
