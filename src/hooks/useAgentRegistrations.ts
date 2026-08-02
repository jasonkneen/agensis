import { useCallback, useEffect, useRef } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState } from './useWorkspaceState';

export interface AgentRegistration {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  requested_handle: string;
  requested_name: string;
  client_label: string;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
}

// Loads pending agent-registration requests and keeps them live over realtime, so the
// owner gets the "X wants to register as @q — Allow?" popup the moment a client asks.
export function useAgentRegistrations(workspaceId: string | null) {
  const [pending, setPending] = useWorkspaceListState<AgentRegistration>(workspaceId, []);
  const workspaceRequestRef = useRef({ workspaceId, generation: 0 });
  if (workspaceRequestRef.current.workspaceId !== workspaceId) {
    workspaceRequestRef.current = {
      workspaceId,
      generation: workspaceRequestRef.current.generation + 1,
    };
  }

  const refresh = useCallback(async () => {
    const request = workspaceRequestRef.current;
    const isCurrent = () => workspaceRequestRef.current === request;
    if (!workspaceId) { setPending([]); return; }
    try {
      const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/agent-registrations?status=pending`), { headers: apiAuthHeaders() });
      const body = await res.json().catch(() => null);
      if (isCurrent() && res.ok && body?.data?.registrations) setPending(body.data.registrations);
    } catch {
      // best effort — realtime keeps it fresh
    }
  }, [setPending, workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<AgentRegistration>(
    {
      enabled: !!workspaceId,
      channelName: `agent_registrations:${workspaceId}`,
      table: 'agent_registrations',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (workspaceRequestRef.current.workspaceId !== workspaceId) return;
      const rowWorkspaceId = payload.new?.workspace_id || payload.old?.workspace_id;
      if (rowWorkspaceId !== workspaceId) return;
      if (!deduper.shouldProcess(payload)) return;
      const row = payload.new || payload.old;
      if (!row) return;
      // A row is "pending" only while awaiting a decision; anything else leaves the list.
      const isPending = payload.eventType !== 'DELETE' && payload.new?.status === 'pending';
      setPending((prev) => {
        const without = prev.filter((r) => r.id !== row.id);
        return isPending && payload.new ? [payload.new, ...without] : without;
      });
    },
  );

  const decide = useCallback(async (id: string, action: 'approve' | 'deny') => {
    const request = workspaceRequestRef.current;
    // Optimistic: drop it from the list immediately.
    setPending((prev) => prev.filter((r) => r.id !== id));
    try {
      const response = await fetch(apiUrl(`/backend/agent-registrations/${encodeURIComponent(id)}/${action}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(`Registration decision failed (${response.status})`);
    } catch {
      if (workspaceRequestRef.current === request) void refresh(); // restore on failure
    }
  }, [refresh, setPending]);

  return { pending, approve: (id: string) => decide(id, 'approve'), deny: (id: string) => decide(id, 'deny'), refresh };
}
