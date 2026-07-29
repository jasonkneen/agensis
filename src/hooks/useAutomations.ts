import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';

// Workspace automations, as the browser sees them.
//
// Three states this hook has to tell apart, because they mean very different
// things to a person looking at an empty list:
//
//   unavailable  the routes 404 — automations are not switched on for this
//                deployment (AGENSIS_AUTOMATIONS). Nothing is wrong; the feature
//                is off. The window says so instead of showing an empty list
//                that implies "you have none".
//   forbidden    a write returned 403 — the caller is not an admin. Authoring an
//                automation is manage-level because it is a standing grant to
//                act without a human.
//   empty        the workspace genuinely has no automations yet.
//
// There is no client-side role model in this codebase — the server is the
// authority and the client learns its role from a 403. So this hook does NOT
// guess whether the user can write; it reports what the server said.

export interface AutomationCondition {
  field: string;
  op: string;
  value?: string;
}

export interface AutomationStep {
  action: string;
  channelId?: string;
  text?: string;
}

export interface AutomationDefinition {
  version: number;
  trigger: { event: string };
  when: AutomationCondition[];
  steps: AutomationStep[];
}

export interface Automation {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger_event: string;
  definition: AutomationDefinition;
  definition_yaml: string;
  created_by: string | null;
  run_count: number;
  fail_count: number;
  last_run_at: string | null;
  last_status: string;
  /** Non-empty when the runaway guard switched this off. */
  disabled_reason: string;
  created_at: string;
  updated_at: string;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  workspace_id: string;
  event_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  steps: Array<{ action: string; ok: boolean; error?: string; messageId?: string | null }>;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ApiResponse<T> {
  data?: T | null;
  error?: { message?: string } | string | null;
}

function messageFrom(body: ApiResponse<unknown> | null, status: number, fallback: string): string {
  const raw = typeof body?.error === 'string' ? body.error : body?.error?.message;
  if (raw) return raw;
  if (status === 403) return 'Only workspace admins can change automations.';
  return fallback;
}

export function useAutomations(workspaceId: string | null) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(false);
  /** The feature is not switched on for this deployment. */
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setAutomations([]);
      setRuns([]);
      setUnavailable(false);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    try {
      const [listRes, runsRes] = await Promise.all([
        fetch(apiUrl(`/backend/workspaces/${workspaceId}/automations`), { headers: apiAuthHeaders() }),
        fetch(apiUrl(`/backend/workspaces/${workspaceId}/automation-runs?limit=50`), { headers: apiAuthHeaders() }),
      ]);
      if (requestRef.current !== requestId) return;

      if (listRes.status === 404) {
        // The routes are behind AGENSIS_AUTOMATIONS. A 404 is "off", not "broken".
        setAutomations([]);
        setRuns([]);
        setUnavailable(true);
        setError(null);
        return;
      }
      setUnavailable(false);

      if (!listRes.ok) {
        const body: ApiResponse<Automation[]> | null = await listRes.json().catch(() => null);
        setError(messageFrom(body, listRes.status, 'Could not load automations.'));
        setAutomations([]);
        return;
      }
      const listBody: ApiResponse<Automation[]> | null = await listRes.json().catch(() => null);
      setAutomations(Array.isArray(listBody?.data) ? listBody.data : []);
      setError(null);

      if (runsRes.ok) {
        const runsBody: ApiResponse<AutomationRun[]> | null = await runsRes.json().catch(() => null);
        setRuns(Array.isArray(runsBody?.data) ? runsBody.data : []);
      } else {
        setRuns([]);
      }
    } catch {
      if (requestRef.current !== requestId) return;
      setError('Could not reach the server.');
      setAutomations([]);
      setRuns([]);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Returns null on success, or the message to show. */
  const createAutomation = useCallback(async (input: {
    name: string;
    description?: string;
    definition: AutomationDefinition;
    enabled?: boolean;
  }): Promise<string | null> => {
    if (!workspaceId) return 'No workspace selected.';
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${workspaceId}/automations`), {
        method: 'POST',
        headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body: ApiResponse<Automation> | null = await response.json().catch(() => null);
      if (!response.ok) return messageFrom(body, response.status, 'Could not create the automation.');
      if (body?.data) setAutomations(prev => [body.data as Automation, ...prev]);
      return null;
    } catch {
      return 'Could not reach the server.';
    }
  }, [workspaceId]);

  const setEnabled = useCallback(async (id: string, enabled: boolean): Promise<string | null> => {
    if (!workspaceId) return 'No workspace selected.';
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${workspaceId}/automations/${id}`), {
        method: 'PATCH',
        headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body: ApiResponse<Automation> | null = await response.json().catch(() => null);
      if (!response.ok) return messageFrom(body, response.status, 'Could not change the automation.');
      if (body?.data) {
        const updated = body.data as Automation;
        setAutomations(prev => prev.map(entry => (entry.id === id ? updated : entry)));
      }
      return null;
    } catch {
      return 'Could not reach the server.';
    }
  }, [workspaceId]);

  const deleteAutomation = useCallback(async (id: string): Promise<string | null> => {
    if (!workspaceId) return 'No workspace selected.';
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${workspaceId}/automations/${id}`), {
        method: 'DELETE',
        headers: apiAuthHeaders(),
      });
      if (!response.ok) {
        const body: ApiResponse<unknown> | null = await response.json().catch(() => null);
        return messageFrom(body, response.status, 'Could not delete the automation.');
      }
      setAutomations(prev => prev.filter(entry => entry.id !== id));
      return null;
    } catch {
      return 'Could not reach the server.';
    }
  }, [workspaceId]);

  return {
    automations, runs, loading, unavailable, error,
    refresh, createAutomation, setEnabled, deleteAutomation,
  };
}
