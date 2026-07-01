import { useState, useCallback, useRef, useEffect } from 'react';
import { backendClient, apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { messageText } from '../lib/chatStream';
import type { ChatSession, Message } from '../types';

export function useSubThreads(workspaceId: string | null) {
  const [subThreadsByMessage, setSubThreadsByMessage] = useState<Record<string, ChatSession[]>>({});
  const [activeSubThread, setActiveSubThread] = useState<ChatSession | null>(null);
  const [subThreadMessages, setSubThreadMessages] = useState<Message[]>([]);
  const [subThreadStreaming, setSubThreadStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => streamAbortRef.current?.abort(), []);

  // Load all sub-thread sessions for this workspace so message badges show immediately.
  useEffect(() => {
    if (!workspaceId) return;
    backendClient
      .from('chat_sessions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .not('parent_message_id', 'is', null)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!data) return;
        const grouped: Record<string, ChatSession[]> = {};
        for (const session of data) {
          const mid = session.parent_message_id as string;
          if (!grouped[mid]) grouped[mid] = [];
          grouped[mid].push(session);
        }
        setSubThreadsByMessage(grouped);
      });
  }, [workspaceId]);

  const loadSubThreadsForMessage = useCallback(async (messageId: string) => {
    if (!workspaceId) return;
    const { data } = await backendClient
      .from('chat_sessions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('parent_message_id', messageId)
      .order('created_at', { ascending: true });
    if (data) {
      setSubThreadsByMessage(prev => ({ ...prev, [messageId]: data }));
    }
  }, [workspaceId]);

  const loadSubThreadMessages = useCallback(async (sessionId: string) => {
    const { data } = await backendClient
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
    if (data) {
      setSubThreadMessages(data.map(normalizeMessage));
    }
  }, []);

  const messageDeduper = useRealtimeDeduper();
  useTableSubscription<Message>(
    {
      enabled: !!activeSubThread?.id,
      channelName: `sub-thread-messages:${activeSubThread?.id}`,
      table: 'messages',
      event: '*',
      schema: 'public',
      filter: `session_id=eq.${activeSubThread?.id}`,
    },
    (payload) => {
      if (!messageDeduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT') {
        const row = payload.new;
        if (!row) return;
        setSubThreadMessages(prev => {
          const normalized = normalizeMessage(row);
          return prev.some(m => m.id === row.id)
            ? prev.map(m => m.id === row.id ? { ...m, ...normalized } : m)
            : [...prev, normalized].sort((a, b) =>
                String(a.created_at).localeCompare(String(b.created_at)));
        });
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new;
        if (!row) return;
        setSubThreadMessages(prev => prev.map(m => m.id === row.id ? normalizeMessage(row) : m));
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.id) return;
        setSubThreadMessages(prev => prev.filter(m => m.id !== row.id));
      }
    },
  );

  // Subscribe to new sub-thread sessions for this workspace.
  const sessionDeduper = useRealtimeDeduper();
  useTableSubscription<ChatSession>(
    {
      enabled: !!workspaceId,
      channelName: `sub-thread-sessions:${workspaceId}`,
      table: 'chat_sessions',
      event: 'INSERT',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!sessionDeduper.shouldProcess(payload)) return;
      const session = payload.new;
      if (!session?.parent_message_id) return;
      const mid = session.parent_message_id as string;
      setSubThreadsByMessage(prev => {
        const existing = prev[mid] || [];
        if (existing.some(s => s.id === session.id)) return prev;
        return { ...prev, [mid]: [...existing, session] };
      });
    },
  );

  const createSubThread = useCallback(async (
    messageId: string,
    agentHandle: string,
    agentId: string | null,
    agentName: string,
    options?: {
      contextMessage?: string;
      additionalAgents?: Array<{ id: string | null; name: string; handle: string }>;
    },
  ): Promise<ChatSession | null> => {
    if (!workspaceId) return null;
    const now = new Date().toISOString();
    const primaryParticipant = {
      id: agentId || agentHandle,
      name: agentName,
      kind: 'agent',
      handle: agentHandle,
      agent_id: agentId,
      direct: true,
      added_at: now,
    };
    const extraParticipants = (options?.additionalAgents || []).map(a => ({
      id: a.id || a.handle,
      name: a.name,
      kind: 'agent',
      handle: a.handle,
      agent_id: a.id,
      direct: false,
      added_at: now,
    }));
    const participants = [primaryParticipant, ...extraParticipants];
    const { data } = await backendClient
      .from('chat_sessions')
      .insert({
        workspace_id: workspaceId,
        title: `${agentName} sub-thread`,
        model: 'auto',
        conversation_mode: 'auto',
        folder: 'sub-thread',
        parent_message_id: messageId,
        participants,
      })
      .select()
      .single();
    if (data) {
      setSubThreadsByMessage(prev => {
        const existing = prev[messageId] || [];
        // The realtime chat_sessions INSERT can land during the await above and
        // add this session first; guard by id so we don't render a duplicate chip.
        if (existing.some(s => s.id === data.id)) return prev;
        return { ...prev, [messageId]: [...existing, data] };
      });
      // Seed the thread with the parent message as context so the agent knows the task
      if (options?.contextMessage) {
        const contextMsgId = crypto.randomUUID();
        await backendClient.from('messages').insert({
          id: contextMsgId,
          session_id: data.id,
          role: 'user',
          content: options.contextMessage,
        });
        // Dispatch to the target agent so it reads the context immediately
        fetch(apiUrl('/backend/agents/dispatch'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({
            workspaceId,
            sessionId: data.id,
            messageId: contextMsgId,
            content: options.contextMessage,
            threadParentId: null,
            messages: [{ role: 'user', content: options.contextMessage }],
          }),
        }).catch(() => null);
      }
    }
    return data;
  }, [workspaceId]);

  const openSubThread = useCallback(async (session: ChatSession) => {
    setActiveSubThread(session);
    setSubThreadMessages([]);
    await loadSubThreadMessages(session.id);
  }, [loadSubThreadMessages]);

  const closeSubThread = useCallback(() => {
    setActiveSubThread(null);
    setSubThreadMessages([]);
  }, []);

  const sendSubThreadMessage = useCallback(async (content: string) => {
    if (!activeSubThread || !workspaceId) return;

    const userMsgId = crypto.randomUUID();
    const userMsg: Message = {
      id: userMsgId,
      session_id: activeSubThread.id,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setSubThreadMessages(prev => [...prev, userMsg]);

    await backendClient.from('messages').insert({
      id: userMsgId,
      session_id: activeSubThread.id,
      role: 'user',
      content,
    });

    // Dispatch to agent via the existing dispatch endpoint
    const dispatchResponse = await fetch(apiUrl('/backend/agents/dispatch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({
        workspaceId,
        sessionId: activeSubThread.id,
        messageId: userMsgId,
        content,
        threadParentId: null,
        messages: [...subThreadMessages, userMsg].map(m => ({
          role: m.role,
          content: messageText(m.content),
        })),
      }),
    }).catch(() => null);

    const dispatchPayload = dispatchResponse
      ? await dispatchResponse.json().catch(() => null)
      : null;

    if (dispatchResponse?.ok) {
      // If dispatch returned a direct message, add it. Otherwise the agent
      // will respond asynchronously via the realtime subscription.
      if (dispatchPayload?.data?.message) {
        const next = normalizeMessage(dispatchPayload.data.message);
        setSubThreadMessages(prev =>
          prev.some(m => m.id === next.id) ? prev : [...prev, next]);
      }
      return;
    }

    // Fallback: stream direct AI if dispatch failed entirely
    if (!dispatchResponse?.ok) {
      setSubThreadStreaming(true);
      const assistantMsgId = crypto.randomUUID();
      const placeholder: Message = {
        id: assistantMsgId,
        session_id: activeSubThread.id,
        role: 'assistant',
        content: '',
        created_at: new Date().toISOString(),
      };
      setSubThreadMessages(prev => [...prev, placeholder]);

      try {
        const controller = new AbortController();
        streamAbortRef.current = controller;
        const response = await fetch(apiUrl('/backend/ai-chat'), {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({
            workspaceId,
            messages: [...subThreadMessages, userMsg].map(m => ({
              role: m.role,
              content: messageText(m.content),
            })),
            model: 'auto',
          }),
        });

        if (!response.ok || !response.body) {
          setSubThreadMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? { ...m, content: 'Failed to get response.' } : m));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let buffer = '';

        const consume = (data: string) => {
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.delta?.content || parsed?.text || '';
            if (text) {
              fullContent += text;
              setSubThreadMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: fullContent } : m));
            }
          } catch { /* ignore */ }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) consume(line.slice(6).trim());
          }
        }

        await backendClient.from('messages').insert({
          id: assistantMsgId,
          session_id: activeSubThread.id,
          role: 'assistant',
          content: fullContent,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      } finally {
        setSubThreadStreaming(false);
      }
    }
  }, [activeSubThread, workspaceId, subThreadMessages]);

  return {
    subThreadsByMessage,
    activeSubThread,
    subThreadMessages,
    subThreadStreaming,
    loadSubThreadsForMessage,
    createSubThread,
    openSubThread,
    closeSubThread,
    sendSubThreadMessage,
  };
}

function normalizeMessage(message: Message): Message {
  return { ...message, content: messageText(message.content) };
}
