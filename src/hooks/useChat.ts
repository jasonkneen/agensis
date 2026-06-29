import { useState, useEffect, useCallback } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import type { ChannelParticipant, ChatSession, Message, MemoryFact, Document, WorkspaceAgent } from '../types';
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
    if (data) setMessages(data.map(normalizeMessage));
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (activeSession) fetchMessages(activeSession.id);
    else setMessages([]);
  }, [activeSession, fetchMessages]);

  useEffect(() => {
    if (!activeSession?.id) return;
    const sessionId = activeSession.id;
    const channel = backendClient
      .channel(`messages:${sessionId}`)
      .on(
        'db_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `session_id=eq.${sessionId}` },
        (payload: { eventType?: string; new?: Message; old?: Partial<Message> }) => {
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
      )
      .subscribe();
    return () => {
      backendClient.removeChannel(channel);
    };
  }, [activeSession?.id]);

  const createSession = useCallback(async (model = 'auto', initial: Partial<ChatSession> = {}) => {
    if (!workspaceId) return null;
    if (!navigator.onLine) return null;
    const initialFields: Record<string, unknown> = { ...initial };
    delete initialFields.id;
    delete initialFields.workspace_id;
    delete initialFields.created_at;
    delete initialFields.updated_at;
    const { data } = await backendClient
      .from('chat_sessions')
      .insert({
        workspace_id: workspaceId,
        title: initial.title || 'New Channel',
        model,
        ...initialFields,
      })
      .select()
      .single();
    if (data) {
      setSessions(prev => [data, ...prev]);
      setActiveSession(data);
      setMessages([]);
    }
    return data;
  }, [workspaceId]);

  const updateSession = useCallback(async (id: string, updates: Partial<ChatSession>) => {
    const { data } = await backendClient
      .from('chat_sessions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (data) {
      setSessions(prev => prev.map(session => session.id === id ? data : session));
      setActiveSession(prev => prev?.id === id ? data : prev);
    }
    return data as ChatSession | null;
  }, []);

  const archiveSession = useCallback((id: string, archived = true) => {
    return updateSession(id, { archived_at: archived ? new Date().toISOString() : null });
  }, [updateSession]);

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
    targetSession?: ChatSession | null,
  ) => {
    const session = targetSession ?? activeSession;
    if (!session) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      session_id: session.id,
      role: 'user',
      content,
      thread_parent_id: threadParentId ?? null,
      created_at: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMsg]);

    if (!navigator.onLine) {
      const offlineReply: Message = {
        id: crypto.randomUUID(),
        session_id: session.id,
        role: 'assistant',
        content: 'You are currently offline. Your message will be sent when you reconnect.',
        thread_parent_id: threadParentId ?? null,
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, offlineReply]);
      return;
    }

    const insertPayload: Record<string, unknown> = {
      id: userMsg.id,
      session_id: session.id,
      role: 'user',
      content,
    };
    if (threadParentId) insertPayload.thread_parent_id = threadParentId;
    await backendClient.from('messages').insert(insertPayload);

    if ((session.title === 'New Chat' || session.title === 'New Channel') && !threadParentId) {
      const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
      await backendClient
        .from('chat_sessions')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', session.id);
      setSessions(prev => prev.map(s =>
        s.id === session.id ? { ...s, title } : s
      ));
      setActiveSession(prev => prev?.id === session.id ? { ...prev, title } : prev);
    }

    const memoryContext = memoryFacts && memoryFacts.length > 0
      ? memoryFacts.map(f => `[${f.category}] ${f.fact}`).join('\n')
      : null;

    const docContext = linkedDocuments && linkedDocuments.length > 0
      ? linkedDocuments.map(d => `--- Document: ${d.title} ---\n${d.content?.replace(/<[^>]+>/g, '') || ''}`).join('\n\n')
      : null;

    const contextMessages = threadParentId
      ? messages.filter(m => m.thread_parent_id === threadParentId || m.id === threadParentId)
      : activeSession?.id === session.id ? messages : [];

    const hasMention = Boolean(firstAgentMention(content));
    const threadHasAgentTarget = Boolean(threadParentId && hasAgentTargetInThread(contextMessages));
    const directParticipant = directAgentParticipantRecord(session);
    const directAgentChannel = Boolean(directParticipant);
    // In an 'auto' channel, a plain message (no mention/thread/direct target) still
    // dispatches so the server-side context-aware auto-interject gate can run.
    // 'mention' channels keep the original mention-only routing.
    const autoChannel = session.conversation_mode === 'auto';
    const shouldRouteToAgent = Boolean(workspaceId && (hasMention || threadHasAgentTarget || directAgentChannel || autoChannel));

    if (shouldRouteToAgent) {
      const dispatchResponse = await fetch(apiUrl('/backend/agents/dispatch'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...apiAuthHeaders(),
        },
        body: JSON.stringify({
          workspaceId,
          sessionId: session.id,
          messageId: userMsg.id,
          content,
          threadParentId: threadParentId ?? null,
          messages: [...contextMessages, userMsg].map(m => ({ role: m.role, content: messageText(m.content) })),
          memory: memoryContext,
          documents: docContext,
          workspaceContext: workspaceContext ?? null,
        }),
      }).catch(() => null);
      const dispatchPayload = dispatchResponse
        ? await dispatchResponse.json().catch(() => null)
        : null;
      if (dispatchResponse?.ok && dispatchPayload?.data?.message) {
        setMessages(prev => {
          const next = normalizeMessage(dispatchPayload.data.message);
          return prev.some(message => message.id === next.id) ? prev : [...prev, next];
        });
        return;
      }
      if (dispatchResponse?.ok && dispatchPayload?.data?.dispatched) {
        return;
      }
      if (!agent && !directParticipant) {
        return;
      }
    } else if (!agent) {
      return;
    }

    setStreaming(true);

    const assistantMsgId = crypto.randomUUID();
    const placeholderMsg: Message = {
      id: assistantMsgId,
      session_id: session.id,
      role: 'assistant',
      content: '',
      thread_parent_id: threadParentId ?? null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, placeholderMsg]);

    try {
      const agentContext = agent ? {
        name: agent.name,
        systemPrompt: agent.system_prompt,
        soul: agent.soul,
        instructions: agent.instructions,
        tools: normalizeStringList(agent.tools),
        skills: normalizeStringList(agent.skills),
        model: agent.model,
      } : directParticipant ? {
        name: directParticipant.name || directParticipant.handle || 'Agent',
        systemPrompt: '',
        soul: '',
        instructions: '',
        tools: [],
        skills: [],
        model: model || 'auto',
      } : null;

      const response = await fetch(apiUrl('/backend/ai-chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...apiAuthHeaders(),
        },
        body: JSON.stringify({
          workspaceId,
          messages: [...contextMessages, userMsg].map(m => ({ role: m.role, content: messageText(m.content) })),
          model: agent?.model || model,
          memory: memoryContext,
          documents: docContext,
          workspaceContext: workspaceContext ?? null,
          agentContext,
        }),
      });

      if (!response.ok || !response.body) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errorMessage(errData.error || errData.message || 'Failed to connect to AI service');
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, content: errMsg } : m
        ));
        const errInsert: Record<string, unknown> = {
          id: assistantMsgId,
          session_id: session.id,
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
              const delta = messageText(
                parsed.delta?.text ??
                parsed.choices?.[0]?.delta?.content ??
                parsed.text ??
                parsed.content ??
                parsed.message,
              );
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
          id: assistantMsgId,
          session_id: session.id,
          role: 'assistant',
          content: fullContent,
          sender_kind: agent || directParticipant ? 'agent' : '',
          sender_id: agent?.id || directParticipant?.agent_id || directParticipant?.handle || '',
          sender_name: agent?.name || directParticipant?.name || directParticipant?.handle || '',
        };
        if (threadParentId) assistantInsert.thread_parent_id = threadParentId;
        await backendClient.from('messages').insert(assistantInsert);
      }
    } catch (error) {
      const errMsg = errorMessage(error || 'Something went wrong. Please try again.');
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId ? { ...m, content: errMsg } : m
      ));
    } finally {
      setStreaming(false);
    }
  }, [activeSession, messages, workspaceId]);

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
    updateSession,
    archiveSession,
    sendMessage,
    deleteSession,
  };
}

