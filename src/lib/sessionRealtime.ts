import { isHuddleSession } from './huddleTranscript';
import type { ChatSession, FloatingWindow } from '../types';
import type { DbChangePayload } from '../types/realtime';

export interface SessionReconciliation {
  sessions: ChatSession[];
  closedSessionId: string | null;
  row: ChatSession | null;
}

export function reconcileWorkspaceSessions(
  current: ChatSession[],
  payload: DbChangePayload<ChatSession>,
  workspaceId: string | null,
): SessionReconciliation {
  const row = (payload.new || payload.old) as ChatSession | undefined;
  if (!row?.id || String(row.workspace_id || '') !== String(workspaceId || '')) {
    return { sessions: current, closedSessionId: null, row: null };
  }
  if (payload.eventType === 'DELETE' || row.deleted_at) {
    return {
      sessions: current.filter(session => session.id !== row.id),
      closedSessionId: String(row.id),
      row,
    };
  }
  if (row.parent_message_id || isHuddleSession(row)) {
    return { sessions: current, closedSessionId: null, row };
  }
  const next = current.some(session => session.id === row.id)
    ? current.map(session => session.id === row.id ? { ...session, ...row } : session)
    : [row, ...current];
  next.sort((a, b) =>
    String(b.updated_at || b.created_at || '').localeCompare(
      String(a.updated_at || a.created_at || ''),
    ));
  return { sessions: next, closedSessionId: null, row };
}

export function windowsClosedWithSessions(
  windows: FloatingWindow[],
  closedSessionIds: readonly string[],
): string[] {
  if (closedSessionIds.length === 0) return [];
  const closed = new Set(closedSessionIds);
  return windows
    .filter(window => Boolean(window.sessionId) && closed.has(String(window.sessionId)))
    .map(window => window.id);
}
