import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { backendClient } from '../lib/backendClient';
import type { RealtimeChannel, BroadcastPayload } from '../types/realtime';

export interface CursorPresence {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  lastSeen: number;
}

const CURSOR_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#0ea5e9', '#ec4899',
  '#14b8a6', '#f59e0b', '#0d9488', '#84cc16',
];

function pickColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

export function useMultiplayerCursors(
  workspaceId: string | null,
  canvasRef: React.RefObject<HTMLElement | null>,
  userId?: string,
  userEmail?: string
) {
  const [cursors, setCursors] = useState<CursorPresence[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const throttleRef = useRef(0);
  const cleanupTimerRef = useRef<number | null>(null);
  const displayName = useMemo(() => userEmail?.split('@')[0] || 'Anonymous', [userEmail]);
  const color = useMemo(() => userId ? pickColor(userId) : '#3b82f6', [userId]);
  const pendingRef = useRef<Map<string, CursorPresence>>(new Map());
  const rafRef = useRef<number | null>(null);
  const hasPeersRef = useRef(false);

  const flushPending = useCallback(() => {
    rafRef.current = null;
    const pending = pendingRef.current;
    if (pending.size === 0) return;
    pendingRef.current = new Map();
    setCursors(prev => {
      const next = prev.filter(item => !pending.has(item.id));
      pending.forEach(cursor => next.push(cursor));
      hasPeersRef.current = next.length > 0;
      return next;
    });
  }, []);

  const upsertCursor = useCallback((cursor: CursorPresence) => {
    if (!userId || cursor.id === userId) return;
    hasPeersRef.current = true;
    pendingRef.current.set(cursor.id, cursor);
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushPending);
  }, [userId, flushPending]);

  const pruneStaleCursors = useCallback(() => {
    const cutoff = Date.now() - 5000;
    setCursors(prev => {
      const next = prev.filter(cursor => cursor.lastSeen >= cutoff);
      if (next.length === prev.length) return prev;
      hasPeersRef.current = next.length > 0;
      return next;
    });
  }, []);

  const sendCursor = useCallback((x: number, y: number) => {
    const channel = channelRef.current;
    if (!channel || !userId) return;

    const now = Date.now();
    channel.send({
      type: 'broadcast',
      event: 'cursor_move',
      payload: {
        id: userId,
        name: displayName,
        color,
        x,
        y,
        lastSeen: now,
      },
    });
  }, [userId, displayName, color]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!canvasRef.current || !userId) return;
    if (!hasPeersRef.current) return;

    const now = Date.now();
    if (now - throttleRef.current < 80) return;
    throttleRef.current = now;

    const rect = canvasRef.current.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) return;

    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    sendCursor(x, y);
  }, [canvasRef, userId, sendCursor]);

  useEffect(() => {
    if (!workspaceId || !userId) return;

    const channel = backendClient.channel(`cursors:${workspaceId}`);

    channel
      .on('broadcast', { event: 'cursor_move' }, ({ payload }: BroadcastPayload<CursorPresence>) => {
        upsertCursor(payload);
      })
      .on('broadcast', { event: 'cursor_leave' }, ({ payload }: BroadcastPayload<{ id: string }>) => {
        const leavingId = payload.id;
        setCursors(prev => prev.filter(cursor => cursor.id !== leavingId));
      })
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          sendCursor(-100, -100);
        }
      });

    channelRef.current = channel;

    const handleLeave = () => {
      channel.send({
        type: 'broadcast',
        event: 'cursor_leave',
        payload: { id: userId },
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('beforeunload', handleLeave);
    cleanupTimerRef.current = window.setInterval(pruneStaleCursors, 1500);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('beforeunload', handleLeave);
      handleLeave();
      if (cleanupTimerRef.current) window.clearInterval(cleanupTimerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [workspaceId, userId, handleMouseMove, pruneStaleCursors, sendCursor, upsertCursor]);

  return { cursors, userId: userId || '' };
}
