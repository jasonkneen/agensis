import { useMemo } from 'react';
import type { AgentConnection, ChatSession, Document, FloatingWindow, WorkspaceAgent } from '../types';
import type { CursorPresence } from './useMultiplayerCursors';
import type { useItemPresence } from './useItemPresence';

export type WorkspacePresenceUser = {
  id: string;
  name: string;
  color: string;
  kind?: 'user' | 'agent';
  status?: string;
  isCurrentUser?: boolean;
  activityItems?: string[];
  windows?: FloatingWindow[];
  /** Raw agent id (unprefixed) — used to open/find the direct-message thread. */
  agentId?: string | null;
  /** Agent handle (without @) — fallback key for the direct-message thread. */
  handle?: string | null;
};

type RemotePresenceUsers = ReturnType<typeof useItemPresence>['remotePresenceUsers'];

export function colorFromSeed(seed: string): string {
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

export function windowLabel(win: FloatingWindow): string {
  if (win.type === 'chat') return `Channel: ${win.title}`;
  if (win.type === 'document') return `Doc: ${win.title}`;
  if (win.type === 'memory') return 'Memory';
  if (win.type === 'tasks') return 'Tasks';
  if (win.type === 'activity') return 'Activity';
  if (win.type === 'agents') return 'AI Agents';
  return win.title;
}

interface WorkspacePresenceInputs {
  user: { id: string; email?: string | null } | null;
  cursors: CursorPresence[];
  remotePresenceUsers: RemotePresenceUsers;
  documents: Document[];
  sessions: ChatSession[];
  agentConnections: AgentConnection[];
  agents: WorkspaceAgent[];
}

export function useWorkspacePresence({
  user,
  cursors,
  remotePresenceUsers,
  documents,
  sessions,
  agentConnections,
  agents,
}: WorkspacePresenceInputs): WorkspacePresenceUser[] {
  return useMemo<WorkspacePresenceUser[]>(() => {
    const byId = new Map<string, WorkspacePresenceUser>();
    if (user) {
      byId.set(user.id, {
        id: user.id,
        name: user.email?.split('@')[0] || 'You',
        color: colorFromSeed(user.id),
        isCurrentUser: true,
      });
    }
    cursors.forEach(cursor => {
      if (!byId.has(cursor.id)) {
        byId.set(cursor.id, {
          id: cursor.id,
          name: cursor.name,
          color: cursor.color,
          isCurrentUser: false,
        });
      }
    });
    remotePresenceUsers.forEach(remote => {
      const existing = byId.get(remote.userId);
      const visibleWindows = remote.windows.filter(win => !win.isPrivate);
      const activityItems = remote.items
        .map(item => {
          if (item.type === 'document') {
            const doc = documents.find(d => d.id === item.itemId);
            return doc ? `Doc: ${doc.title}` : 'Document';
          }
          const session = sessions.find(s => s.id === item.itemId);
          return session ? `Channel: ${session.title}` : 'Channel';
        })
        .slice(0, 4);
      byId.set(remote.userId, {
        id: remote.userId,
        name: existing?.name || remote.name,
        color: existing?.color || remote.color,
        isCurrentUser: existing?.isCurrentUser,
        activityItems: activityItems.length > 0 ? activityItems : visibleWindows.slice(0, 4).map(win => windowLabel(win)),
        windows: visibleWindows,
      });
    });
    agentConnections
      .filter(connection => connection.status !== 'offline')
      .forEach(connection => {
        const agent = agents.find(item => item.id === connection.agent_id);
        const id = `agent:${connection.agent_id || connection.id}`;
        byId.set(id, {
          id,
          name: agent?.name || connection.name || connection.handle,
          color: colorFromSeed(id),
          kind: 'agent',
          status: connection.status,
          agentId: connection.agent_id || null,
          handle: connection.handle || null,
          activityItems: [
            connection.status === 'busy' ? 'Running a job' : 'Connected daemon',
            connection.host ? `Host: ${connection.host}` : '',
            connection.cwd ? `Folder: ${connection.cwd}` : '',
          ].filter(Boolean).slice(0, 3),
          windows: [],
        });
      });
    return Array.from(byId.values());
  }, [agentConnections, agents, cursors, documents, remotePresenceUsers, sessions, user]);
}
