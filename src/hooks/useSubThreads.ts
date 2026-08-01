import { useState, useCallback, useRef, useEffect } from 'react';
import { backendClient, apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { cachedFetch, offlineMessageSendResult } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { classifyWriteFailure, type SendOutcome } from '../lib/writeFeedback';
import { messageText } from '../lib/chatStream';
import { redactDeletedMessage } from '../lib/messageTombstone';
import {
  applyMessageRow,
  createMessageSnapshotOverlay,
  reconcileMessageSnapshot,
  recordMessageSnapshotChange,
  resetMessageSnapshotOverlay,
} from '../lib/messageSnapshot';
import { closeSession as closeSessionControl } from '../lib/sessionControl';
import { useSessionClosureSignal } from './useSessionClosureSignal';
import { useSessionRevocationSignal } from './useSessionRevocationSignal';
import {
  buildQuotedMessageContext,
  type QuotedMessageSource,
} from '../lib/quotedSessionContext';
import type { ChatSession, Message, MessageAttachment } from '../types';

export function useSubThreads(workspaceId: string | null) {
  const [subThreadsByMessage, setSubThreadsByMessage] = useState<Record<string, ChatSession[]>>({});
  const [activeSubThread, setActiveSubThread] = useState<ChatSession | null>(null);
  const [activeSubThreadHostSessionId, setActiveSubThreadHostSessionId] = useState<string | null>(null);
  const [subThreadMessages, setSubThreadMessages] = useState<Message[]>([]);
  const [subThreadHasMore, setSubThreadHasMore] = useState(false);
  const [subThreadLoadingEarlier, setSubThreadLoadingEarlier] = useState(false);
  const activeSubThreadIdRef = useRef<string | null>(null);
  const subThreadMessagesRef = useRef<Message[]>([]);
  const snapshotOverlayRef = useRef(createMessageSnapshotOverlay());
  useEffect(() => { subThreadMessagesRef.current = subThreadMessages; }, [subThreadMessages]);

  useSessionClosureSignal(activeSubThread?.id ?? null, (closed) => {
    if (activeSubThreadIdRef.current === closed.id) {
      activeSubThreadIdRef.current = null;
      resetMessageSnapshotOverlay(snapshotOverlayRef.current, null);
      setActiveSubThread(null);
      setActiveSubThreadHostSessionId(null);
      setSubThreadMessages([]);
      setSubThreadHasMore(false);
      setSubThreadLoadingEarlier(false);
    }
    setSubThreadsByMessage(prev => {
      let changed = false;
      const next: Record<string, ChatSession[]> = {};
      for (const [messageId, sessions] of Object.entries(prev)) {
        const remaining = sessions.filter(session => session.id !== closed.id);
        if (remaining.length !== sessions.length) changed = true;
        next[messageId] = remaining;
      }
      return changed ? next : prev;
    });
  });
  useSessionRevocationSignal(activeSubThread?.id ?? null, (revokedSessionId) => {
    if (activeSubThreadIdRef.current === revokedSessionId) {
      activeSubThreadIdRef.current = null;
      resetMessageSnapshotOverlay(snapshotOverlayRef.current, null);
      setActiveSubThread(null);
      setActiveSubThreadHostSessionId(null);
      setSubThreadMessages([]);
      setSubThreadHasMore(false);
      setSubThreadLoadingEarlier(false);
    }
    setSubThreadsByMessage(prev => {
      let changed = false;
      const next: Record<string, ChatSession[]> = {};
      for (const [messageId, sessions] of Object.entries(prev)) {
        const remaining = sessions.filter(session => session.id !== revokedSessionId);
        if (remaining.length !== sessions.length) changed = true;
        next[messageId] = remaining;
      }
      return changed ? next : prev;
    });
  });

  // Load all sub-thread sessions for this workspace so message badges show immediately.
  useEffect(() => {
    activeSubThreadIdRef.current = null;
    resetMessageSnapshotOverlay(snapshotOverlayRef.current, null);
    setActiveSubThread(null);
    setActiveSubThreadHostSessionId(null);
    setSubThreadMessages([]);
    setSubThreadHasMore(false);
    setSubThreadLoadingEarlier(false);
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
          if (session.deleted_at) continue;
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
      const sessions = data as ChatSession[];
      setSubThreadsByMessage(prev => ({
        ...prev,
        [messageId]: sessions.filter((session: ChatSession) => !session.deleted_at),
      }));
    }
  }, [workspaceId]);

  const loadSubThreadMessages = useCallback(async (sessionId: string) => {
    const result = await cachedFetch<{ messages: Message[]; hasMore: boolean }>(
      `messages_page_${sessionId}`,
      async () => {
        const response = await fetch(
          apiUrl(`/backend/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`),
          { headers: apiAuthHeaders() },
        );
        if (!response.ok) return { messages: [], hasMore: false };
        const body = await response.json().catch(() => null);
        return body?.data ?? { messages: [], hasMore: false };
      },
    );
    // A slower request for A must not replace B after the user has already
    // switched panels. The main session loader uses the same identity guard.
    if (result && activeSubThreadIdRef.current === sessionId) {
      setSubThreadMessages(reconcileMessageSnapshot(
        (result.messages || []).map(normalizeMessage),
        snapshotOverlayRef.current,
        sessionId,
      ));
      setSubThreadHasMore(Boolean(result.hasMore));
      setSubThreadLoadingEarlier(false);
    }
  }, []);

  const loadEarlierSubThreadMessages = useCallback(() => {
    const sessionId = activeSubThreadIdRef.current;
    if (!sessionId || subThreadLoadingEarlier) return;
    const oldest = subThreadMessagesRef.current[0];
    if (!oldest) return;
    setSubThreadLoadingEarlier(true);
    const params = new URLSearchParams({
      limit: '200',
      before: String(oldest.created_at ?? ''),
      beforeId: String(oldest.id ?? ''),
    });
    fetch(apiUrl(`/backend/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`), {
      headers: apiAuthHeaders(),
    })
      .then(response => (response.ok ? response.json() : null))
      .then(body => {
        if (activeSubThreadIdRef.current !== sessionId || !body) return;
        const older = (body?.data?.messages ?? []).map(normalizeMessage);
        setSubThreadHasMore(Boolean(body?.data?.hasMore));
        if (older.length > 0) {
          setSubThreadMessages(previous => {
            const seen = new Set(previous.map(message => message.id));
            const deduped = older.filter((message: Message) => !seen.has(message.id));
            return deduped.length > 0 ? [...deduped, ...previous] : previous;
          });
        }
      })
      .finally(() => {
        if (activeSubThreadIdRef.current === sessionId) setSubThreadLoadingEarlier(false);
      });
  }, [subThreadLoadingEarlier]);

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
      const targetSessionId = activeSubThreadIdRef.current;
      if (!targetSessionId || payloadSessionId !== targetSessionId) return;
      if (payload.eventType === 'INSERT') {
        const row = payload.new;
        if (!row) return;
        const normalized = normalizeMessage(row);
        recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, normalized);
        setSubThreadMessages(prev => {
          return applyMessageRow(prev, normalized);
        });
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new;
        if (!row) return;
        const normalized = normalizeMessage(row);
        recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, normalized);
        setSubThreadMessages(prev => prev.map(message =>
          message.id === row.id ? normalized : message));
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.id) return;
        recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, null, row.id);
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
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!sessionDeduper.shouldProcess(payload)) return;
      const session = payload.new || payload.old;
      if (!session?.id || !session.parent_message_id) return;
      const mid = session.parent_message_id as string;
      setSubThreadsByMessage(prev => {
        const existing = prev[mid] || [];
        if (payload.eventType === 'DELETE' || session.deleted_at) {
          const next = existing.filter(item => item.id !== session.id);
          return next.length === existing.length ? prev : { ...prev, [mid]: next };
        }
        if (existing.some(item => item.id === session.id)) {
          return {
            ...prev,
            [mid]: existing.map(item => (
              item.id === session.id ? { ...item, ...session } as ChatSession : item
            )),
          };
        }
        if (payload.eventType !== 'INSERT' || !payload.new) return prev;
        return { ...prev, [mid]: [...existing, payload.new as ChatSession] };
      });
    },
  );

  const createSubThread = useCallback(async (
    messageId: string,
    agentHandle: string,
    agentId: string | null,
    agentName: string,
    options?: {
      sourceContext?: QuotedMessageSource;
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
      // Seed one explicitly quoted, provenance-labelled user instruction. The
      // original speaker remains context; the new row is never a verbatim clone
      // attributed to the person delegating it.
      if (options?.sourceContext) {
        const quotedContext = buildQuotedMessageContext(messageId, options.sourceContext);
        const contextMsgId = crypto.randomUUID();
        const { error: contextError } = await backendClient.from('messages').insert({
          id: contextMsgId,
          session_id: data.id,
          role: 'user',
          content: quotedContext,
        });
        if (contextError) {
          // A delegate without its premise is not a successful sub-thread.
          // Close the empty shell and never dispatch an id that was not stored.
          const closed = await closeSessionControl(data.id);
          if (closed) {
            setSubThreadsByMessage(prev => ({
              ...prev,
              [messageId]: (prev[messageId] || []).filter(session => session.id !== data.id),
            }));
          }
          return null;
        }
        // Dispatch to the target agent so it reads the context immediately.
        // A persisted seed with no accepted dispatch is not a successful
        // delegate: await the response and close the shell before reporting
        // failure, so the UI cannot say "created" for a request the server
        // rejected.
        const dispatchResponse = await fetch(apiUrl('/backend/agents/dispatch'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({
            workspaceId,
            sessionId: data.id,
            messageId: contextMsgId,
            content: quotedContext,
            threadParentId: null,
            messages: [{ role: 'user', content: quotedContext }],
          }),
        }).catch(() => null);
        if (!dispatchResponse?.ok) {
          const closed = await closeSessionControl(data.id);
          if (closed) {
            setSubThreadsByMessage(prev => ({
              ...prev,
              [messageId]: (prev[messageId] || []).filter(session => session.id !== data.id),
            }));
          }
          return null;
        }
      }
      setSubThreadsByMessage(prev => {
        const existing = prev[messageId] || [];
        // The realtime chat_sessions INSERT can land during the await above and
        // add this session first; guard by id so we don't render a duplicate chip.
        if (existing.some(s => s.id === data.id)) return prev;
        return { ...prev, [messageId]: [...existing, data] };
      });
    }
    return data;
  }, [workspaceId]);

  const openSubThread = useCallback(async (session: ChatSession, hostSessionId?: string) => {
    activeSubThreadIdRef.current = session.id;
    resetMessageSnapshotOverlay(snapshotOverlayRef.current, session.id);
    setActiveSubThread(session);
    setActiveSubThreadHostSessionId(hostSessionId || null);
    setSubThreadMessages([]);
    setSubThreadHasMore(false);
    setSubThreadLoadingEarlier(false);
    await loadSubThreadMessages(session.id);
  }, [loadSubThreadMessages]);

  const closeSubThread = useCallback(() => {
    activeSubThreadIdRef.current = null;
    resetMessageSnapshotOverlay(snapshotOverlayRef.current, null);
    setActiveSubThread(null);
    setActiveSubThreadHostSessionId(null);
    setSubThreadMessages([]);
    setSubThreadHasMore(false);
    setSubThreadLoadingEarlier(false);
  }, []);

  const sendSubThreadMessage = useCallback(async (
    content: string,
    attachments: MessageAttachment[] = [],
  ): Promise<SendOutcome> => {
    if (!activeSubThread || !workspaceId) return { delivered: false };
    const target = activeSubThread;
    const targetSessionId = target.id;

    const userMsgId = crypto.randomUUID();
    const userMsg: Message = {
      id: userMsgId,
      session_id: targetSessionId,
      role: 'user',
      content,
      attachments: attachments.length > 0 ? attachments : null,
      created_at: new Date().toISOString(),
    };
    if (activeSubThreadIdRef.current === targetSessionId) {
      recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, userMsg);
      setSubThreadMessages(prev => applyMessageRow(prev, userMsg));
    }

    const write = await offlineMessageSendResult({
      id: userMsgId,
      session_id: targetSessionId,
      role: 'user',
      content,
      attachments: attachments.length > 0 ? attachments : null,
    }, {
      workspaceId,
      sessionId: targetSessionId,
      messageId: userMsgId,
      content,
      threadParentId: null,
      autoThread: false,
      // A sub-thread is an agent lane by definition. Persist that intent with
      // the message so reconnect cannot reinterpret it as a post-only send or
      // a direct model turn after the user changes the active window.
      route: 'agent',
      fallback: 'none',
    });
    const insertError = write.error;

    // The insert result used to be discarded, which left a phantom message on
    // screen after a rejection and then dispatched a messageId the server had
    // never stored. Roll the optimistic row back and say so, exactly as
    // useChat's insertUserMessage does.
    if (insertError) {
      recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, null, userMsgId);
      if (activeSubThreadIdRef.current === targetSessionId) {
        setSubThreadMessages(prev => prev.filter(m => m.id !== userMsgId));
      }
      const failure = classifyWriteFailure(insertError, { online: navigator.onLine });
      if (activeSubThreadIdRef.current === targetSessionId) {
        const notice: Message = {
          id: crypto.randomUUID(),
          session_id: targetSessionId,
          role: 'assistant',
          content: `Couldn't send your message — ${failure.reason}`,
          created_at: new Date().toISOString(),
        };
        recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, notice);
        setSubThreadMessages(prev => applyMessageRow(prev, notice));
      }
      return { delivered: false };
    }
    if (write.queued) {
      if (activeSubThreadIdRef.current === targetSessionId) {
        const notice: Message = {
          id: crypto.randomUUID(),
          session_id: targetSessionId,
          role: 'assistant',
          sender_name: 'Agensis',
          content: 'Queued on this device. It will post and wake the agent when you reconnect.',
          created_at: new Date().toISOString(),
        };
        recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, notice);
        setSubThreadMessages(prev => applyMessageRow(prev, notice));
      }
      return { delivered: true };
    }

    // Dispatch to agent via the existing dispatch endpoint
    const dispatchResponse = await fetch(apiUrl('/backend/agents/dispatch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({
        workspaceId,
        sessionId: targetSessionId,
        messageId: userMsgId,
        content,
        threadParentId: null,
        attachments,
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
        if (activeSubThreadIdRef.current === targetSessionId) {
          recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, next);
          setSubThreadMessages(prev => applyMessageRow(prev, next));
        }
      }
      return { delivered: true };
    }

    // Never substitute a generic model for the agent the user chose. The old
    // fallback called /ai-chat with model:auto and no persona, identity, or
    // configured agent model, then rendered that output as the delegate's.
    const detail = String(dispatchPayload?.error?.message || '').trim();
    if (activeSubThreadIdRef.current === targetSessionId) {
      const notice: Message = {
        id: crypto.randomUUID(),
        session_id: targetSessionId,
        role: 'assistant',
        sender_name: 'Agensis',
        content: detail
          ? `Couldn't reach the configured agent — ${detail}`
          : "Couldn't reach the configured agent. Your message was saved, but no fallback model was run.",
        created_at: new Date().toISOString(),
      };
      recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, notice);
      setSubThreadMessages(prev => applyMessageRow(prev, notice));
    }
    return { delivered: true };
  }, [activeSubThread, workspaceId]);

  return {
    subThreadsByMessage,
    activeSubThread,
    activeSubThreadHostSessionId,
    subThreadMessages,
    subThreadHasMore,
    subThreadLoadingEarlier,
    loadEarlierSubThreadMessages,
    subThreadStreaming: false,
    loadSubThreadsForMessage,
    createSubThread,
    openSubThread,
    closeSubThread,
    sendSubThreadMessage,
  };
}

function normalizeMessage(message: Message): Message {
  return redactDeletedMessage({ ...message, content: messageText(message.content) });
}
