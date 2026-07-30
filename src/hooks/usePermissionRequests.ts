import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { tableRealtimeManager } from '../lib/realtimeManager';
import type { PermissionRequest, PermissionScope } from '../types';
import type { DbChangePayload } from '../types/realtime';

/**
 * Tool-approval requests raised by this workspace's daemon agents.
 *
 * Loaded once through the route (which returns only what is still pending and
 * unexpired) and then kept live over the same realtime db_changes subscription
 * every other table uses. The realtime row is the RAW database shape, not the
 * route's camelCase view, so it is normalised on arrival — otherwise a card
 * would render from `tool_name` on first paint and `toolName` after the first
 * update, and half its fields would blank out.
 */
type PermissionRequestRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  job_id?: string | null;
  session_id?: string | null;
  message_id?: string | null;
  tool_name?: string | null;
  tool_detail?: string | null;
  title?: string | null;
  description?: string | null;
  rules?: string[] | null;
  scopes?: string[] | null;
  status?: string | null;
  scope?: string | null;
  decided_by?: string | null;
  decided_by_name?: string | null;
  decided_at?: string | null;
  expires_at?: string | null;
  created_at?: string | null;
};

function fromRow(row: PermissionRequestRow): PermissionRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    jobId: row.job_id ?? null,
    sessionId: row.session_id ?? null,
    messageId: row.message_id ?? null,
    toolName: row.tool_name ?? '',
    toolDetail: row.tool_detail ?? '',
    title: row.title ?? '',
    description: row.description ?? '',
    rules: Array.isArray(row.rules) ? row.rules : [],
    scopes: (Array.isArray(row.scopes) ? row.scopes : []) as PermissionScope[],
    status: (row.status ?? 'pending') as PermissionRequest['status'],
    scope: (row.scope ?? '') as PermissionRequest['scope'],
    decidedBy: row.decided_by ?? null,
    decidedByName: row.decided_by_name ?? '',
    decidedAt: row.decided_at ?? null,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at ?? null,
  };
}

export interface DecideResult {
  request: PermissionRequest | null;
  error: string;
}

export function usePermissionRequests(workspaceId: string | null) {
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>('');

  const load = useCallback(async () => {
    if (!workspaceId) {
      setRequests([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/permission-requests`),
        { headers: apiAuthHeaders() },
      );
      const payload = await response.json();
      setRequests(response.ok && !payload.error ? (payload.data as PermissionRequest[]) : []);
    } catch {
      setRequests([]);
    }
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!workspaceId) return;
    return tableRealtimeManager.subscribe(
      {
        table: 'agent_permission_requests',
        filter: `workspace_id=eq.${workspaceId}`,
        channelName: `permission-requests:${workspaceId}`,
      },
      (payload: DbChangePayload<PermissionRequestRow>) => {
        const row = (payload.new ?? payload.old) as PermissionRequestRow | undefined;
        if (!row?.id) return;
        const request = fromRow(row);
        setRequests(prev => {
          const rest = prev.filter(entry => entry.id !== request.id);
          // Settled requests stay in the list rather than vanishing: the card
          // in the transcript reads its outcome from here, and dropping the row
          // the moment it is answered would flip the card back to a bare
          // sentence the instant someone clicked it.
          return [request, ...rest];
        });
      },
    );
  }, [workspaceId]);

  const byId = useMemo(() => {
    const map = new Map<string, PermissionRequest>();
    for (const request of requests) map.set(request.id, request);
    return map;
  }, [requests]);

  const pendingCount = useMemo(
    () => requests.filter(request => request.status === 'pending').length,
    [requests],
  );

  /**
   * Answer a request.
   *
   * Goes through the dedicated route, never a generic table update: the server
   * has to push the answer to the daemon holding the turn open, and it refuses
   * the whole decision if that push fails. A row flipped straight to 'allowed'
   * would show "Approved" over a tool call that never ran.
   */
  const decide = useCallback(async (
    requestId: string,
    behavior: 'allow' | 'deny',
    scope: PermissionScope = 'once',
  ): Promise<DecideResult> => {
    if (!workspaceId) return { request: null, error: 'No workspace' };
    setBusyId(requestId);
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/permission-requests/${requestId}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({ behavior, scope }),
        },
      );
      const payload = await response.json();
      if (!response.ok || payload.error) {
        return { request: null, error: String(payload.error || 'Could not record that decision') };
      }
      const request = payload.data as PermissionRequest;
      setRequests(prev => prev.map(entry => (entry.id === request.id ? request : entry)));
      return { request, error: '' };
    } catch (error) {
      return { request: null, error: error instanceof Error ? error.message : 'Could not record that decision' };
    } finally {
      setBusyId('');
    }
  }, [workspaceId]);

  return { requests, byId, pendingCount, loading, busyId, decide, reload: load };
}
