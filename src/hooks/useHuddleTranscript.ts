import { useCallback, useEffect, useRef, useState } from 'react';
import { backendClient, apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { messageText } from '../lib/chatStream';
import { redactDeletedMessage } from '../lib/messageTombstone';
import {
  applyMessageRow,
  createMessageSnapshotOverlay,
  reconcileMessageSnapshot,
  recordMessageSnapshotChange,
  resetMessageSnapshotOverlay,
} from '../lib/messageSnapshot';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useSessionRevocationSignal } from './useSessionRevocationSignal';
import type { Message } from '../types';

// The huddle's own conversation: post into it, and watch it.
//
// This is the ONLY thing that changed about agent dispatch. An utterance still
// becomes an ordinary `messages` row and still goes through
// /backend/agents/dispatch — the exact path the composer uses — it is just
// addressed to the huddle's session instead of the channel's. Dispatch resolves
// @mentions and the DM `direct: true` shortcut from the SESSION's participants,
// and the transcript session copies those from its host when it is created, so
// every agent that answered in the channel answers here.
//
// Split into two hooks ON PURPOSE. The voice path lives in the huddle card,
// which is mounted for the whole call and must not re-render on every incoming
// token; the message list lives in the panel, which does. So sending is
// stateless (useHuddleSend) and only the panel subscribes to the transcript.

/**
 * Insert one message into a huddle session and wake whoever it mentions.
 *
 * `/backend/agents/dispatch` rebuilds all context — mentions, history, budget —
 * from the database, so the row must be persisted BEFORE dispatch and the
 * request body carries no conversation of its own.
 *
 * Returns the row on success and null on failure, so an optimistic caller knows
 * whether to keep what it drew.
 */
async function postHuddleMessage(
  workspaceId: string,
  sessionId: string,
  content: string,
): Promise<Message | null> {
  const id = crypto.randomUUID();
  const { error } = await backendClient.from('messages').insert({
    id,
    session_id: sessionId,
    role: 'user',
    content,
  });
  // Offline is not a rejection: the client queues the write and the row lands
  // later, so tearing the optimistic message down would lose it on screen only.
  if (error && navigator.onLine) return null;

  await fetch(apiUrl('/backend/agents/dispatch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({ workspaceId, sessionId, messageId: id, content, threadParentId: null }),
  }).catch(() => null);

  return { id, session_id: sessionId, role: 'user', content, created_at: new Date().toISOString() };
}

export interface HuddleSender {
  send: (content: string) => Promise<Message | null>;
  /** '' unless the last send failed. Surfaced in the UI, never thrown. */
  error: string;
}

/**
 * Send into a huddle, without subscribing to it.
 *
 * Used by the voice path. It holds no message state at all, which is what lets
 * the huddle card stay mounted for a whole call without re-rendering (and so
 * restarting the speech recogniser) every time somebody says something.
 */
export function useHuddleSend(workspaceId: string | null, sessionId: string | null): HuddleSender {
  const [error, setError] = useState('');
  const send = useCallback(async (content: string) => {
    const body = content.trim();
    if (!body || !workspaceId || !sessionId) return null;
    const row = await postHuddleMessage(workspaceId, sessionId, body);
    setError(row ? '' : 'That did not send. Say it again?');
    return row;
  }, [workspaceId, sessionId]);
  return { send, error };
}

export interface HuddleTranscript extends HuddleSender {
  messages: Message[];
  loading: boolean;
}

const EMPTY: Message[] = [];

/**
 * The huddle's messages, live.
 *
 * Deliberately NOT a fork of useChat: a huddle transcript has no threads, no
 * splits, no pins, no editing and no streaming fallback. It is a flat list of
 * messages in one session, which is all the panel renders.
 */
export function useHuddleTranscript(
  workspaceId: string | null,
  sessionId: string | null,
): HuddleTranscript {
  const [messages, setMessages] = useState<Message[]>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const activeSessionRef = useRef<string | null>(sessionId);
  const snapshotOverlayRef = useRef(createMessageSnapshotOverlay());
  activeSessionRef.current = sessionId;
  resetMessageSnapshotOverlay(snapshotOverlayRef.current, sessionId);

  useSessionRevocationSignal(sessionId, () => {
    snapshotOverlayRef.current.changes.clear();
    setMessages(EMPTY);
    setLoading(false);
    setError('Access to this conversation was removed.');
  });

  useEffect(() => {
    let cancelled = false;
    setMessages(EMPTY);
    if (!sessionId) return;
    setLoading(true);
    void backendClient
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (cancelled || activeSessionRef.current !== sessionId) return;
        const rows = Array.isArray(data) ? data.map(normalize) : EMPTY;
        setMessages(reconcileMessageSnapshot(rows, snapshotOverlayRef.current, sessionId));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<Message>(
    {
      enabled: !!sessionId,
      // The same canonical channel name used by the ordinary session-message
      // readers, so the realtime manager reference-counts ONE underlying
      // subscription instead of opening another over identical rows.
      channelName: `messages:${sessionId}`,
      table: 'messages',
      event: '*',
      schema: 'public',
      filter: `session_id=eq.${sessionId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      const rowSessionId = String(payload.new?.session_id || payload.old?.session_id || '');
      if (!sessionId || rowSessionId !== sessionId || activeSessionRef.current !== sessionId) return;
      if (payload.eventType === 'DELETE') {
        const id = payload.old?.id;
        if (id) {
          recordMessageSnapshotChange(snapshotOverlayRef.current, sessionId, null, id);
          setMessages(prev => prev.filter(m => m.id !== id));
        }
        return;
      }
      const row = payload.new;
      if (!row?.id) return;
      const next = normalize(row);
      recordMessageSnapshotChange(snapshotOverlayRef.current, sessionId, next);
      // Merge by id: the optimistic row this client drew and the realtime
      // INSERT that follows it are the same message, not two.
      setMessages(prev => applyMessageRow(prev, next));
    },
  );

  const send = useCallback(async (content: string) => {
    const body = content.trim();
    if (!body || !workspaceId || !sessionId) return null;
    const row = await postHuddleMessage(workspaceId, sessionId, body);
    if (!row) {
      setError('That did not send.');
      return null;
    }
    setError('');
    if (activeSessionRef.current === sessionId) {
      recordMessageSnapshotChange(snapshotOverlayRef.current, sessionId, row);
      setMessages(prev => applyMessageRow(prev, row));
    }
    return row;
  }, [workspaceId, sessionId]);

  return { messages, loading, error, send };
}

function normalize(message: Message): Message {
  return redactDeletedMessage({ ...message, content: messageText(message.content) });
}
