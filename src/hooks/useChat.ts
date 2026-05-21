import { useState, useEffect, useCallback } from 'react';
import { backendClient, getBackendBaseUrl } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import type { ChatSession, Message, MemoryFact, Document, WorkspaceAgent } from '../types';
import type { WorkspaceContextSnapshot } from './useWorkspaceContext';

export function useChat(workspaceId: string | null) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

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

  // Top-level messages (no thread parent)
  const topLevelMessages = messages.filter(m => !m.thread_parent_id);

  // Thread messages for the active thread
  const threadMessages = activeThreadId
    ? messages.filter(m => m.thread_parent_id === activeThreadId || m.id === activeThreadId)
    : [];

  // Thread reply counts per parent message
  const threadReplyCounts: Record<string, number> = {};
  messages.forEach(m => {
    if (m.thread_parent_id) {
      threadReplyCounts[m.thread_parent_id] = (threadReplyCounts[m.thread_parent_id] || 0) + 1;
    }
  });

  const openThread = useCallback((messageId: string) => {
    setActiveThreadId(messageId);
  }, []);

  const closeThread = useCallback(() => {
    setActiveThreadId(null);
  }, []);

  const sendMessage = useCallback(async (
    content: string,
    model: string,
    memoryFacts?: MemoryFact[],
    linkedDocuments?: Document[],
    workspaceContext?: WorkspaceContextSnapshot | null,
    agent?: WorkspaceAgent | null,
    threadParentId?: string | null,
  ) => {
    if (!activeSession) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      session_id: activeSession.id,
      role: 'user',
      content,
      thread_parent_id: threadParentId ?? null,
      created_at: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMsg]);

    if (!navigator.onLine) {
      const offlineReply: Message = {
        id: crypto.randomUUID(),
        session_id: activeSession.id,
        role: 'assistant',
        content: 'You are currently offline. Your message will be sent when you reconnect.',
        thread_parent_id: threadParentId ?? null,
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, offlineReply]);
      return;
    }

    const insertPayload: Record<string, unknown> = {
      session_id: activeSession.id,
      role: 'user',
      content,
    };
    if (threadParentId) insertPayload.thread_parent_id = threadParentId;
    await backendClient.from('messages').insert(insertPayload);

    if (activeSession.title === 'New Chat' && !threadParentId) {
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
      thread_parent_id: threadParentId ?? null,
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

      // For thread replies, only send thread context
      const contextMessages = threadParentId
        ? messages.filter(m => m.thread_parent_id === threadParentId || m.id === threadParentId)
        : messages;

      const agentContext = agent ? {
        name: agent.name,
        systemPrompt: agent.system_prompt,
        model: agent.model,
      } : null;

      const response = await fetch(`${backendBase}/backend/ai-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [...contextMessages, userMsg].map(m => ({ role: m.role, content: m.content })),
          model: agent?.model || model,
          memory: memoryContext,
          documents: docContext,
          workspaceContext: workspaceContext ?? null,
          agentContext,
        }),
      });

      if (!response.ok || !response.body) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error || 'Failed to connect to AI service';
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, content: errMsg } : m
        ));
        const errInsert: Record<string, unknown> = {
          session_id: activeSession.id,
          role: 'assistant',
          content: errMsg,
        };
        if (threadParentId) errInsert.thread_parent_id = threadParentId;
        await backendClient.from('messages').insert(errInsert);
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
        const assistantInsert: Record<string, unknown> = {
          session_id: activeSession.id,
          role: 'assistant',
          content: fullContent,
        };
        if (threadParentId) assistantInsert.thread_parent_id = threadParentId;
        await backendClient.from('messages').insert(assistantInsert);
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
    topLevelMessages,
    threadMessages,
    threadReplyCounts,
    activeThreadId,
    openThread,
    closeThread,
    loading,
    streaming,
    createSession,
    sendMessage,
    deleteSession,
  };
}
