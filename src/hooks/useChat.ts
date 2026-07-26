import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { extractSseDataLines, finalAssistantStreamContent, messageText, parseAiStreamPayload } from '../lib/chatStream';
import { computeThreadDivergence } from '../lib/threadMerge';
import { directAiModel, isSharedModelRoute } from '../lib/chatModelRouting';
import { cachedFetch } from '../lib/offlineBackend';
import { WORKSPACE_UNAVAILABLE, classifyWriteFailure, type WriteFailure } from '../lib/writeFeedback';
import { channelMessages } from '../components/chat/channelView';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { ChannelParticipant, ChatSession, Message, MemoryFact, Document, WorkspaceAgent } from '../types';
import type { WorkspaceContextSnapshot } from './useWorkspaceContext';

// NET-05: a chat window loads the newest MESSAGE_PAGE_SIZE on open and pages
// backwards on demand via /backend/sessions/:id/messages, instead of pulling a
// whole (possibly multi-thousand-row) transcript per open window. Agent CONTEXT
// is fetched independently at dispatch time, so this display cap never truncates
// what an agent sees.
const MESSAGE_PAGE_SIZE = 200;

export interface CreateSessionResult {
  session: ChatSession | null;
  failure: WriteFailure | null;
}

export interface SendMessageResult {
  /** The user's message reached the database. False means it is not saved. */
  delivered: boolean;
  failure: WriteFailure | null;
}

