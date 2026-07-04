import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { extractSseDataLines, finalAssistantStreamContent, messageText, parseAiStreamPayload } from '../lib/chatStream';
import { computeThreadDivergence } from '../lib/threadMerge';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { ChannelParticipant, ChatSession, Message, MemoryFact, Document, WorkspaceAgent } from '../types';
import type { WorkspaceContextSnapshot } from './useWorkspaceContext';

export function useChat(workspaceId: string | null, currentUserName?: string) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // Aborts the in-flight AI stream fetch if the hook unmounts mid-stream, so a
  // disposed component never keeps the request alive or writes into dead state.
  const streamAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => streamAbortRef.current?.abort(), []);

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
    // Drop soft-deleted messages (a cleared/closed DM retains its rows in the DB
    // but they must never re-surface). Server read paths filter too; this covers
    // the generic table-select the client uses.
    if (data) setMessages(data.filter(m => !m.deleted_at).map(normalizeMessage));
    setLoading(false);
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

  useEffect(() => {
    if (activeSession) fetchMessages(activeSession.id);
    else setMessages([]);
  }, [activeSession, fetchMessages]);

  const messageDeduper = useRealtimeDeduper();
  const sessionId = activeSession?.id ?? null;
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
    const topLevel = ((sourceMessages || []) as Message[]).filter(m => !m.thread_parent_id);
    if (topLevel.length > 0) {
      const copies = topLevel.map(m => {
        const row: Record<string, unknown> = {
          id: crypto.randomUUID(),
          session_id: forked.id,
          role: m.role,
          content: m.content,
          created_at: m.created_at,
        };
        if (m.sender_kind) row.sender_kind = m.sender_kind;
        if (m.sender_id) row.sender_id = m.sender_id;
        if (m.sender_name) row.sender_name = m.sender_name;
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

  // Top-level messages (no thread parent)
  const topLevelMessages = useMemo(() => messages.filter(m => !m.thread_parent_id), [messages]);

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
  ): Promise<Message> => {
    const userMsg: Message = {
      id: crypto.randomUUID(),
      session_id: session.id,
      role: 'user',
      content,
      sender_name: currentUserName || null,
      thread_parent_id: threadParentId ?? null,
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
    await backendClient.from('messages').insert(insertPayload);

    return userMsg;
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
  ) => {
    const session = targetSession ?? activeSession;
    if (!session) return;

    if (!navigator.onLine) {
      await insertUserMessage(session, content, threadParentId);
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

    const userMsg = await insertUserMessage(session, content, threadParentId);
    await autoTitleSession(session, content, threadParentId);

    let contextMessages: Message[];
    if (threadParentId) {
      contextMessages = messages.filter(m => m.thread_parent_id === threadParentId || m.id === threadParentId);
    } else if (activeSession?.id === session.id) {
      contextMessages = messages;
    } else {
      // Sending to a session other than the one on screen (e.g. a split window):
      // the `messages` state only holds the active session, so load the target's
      // own top-level history rather than sending the agent empty context (L5,
      // 2026-07 review). Don't touch `messages` state (it belongs to the active
      // session); exclude the just-inserted message since dispatch appends it.
      const { data } = await backendClient
        .from('messages')
        .select('*')
        .eq('session_id', session.id)
        .order('created_at', { ascending: true });
      contextMessages = (data || [])
        .filter((m: Message) => !m.deleted_at && !m.thread_parent_id && m.id !== userMsg.id)
        .map(normalizeMessage);
    }

    const { memoryContext, docContext } = buildContextStrings(memoryFacts, linkedDocuments, contextMessages);

    const hasMention = Boolean(firstAgentMention(content));
    const threadHasAgentTarget = Boolean(threadParentId && hasAgentTargetInThread(contextMessages));
    const directParticipant = directAgentParticipantRecord(session);
    const directAgentChannel = Boolean(directParticipant);
    const autoChannel = session.conversation_mode === 'auto';
    const shouldRouteToAgent = Boolean(workspaceId && (hasMention || threadHasAgentTarget || directAgentChannel || autoChannel));

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
      if (dispatched) return;
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
        return;
      }
    } else if (!agent) {
      return;
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
  }, [activeSession, messages, workspaceId, insertUserMessage, autoTitleSession, buildContextStrings, dispatchToAgent, streamDirectAI]);

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
    const parentTop = (parentRes.data || []).filter((m: Message) => !m.thread_parent_id && !m.deleted_at);
    const forkTop = (forkRes.data || []).filter((m: Message) => !m.thread_parent_id && !m.deleted_at);
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
    const userMsg = await insertUserMessage(parent, prompt);
    const dispatched = await dispatchToAgent(parent, userMsg, prompt, parentTop, null, null);

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
