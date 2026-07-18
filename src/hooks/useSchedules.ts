import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';

export interface AgentSchedule {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  session_id: string | null;
  created_by: string | null;
  name: string;
  prompt: string;
  interval_seconds: number;
  enabled: boolean;
  running: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string;
  run_count: number;
  fail_count: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduleInput {
  agentId: string;
  sessionId: string;
  name?: string;
  prompt?: string;
  intervalSeconds?: number;
  enabled?: boolean;
}

export function useSchedules(workspaceId: string | null) {
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId) { setSchedules([]); return; }
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/schedules`), { headers: apiAuthHeaders() });
      const payload = await res.json().catch(() => null);
      if (Array.isArray(payload?.data)) setSchedules(payload.data as AgentSchedule[]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<AgentSchedule>(
    {
      enabled: !!workspaceId,
      channelName: `agent_schedules:${workspaceId}`,
      table: 'agent_schedules',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
        const row = payload.new;
        if (!row) return;
        setSchedules(prev => {
          const exists = prev.some(s => s.id === row.id);
          return exists ? prev.map(s => s.id === row.id ? row : s) : [row, ...prev];
        });
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.id) return;
        setSchedules(prev => prev.filter(s => s.id !== row.id));
      }
    },
  );

  const createSchedule = useCallback(async (input: ScheduleInput): Promise<AgentSchedule | null> => {
    if (!workspaceId) return null;
    const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/schedules`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify(input),
    });
    const payload = await res.json().catch(() => null);
    const created = payload?.data as AgentSchedule | undefined;
    if (created) setSchedules(prev => prev.some(s => s.id === created.id) ? prev : [created, ...prev]);
    return created ?? null;
  }, [workspaceId]);

  const updateSchedule = useCallback(async (id: string, updates: Partial<ScheduleInput>): Promise<void> => {
    const res = await fetch(apiUrl(`/backend/schedules/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify(updates),
    });
    const payload = await res.json().catch(() => null);
    const row = payload?.data as AgentSchedule | undefined;
    if (row) setSchedules(prev => prev.map(s => s.id === id ? row : s));
  }, []);

  const runSchedule = useCallback(async (id: string): Promise<void> => {
    await fetch(apiUrl(`/backend/schedules/${encodeURIComponent(id)}/run`), { method: 'POST', headers: apiAuthHeaders() });
  }, []);

  const deleteSchedule = useCallback(async (id: string): Promise<void> => {
    setSchedules(prev => prev.filter(s => s.id !== id));
    await fetch(apiUrl(`/backend/schedules/${encodeURIComponent(id)}`), { method: 'DELETE', headers: apiAuthHeaders() });
  }, []);

  return { schedules, loading, refresh, createSchedule, updateSchedule, runSchedule, deleteSchedule };
}
