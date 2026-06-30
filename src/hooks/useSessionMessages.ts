import { useState, useEffect } from 'react';
import { backendClient } from '../lib/backendClient';
import { messageText } from '../lib/chatStream';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { Message } from '../types';

function normalizeMessage(message: Message): Message {
  return { ...message, content: messageText(message.content) };
}

/**
 * Loads and live-subscribes to one session's messages, independent of the
 * globally-active chat session in `useChat`. This lets a non-active chat window
 * (e.g. a second open agent DM) still render its history AND receive new agent
 * replies in realtime. Token-by-token streaming only animates in the active
 * window (driven by `useChat`); inactive windows get the final message via the
 * realtime INSERT/UPDATE below.
 */
export function useSessionMessages(sessionId: string | null): Message[] {
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setMessages([]);
      return;
    }
    cachedFetch<Message[]>(`messages_${sessionId}`, async () => {
      const { data } = await backendClient
        .from('messages')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });
      return data;
    }).then(data => {
      if (!cancelled && data) setMessages(data.map(normalizeMessage));
    });
    return () => {
      cancelled = true;
    };
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

  return messages;
}
