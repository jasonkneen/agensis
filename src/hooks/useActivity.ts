import { useState, useEffect, useCallback, useRef } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import type { ActivityEvent, ActivityEventType } from '../types';
import type { DbChangePayload } from '../types/realtime';

export interface LogEventInput {
  event_type: ActivityEventType;
  title: string;
  entity_type?: string;
  entity_id?: string;
  metadata?: Record<string, unknown>;
}

export function useActivity(workspaceId: string | null, userId?: string) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const loggedKeysRef = useRef<Set<string>>(new Set());

  const fetchEvents = useCallback(async () => {
    if (!workspaceId) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<ActivityEvent[]>(`activity_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('activity_events')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(100);
      return data;
    });
    if (data) setEvents(data);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    if (!workspaceId) return;
    const channel = backendClient
      .channel(`activity:${workspaceId}`)
      .on(
        'db_changes',
        { event: 'INSERT', schema: 'public', table: 'activity_events', filter: `workspace_id=eq.${workspaceId}` },
        (payload: DbChangePayload<ActivityEvent>) => {
          const row = payload.new;
          if (!row) return;
          setEvents(prev => prev.some(e => e.id === row.id) ? prev : [row, ...prev].slice(0, 100));
        },
      )
      .subscribe();
    return () => {
      backendClient.removeChannel(channel);
    };
  }, [workspaceId]);

  const logEvent = useCallback(async (input: LogEventInput) => {
    if (!workspaceId || !navigator.onLine) return;
    // dedupe rapid identical events within this session
    const key = `${input.event_type}:${input.entity_id ?? ''}:${input.title}`;
    if (loggedKeysRef.current.has(key)) return;
    loggedKeysRef.current.add(key);
    setTimeout(() => loggedKeysRef.current.delete(key), 2000);

    await backendClient.from('activity_events').insert({
      workspace_id: workspaceId,
      user_id: userId ?? null,
      event_type: input.event_type,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      title: input.title,
      metadata: input.metadata ?? {},
    });
  }, [workspaceId, userId]);

  return {
    events,
    loading,
    logEvent,
    refetch: fetchEvents,
  };
}
