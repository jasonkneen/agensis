import { useState, useEffect, useRef, useCallback } from 'react';
import { apiUrl, apiAuthHeaders } from '../lib/backendClient';
import { messageText } from '../lib/chatStream';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { Message } from '../types';

// NET-05: inactive/split windows load only the newest page and page backwards on
// demand, matching the active window (useChat). Mirrors that page size.
const MESSAGE_PAGE_SIZE = 200;

function normalizeMessage(message: Message): Message {
 return { ...message, content: messageText(message.content) };
}

export interface SessionMessagesResult {
 messages: Message[];
 hasMore: boolean;
 loadingEarlier: boolean;
 loadEarlier: () => void;
}

/**
 * Loads and live-subscribes to one session's messages, independent of the
 * globally-active chat session in `useChat`. This lets a non-active chat window
 * (e.g. a second open agent DM) still render its history AND receive new agent
 * replies in realtime. Token-by-token streaming only animates in the active
 * window (driven by `useChat`); inactive windows get the final message via the
 * realtime INSERT/UPDATE below.
 *
 * NET-05: history is paginated — the newest page loads on open, older pages load
 * on demand via `loadEarlier`, so a second window on a huge channel no longer
 * pulls the whole transcript.
 */
export function useSessionMessages(sessionId: string | null): SessionMessagesResult {
 const [messages, setMessages] = useState<Message[]>([]);
 const [hasMore, setHasMore] = useState(false);
 const [loadingEarlier, setLoadingEarlier] = useState(false);
 const messagesRef = useRef<Message[]>([]);
 useEffect(() => { messagesRef.current = messages; }, [messages]);
 // Tracks the session currently shown, synced DURING render so an in-flight
 // loadEarlier from a previous session is ignored when its response lands, with
 // no render→effect window (stale-response guard).
 const currentSessionRef = useRef<string | null>(sessionId);
 currentSessionRef.current = sessionId;

 useEffect(() => {
  let cancelled = false;
  if (!sessionId) {
   setMessages([]);
   setHasMore(false);
   setLoadingEarlier(false);
   return;
  }
  cachedFetch<{ messages: Message[]; hasMore: boolean }>(`messages_page_${sessionId}`, async () => {
   const res = await fetch(apiUrl(`/backend/sessions/${sessionId}/messages?limit=${MESSAGE_PAGE_SIZE}`), {
    headers: apiAuthHeaders(),
   });
   if (!res.ok) return { messages: [], hasMore: false };
   const body = await res.json();
   return body?.data ?? { messages: [], hasMore: false };
  }).then(result => {
   if (cancelled || !result) return;
   setMessages((result.messages ?? []).filter(m => !m.deleted_at).map(normalizeMessage));
   setHasMore(Boolean(result.hasMore));
  });
  return () => {
   cancelled = true;
  };
 }, [sessionId]);

 const loadEarlier = useCallback(() => {
  if (!sessionId) return;
  const oldest = messagesRef.current[0];
  if (!oldest) return;
  const requestedSessionId = sessionId;
  setLoadingEarlier(true);
  const params = new URLSearchParams({
   limit: String(MESSAGE_PAGE_SIZE),
   before: String(oldest.created_at ?? ''),
   beforeId: String(oldest.id ?? ''),
  });
  fetch(apiUrl(`/backend/sessions/${requestedSessionId}/messages?${params.toString()}`), { headers: apiAuthHeaders() })
   .then(res => (res.ok ? res.json() : null))
   .then(body => {
    // Stale-response guard: the window may have switched sessions (or
    // unmounted) while this was in flight — never prepend a foreign
    // session's rows or flip state for a session we no longer show.
    if (currentSessionRef.current !== requestedSessionId) return;
    if (!body) return;
    const older = (body?.data?.messages ?? []).filter((m: Message) => !m.deleted_at).map(normalizeMessage);
    setHasMore(Boolean(body?.data?.hasMore));
    if (older.length > 0) {
     setMessages(prev => {
      const seen = new Set(prev.map(m => m.id));
      const deduped = older.filter((m: Message) => !seen.has(m.id));
      return deduped.length > 0 ? [...deduped, ...prev] : prev;
     });
    }
   })
   .finally(() => {
    if (currentSessionRef.current === requestedSessionId) setLoadingEarlier(false);
   });
 }, [sessionId]);

 const deduper = useRealtimeDeduper();
 useTableSubscription<Message>(
  {
   enabled: !!sessionId,
   channelName: `messages:${sessionId}`,
   table: 'messages',
   event: '*',
   schema: 'public',
   filter: `session_id=eq.${sessionId}`,
  },
  (payload) => {
   if (!deduper.shouldProcess(payload)) return;
   if (payload.eventType === 'INSERT') {
    const row = payload.new;
    if (!row) return;
    setMessages(prev => {
     const normalized = normalizeMessage(row);
     const next = prev.some(message => message.id === row.id)
      ? prev.map(message => message.id === row.id ? { ...message, ...normalized } : message)
      : [...prev, normalized];
     return next.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    });
   } else if (payload.eventType === 'UPDATE') {
    const row = payload.new;
    if (!row) return;
    setMessages(prev => prev.map(message => message.id === row.id ? normalizeMessage(row) : message));
   } else if (payload.eventType === 'DELETE') {
    const row = payload.old;
    if (!row?.id) return;
    setMessages(prev => prev.filter(message => message.id !== row.id));
   }
  },
 );

 return { messages, hasMore, loadingEarlier, loadEarlier };
}
