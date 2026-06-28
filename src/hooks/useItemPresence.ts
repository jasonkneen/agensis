import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backendClient } from '../lib/backendClient';
import type { FloatingWindow, ItemPresenceUser, WorkspaceInstanceShareMode } from '../types';

type RealtimeChannel = {
  on: <T>(type: 'broadcast', config: { event: string }, callback: (message: BroadcastPayload<T>) => void) => RealtimeChannel;
  subscribe: (callback?: (status: string) => void) => RealtimeChannel;
  unsubscribe: () => Promise<unknown>;
  send: (message: BroadcastSendMessage) => Promise<unknown>;
};

type BroadcastPayload<T> = { payload: T };
type BroadcastSendMessage = { type: 'broadcast'; event: string; payload: unknown };

interface PresenceSnapshotItem {
  type: 'chat' | 'document';
  itemId: string;
  typing?: boolean;
}

interface PresenceSnapshotPayload {
  userId: string;
  name: string;
  color: string;
  items: PresenceSnapshotItem[];
  windows?: FloatingWindow[];
  activeLayerId?: string;
  lastSeen: number;
}

interface RemotePresenceState {
  userId: string;
  name: string;
  color: string;
  items: PresenceSnapshotItem[];
  windows: FloatingWindow[];
  activeLayerId: string | null;
  lastSeen: number;
}

const COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  '#14b8a6', '#84cc16', '#f59e0b', '#6366f1',
];

function pickColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function useItemPresence(
  workspaceId: string | null,
  windows: FloatingWindow[],
  activeLayerId: string = 'base',
  userId?: string,
  userEmail?: string,
  shareMode: WorkspaceInstanceShareMode = 'all',
) {
  const [remotePresence, setRemotePresence] = useState<Record<string, RemotePresenceState>>({});
  const channelRef = useRef<RealtimeChannel | null>(null);
  const typingRef = useRef<Record<string, boolean>>({});
  const windowsRef = useRef<FloatingWindow[]>(windows);
  const heartbeatRef = useRef<number | null>(null);
  const displayName = userEmail?.split('@')[0] || 'Anonymous';
  const color = userId ? pickColor(userId) : '#3b82f6';

  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  const buildItems = useCallback((): PresenceSnapshotItem[] => {
    const seen = new Set<string>();
    const items: PresenceSnapshotItem[] = [];

    windowsRef.current
      .filter(win => !win.minimized)
      .forEach(win => {
        if (win.type === 'chat' && win.sessionId) {
          const key = `chat:${win.sessionId}`;
          if (seen.has(key)) return;
          seen.add(key);
          items.push({
            type: 'chat',
            itemId: win.sessionId,
            typing: !!typingRef.current[key],
          });
        }

        if (win.type === 'document' && win.documentId) {
          const key = `document:${win.documentId}`;
          if (seen.has(key)) return;
          seen.add(key);
          items.push({
            type: 'document',
            itemId: win.documentId,
            typing: !!typingRef.current[key],
          });
        }
      });

    return items;
  }, []);

  const buildSharedWindows = useCallback((): FloatingWindow[] => {
    if (shareMode === 'off') return [];

    return windowsRef.current
      .filter(win => !win.isPrivate)
      .filter(win => shareMode === 'all' || win.shared)
      .map(win => ({
        ...win,
        ownerUserId: userId || win.ownerUserId || null,
      }));
  }, [shareMode, userId]);

  const sendSnapshot = useCallback(() => {
    if (!channelRef.current || !userId) return;

    const payload: PresenceSnapshotPayload = {
      userId,
      name: displayName,
      color,
      items: buildItems(),
      windows: buildSharedWindows(),
      activeLayerId,
      lastSeen: Date.now(),
    };

    channelRef.current.send({
      type: 'broadcast',
      event: 'presence_snapshot',
      payload,
    });
  }, [activeLayerId, buildItems, buildSharedWindows, color, displayName, userId]);

  const pruneStaleUsers = useCallback(() => {
    const cutoff = Date.now() - 7000;
    setRemotePresence(prev => {
      const next = { ...prev };
      for (const [id, state] of Object.entries(next)) {
        if (state.lastSeen < cutoff) delete next[id];
      }
      return next;
    });
  }, []);

  const setTyping = useCallback((type: 'chat' | 'document', itemId: string, typing: boolean) => {
    const key = `${type}:${itemId}`;
    if (typing) typingRef.current[key] = true;
    else delete typingRef.current[key];
    sendSnapshot();
  }, [sendSnapshot]);

  useEffect(() => {
    if (!workspaceId || !userId) {
      setRemotePresence({});
      return;
    }

    const channel = backendClient.channel(`item-presence:${workspaceId}`);
    channelRef.current = channel;

    channel
      .on('broadcast', { event: 'presence_snapshot' }, ({ payload }: BroadcastPayload<PresenceSnapshotPayload>) => {
        const snapshot = payload;
        if (!snapshot.userId || snapshot.userId === userId) return;
        setRemotePresence(prev => ({
          ...prev,
          [snapshot.userId]: {
            userId: snapshot.userId,
            name: snapshot.name,
            color: snapshot.color,
            items: snapshot.items || [],
            windows: snapshot.windows || [],
            activeLayerId: snapshot.activeLayerId || null,
            lastSeen: snapshot.lastSeen || Date.now(),
          },
        }));
      })
      .on('broadcast', { event: 'presence_leave' }, ({ payload }: BroadcastPayload<{ userId?: string }>) => {
        const leavingId = payload.userId;
        if (!leavingId) return;
        setRemotePresence(prev => {
          const next = { ...prev };
          delete next[leavingId];
          return next;
        });
      })
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          sendSnapshot();
        }
      });

    const handleBeforeUnload = () => {
      channel.send({
        type: 'broadcast',
        event: 'presence_leave',
        payload: { userId },
      });
    };

    heartbeatRef.current = window.setInterval(() => {
      sendSnapshot();
      pruneStaleUsers();
    }, 2000);

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      handleBeforeUnload();
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [workspaceId, userId, sendSnapshot, pruneStaleUsers]);

  useEffect(() => {
    if (!workspaceId || !userId) return;
    sendSnapshot();
  }, [workspaceId, userId, windows, activeLayerId, sendSnapshot]);

  const { documentPresence, chatPresence, remotePresenceUsers, sharedWindows } = useMemo(() => {
    const documents: Record<string, ItemPresenceUser[]> = {};
    const chats: Record<string, ItemPresenceUser[]> = {};
    const users = Object.values(remotePresence);
    const remoteWindows = users.flatMap(remoteUser =>
      remoteUser.windows.map(win => ({
        ...win,
        id: `remote:${remoteUser.userId}:${win.id}`,
        ownerUserId: remoteUser.userId,
      }))
    );

    users.forEach(user => {
      user.items.forEach(item => {
        const target = item.type === 'document' ? documents : chats;
        if (!target[item.itemId]) target[item.itemId] = [];
        target[item.itemId].push({
          userId: user.userId,
          name: user.name,
          color: user.color,
          typing: !!item.typing,
        });
      });
    });

    return {
      documentPresence: documents,
      chatPresence: chats,
      remotePresenceUsers: users,
      sharedWindows: remoteWindows,
    };
  }, [remotePresence]);

  return {
    documentPresence,
    chatPresence,
    remotePresenceUsers,
    sharedWindows,
    setTyping,
  };
}
