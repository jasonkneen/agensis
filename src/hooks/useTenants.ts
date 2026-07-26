import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { TenantAccount, TenantAccountDetail, TenantListPayload } from '../lib/tenants';

// Data for the Tenants surface.
//
// `owner` comes from /backend/tenants/access rather than being inferred from
// the signed-in email client-side: the browser can be told anything, and the
// only answer worth rendering is the one the server would also enforce. Hiding
// the entry point is cosmetic — every route re-checks (shared/tenant-admin.cjs).

async function getJson<T>(path: string): Promise<{ data: T | null; status: number }> {
  const response = await fetch(apiUrl(path), { headers: apiAuthHeaders() });
  const payload = await response.json().catch(() => null);
  return { data: (payload?.data as T) ?? null, status: response.status };
}

/** Whether to offer the Tenants entry at all. Answered by the server. */
export function useTenantAccess(enabled: boolean) {
  const [owner, setOwner] = useState(false);

  useEffect(() => {
    if (!enabled) { setOwner(false); return; }
    let active = true;
    void getJson<{ owner: boolean }>('/backend/tenants/access')
      .then(({ data }) => { if (active) setOwner(Boolean(data?.owner)); })
      // A failed check is NOT ownership. Anything other than an explicit yes
      // leaves the surface hidden.
      .catch(() => { if (active) setOwner(false); });
    return () => { active = false; };
  }, [enabled]);

  return owner;
}

export function useTenants(enabled: boolean) {
  const [accounts, setAccounts] = useState<TenantAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data, status } = await getJson<TenantListPayload>('/backend/tenants');
      if (!data) {
        // Say which failure it was. "Nothing here" and "you are not allowed"
        // and "the server broke" are three different things to a reader.
        setError(status === 403 ? 'Not available for this account.' : 'Could not load accounts.');
        setAccounts([]);
        return;
      }
      setAccounts(data.accounts || []);
      setTotal(data.total ?? (data.accounts || []).length);
      setTruncated(Boolean(data.truncated));
    } catch {
      setError('Could not load accounts.');
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (enabled) void load(); }, [enabled, load]);

  return { accounts, total, truncated, loading, error, refetch: load };
}

export function useTenantDetail(accountId: string | null) {
  const [detail, setDetail] = useState<TenantAccountDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!accountId) { setDetail(null); return; }
    let active = true;
    setLoading(true);
    // Clear the previous account first: showing one tenant's workspaces under
    // another tenant's name, even for a frame, is the worst thing this surface
    // could do.
    setDetail(null);
    void getJson<TenantAccountDetail>(`/backend/tenants/${encodeURIComponent(accountId)}`)
      .then(({ data }) => { if (active) setDetail(data); })
      .catch(() => { if (active) setDetail(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [accountId]);

  return { detail, loading };
}
