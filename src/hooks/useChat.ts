import { useState, useEffect, useCallback } from 'react';
import { backendClient, getBackendBaseUrl } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import type { ChatSession, Message, MemoryFact, Document } from '../types';
import type { WorkspaceContextSnapshot } from './useWorkspaceContext';

export function useChat(workspaceId: string | null) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const fetchSessions = useCallback(async () => {
    if (!workspaceId) return;
    const data = await cachedFetch<ChatSession[]>(`sessions_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('chat_sessions')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('updated_at', { ascending: false });
      return data;
    });
    if (data) {
      setSessions(data);
      if (data.length > 0) {
        setActiveSession(prev => prev ?? data[0]);
      }
    }
  }, [workspaceId]);

  const fetchMessages = useCallback(async (sessionId: string) => {
    setLoading(true);
    const data = await cachedFetch<Message[]>(`messages_${sessionId}`, async () => {
      const { data } = await backendClient
        .from('messages')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });
      return data;
    });
    if (data) setMessages(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (activeSession) fetchMessages(activeSession.id);
    else setMessages([]);
  }, [activeSession, fetchMessages]);

  const createSession = useCallback(async (model = 'auto') => {
    if (!workspaceId) return null;
    if (!navigator.onLine) return null;
    const { data } = await backendClient
      .from('chat_sessions')
      .insert({ workspace_id: workspaceId, title: 'New Chat', model })
      .select()
      .single();
    if (data) {
      setSessions(prev => [data, ...prev]);
      setActiveSession(data);
      setMessages([]);
    }
    return data;
  }, [workspaceId]);

  const sendMessage = useCallback(async (
    content: string,
    model: string,
    memoryFacts?: MemoryFact[],
    linkedDocuments?: Document[],
    workspaceContext?: WorkspaceContextSnapshot | null,
  ) => {
    if (!activeSession) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      session_id: activeSession.id,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMsg]);

    if (!navigator.onLine) {
      const offlineReply: Message = {
        id: crypto.randomUUID(),
        session_id: activeSession.id,
        role: 'assistant',
        content: 'You are currently offline. Your message will be sent when you reconnect.',
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, offlineReply]);
      return;
    }

    await backendClient.from('messages').insert({
      session_id: activeSession.id,
      role: 'user',
      content,
    });

    if (activeSession.title === 'New Chat') {
      const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
      await backendClient
        .from('chat_sessions')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', activeSession.id);
      setSessions(prev => prev.map(s =>
        s.id === activeSession.id ? { ...s, title } : s
      ));
    }

    setStreaming(true);

    const assistantMsgId = crypto.randomUUID();
    const placeholderMsg: Message = {
      id: assistantMsgId,
      session_id: activeSession.id,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, placeholderMsg]);

    try {
      const backendBase = getBackendBaseUrl();

      const memoryContext = memoryFacts && memoryFacts.length > 0
        ? memoryFacts.map(f => `[${f.category}] ${f.fact}`).join('\n')
        : null;

      const docContext = linkedDocuments && linkedDocuments.length > 0
        ? linkedDocuments.map(d => `--- Document: ${d.title} ---\n${d.content?.replace(/<[^>]+>/g, '') || ''}`).join('\n\n')
        : null;

      const response = await fetch(`${backendBase}/backend/ai-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
          model,
          memory: memoryContext,
          documents: docContext,
          workspaceContext: workspaceContext ?? null,
        }),
      });

      if (!response.ok || !response.body) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error || 'Failed to connect to AI service';
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, content: errMsg } : m
        ));
        await backendClient.from('messages').insert({
          session_id: activeSession.id,
          role: 'assistant',
          content: errMsg,
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.delta?.text || parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                fullContent += delta;
                setMessages(prev => prev.map(m =>
                  m.id === assistantMsgId ? { ...m, content: fullContent } : m
                ));
              }
            } catch {
              // Ignore malformed stream chunks and keep consuming the stream.
            }
          }
        }
      }

      if (fullContent) {
        await backendClient.from('messages').insert({
          session_id: activeSession.id,
          role: 'assistant',
          content: fullContent,
        });
      }
    } catch {
      const errMsg = 'Something went wrong. Please try again.';
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId ? { ...m, content: errMsg } : m
      ));
    } finally {
      setStreaming(false);
    }
  }, [activeSession, messages]);

  const deleteSession = useCallback(async (id: string) => {
    await backendClient.from('chat_sessions').delete().eq('id', id);
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSession?.id === id) {
      setActiveSession(null);
      setMessages([]);
    }
  }, [activeSession]);

  return {
    sessions,
    activeSession,
    setActiveSession,
    messages,
    loading,
    streaming,
    createSession,
    sendMessage,
    deleteSession,
  };
}
