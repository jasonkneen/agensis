import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { AuditEntry } from '../types';

// The audit log, as the browser sees it: READ-ONLY, ON DEMAND, MANAGE-GATED.
//
// Deliberately NOT a useTableSubscription. Every other list in this app is live
// over realtime db_changes; this one must not be. Audit rows say who changed
// whose role and which vault key was written, and a realtime binding would fan
// that at every subscribed browser holding the channel. The server refuses such
// a subscription outright (audit_log is absent from the client table allowlist,
// so the subscribe is rejected before authorization is even consulted), so this
// hook could not stream even if it tried — it fetches.
//
// Paging is KEYSET, not offset: the table only grows, and `before` is simply the
// created_at of the last row already held, with the id breaking ties.

/** Matches the server's clamp. Asking for more than this just returns 200. */
const AUDIT_PAGE_SIZE = 50;

interface AuditResponse {
  data?: AuditEntry[] | null;
  error?: { message?: string } | string | null;
}

function errorMessage(body: AuditResponse | null, status: number): string {
  const raw = typeof body?.error === 'string' ? body.error : body?.error?.message;
  if (raw) return raw;
  if (status === 403) return 'You need the manage role on this workspace to read its audit log.';
  if (status === 401) return 'Sign in again to read the audit log.';
  return `Could not load the audit log (${status}).`;
}

export function useAuditLog(workspaceId: string | null, action: string = '') {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Guards a late response from a previous workspace/filter overwriting a newer
  // one — the two requests are independent fetches with no ordering guarantee.
  const requestRef = useRef(0);

  const fetchPage = useCallback(async (cursor: AuditEntry | null) => {
    if (!workspaceId) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (cursor) setLoadingMore(true); else setLoading(true);

    try {
      const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
      if (action) params.set('action', action);
      if (cursor) {
        params.set('before', cursor.created_at);
        params.set('beforeId', cursor.id);
      }
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/audit?${params.toString()}`),
        { headers: apiAuthHeaders() },
      );
      const body: AuditResponse | null = await response.json().catch(() => null);
      if (requestRef.current !== requestId) return;

      if (!response.ok) {
        setError(errorMessage(body, response.status));
        if (!cursor) setEntries([]);
        setHasMore(false);
        return;
      }
      const rows = Array.isArray(body?.data) ? body.data : [];
      setError(null);
      setEntries(previous => (cursor ? [...previous, ...rows] : rows));
      // A short page means the end. A full page only means there MIGHT be more.
      setHasMore(rows.length === AUDIT_PAGE_SIZE);
    } catch {
      if (requestRef.current !== requestId) return;
      setError('Could not reach the server.');
      setHasMore(false);
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [workspaceId, action]);

  useEffect(() => {
    if (!workspaceId) {
      setEntries([]);
      setError(null);
      setHasMore(false);
      return;
    }
    void fetchPage(null);
  }, [workspaceId, action, fetchPage]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    void fetchPage(entries[entries.length - 1] ?? null);
  }, [entries, fetchPage, hasMore, loadingMore]);

  const refresh = useCallback(() => { void fetchPage(null); }, [fetchPage]);

  return { entries, loading, loadingMore, error, hasMore, loadMore, refresh };
}
