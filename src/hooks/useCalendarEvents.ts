import { useCallback, useEffect } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineDelete, offlineInsert } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState } from './useWorkspaceState';

// Calendar events for one workspace: loaded, kept live over realtime, and created
// or deleted through the same offline-aware path tasks use. Events are not tasks;
// they only appear in the Calendar view.

export interface CalendarEvent {
  id: string;
  workspace_id: string;
  created_by: string | null;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateCalendarEventInput {
  title: string;
  starts_at: string;
  ends_at?: string | null;
  all_day?: boolean;
  description?: string;
}

export function useCalendarEvents(workspaceId: string | null, userId?: string) {
  const [events, setEvents, beginRequest] = useWorkspaceListState<CalendarEvent>(workspaceId, []);

  const fetchEvents = useCallback(async () => {
    const isCurrent = beginRequest();
    if (!workspaceId) {
      setEvents([]);
      return;
    }
    const data = await cachedFetch<CalendarEvent[]>(`calendar_events_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('calendar_events')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('starts_at', { ascending: true });
      return data;
    });
    if (isCurrent() && data) setEvents(data);
  }, [beginRequest, setEvents, workspaceId]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<CalendarEvent>(
    {
      enabled: !!workspaceId,
      channelName: `calendar_events:${workspaceId}`,
      table: 'calendar_events',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    payload => {
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT' && payload.new) {
        const row = payload.new;
        setEvents(prev => (prev.some(e => e.id === row.id) ? prev : [...prev, row]));
      } else if (payload.eventType === 'UPDATE' && payload.new) {
        const row = payload.new;
        setEvents(prev => prev.map(e => (e.id === row.id ? row : e)));
      } else if (payload.eventType === 'DELETE' && payload.old?.id) {
        const id = payload.old.id;
        setEvents(prev => prev.filter(e => e.id !== id));
      }
    },
  );

  const createEvent = useCallback(
    async (input: CreateCalendarEventInput) => {
      if (!workspaceId) return null;
      const data = await offlineInsert(
        'calendar_events',
        {
          workspace_id: workspaceId,
          created_by: userId ?? null,
          title: input.title,
          description: input.description ?? '',
          starts_at: input.starts_at,
          ends_at: input.ends_at ?? null,
          all_day: input.all_day ?? false,
        },
        `calendar_events_${workspaceId}`,
      );
      if (data) {
        const event = data as unknown as CalendarEvent;
        setEvents(prev => (prev.some(e => e.id === event.id) ? prev : [...prev, event]));
      }
      return data;
    },
    [setEvents, userId, workspaceId],
  );

  const deleteEvent = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      try {
        const deleted = await offlineDelete('calendar_events', id, `calendar_events_${workspaceId}`);
        if (deleted) setEvents(prev => prev.filter(e => e.id !== id));
      } catch {
        // Keep the event visible if the delete could not be saved.
      }
    },
    [setEvents, workspaceId],
  );

  return { events, createEvent, deleteEvent, refetch: fetchEvents };
}
