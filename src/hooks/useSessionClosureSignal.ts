import { announceActivityRedaction } from '../lib/activityRedaction';
import { redactCachedSessionMessages } from '../lib/offlineBackend';
import type { ChatSession } from '../types';
import type { DbChangePayload } from '../types/realtime';
import { useRealtimeDeduper, useTableSubscription } from './useTableSubscription';

type SessionClosureRow = Pick<ChatSession, 'id' | 'deleted_at' | 'updated_at'>;

export function isSessionClosure(
  payload: DbChangePayload<SessionClosureRow>,
  sessionId: string | null,
): boolean {
  const row = payload.new;
  return payload.eventType === 'UPDATE'
    && Boolean(sessionId)
    && String(row?.id || '') === String(sessionId)
    && Boolean(row?.deleted_at);
}

/**
 * A chat_sessions UPDATE is the bounded logical close event. The backend sends
 * one scoped row per host/transcript session; consumers clear local and offline
 * message state instead of broadcasting every tombstoned message body.
 */
export function useSessionClosureSignal(
  sessionId: string | null,
  onClosed: (session: SessionClosureRow) => void,
): void {
  const deduper = useRealtimeDeduper();
  useTableSubscription<SessionClosureRow>(
    {
      enabled: Boolean(sessionId),
      channelName: `session-lifecycle:${sessionId || ''}`,
      table: 'chat_sessions',
      event: 'UPDATE',
      schema: 'public',
      filter: `id=eq.${sessionId || ''}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload) || !isSessionClosure(payload, sessionId)) return;
      const row = payload.new as SessionClosureRow;
      void redactCachedSessionMessages(row.id).catch(() => {});
      announceActivityRedaction({ sessionId: row.id });
      onClosed(row);
    },
  );
}