export function useChat(workspaceId: string | null, currentUserName?: string, seedSessions?: ChatSession[] | null) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    if (!seedSessions?.length) return [];
    return seedSessions.filter(s => !s.parent_message_id && !s.deleted_at);
  });
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  // Aborts the in-flight AI stream fetch if the hook unmounts mid-stream, so a
  // disposed component never keeps the request alive or writes into dead state.
  const streamAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => streamAbortRef.current?.abort(), []);

  // A ref mirror of `messages` so callbacks (loadEarlierMessages, dispatch) can
  // read the current list synchronously without taking it as a dependency.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    if (!seedSessions) return;
    const mainSessions = seedSessions.filter(s => !s.parent_message_id && !s.deleted_at);
    setSessions(mainSessions);
    if (mainSessions.length > 0) {
      setActiveSession(prev => prev ?? mainSessions[0]);
    }
  }, [seedSessions]);

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
      const mainSessions = data.filter(s => !s.parent_message_id && !s.deleted_at);
      setSessions(mainSessions);
      if (mainSessions.length > 0) {
        setActiveSession(prev => prev ?? mainSessions[0]);
      }
    }
  }, [workspaceId]);

  // Tracks the session currently on screen, synced DURING render so an in-flight
  // fetchMessages from a previously-active session is ignored when its response
  // lands, with no render→effect window (stale-response guard; mirrors
  // useSessionMessages).
  const activeSessionId = activeSession?.id ?? null;
  const currentSessionRef = useRef<string | null>(activeSessionId);
  currentSessionRef.current = activeSessionId;

  const fetchMessages = useCallback(async (sessionId: string) => {
    setLoading(true);
    // NET-05: load only the newest page on open. The cache key stays per-session
    // so offline reads still work; the endpoint returns { messages, hasMore }.
    const result = await cachedFetch<{ messages: Message[]; hasMore: boolean }>(`messages_page_${sessionId}`, async () => {
      const res = await fetch(apiUrl(`/backend/sessions/${sessionId}/messages?limit=${MESSAGE_PAGE_SIZE}`), {
        headers: apiAuthHeaders(),
      });
      if (!res.ok) return { messages: [], hasMore: false };
      const body = await res.json();
      return body?.data ?? { messages: [], hasMore: false };
    });
    // Stale-response guard: the user may have switched sessions while this was
    // in flight — painting it now would show this session's transcript under
    // the new session's header/composer/thread panel. The newer fetch owns the
    // loading flag from here on, so leave it alone too.
    if (currentSessionRef.current !== sessionId) return;
    const rows = result?.messages ?? [];
    // Drop soft-deleted messages (a cleared/closed DM retains its rows in the DB
    // but they must never re-surface). The server already filters; this is belt.
    setMessages(rows.filter(m => !m.deleted_at).map(normalizeMessage));
    setHasMoreMessages(Boolean(result?.hasMore));
    setLoading(false);
  }, []);

  // NET-05: page backwards. Fetches the page of messages older than the oldest
  // currently-loaded row (compound (created_at,id) cursor) and prepends them.
  const loadEarlierMessages = useCallback(async (sessionId: string) => {
    const oldest = messagesRef.current[0];
    if (!oldest) return;
    setLoadingEarlier(true);
    try {
      const params = new URLSearchParams({
        limit: String(MESSAGE_PAGE_SIZE),
        before: String(oldest.created_at ?? ''),
        beforeId: String(oldest.id ?? ''),
      });
      const res = await fetch(apiUrl(`/backend/sessions/${sessionId}/messages?${params.toString()}`), {
        headers: apiAuthHeaders(),
      });
      if (!res.ok) return;
      const body = await res.json();
      const older = (body?.data?.messages ?? []).filter((m: Message) => !m.deleted_at).map(normalizeMessage);
      setHasMoreMessages(Boolean(body?.data?.hasMore));
      if (older.length > 0) {
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id));
          const deduped = older.filter((m: Message) => !seen.has(m.id));
          return deduped.length > 0 ? [...deduped, ...prev] : prev;
        });
      }
    } finally {
      setLoadingEarlier(false);
    }
  }, []);

  // Drop the previous workspace's active session when the workspace changes.
  // fetchSessions preserves `prev ?? first`, so without this the old
  // workspace's session (and its messages) would stay selected after a
  // switch. Clearing here lets fetchSessions pick the new workspace's first
  // session instead.
  useEffect(() => {
    setActiveSession(null);
  }, [workspaceId]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Depend on the session ID, not the session OBJECT: updateSession /
  // autoTitleSession hand setActiveSession a fresh object for the SAME session,
  // and re-running fetchMessages there replaces `messages` wholesale — wiping
  // client-only rows such as the in-flight streaming assistant placeholder.
  useEffect(() => {
    if (activeSessionId) fetchMessages(activeSessionId);
    // No session to load: clear the transcript and release the loading flag,
    // since the stale-response guard above leaves it to whoever loads next.
    else { setMessages([]); setLoading(false); }
  }, [activeSessionId, fetchMessages]);

  const messageDeduper = useRealtimeDeduper();
  const sessionId = activeSessionId;
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
      if (!messageDeduper.shouldProcess(payload)) return;
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

  // Returns the failure as well as the row. Every caller of this opens a window
  // or sends a message next; when the insert is rejected there is nothing to
  // open, and each of them used to just `return` — which is exactly what the
  // "+ makes no channel and says nothing" report was.
  const createSession = useCallback(async (
    model = 'auto',
    initial: Partial<ChatSession> = {},
  ): Promise<CreateSessionResult> => {
    if (!workspaceId) return { session: null, failure: WORKSPACE_UNAVAILABLE };
    if (!navigator.onLine) return { session: null, failure: classifyWriteFailure(null, { online: false }) };
    const initialFields: Record<string, unknown> = { ...initial };
    delete initialFields.id;
    delete initialFields.workspace_id;
    delete initialFields.created_at;
    delete initialFields.updated_at;
    const { data, error } = await backendClient
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
      return { session: data, failure: null };
    }
    return { session: null, failure: classifyWriteFailure(error, { online: navigator.onLine }) };
  }, [workspaceId]);

  // Split a thread: clone the session as a new top-level thread and copy its
  // full top-level transcript into the fork so it mirrors the original. No
  // agent is dispatched — the human "starts it" by sending the first message
  // (and can @mention a different agent to pit a competitor against the fork).
  const splitSession = useCallback(async (source: ChatSession): Promise<ChatSession | null> => {
    if (!workspaceId) return null;
    if (!navigator.onLine) return null;

    // 1. Clone the session row. Mirror the fields that drive routing/rendering
    //    (folder, participants, conversation_mode, model); the fork stays
    //    top-level (parent_message_id null) so it can spawn its own sub-threads.
    const { data: forked } = await backendClient
      .from('chat_sessions')
      .insert({
        workspace_id: workspaceId,
        title: `${source.title || 'Untitled'} (split)`,
        model: source.model || 'auto',
        conversation_mode: source.conversation_mode ?? 'auto',
        folder: source.folder ?? null,
        canvas_id: source.canvas_id ?? null,
        participants: source.participants ?? null,
        // Lineage: link the fork to its source so the sidebar can render it
        // indented under the parent, and merge can diff messages after the
        // divergence point (split_at).
        split_parent_id: source.id,
        split_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (!forked) return null;

    // 2. Copy every top-level message into the fork, preserving authorship and
    //    order. created_at is carried over so a single bulk insert (which would
    //    otherwise stamp identical now() values) keeps the original ordering.
    const { data: sourceMessages } = await backendClient
      .from('messages')
      .select('*')
      .eq('session_id', source.id)
      .order('created_at', { ascending: true });

    // Copy only top-level messages (not in-session sub-thread replies). The
    // backendClient query builder has no `.is()`, so filter client-side exactly
    // like the main view does (see topLevelMessages below).
    const topLevel = channelMessages((sourceMessages || []) as Message[]);
    if (topLevel.length > 0) {
      // Every copy MUST carry the same keys: both backends derive the INSERT
      // column list from the first row only, so a key that is absent from
      // copies[0] is silently dropped for the whole batch — a channel that
      // opens with a human message (no sender_*) would strip agent identity
      // from every copied agent reply. Emit `?? null` instead of omitting.
      const copies = topLevel.map(m => {
        const row: Record<string, unknown> = {
          id: crypto.randomUUID(),
          session_id: forked.id,
          role: m.role,
          content: m.content,
          created_at: m.created_at,
          sender_kind: m.sender_kind ?? null,
          sender_id: m.sender_id ?? null,
          sender_name: m.sender_name ?? null,
        };
        return row;
      });
      await backendClient.from('messages').insert(copies);
    }

    // 3. Register the fork. The caller opens it as its own (non-active) split
    //    window; it fetches the copied rows itself via useSessionMessages, so
    //    it never needs to borrow the parent's active-session state.
    setSessions(prev => [forked, ...prev]);
    return forked;
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

  // What the CHANNEL shows: top-level messages PLUS thread replies explicitly
  // broadcast to the channel. An agent works inside a thread now (placeholder,
  // tool chips, intermediate blocks all stay there) and only its final answer is
  // flagged, so filtering on thread_parent_id alone would leave the channel empty
  // apart from the human's own messages. See components/chat/channelView.ts.
  const topLevelMessages = useMemo(() => channelMessages(messages), [messages]);

  // Thread messages for the active thread
  const threadMessages = useMemo(() => activeThreadId
    ? messages.filter(m => m.thread_parent_id === activeThreadId || m.id === activeThreadId)
    : [], [messages, activeThreadId]);

  // Thread reply counts per parent message
  const threadReplyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    messages.forEach(m => {
      if (m.thread_parent_id) {
        counts[m.thread_parent_id] = (counts[m.thread_parent_id] || 0) + 1;
      }
    });
    return counts;
  }, [messages]);

  const openThread = useCallback((messageId: string) => {
    setActiveThreadId(messageId);
  }, []);

  const closeThread = useCallback(() => {
    setActiveThreadId(null);
  }, []);

  const insertUserMessage = useCallback(async (
    session: ChatSession,
    content: string,
    threadParentId?: string | null,
    broadcastToChannel?: boolean,
  ): Promise<{ message: Message | null; error: { message: string; code?: string | null } | null }> => {
    // "Send to channel" from the thread composer. Only meaningful for a reply that
    // has a thread to be broadcast OUT of — a top-level message is already in the
    // channel, and flagging it would just make it render its own "from a thread"
    // affordance pointing nowhere.
    const broadcast = Boolean(broadcastToChannel && threadParentId);
    const userMsg: Message = {
      id: crypto.randomUUID(),
      session_id: session.id,
      role: 'user',
      content,
      sender_name: currentUserName || null,
      thread_parent_id: threadParentId ?? null,
      broadcast_to_channel: broadcast,
      created_at: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMsg]);

    const insertPayload: Record<string, unknown> = {
      id: userMsg.id,
      session_id: session.id,
      role: 'user',
      content,
    };
    if (currentUserName) insertPayload.sender_name = currentUserName;
    if (threadParentId) insertPayload.thread_parent_id = threadParentId;
    if (broadcast) insertPayload.broadcast_to_channel = true;
    const { error } = await backendClient.from('messages').insert(insertPayload);

    // backendClient swallows HTTP failures into { error } instead of throwing,
    // so an unchecked insert left a phantom message on screen after a 403
    // (viewer role), 429 (rate limit) or 500 — and the caller then dispatched a
    // messageId the server never stored. Roll the optimistic row back like the
    // other optimistic mutations do (see handleTogglePin) and report the error.
    // Offline sends are exempt: sendMessage's offline branch deliberately keeps
    // the row and posts its own "will be sent when you reconnect" notice.
    if (error && navigator.onLine) {
      setMessages(prev => prev.filter(m => m.id !== userMsg.id));
      return { message: null, error };
    }

    return { message: userMsg, error };
  }, [currentUserName]);

  const autoTitleSession = useCallback(async (
    session: ChatSession,
    content: string,
    threadParentId?: string | null,
  ) => {
    if (threadParentId) return;
    if (session.title !== 'New Chat' && session.title !== 'New Channel') return;

    const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
    await backendClient
      .from('chat_sessions')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', session.id);
    setSessions(prev => prev.map(s => s.id === session.id ? { ...s, title } : s));
    setActiveSession(prev => prev?.id === session.id ? { ...prev, title } : prev);
  }, []);

  const buildContextStrings = useCallback((
    memoryFacts?: MemoryFact[],
    linkedDocuments?: Document[],
    contextMessages?: Message[],
  ) => {
    const memoryContext = memoryFacts && memoryFacts.length > 0
      ? memoryFacts.map(f => `[${f.category}] ${f.fact}`).join('\n')
      : null;

    const docContext = linkedDocuments && linkedDocuments.length > 0
      ? linkedDocuments.map(d => `--- Document: ${d.title} ---\n${d.content?.replace(/<[^>]+>/g, '') || ''}`).join('\n\n')
      : null;

    const messagesPayload = (contextMessages || []).map(m => ({
      role: m.role,
      content: messageText(m.content),
    }));

    return { memoryContext, docContext, messagesPayload };
  }, []);

  const dispatchToAgent = useCallback(async (
    session: ChatSession,
    userMsg: Message,
    content: string,
    contextMessages: Message[],
    memoryContext: string | null,
    docContext: string | null,
    workspaceContext?: WorkspaceContextSnapshot | null,
    threadParentId?: string | null,
  ): Promise<boolean> => {
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
      return true;
    }

    if (dispatchResponse?.ok && dispatchPayload?.data?.dispatched) {
      return true;
    }

    return false;
  }, [workspaceId]);

  const streamDirectAI = useCallback(async (
    session: ChatSession,
    userMsg: Message,
    model: string,
    contextMessages: Message[],
    memoryContext: string | null,
    docContext: string | null,
    workspaceContext?: WorkspaceContextSnapshot | null,
    agent?: WorkspaceAgent | null,
    directParticipant?: { name?: string | null; handle?: string | null; agent_id?: string | null } | null,
    threadParentId?: string | null,
  ) => {
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

    let flushHandle: number | null = null;

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

      const controller = new AbortController();
      streamAbortRef.current = controller;
      const response = await fetch(apiUrl('/backend/ai-chat'), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...apiAuthHeaders(),
        },
        body: JSON.stringify({
          workspaceId,
          messages: [...contextMessages, userMsg].map(m => ({ role: m.role, content: messageText(m.content) })),
          model: directAiModel(model, agent?.model),
          memory: memoryContext,
          documents: docContext,
          workspaceContext: workspaceContext ?? null,
          agentContext,
        }),
      });

      if (!response.ok || !response.body) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errorMessage(errData.error || errData.message || 'Failed to connect to AI service');
        setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: errMsg } : m));
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
      let streamError = '';
      let streamBuffer = '';

      const flushStreamContent = () => {
        flushHandle = null;
        const snapshot = fullContent;
        setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: snapshot } : m));
      };

      const consumeStreamData = (data: string) => {
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const { text, error } = parseAiStreamPayload(parsed);
          if (error) {
            streamError = error;
          }
          if (text) {
            fullContent += text;
            if (flushHandle === null) flushHandle = requestAnimationFrame(flushStreamContent);
          }
        } catch {
          // Ignore malformed stream chunks and keep consuming the stream.
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamBuffer += decoder.decode(value, { stream: true });
        const { data, remainder } = extractSseDataLines(streamBuffer);
        streamBuffer = remainder;
        data.forEach(consumeStreamData);
      }

      const flushed = decoder.decode();
      if (flushed) streamBuffer += flushed;
      if (streamBuffer) {
        const { data } = extractSseDataLines(streamBuffer, true);
        for (const item of data) {
          consumeStreamData(item);
        }
      }

      if (flushHandle !== null) { cancelAnimationFrame(flushHandle); flushHandle = null; }

      const finalContent = finalAssistantStreamContent(fullContent, streamError);
      setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: finalContent } : m));

      const assistantInsert: Record<string, unknown> = {
        id: assistantMsgId,
        session_id: session.id,
        role: 'assistant',
        content: finalContent,
        sender_kind: agent || directParticipant ? 'agent' : '',
        sender_id: agent?.id || directParticipant?.agent_id || directParticipant?.handle || '',
        sender_name: agent?.name || directParticipant?.name || directParticipant?.handle || '',
      };
      if (threadParentId) assistantInsert.thread_parent_id = threadParentId;
      await backendClient.from('messages').insert(assistantInsert);
    } catch (error) {
      if (flushHandle !== null) { cancelAnimationFrame(flushHandle); flushHandle = null; }
      // Unmount aborted the stream — the component is gone, skip all state writes.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const errMsg = errorMessage(error || 'Something went wrong. Please try again.');
      setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: errMsg } : m));
    } finally {
      setStreaming(false);
    }
  }, [workspaceId]);

  const sendMessage = useCallback(async (
    content: string,
    model: string,
    memoryFacts?: MemoryFact[],
    linkedDocuments?: Document[],
    workspaceContext?: WorkspaceContextSnapshot | null,
    agent?: WorkspaceAgent | null,
    threadParentId?: string | null,
    targetSession?: ChatSession | null,
    broadcastToChannel?: boolean,
  ): Promise<SendMessageResult> => {
    const session = targetSession ?? activeSession;
    // No session to send into: the composer must keep the draft rather than
    // clearing it into nothing.
    if (!session) return { delivered: false, failure: WORKSPACE_UNAVAILABLE };

    if (!navigator.onLine) {
      await insertUserMessage(session, content, threadParentId, broadcastToChannel);
      const offlineReply: Message = {
        id: crypto.randomUUID(),
        session_id: session.id,
        role: 'assistant',
        content: 'You are currently offline. Your message will be sent when you reconnect.',
        thread_parent_id: threadParentId ?? null,
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, offlineReply]);
      // Deliberately reported as delivered: the offline branch keeps the row on
      // screen and posts its own notice, so the user's words are still visible
      // and the composer is free to clear.
      return { delivered: true, failure: null };
    }

    const { message: userMsg, error: sendError } = await insertUserMessage(session, content, threadParentId, broadcastToChannel);
    // The message never reached the DB (viewer role, rate limit, server error).
    // The optimistic row is already rolled back; say why and abort before
    // dispatch/stream run against a messageId the server has never seen.
    if (!userMsg) {
      if (activeSession?.id === session.id) {
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          session_id: session.id,
          role: 'assistant',
          content: `Couldn't send your message — ${errorMessage(sendError)}`,
          thread_parent_id: threadParentId ?? null,
          created_at: new Date().toISOString(),
        }]);
      }
      // Not delivered: the composer restores the draft so the words the user
      // typed are not destroyed along with the send.
      return { delivered: false, failure: classifyWriteFailure(sendError, { online: navigator.onLine }) };
    }
    await autoTitleSession(session, content, threadParentId);

    // NET-05: the on-screen `messages` state is a PAGINATED window (newest page
    // only), so it must NOT be used as agent context — that would silently
    // truncate history for both thread and top-level dispatch. Load the session's
    // FULL history from the DB once, then derive the right context from it.
    // Exclude the just-inserted user message (dispatch appends it) and deleted rows.
    const { data: fullHistory } = await backendClient
      .from('messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: true });
    const sessionMessages: Message[] = (fullHistory || [])
      .filter((m: Message) => !m.deleted_at && m.id !== userMsg.id)
      .map(normalizeMessage);
    let contextMessages: Message[];
    if (threadParentId) {
      contextMessages = sessionMessages.filter((m: Message) => m.thread_parent_id === threadParentId || m.id === threadParentId);
    } else {
      // Mirror the server's channel-level context (loadChannelMessages): top-level
      // plus broadcast thread replies. Without the broadcast half, a channel whose
      // agents work in threads would look to the model like nobody ever answered.
      contextMessages = channelMessages(sessionMessages);
    }

    const { memoryContext, docContext } = buildContextStrings(memoryFacts, linkedDocuments, contextMessages);

    const hasMention = Boolean(firstAgentMention(content));
    const threadHasAgentTarget = Boolean(threadParentId && hasAgentTargetInThread(contextMessages));
    const directParticipant = directAgentParticipantRecord(session);
    const directAgentChannel = Boolean(directParticipant);
    // A "Direct messages" session is always agent-routable, even if its participant
    // record is degraded/missing (legacy DMs) — the server resolves the target
    // agent by folder + title. Without this, a DM with a null direct participant
    // would hit neither directAgentChannel nor autoChannel (autoChannel excludes
    // DMs) and silently never dispatch, so the agent never replies.
    const folderDm = session.folder === 'Direct messages';
    // AUTO is always on for channels now (no per-channel toggle): any non-DM
    // channel lets participant agents chime in on new messages. DMs route via
    // their direct participant or the folder fallback above.
    const autoChannel = session.folder !== 'Direct messages';
    const sharedModelRoute = isSharedModelRoute(model);
    const shouldRouteToAgent = Boolean(!sharedModelRoute && workspaceId && (hasMention || threadHasAgentTarget || directAgentChannel || folderDm || autoChannel));

    if (shouldRouteToAgent) {
      const dispatched = await dispatchToAgent(
        session,
        userMsg,
        content,
        contextMessages,
        memoryContext,
        docContext,
        workspaceContext,
        threadParentId,
      );
      if (dispatched) return { delivered: true, failure: null };
      // Dispatch failed. If there's a direct-AI fallback (agent/direct
      // participant) fall through to it; otherwise surface the failure instead
      // of returning silently and leaving the user's message looking sent (M6).
      // Only append the notice when the target is the on-screen session — the
      // `messages` state belongs to the active session, so writing a foreign
      // session_id row into it would surface the error in the wrong pane.
      if (!agent && !directParticipant) {
        if (activeSession?.id === session.id) {
          setMessages(prev => [...prev, {
            id: crypto.randomUUID(),
            session_id: session.id,
            role: 'assistant',
            content: "Couldn't reach the agent — your message was posted but no reply was generated. Please try sending it again.",
            thread_parent_id: threadParentId ?? null,
            created_at: new Date().toISOString(),
          }]);
        }
        // The message itself IS saved — only the reply is missing — so the
        // composer keeps its clear. The notice above owns the explanation.
        return { delivered: true, failure: null };
      }
    } else if (!agent && !sharedModelRoute) {
      return { delivered: true, failure: null };
    }

    await streamDirectAI(
      session,
      userMsg,
      model,
      contextMessages,
      memoryContext,
      docContext,
      workspaceContext,
      agent,
      directParticipant,
      threadParentId,
    );
    return { delivered: true, failure: null };
  }, [activeSession, workspaceId, insertUserMessage, autoTitleSession, buildContextStrings, dispatchToAgent, streamDirectAI]);

  // Merge a split fork back into its parent. "What changed" = the messages
  // created after split_at on BOTH branches — the parent kept talking while the
  // fork ran a competing line (split exists precisely to pit two answers against
  // each other). We post those two divergences into the parent as one synthesis
  // request and let the parent's agent reconcile them into a single solution via
  // the normal async dispatch path — no new pipeline, no frozen UI. The request
  // embeds the fork's divergent content verbatim, so nothing is lost even if the
  // parent has no agent wired to respond. The fork is then soft-deleted (data
  // retained), per the merge decision: result → parent, source → soft-delete.
  const mergeSession = useCallback(async (
    fork: ChatSession,
  ): Promise<{ status: 'merged' | 'empty' | 'error'; parent?: ChatSession }> => {
    if (!workspaceId || !navigator.onLine) return { status: 'error' };
    const parentId = fork.split_parent_id;
    const splitAt = fork.split_at;
    if (!parentId || !splitAt) return { status: 'error' };

    const parent = sessions.find(s => s.id === parentId);
    if (!parent) return { status: 'error' };

    // Pull both full transcripts; isolate each branch's post-split divergence.
    const [parentRes, forkRes] = await Promise.all([
      backendClient.from('messages').select('*').eq('session_id', parentId).order('created_at', { ascending: true }),
      backendClient.from('messages').select('*').eq('session_id', fork.id).order('created_at', { ascending: true }),
    ]);
    // Channel view, not strictly top level: an agent's answer is now a BROADCAST
    // thread reply, so a top-level-only diff would show the two branches' human
    // prompts and none of the answers the merge is supposed to reconcile.
    const parentTop = channelMessages((parentRes.data || []).filter((m: Message) => !m.deleted_at));
    const forkTop = channelMessages((forkRes.data || []).filter((m: Message) => !m.deleted_at));
    // Divergence by set-difference of the shared (copied) history — clock-skew
    // safe (M7); see computeThreadDivergence.
    const { parentDiverged, forkDiverged } = computeThreadDivergence(parentTop, forkTop);

    // Nothing happened in the fork after the split → merge is pure cleanup.
    if (forkDiverged.length === 0) {
      await backendClient.from('chat_sessions').update({ deleted_at: new Date().toISOString() }).eq('id', fork.id);
      setSessions(prev => prev.filter(s => s.id !== fork.id));
      setActiveSession(parent);
      return { status: 'empty', parent };
    }

    const fmt = (msgs: Message[]) =>
      msgs.map(m => `${m.sender_name || m.role}: ${messageText(m.content)}`).join('\n\n') || '(no further messages)';
    const prompt =
      `Merge two diverged branches of this thread into a single combined solution.\n\n` +
      `Both branches share this thread's history up to the split. After the split they diverged:\n\n` +
      `=== This thread continued ===\n${fmt(parentDiverged)}\n\n` +
      `=== Split branch "${fork.title || 'Untitled'}" continued ===\n${fmt(forkDiverged)}\n\n` +
      `Reconcile them: keep the best of each, resolve any conflicts, and produce one combined result. ` +
      `If one branch is clearly better, use it and say why.`;

    // Land on the parent so the synthesis renders in place, then dispatch.
    setActiveSession(parent);
    const { message: userMsg } = await insertUserMessage(parent, prompt);
    // A rejected insert leaves nothing for the agent to answer, so treat it
    // exactly like a failed dispatch below: keep the fork, surface the failure.
    const dispatched = userMsg
      ? await dispatchToAgent(parent, userMsg, prompt, parentTop, null, null)
      : false;

    // If the synthesis dispatch failed, keep the fork (do NOT soft-delete) so
    // the merge can be retried, and surface the failure instead of silently
    // destroying the branch with no synthesis (M6).
    if (!dispatched) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        session_id: parent.id,
        role: 'assistant',
        content: "Couldn't reach the agent to synthesize the merge — the split branch has been kept. Please try merging again.",
        created_at: new Date().toISOString(),
      }]);
      return { status: 'error', parent };
    }

    // Source split done — soft-delete (retain data for audit/history).
    await backendClient.from('chat_sessions').update({ deleted_at: new Date().toISOString() }).eq('id', fork.id);
    setSessions(prev => prev.filter(s => s.id !== fork.id));

    return { status: 'merged', parent };
  }, [workspaceId, sessions, insertUserMessage, dispatchToAgent]);

  // Soft delete: never hard-delete a session — stamp deleted_at so the data
  // is retained (for audit/merge/history) and filtered out of every load path
  // (see fetchSessions). Row disappears from the UI immediately.
  const deleteSession = useCallback(async (id: string) => {
    await backendClient
      .from('chat_sessions')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSession?.id === id) {
      setActiveSession(null);
      setMessages([]);
    }
  }, [activeSession]);

  // Clear + close a conversation: soft-delete every message in the thread AND
  // soft-delete (close) the session, in one action. Nothing is hard-deleted —
  // both the messages and the session keep their rows (stamped deleted_at) so the
  // data is retained, but they're filtered out of every read path (sidebar, DM
  // resolution, message fetch, agent search/digest/context). Used by the DM row's
  // "Delete conversation" action.
  const closeAndClearSession = useCallback(async (id: string) => {
    const stamp = new Date().toISOString();
    await backendClient.from('messages').update({ deleted_at: stamp }).eq('session_id', id);
    await backendClient.from('chat_sessions').update({ deleted_at: stamp }).eq('id', id);
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
    hasMoreMessages,
    loadingEarlier,
    loadEarlierMessages,
    createSession,
    splitSession,
    updateSession,
    archiveSession,
    sendMessage,
    deleteSession,
    closeAndClearSession,
    mergeSession,
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
  const out: string[] = [];
  const add = (item: unknown) => {
    const text = String(item || '').trim();
    if (text) out.push(text);
  };
  const objectToken = (input: Record<string, unknown>) => {
    for (const key of ['label', 'name', 'id', 'type']) {
      const token = input[key];
      if (typeof token === 'string' && token.trim()) return token.trim();
    }
    return '';
  };
  if (Array.isArray(value)) {
    value.forEach(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) add(objectToken(item as Record<string, unknown>));
      else add(item);
    });
    return Array.from(new Set(out));
  }
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
  if (value && typeof value === 'object') {
    add(objectToken(value as Record<string, unknown>));
    return Array.from(new Set(out));
  }
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
