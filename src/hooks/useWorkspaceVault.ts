import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';

// The workspace vault, as the browser sees it: WRITE-ONLY.
//
// A value can be set, replaced and deleted; it can never be read back. The
// backend does not decrypt on this path and its SQL does not even select the
// secret columns, so there is no masked preview to render — an entry is
// `configured` or it is not, plus when it was last set.
//
// Entries are CLASSIFIED, not flat. `group` says what kind of credential it is and
// `lane` says which route may write it, so a provider entry
// (`sandbox:box:api_key`) renders under the thing that owns it.
export type VaultGroup = 'managed' | 'provider' | 'shared' | 'unknown';
export type VaultLane = 'managed' | 'provider' | 'shared' | 'none';

export interface VaultEntry {
  key: string;
  group: VaultGroup;
  lane: VaultLane;
  /** The provider slug this entry belongs to; '' for a loose secret. */
  owner: string;
  /** Display name for that owner — normally a provider's name. */
  ownerLabel: string;
  /** Display name for the entry itself ('API key', 'Signing secret'). */
  label: string;
  provider: string;
  credential: string;
  description: string;
  configured: boolean;
  updated_at: string | null;
  /** Set on rows still holding a pre-encryption plaintext value. */
  legacy_plaintext?: boolean;
  /** Provider slots only: the env var the same credential falls back to locally. */
  env?: string;
  docs_url?: string;
}

export interface VaultSection {
  group: VaultGroup;
  title: string;
  /** Owner subgroups, so a provider's credentials sit together under its name. */
  owners: Array<{ owner: string; ownerLabel: string; entries: VaultEntry[] }>;
}

const SECTION_TITLES: Record<VaultGroup, string> = {
  managed: 'Platform keys',
  provider: 'Provider credentials',
  shared: 'Shared secrets',
  unknown: 'Unrecognised entries',
};

const SECTION_ORDER: VaultGroup[] = ['managed', 'provider', 'shared', 'unknown'];

function groupEntries(entries: VaultEntry[]): VaultSection[] {
  const byGroup = new Map<VaultGroup, VaultEntry[]>();
  for (const entry of entries) {
    const list = byGroup.get(entry.group) ?? [];
    list.push(entry);
    byGroup.set(entry.group, list);
  }
  const sections: VaultSection[] = [];
  for (const group of SECTION_ORDER) {
    const list = byGroup.get(group);
    if (!list || list.length === 0) continue;
    const owners = new Map<string, { owner: string; ownerLabel: string; entries: VaultEntry[] }>();
    for (const entry of list) {
      const bucket = owners.get(entry.owner) ?? { owner: entry.owner, ownerLabel: entry.ownerLabel, entries: [] };
      bucket.entries.push(entry);
      owners.set(entry.owner, bucket);
    }
    sections.push({ group, title: SECTION_TITLES[group], owners: [...owners.values()] });
  }
  return sections;
}

function vaultPath(workspaceId: string, ...rest: string[]) {
  const suffix = rest.map(part => encodeURIComponent(part)).join('/');
  return `/backend/workspaces/${encodeURIComponent(workspaceId)}/vault${suffix ? `/${suffix}` : ''}`;
}

export function useWorkspaceVault(workspaceId: string | null) {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) { setEntries([]); return; }
    setLoading(true);
    try {
      const res = await fetch(apiUrl(vaultPath(workspaceId)), { headers: apiAuthHeaders() });
      const payload = await res.json().catch(() => null);
      if (Array.isArray(payload?.data)) {
        setEntries(payload.data as VaultEntry[]);
        setError(null);
      } else {
        setError(payload?.error?.message || 'Could not load the vault');
      }
    } catch {
      setError('Could not load the vault');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // A loose shared secret: the generic vault route, key charset [A-Za-z0-9_.-].
  const setSharedSecret = useCallback(async (key: string, value: string, description?: string): Promise<string | null> => {
    if (!workspaceId) return 'No workspace selected';
    const res = await fetch(apiUrl(vaultPath(workspaceId, key)), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({ value, description }),
    });
    const payload = await res.json().catch(() => null);
    await refresh();
    return res.ok ? null : (payload?.error?.message || 'Could not save that secret');
  }, [workspaceId, refresh]);

  const deleteSharedSecret = useCallback(async (key: string): Promise<void> => {
    if (!workspaceId) return;
    setEntries(prev => prev.filter(entry => entry.key !== key));
    await fetch(apiUrl(vaultPath(workspaceId, key)), { method: 'DELETE', headers: apiAuthHeaders() });
    await refresh();
  }, [workspaceId, refresh]);

  // A provider credential: its own route, because the key is namespaced
  // (`sandbox:<provider>:<credential>`) and the generic one cannot address it.
  const setProviderCredential = useCallback(async (
    provider: string,
    credential: string,
    value: string,
  ): Promise<string | null> => {
    if (!workspaceId) return 'No workspace selected';
    const res = await fetch(
      apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/sandbox-credentials/${encodeURIComponent(provider)}`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ credential, value }),
      },
    );
    const payload = await res.json().catch(() => null);
    await refresh();
    return res.ok ? null : (payload?.error?.message || 'Could not save that credential');
  }, [workspaceId, refresh]);

  const deleteProviderCredential = useCallback(async (provider: string, credential: string): Promise<void> => {
    if (!workspaceId) return;
    const search = new URLSearchParams({ credential });
    await fetch(
      apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/sandbox-credentials/${encodeURIComponent(provider)}?${search}`),
      { method: 'DELETE', headers: apiAuthHeaders() },
    );
    await refresh();
  }, [workspaceId, refresh]);

  const sections = useMemo(() => groupEntries(entries), [entries]);

  return {
    entries,
    sections,
    loading,
    error,
    refresh,
    setSharedSecret,
    deleteSharedSecret,
    setProviderCredential,
    deleteProviderCredential,
  };
}

export const __vaultTest = { groupEntries, SECTION_TITLES, SECTION_ORDER };
