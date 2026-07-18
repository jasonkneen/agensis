import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';

// A vault secret is never returned in full — only a masked preview. Writing a
// value replaces it (encrypted at rest server-side); reading only confirms it is
// configured and shows a preview.
export interface VaultSecret {
  key: string;
  description: string;
  preview: string;
  configured: boolean;
  updated_at: string | null;
}

export function useWorkspaceVault(workspaceId: string | null) {
  const [secrets, setSecrets] = useState<VaultSecret[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId) { setSecrets([]); return; }
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/vault`), { headers: apiAuthHeaders() });
      const payload = await res.json().catch(() => null);
      if (Array.isArray(payload?.data)) setSecrets(payload.data as VaultSecret[]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setSecret = useCallback(async (key: string, value: string, description?: string): Promise<boolean> => {
    if (!workspaceId) return false;
    const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/vault/${encodeURIComponent(key)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({ value, description }),
    });
    const ok = res.ok;
    await refresh();
    return ok;
  }, [workspaceId, refresh]);

  const deleteSecret = useCallback(async (key: string): Promise<void> => {
    if (!workspaceId) return;
    setSecrets(prev => prev.filter(s => s.key !== key));
    await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/vault/${encodeURIComponent(key)}`), {
      method: 'DELETE',
      headers: apiAuthHeaders(),
    });
  }, [workspaceId]);

  return { secrets, loading, refresh, setSecret, deleteSecret };
}
