import { useCallback, useEffect } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { useWorkspaceListState } from './useWorkspaceState';
import type { StatusEvent } from '../lib/pm/reports';

// The recorded status changes for one workspace's tasks, read once for the cumulative flow
// report. A database trigger writes them, so this hook only reads, and it loads on demand
// (when the report opens) rather than staying subscribed.

export function useTaskStatusEvents(workspaceId: string | null, enabled = true) {
  const [events, setEvents, beginRequest] = useWorkspaceListState<StatusEvent>(workspaceId, []);

  const fetchEvents = useCallback(async () => {
    const isCurrent = beginRequest();
    if (!workspaceId) {
      setEvents([]);
      return;
    }
    const data = await cachedFetch<StatusEvent[]>(`task_status_events_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('task_status_events')
        .select('task_id,from_status,to_status,changed_at')
        .eq('workspace_id', workspaceId)
        .order('changed_at', { ascending: true });
      return data;
    });
    if (isCurrent() && data) setEvents(data);
  }, [beginRequest, setEvents, workspaceId]);

  useEffect(() => {
    if (enabled) void fetchEvents();
  }, [enabled, fetchEvents]);

  return { events, refetch: fetchEvents };
}
