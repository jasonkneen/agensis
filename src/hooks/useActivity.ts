import { useState, useEffect, useCallback, useRef } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { ActivityEvent, ActivityEventType, ChatSession } from '../types';
import {
  ACTIVITY_REDACTION_EVENT,
  redactActivityEvents,
  type ActivityRedactionTarget,
} from '../lib/activityRedaction';

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

  const deduper = useRealtimeDeduper();
  useTableSubscription<ActivityEvent>(
    {
      enabled: !!workspaceId,
      channelName: `activity:${workspaceId}`,
      table: 'activity_events',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'DELETE') {
        const id = payload.old?.id;
        if (id) setEvents(prev => prev.filter(event => event.id !== id));
        return;
      }
      const row = payload.new;
      if (!row) return;
      setEvents((prev) => {
        if (payload.eventType === 'UPDATE') {
          return prev.map(event => event.id === row.id ? row : event);
        }
        return prev.some(event => event.id === row.id) ? prev : [row, ...prev].slice(0, 100);
      });
    },
  );

  // Conversation clear emits one bounded chat_sessions invalidation instead of
  // one activity UPDATE per message. Evict every already-rendered source row.
  useTableSubscription<ChatSession>(
    {
      enabled: !!workspaceId,
      channelName: `activity-session-redaction:${workspaceId}`,
      table: 'chat_sessions',
      event: 'UPDATE',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      const session = payload.new;
      if (
        !session?.deleted_at
        && session?.visibility !== 'private'
        && session?.folder !== 'Direct messages'
      ) return;
      setEvents(prev => redactActivityEvents(prev, { sessionId: session.id }));
    },
  );

  // The Netlify mirror has no websocket server. The caller that performed a
  // delete evicts its own stale feed immediately; its next fetch sees the same
  // scrubbed database row.
  useEffect(() => {
    const redact = (event: Event) => {
      const detail = (event as CustomEvent<ActivityRedactionTarget>).detail;
      setEvents(prev => redactActivityEvents(prev, detail || {}));
    };
    window.addEventListener(ACTIVITY_REDACTION_EVENT, redact);
    return () => window.removeEventListener(ACTIVITY_REDACTION_EVENT, redact);
  }, []);

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
