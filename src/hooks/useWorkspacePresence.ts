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
  /**
   * What this person is looking at, as display strings — "Channel: general",
   * "Doc: Roadmap". Genuinely *activity*, and only ever populated for humans.
   *
   * It used to double as the agent metadata carrier: an agent's connection
   * kind, host and cwd were pre-formatted into this same array
   * ("Connected daemon", "Host: …", "Folder: /Users/…"), so the roster had no
   * way to tell "what they're doing" from "where their daemon runs" and
   * rendered all of it as one undifferentiated stack of chips — three per
   * agent, each truncating, four lines per participant. Connection metadata
   * now has its own fields below and is demoted out of the row entirely.
   */
  activityItems?: string[];
  windows?: FloatingWindow[];
  /** Raw agent id (unprefixed) — used to open/find the direct-message thread. */
  agentId?: string | null;
  /** Agent handle (without @) — fallback key for the direct-message thread. */
  handle?: string | null;
  /** Daemon host machine. Metadata: behind a disclosure, never on the row. */
  host?: string | null;
  /** Daemon working folder. Metadata: behind a disclosure, never on the row. */
  cwd?: string | null;
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
    // Agents are sourced from the DAEMON's connection rows, not from browser
    // presence — an agent never holds a cursor or a LiveKit session, so a
    // roster built from `cursors`/`remotePresenceUsers` alone shows an empty
    // room in a workspace full of working agents. `status` here is the daemon
    // heartbeat's view of liveness and is the only thing that decides whether
    // an agent is in the list at all.
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
          // Structured, NOT pre-formatted into `activityItems`. Where a daemon
          // runs is reference material you go looking for; it is not what the
          // agent is doing, and the roster row has no room for it.
          host: connection.host || null,
          cwd: connection.cwd || null,
          windows: [],
        });
      });
    return Array.from(byId.values());
  }, [agentConnections, agents, cursors, documents, remotePresenceUsers, sessions, user]);
}
