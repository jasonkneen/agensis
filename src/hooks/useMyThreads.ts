import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { ChatSession } from '../types';

export interface MyThread extends ChatSession {
  message_count?: number;
  last_activity?: string;
}

// Quick-access list of threads the signed-in user is involved in (authored a
// message in a sub-thread, or posted a threaded reply) across the workspace.
export function useMyThreads(workspaceId: string | null, enabled = true) {
  const [threads, setThreads] = useState<MyThread[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId || !enabled) { setThreads([]); return; }
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/my-threads`), { headers: apiAuthHeaders() });
      const payload = await res.json().catch(() => null);
      if (Array.isArray(payload?.data)) setThreads(payload.data as MyThread[]);
    } catch {
      // best-effort — leave the previous list in place on a transient failure
    } finally {
      setLoading(false);
    }
  }, [workspaceId, enabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { threads, loading, refresh };
}
