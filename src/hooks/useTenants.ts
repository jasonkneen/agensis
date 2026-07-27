import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { TenantAccount, TenantAccountDetail, TenantListPayload } from '../lib/tenants';
import type { TenantMeteringWindow } from '../lib/tenantStats';

// ---------------------------------------------------------------------------
// Data for the owner-only Tenants surface.
//
// NOT cached (no `cachedFetch`, no offline mirror) and NOT subscribed to
// realtime. Both are deliberate: this is every account on the deployment, and
// stashing that in an IndexedDB mirror on the operator's machine — where it
// would outlive the session and the window — is a liability for no benefit on a
// surface that is opened deliberately and read once.
//
// Authorization is the SERVER's. `useTenantAccess` exists so the rail can hide
// a button the user cannot use, and its answer is advisory — it comes from an
// endpoint that reports on the caller alone, and every data route re-checks.
// A client that lied to itself here would gain nothing but a 403.
// ---------------------------------------------------------------------------

interface TenantAccessResult {
  /** True only when the SERVER says this session belongs to the system owner. */
  isOwner: boolean;
  /** False until the probe has answered — the rail renders nothing until then. */
  checked: boolean;
}

/**
 * Distinguishes the three failures a reader needs told apart: "you are not
 * allowed", "nothing came back", and "the request never landed". A 403 here is
 * not an error state to debug — it is the server enforcing the gate, which it
 * does whatever the client believed about who is signed in.
 */
async function getJson<T>(path: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(apiUrl(path), { headers: apiAuthHeaders() });
    const payload = await response.json().catch(() => null);
    if (response.status === 403) return { data: null, error: 'Not available for this account.' };
    if (!response.ok) {
      return { data: null, error: payload?.error?.message || `HTTP ${response.status}` };
    }
    return { data: (payload?.data ?? null) as T | null, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'Network error' };
  }
}

/**
 * Whether to offer the Tenants entry at all. One request per session per
 * signed-in user; `userId` in the dependency list so switching account
 * re-asks rather than carrying the previous answer over.
 */
export function useTenantAccess(userId: string | null | undefined): TenantAccessResult {
  const [state, setState] = useState<TenantAccessResult>({ isOwner: false, checked: false });

  useEffect(() => {
    if (!userId) {
      setState({ isOwner: false, checked: true });
      return;
    }
    let cancelled = false;
    setState({ isOwner: false, checked: false });
    void getJson<{ owner?: boolean }>('/backend/tenants/access').then(({ data }) => {
      if (cancelled) return;
      setState({ isOwner: data?.owner === true, checked: true });
    });
    return () => { cancelled = true; };
  }, [userId]);

  return state;
}

export interface UseTenantsResult {
  accounts: TenantAccount[];
  total: number;
  /** The route capped the list — the UI says so rather than under-reporting. */
  truncated: boolean;
  /**
   * When cost metering began, straight from the server. Null until the list
   * lands, and null FOREVER on a deployment where metering never started — the
   * UI must render that as "not recording", never as zero spend.
   */
  metering: TenantMeteringWindow | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** The account whose detail is open, or null. */
  detail: TenantAccountDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  selectedId: string | null;
  select: (accountId: string | null) => void;
}

export function useTenants(enabled: boolean): UseTenantsResult {
  const [accounts, setAccounts] = useState<TenantAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [metering, setMetering] = useState<TenantMeteringWindow | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TenantAccountDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [reloadToken, setReloadToken] = useState(0);
  const refetch = useCallback(() => setReloadToken(token => token + 1), []);

  useEffect(() => {
    if (!enabled) {
      setAccounts([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getJson<TenantListPayload>('/backend/tenants').then(({ data, error: failure }) => {
      if (cancelled) return;
      setAccounts(Array.isArray(data?.accounts) ? data.accounts : []);
      setTotal(typeof data?.total === 'number' ? data.total : 0);
      setTruncated(data?.truncated === true);
      setMetering(data?.metering ?? null);
      setError(failure);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [enabled, reloadToken]);

  // The detail pane is fetched per selection rather than derived from the list
  // row: the list carries counts, the pane carries the workspaces behind them,
  // and loading every account's workspaces up front would mean reading the whole
  // deployment to render one column.
  //
  // A stale response must never land in a pane the user has moved on from, so
  // the in-flight selection is tracked by ref and a mismatched reply is dropped.
  const wantedRef = useRef<string | null>(null);
  useEffect(() => {
    wantedRef.current = selectedId;
    if (!enabled || !selectedId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    // Clear the OUTGOING account's detail before fetching the next one. Showing
    // one tenant's workspaces under another tenant's name, even for a frame, is
    // the worst thing this surface could do.
    setDetail(null);
    void getJson<TenantAccountDetail>(`/backend/tenants/${encodeURIComponent(selectedId)}`)
      .then(({ data, error: failure }) => {
        if (cancelled || wantedRef.current !== selectedId) return;
        setDetail(data ?? null);
        setDetailError(failure || (data ? null : 'That account could not be loaded.'));
        setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [enabled, selectedId, reloadToken]);

  const select = useCallback((accountId: string | null) => setSelectedId(accountId), []);

  return {
    accounts, total, truncated, metering, loading, error, refetch,
    detail, detailLoading, detailError, selectedId, select,
  };
}