function firstAgentMention(content: unknown): string {
  const match = messageText(content).match(/(^|\s)@([a-zA-Z0-9_.-]{1,64})\b/);
  return match ? match[2].toLowerCase() : '';
}

function hasAgentTargetInThread(threadMessages: Message[]): boolean {
  return threadMessages.some(message => {
    if (message.sender_kind === 'agent' && message.sender_id) return true;
    return Boolean(firstAgentMention(message.content));
  });
}

function directAgentParticipantRecord(session: ChatSession | null | undefined): ChannelParticipant | null {
  const participants = Array.isArray(session?.participants) ? session.participants : [];
  const agentParticipants = participants.filter(participant =>
    participant?.kind === 'agent' && (participant.agent_id || participant.handle || participant.name)
  );
  if (agentParticipants.length === 0) return null;
  return agentParticipants.find(participant => participant.direct) || (agentParticipants.length === 1 ? agentParticipants[0] : null);
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
  if (value && typeof value === 'object') return Object.values(value).map(item => String(item || '').trim()).filter(Boolean);
  return [];
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as { message?: unknown; detail?: unknown; code?: unknown };
    if (typeof record.message === 'string') return record.message;
    if (typeof record.detail === 'string') return record.detail;
    if (typeof record.code === 'string') return record.code;
  }
  return 'Something went wrong. Please try again.';
}

function normalizeMessage(message: Message): Message {
  return {
    ...message,
    content: messageText(message.content),
  };
}

function messageText(value: unknown): string {
  if (typeof value === 'string') {
    return value === '[object Object]' ? 'Response could not be rendered as text.' : value;
  }
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const record = value as {
      text?: unknown;
      content?: unknown;
      message?: unknown;
      error?: unknown;
      delta?: unknown;
      output?: unknown;
      response?: unknown;
    };
    for (const key of ['text', 'content', 'message', 'error', 'delta', 'output', 'response'] as const) {
      const text = messageText(record[key]);
      if (text) return text;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return 'Response could not be rendered as text.';
    }
  }
  return String(value);
}
