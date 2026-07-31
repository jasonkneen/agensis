import { useState, useCallback, useRef, useEffect } from 'react';
import { backendClient, apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { classifyWriteFailure, type SendOutcome } from '../lib/writeFeedback';
import { messageText } from '../lib/chatStream';
import type { ChatSession, Message } from '../types';

export function useSubThreads(workspaceId: string | null) {
  const [subThreadsByMessage, setSubThreadsByMessage] = useState<Record<string, ChatSession[]>>({});
  const [activeSubThread, setActiveSubThread] = useState<ChatSession | null>(null);
  const [activeSubThreadHostSessionId, setActiveSubThreadHostSessionId] = useState<string | null>(null);
  const [subThreadMessages, setSubThreadMessages] = useState<Message[]>([]);
  const activeSubThreadIdRef = useRef<string | null>(null);

  // Load all sub-thread sessions for this workspace so message badges show immediately.
  useEffect(() => {
    activeSubThreadIdRef.current = null;
    setActiveSubThread(null);
    setActiveSubThreadHostSessionId(null);
    setSubThreadMessages([]);
    setSubThreadsByMessage({});
    if (!workspaceId) return;
    let cancelled = false;
    backendClient
      .from('chat_sessions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .not('parent_message_id', 'is', null)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (cancelled || !data) return;
        const grouped: Record<string, ChatSession[]> = {};
        for (const session of data) {
          const mid = session.parent_message_id as string;
          if (!grouped[mid]) grouped[mid] = [];
          grouped[mid].push(session);
        }
        setSubThreadsByMessage(grouped);
      });
    return () => { cancelled = true; };
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
    // A slower request for A must not replace B after the user has already
    // switched panels. The main session loader uses the same identity guard.
    if (data && activeSubThreadIdRef.current === sessionId) {
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
      const payloadSessionId = String(payload.new?.session_id || payload.old?.session_id || '');
      if (payloadSessionId && payloadSessionId !== activeSubThreadIdRef.current) return;
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
    },
  ): Promise<ChatSession | null> => {
    if (!workspaceId) return null;
    const now = new Date().toISOString();
    // Canonical id shape: `agent:<uuid>`, matching every other writer. This
    // hook wrote the bare uuid, so the same agent added again through the
    // people dialog landed as a SECOND row — and continueConversation
    // dispatches per agent row, so the duplicate answered twice and a huddle
    // read both replies aloud.
    const primaryParticipant = {
      id: agentId ? `agent:${agentId}` : `agent:${agentHandle}`,
      name: agentName,
      kind: 'agent',
      handle: agentHandle,
      agent_id: agentId,
      direct: true,
      added_at: now,
    };
    const { data } = await backendClient
      .from('chat_sessions')
      .insert({
        workspace_id: workspaceId,
        title: `${agentName} sub-thread`,
        model: 'auto',
        conversation_mode: 'auto',
        folder: 'sub-thread',
        parent_message_id: messageId,
        participants: [primaryParticipant],
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

  const openSubThread = useCallback(async (session: ChatSession, hostSessionId?: string) => {
    activeSubThreadIdRef.current = session.id;
    setActiveSubThread(session);
    setActiveSubThreadHostSessionId(hostSessionId || null);
    setSubThreadMessages([]);
    await loadSubThreadMessages(session.id);
  }, [loadSubThreadMessages]);

  const closeSubThread = useCallback(() => {
    activeSubThreadIdRef.current = null;
    setActiveSubThread(null);
    setActiveSubThreadHostSessionId(null);
    setSubThreadMessages([]);
  }, []);

  const sendSubThreadMessage = useCallback(async (content: string): Promise<SendOutcome> => {
    if (!activeSubThread || !workspaceId) return { delivered: false };

    const userMsgId = crypto.randomUUID();
    const userMsg: Message = {
      id: userMsgId,
      session_id: activeSubThread.id,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setSubThreadMessages(prev => [...prev, userMsg]);

    const { error: insertError } = await backendClient.from('messages').insert({
      id: userMsgId,
      session_id: activeSubThread.id,
      role: 'user',
      content,
    });

    // The insert result used to be discarded, which left a phantom message on
    // screen after a rejection and then dispatched a messageId the server had
    // never stored. Roll the optimistic row back and say so, exactly as
    // useChat's insertUserMessage does.
    if (insertError && navigator.onLine) {
      setSubThreadMessages(prev => prev.filter(m => m.id !== userMsgId));
      const failure = classifyWriteFailure(insertError, { online: navigator.onLine });
      setSubThreadMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        session_id: activeSubThread.id,
        role: 'assistant',
        content: `Couldn't send your message — ${failure.reason}`,
        created_at: new Date().toISOString(),
      }]);
      return { delivered: false };
    }

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
      return { delivered: true };
    }

    // Never substitute a generic model for the agent the user chose. The old
    // fallback called /ai-chat with model:auto and no persona, identity, or
    // configured agent model, then rendered that output as the delegate's.
    const detail = String(dispatchPayload?.error?.message || '').trim();
    setSubThreadMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      session_id: activeSubThread.id,
      role: 'assistant',
      sender_name: 'Agensis',
      content: detail
        ? `Couldn't reach the configured agent — ${detail}`
        : "Couldn't reach the configured agent. Your message was saved, but no fallback model was run.",
      created_at: new Date().toISOString(),
    }]);
    return { delivered: true };
  }, [activeSubThread, workspaceId, subThreadMessages]);

  return {
    subThreadsByMessage,
    activeSubThread,
    activeSubThreadHostSessionId,
    subThreadMessages,
    subThreadStreaming: false,
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
