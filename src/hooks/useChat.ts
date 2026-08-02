import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { extractSseDataLines, finalAssistantStreamContent, messageText, parseAiStreamPayload } from '../lib/chatStream';
import { directAiModel, isSharedModelRoute } from '../lib/chatModelRouting';
import {
  buildQuotedSessionContext,
  QUOTED_CONTEXT_MESSAGE_LIMIT,
} from '../lib/quotedSessionContext';
import {
  cachedFetch,
  offlineMessageSendResult,
  redactCachedSessionMessages,
} from '../lib/offlineBackend';
import type { OfflineMessageDispatch, OfflineMessageRoute } from '../lib/offlineBackend';
import { announceActivityRedaction } from '../lib/activityRedaction';
import { linkedDocumentContext } from '../lib/linkedDocumentContext';
import { WORKSPACE_UNAVAILABLE, classifyWriteFailure, type WriteFailure } from '../lib/writeFeedback';
import { channelMessages } from '../components/chat/channelView';
import { isToolStepMessage } from '../components/chat/toolSteps';
import { allowsUnpromptedReply, mentionsChannel } from '../lib/channelMentions';
import { isHuddleSession } from '../lib/huddleTranscript';
import { dedupeSessionParticipants } from '../lib/sessionParticipants';
import { redactDeletedMessage } from '../lib/messageTombstone';
import {
  applyMessageRow,
  createMessageSnapshotOverlay,
  reconcileMessageSnapshot,
  recordMessageSnapshotChange,
  resetMessageSnapshotOverlay,
} from '../lib/messageSnapshot';
import { closeSession as closeSessionControl } from '../lib/sessionControl';
import {
  buildMergeSynthesisPrompt,
  createMergeSynthesisPoller,
  isDurableMergeSynthesis,
  MERGE_BRANCH_MESSAGE_LIMIT,
  splitDivergence,
} from '../lib/threadMerge';
import { reconcileWorkspaceSessions } from '../lib/sessionRealtime';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useSessionRevocationSignal } from './useSessionRevocationSignal';
import { useWorkspaceListState, useWorkspaceState } from './useWorkspaceState';
import type { ChannelParticipant, ChatSession, Message, MemoryFact, MessageAttachment, Document, WorkspaceAgent } from '../types';
import type { WorkspaceContextSnapshot } from './useWorkspaceContext';

// NET-05: a chat window loads the newest MESSAGE_PAGE_SIZE on open and pages
// backwards on demand via /backend/sessions/:id/messages, instead of pulling a
// whole (possibly multi-thousand-row) transcript per open window. Agent CONTEXT
// is fetched independently at dispatch time, so this display cap never truncates
// what an agent sees.
const MESSAGE_PAGE_SIZE = 200;
// Tool steps and thread-only replies can dominate a busy run. Fetch a bounded
// surplus, then apply the channel-visible filter before taking the final quote
// window; limiting to twelve in SQL first could yield an empty "context" even
// while useful channel messages existed immediately behind those rows.
const QUOTED_CONTEXT_FETCH_LIMIT = QUOTED_CONTEXT_MESSAGE_LIMIT * 4;

/**
 * Carry context as one clearly-labelled quote authored by the person doing the
 * import. Cloning the source rows would make an agent or another human appear
 * to have spoken natively in the target conversation and would recreate the
 * attribution-forgery surface the generic message guard closes.
 */
async function importQuotedSessionContext(
  source: ChatSession,
  targetSessionId: string,
): Promise<boolean> {
  const { data, error } = await backendClient
    .from('messages')
    .select('*')
    .eq('session_id', source.id)
    .order('created_at', { ascending: false })
    .limit(QUOTED_CONTEXT_FETCH_LIMIT);
  if (error) return false;

  const sourceMessages = channelMessages(
    (data || []).filter((message: Message) => !message.deleted_at && !isToolStepMessage(message)),
  )
    .slice(0, QUOTED_CONTEXT_MESSAGE_LIMIT)
    .reverse();
  const content = buildQuotedSessionContext(source.title || 'Untitled', sourceMessages);
  const result = await backendClient.from('messages').insert({
    id: crypto.randomUUID(),
    session_id: targetSessionId,
    content,
    attachments: [],
  });
  return !result.error;
}

/**
 * What /backend/agents/dispatch decided.
 *
 * 'declined' exists because a bare boolean conflated "the channel chose not to
 * wake anyone" with "dispatch broke", and the two want opposite handling: the
 * first is the feature working, the second gets a fallback reply or a visible
 * notice. See the reason constant below.
 */
type DispatchOutcome = 'dispatched' | 'declined' | 'failed';

/** The server's reason for a deliberate non-dispatch. Must match server/index.cjs. */
const DISPATCH_DECLINED_ON_MENTION_ONLY = 'channel_replies_on_mention_only';

export interface CreateSessionResult {
  session: ChatSession | null;
  failure: WriteFailure | null;
}

export interface SendMessageResult {
  /** The user's message reached the database. False means it is not saved. */
  delivered: boolean;
  failure: WriteFailure | null;
}

/**
 * The sessions that are CHANNELS — the ones a person navigates between.
 *
 * Sub-threads are excluded by their parent_message_id, as they always were.
 * Huddle transcripts have to be excluded explicitly: they carry no
 * parent_message_id, so without this they are indistinguishable from a channel,
 * and since the list is ordered by `updated_at` the app would open into the
 * last voice call anybody held instead of into a real channel.
 */
function mainSessionsOf(sessions: ChatSession[]): ChatSession[] {
  return sessions.filter(s => !s.parent_message_id && !s.deleted_at && !isHuddleSession(s));
}

export function useChat(
  workspaceId: string | null,
  currentUserName?: string,
  seedSessions?: ChatSession[] | null,
  currentUserId?: string,
) {
  const [sessions, setSessions, beginSessionsRequest] = useWorkspaceListState<ChatSession>(
    workspaceId,
    mainSessionsOf(seedSessions || []).filter(session => session.workspace_id === workspaceId),
  );
  const [activeSession, setActiveSession] = useWorkspaceState<ChatSession | null>(workspaceId, null, null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [, forceStreamingRender] = useState(0);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [closedSessionIds, setClosedSessionIds] = useState<string[]>([]);

  // Aborts the in-flight AI stream fetch if the hook unmounts mid-stream, so a
  // disposed component never keeps the request alive or writes into dead state.
  const streamAbortRefs = useRef(new Map<string, AbortController>());
  const streamingSessionIdsRef = useRef(new Set<string>());
  const pendingMergeForksRef = useRef(new Set<string>());
  const mergeWatchCleanupRefs = useRef(new Set<() => void>());
  useEffect(() => () => {
    for (const controller of streamAbortRefs.current.values()) controller.abort();
    streamAbortRefs.current.clear();
    streamingSessionIdsRef.current.clear();
    for (const cleanup of mergeWatchCleanupRefs.current) cleanup();
    mergeWatchCleanupRefs.current.clear();
    pendingMergeForksRef.current.clear();
  }, []);

  // A ref mirror of `messages` so callbacks (loadEarlierMessages, dispatch) can
  // read the current list synchronously without taking it as a dependency.
  const messagesRef = useRef<Message[]>([]);
  const snapshotOverlayRef = useRef(createMessageSnapshotOverlay());
  const closedSessionIdsRef = useRef(new Set<string>());
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    if (!seedSessions) return;
    const mainSessions = mainSessionsOf(seedSessions)
      .filter(session => session.workspace_id === workspaceId);
    setSessions(mainSessions);
    if (mainSessions.length > 0) {
      setActiveSession(prev => prev ?? mainSessions[0]);
    }
  }, [seedSessions, setActiveSession, setSessions, workspaceId]);

  const fetchSessions = useCallback(async () => {
    const isCurrent = beginSessionsRequest();
    if (!workspaceId) {
      setSessions([]);
      setActiveSession(null);
      return;
    }
    const data = await cachedFetch<ChatSession[]>(`sessions_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('chat_sessions')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('updated_at', { ascending: false });
      return data;
    });
    if (isCurrent() && data) {
      const mainSessions = mainSessionsOf(data);
      setSessions(mainSessions);
      if (mainSessions.length > 0) {
        setActiveSession(prev => prev ?? mainSessions[0]);
      }
    }
  }, [beginSessionsRequest, setActiveSession, setSessions, workspaceId]);

  // Tracks the session currently on screen, synced DURING render so an in-flight
  // fetchMessages from a previously-active session is ignored when its response
  // lands, with no render→effect window (stale-response guard; mirrors
  // useSessionMessages).
  const activeSessionId = activeSession?.id ?? null;
  const currentSessionRef = useRef<string | null>(activeSessionId);
  currentSessionRef.current = activeSessionId;
  resetMessageSnapshotOverlay(snapshotOverlayRef.current, activeSessionId);
  const streaming = Boolean(activeSessionId && streamingSessionIdsRef.current.has(activeSessionId));

  const setSessionStreaming = useCallback((targetSessionId: string, active: boolean) => {
    const set = streamingSessionIdsRef.current;
    const changed = active ? !set.has(targetSessionId) : set.has(targetSessionId);
    if (!changed) return;
    if (active) set.add(targetSessionId);
    else set.delete(targetSessionId);
    forceStreamingRender(value => value + 1);
  }, []);

  const commitMessages = useCallback((
    updater: (previous: Message[]) => Message[],
  ) => {
    setMessages(previous => {
      const next = updater(previous);
      messagesRef.current = next;
      return next;
    });
  }, []);

  const applyScopedMessage = useCallback((targetSessionId: string, row: Message) => {
    if (currentSessionRef.current !== targetSessionId) return;
    const normalized = normalizeMessage(row);
    recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, normalized);
    commitMessages(previous => applyMessageRow(previous, normalized));
  }, [commitMessages]);

  const patchScopedMessage = useCallback((
    targetSessionId: string,
    messageId: string,
    patch: Partial<Message>,
  ) => {
    if (currentSessionRef.current !== targetSessionId) return;
    commitMessages(previous => previous.map(message => {
      if (message.id !== messageId) return message;
      const next = normalizeMessage({ ...message, ...patch });
      recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, next);
      return next;
    }));
  }, [commitMessages]);

  const removeScopedMessage = useCallback((targetSessionId: string, messageId: string) => {
    if (currentSessionRef.current !== targetSessionId) return;
    recordMessageSnapshotChange(snapshotOverlayRef.current, targetSessionId, null, messageId);
    commitMessages(previous => previous.filter(message => message.id !== messageId));
  }, [commitMessages]);

  const clearSessionState = useCallback((targetSessionId: string) => {
    closedSessionIdsRef.current.add(targetSessionId);
    setClosedSessionIds(previous => (
      previous.includes(targetSessionId) ? previous : [...previous, targetSessionId]
    ));
    setSessions(previous => previous.filter(session => session.id !== targetSessionId));
    const controller = streamAbortRefs.current.get(targetSessionId);
    controller?.abort();
    streamAbortRefs.current.delete(targetSessionId);
    setSessionStreaming(targetSessionId, false);
    if (currentSessionRef.current !== targetSessionId) return;
    resetMessageSnapshotOverlay(snapshotOverlayRef.current, null);
    messagesRef.current = [];
    setMessages([]);
    setHasMoreMessages(false);
    setLoading(false);
    setLoadingEarlier(false);
    setActiveThreadId(null);
    setActiveSession(previous => (previous?.id === targetSessionId ? null : previous));
  }, [setActiveSession, setSessionStreaming, setSessions]);

  useSessionRevocationSignal(activeSessionId, clearSessionState);

  const fetchMessages = useCallback(async (sessionId: string) => {
    if (closedSessionIdsRef.current.has(sessionId)) {
      messagesRef.current = [];
      setMessages([]);
      setHasMoreMessages(false);
      setLoading(false);
      return;
    }
    if (currentSessionRef.current === sessionId) setLoading(true);
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
    if (
      currentSessionRef.current !== sessionId
      || closedSessionIdsRef.current.has(sessionId)
    ) return;
    const rows = result?.messages ?? [];
    // Deleted roots stay as redacted tombstones so retained replies and
    // sub-threads still have an anchor. normalizeMessage is the client-side
    // backstop if an older backend sends the unredacted retained row.
    const reconciled = reconcileMessageSnapshot(
      rows.map(normalizeMessage),
      snapshotOverlayRef.current,
      sessionId,
    );
    messagesRef.current = reconciled;
    setMessages(reconciled);
    setHasMoreMessages(Boolean(result?.hasMore));
    setLoading(false);
  }, []);

  // NET-05: page backwards. Fetches the page of messages older than the oldest
  // currently-loaded row (compound (created_at,id) cursor) and prepends them.
  const loadEarlierMessages = useCallback(async (sessionId: string) => {
    if (
      closedSessionIdsRef.current.has(sessionId)
      || currentSessionRef.current !== sessionId
    ) return;
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
      const older = (body?.data?.messages ?? []).map(normalizeMessage);
      if (
        currentSessionRef.current !== sessionId
        || closedSessionIdsRef.current.has(sessionId)
      ) return;
      setHasMoreMessages(Boolean(body?.data?.hasMore));
      if (older.length > 0) {
        commitMessages(prev => {
          const seen = new Set(prev.map(m => m.id));
          const deduped = older.filter((m: Message) => !seen.has(m.id));
          return deduped.length > 0 ? [...deduped, ...prev] : prev;
        });
      }
    } finally {
      if (currentSessionRef.current === sessionId) setLoadingEarlier(false);
    }
  }, [commitMessages]);

  // Drop the previous workspace's active session when the workspace changes.
  // fetchSessions preserves `prev ?? first`, so without this the old
  // workspace's session (and its messages) would stay selected after a
  // switch. Clearing here lets fetchSessions pick the new workspace's first
  // session instead.
  useEffect(() => {
    setActiveSession(null);
    closedSessionIdsRef.current.clear();
    setClosedSessionIds([]);
  }, [setActiveSession, workspaceId]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Depend on the session ID, not the session OBJECT: updateSession /
  // autoTitleSession hand setActiveSession a fresh object for the SAME session,
  // and re-running fetchMessages there replaces `messages` wholesale — wiping
  // client-only rows such as the in-flight streaming assistant placeholder.
  useLayoutEffect(() => {
    messagesRef.current = [];
    setMessages([]);
    setHasMoreMessages(false);
    setLoadingEarlier(false);
    setActiveThreadId(null);
    if (activeSessionId) fetchMessages(activeSessionId);
    // No session to load: clear the transcript and release the loading flag,
    // since the stale-response guard above leaves it to whoever loads next.
    else { setLoading(false); }
  }, [activeSessionId, fetchMessages]);

  const messageDeduper = useRealtimeDeduper();
  const sessionId = activeSessionId;
  const sessionDeduper = useRealtimeDeduper();
  useTableSubscription<ChatSession>(
    {
      enabled: Boolean(workspaceId),
      channelName: `chat-sessions:${workspaceId || ''}`,
      table: 'chat_sessions',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId || ''}`,
    },
    (payload) => {
      if (!sessionDeduper.shouldProcess(payload)) return;
      const row = payload.new || payload.old;
      if (!row?.id || String(row.workspace_id || '') !== String(workspaceId || '')) return;
      const reconciliation = reconcileWorkspaceSessions(sessions, payload, workspaceId);
      if (reconciliation.closedSessionId) {
        const id = reconciliation.closedSessionId;
        void redactCachedSessionMessages(id).catch(() => {});
        announceActivityRedaction({ sessionId: id });
        clearSessionState(id);
        return;
      }
      if (row.parent_message_id || isHuddleSession(row)) return;
      setSessions(prev => reconcileWorkspaceSessions(prev, payload, workspaceId).sessions);
      setActiveSession(prev => prev?.id === row.id ? { ...prev, ...row } as ChatSession : prev);
    },
  );

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
      if (!sessionId || closedSessionIdsRef.current.has(sessionId)) return;
      const payloadSessionId = String(payload.new?.session_id || payload.old?.session_id || '');
      if (
        payloadSessionId !== sessionId
        || currentSessionRef.current !== sessionId
      ) return;
      if (payload.eventType === 'INSERT') {
        const row = payload.new;
        if (!row) return;
        applyScopedMessage(sessionId, row);
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new;
        if (!row) return;
        applyScopedMessage(sessionId, row);
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.id) return;
        removeScopedMessage(sessionId, row.id);
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
    // Normalize the roster at the ONE point every creation path goes through.
    // The same agent can arrive as `agent:<uuid>` from one caller and bare
    // `<uuid>` from another; a duplicate is not cosmetic, because
    // continueConversation iterates agent participants, so the agent is
    // dispatched twice per turn and a huddle reads both replies aloud. Doing it
    // here means no future caller has to remember.
    if (Array.isArray(initialFields.participants)) {
      initialFields.participants = dedupeSessionParticipants(initialFields.participants);
    }
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
  }, [setActiveSession, setSessions, workspaceId]);

  // Split a thread: clone the session as a new top-level thread and carry its
  // recent channel-visible transcript as one explicit quoted-context message.
  // No agent is dispatched — the human starts it by sending the first message.
  const splitSession = useCallback(async (source: ChatSession): Promise<ChatSession | null> => {
    if (!workspaceId) return null;
    if (!navigator.onLine) return null;
    // The server locks the source, snapshots its context and attachment refs,
    // creates the fork, stamps exact merge provenance and inserts the quoted
    // baseline in ONE transaction. A browser timestamp cannot straddle a
    // concurrent source message, and a failed quote cannot leave an empty shell.
    const response = await fetch(
      apiUrl(`/backend/sessions/${encodeURIComponent(source.id)}/split`),
      { method: 'POST', headers: apiAuthHeaders() },
    ).catch(() => null);
    if (!response?.ok) return null;
    const payload = await response.json().catch(() => null);
    const forked = payload?.data?.session as ChatSession | null;
    if (!forked?.id) return null;

    setSessions(prev => (
      prev.some(session => session.id === forked.id) ? prev : [forked, ...prev]
    ));
    return forked;
  }, [setSessions, workspaceId]);

  // Escalate a thread into an existing channel as one bounded, clearly-labelled
  // quoted-context message. It is a normal human-authored message in the target,
  // never a clone of somebody else's attribution.
  const escalateSessionToChannel = useCallback(async (source: ChatSession, targetChannelId: string): Promise<boolean> => {
    if (!workspaceId) return false;
    if (!navigator.onLine) return false;
    return importQuotedSessionContext(source, targetChannelId);
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
  }, [setActiveSession, setSessions]);

  /**
   * Patch a session already saved elsewhere into the local list.
   *
   * updateSession WRITES then patches; this only patches. The channel editor
   * saves through its own validating route (which normalizes icon, intent and
   * participants), so re-writing here would be a second write with a weaker
   * shape — but the sidebar reads THIS list and has to be told, or a rename
   * shows in the channel header and nowhere else until a reload.
   */
  const patchSessionLocal = useCallback((id: string, patch: Partial<ChatSession>) => {
    if (!id) return;
    setSessions(prev => prev.map(session => (session.id === id ? { ...session, ...patch } : session)));
    setActiveSession(prev => (prev?.id === id ? { ...prev, ...patch } : prev));
  }, [setActiveSession, setSessions]);

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

  // Thread reply counts per parent message. Tool-call steps carry a
  // thread_parent_id too (that's how they nest under the run), but they are
  // work, not conversation — see threadSummary.ts's toolCount for those.
  const threadReplyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    messages.forEach(m => {
      if (m.thread_parent_id && !isToolStepMessage(m)) {
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
    attachments?: MessageAttachment[],
    offlineDispatch?: Pick<OfflineMessageDispatch, 'route' | 'fallback' | 'replyMessageId' | 'model' | 'replyAgentId'>,
  ): Promise<{
    message: Message | null;
    error: { message: string; code?: string | null } | null;
    queued: boolean;
  }> => {
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
      sender_kind: 'user',
      sender_id: currentUserId || null,
      sender_name: currentUserName || null,
      thread_parent_id: threadParentId ?? null,
      broadcast_to_channel: broadcast,
      // Painted optimistically so the chip appears with the message rather than
      // one realtime round-trip later. The INSERT below stores the same list.
      attachments: attachments && attachments.length > 0 ? attachments : null,
      created_at: new Date().toISOString(),
    };

    applyScopedMessage(session.id, userMsg);

    const insertPayload: Record<string, unknown> = {
      id: userMsg.id,
      session_id: session.id,
      role: 'user',
      content,
    };
    if (currentUserName) insertPayload.sender_name = currentUserName;
    if (threadParentId) insertPayload.thread_parent_id = threadParentId;
    if (broadcast) insertPayload.broadcast_to_channel = true;
    // Bind the ARRAY, not a JSON string. `messages.attachments` is registered in
    // JSON_COLUMNS_BY_TABLE, so each backend serialises it the way ITS driver
    // needs (the Fly server binds the object; Netlify stringifies). Pre-encoding
    // here would double-encode on Fly into a jsonb string scalar — see
    // tests/jsonb-bind-hygiene.test.cjs.
    if (attachments && attachments.length > 0) insertPayload.attachments = attachments;
    const write = await offlineMessageSendResult(insertPayload, {
      workspaceId: String(workspaceId || ''),
      sessionId: session.id,
      messageId: userMsg.id,
      content,
      threadParentId: threadParentId ?? null,
      autoThread: true,
      ...offlineDispatch,
    });
    const { error } = write;

    // backendClient swallows HTTP failures into { error } instead of throwing,
    // so an unchecked insert left a phantom message on screen after a 403
    // (viewer role), 429 (rate limit) or 500 — and the caller then dispatched a
    // messageId the server never stored. Roll the optimistic row back like the
    // other optimistic mutations do (see handleTogglePin) and report the error.
    if (error) {
      removeScopedMessage(session.id, userMsg.id);
      return { message: null, error, queued: false };
    }

    return { message: userMsg, error: null, queued: write.queued };
  }, [
    applyScopedMessage,
    currentUserId,
    currentUserName,
    removeScopedMessage,
    workspaceId,
  ]);

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
  }, [setActiveSession, setSessions]);

  const buildContextStrings = useCallback((
    memoryFacts?: MemoryFact[],
    linkedDocuments?: Document[],
    contextMessages?: Message[],
  ) => {
    const memoryContext = memoryFacts && memoryFacts.length > 0
      ? memoryFacts.map(f => `[${f.category}] ${f.fact}`).join('\n')
      : null;

    const docContext = linkedDocuments && linkedDocuments.length > 0
      ? linkedDocumentContext(linkedDocuments)
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
  ): Promise<DispatchOutcome> => {
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
        // Option A: main-box messages (threadParentId null) auto-thread the agent's
        // reply under this message server-side; follow-ups already pass threadParentId.
        // The sub-thread panel (useSubThreads) omits this flag, so it stays flat.
        autoThread: true,
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
      applyScopedMessage(session.id, dispatchPayload.data.message);
      return 'dispatched';
    }

    if (dispatchResponse?.ok && dispatchPayload?.data?.dispatched) {
      return 'dispatched';
    }

    // The channel is set to answer only when asked, and this post asked nobody.
    // That is a decision, not a failure: no fallback reply, no "couldn't reach
    // the agent" notice. Every OTHER dispatched:false reason keeps its previous
    // meaning — 'serverless_dispatch_unavailable' in particular is how a
    // Netlify-only deploy falls through to the direct-AI path.
    if (dispatchResponse?.ok && dispatchPayload?.data?.reason === DISPATCH_DECLINED_ON_MENTION_ONLY) {
      return 'declined';
    }

    return 'failed';
  }, [applyScopedMessage, workspaceId]);

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
    setSessionStreaming(session.id, true);

    const assistantMsgId = crypto.randomUUID();
    const replyAgentId = agent?.id
      || (!isSharedModelRoute(model) ? directParticipant?.agent_id : null)
      || null;
    const replyAgentName = agent?.name
      || (replyAgentId ? (directParticipant?.name || directParticipant?.handle || 'Agent') : 'Agensis');
    const placeholderMsg: Message = {
      id: assistantMsgId,
      session_id: session.id,
      role: 'assistant',
      content: '',
      sender_kind: replyAgentId ? 'agent' : 'assistant',
      sender_id: replyAgentId,
      sender_name: replyAgentName,
      thread_parent_id: threadParentId ?? null,
      created_at: new Date().toISOString(),
    };
    applyScopedMessage(session.id, placeholderMsg);

    let flushHandle: number | null = null;
    let controller: AbortController | null = null;

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

      controller = new AbortController();
      streamAbortRefs.current.get(session.id)?.abort();
      streamAbortRefs.current.set(session.id, controller);
      const response = await fetch(apiUrl('/backend/ai-chat'), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...apiAuthHeaders(),
        },
        body: JSON.stringify({
          workspaceId,
          sessionId: session.id,
          messageId: assistantMsgId,
          seedMessageId: userMsg.id,
          threadParentId: threadParentId ?? null,
          replyAgentId,
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
        patchScopedMessage(session.id, assistantMsgId, { content: errMsg });
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
        patchScopedMessage(session.id, assistantMsgId, { content: snapshot });
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
      patchScopedMessage(session.id, assistantMsgId, { content: finalContent });
    } catch (error) {
      if (flushHandle !== null) { cancelAnimationFrame(flushHandle); flushHandle = null; }
      // Unmount aborted the stream — the component is gone, skip all state writes.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const errMsg = errorMessage(error || 'Something went wrong. Please try again.');
      patchScopedMessage(session.id, assistantMsgId, { content: errMsg });
    } finally {
      if (!controller) {
        setSessionStreaming(session.id, false);
      } else if (streamAbortRefs.current.get(session.id) === controller) {
        streamAbortRefs.current.delete(session.id);
        setSessionStreaming(session.id, false);
      }
    }
  }, [applyScopedMessage, patchScopedMessage, setSessionStreaming, workspaceId]);

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
    attachments?: MessageAttachment[],
  ): Promise<SendMessageResult> => {
    const session = targetSession ?? activeSession;
    // No session to send into: the composer must keep the draft rather than
    // clearing it into nothing.
    if (!session) return { delivered: false, failure: WORKSPACE_UNAVAILABLE };

    // Decide the offline route before touching the network. Re-evaluating this
    // from the session after reconnect is wrong: the conversation may have
    // changed, a selected model may have changed, and a post that was intended
    // for a named agent could be sent to a different agent (or vice versa).
    // This mirrors the server's deterministic routing inputs available at send
    // time and is only used when the INSERT itself has to be queued.
    const preRouteParticipant = directAgentParticipantRecord(session);
    const preRouteSharedModel = isSharedModelRoute(model);
    const preRouteHasMention = Boolean(firstAgentMention(content)) || mentionsChannel(content);
    const preRouteThreadHasAgent = Boolean(
      threadParentId
      && hasAgentTargetInThread(messages.filter(message => message.session_id === session.id)),
    );
    const preRouteAutoChannel = session.folder !== 'Direct messages'
      && allowsUnpromptedReply({ conversationMode: session.conversation_mode });
    const preRouteToAgent = Boolean(
      !preRouteSharedModel
      && workspaceId
      && (
        preRouteHasMention
        || preRouteThreadHasAgent
        || preRouteParticipant
        || session.folder === 'Direct messages'
        || preRouteAutoChannel
      ),
    );
    const offlineRoute: OfflineMessageRoute = preRouteSharedModel || (agent && !preRouteToAgent)
      ? 'direct_ai'
      : preRouteToAgent
        ? 'agent'
        : 'post_only';
    const offlineDispatch = {
      route: offlineRoute,
      fallback: preRouteToAgent && (agent || preRouteParticipant) ? 'direct_ai' as const : 'none' as const,
      replyMessageId: offlineRoute === 'direct_ai' || (preRouteToAgent && (agent || preRouteParticipant))
        ? crypto.randomUUID()
        : null,
      model: offlineRoute === 'direct_ai' || (preRouteToAgent && (agent || preRouteParticipant))
        ? directAiModel(model, agent?.model)
        : null,
      replyAgentId: agent?.id || (!preRouteSharedModel ? preRouteParticipant?.agent_id || null : null),
    };
    const {
      message: userMsg,
      error: sendError,
      queued,
    } = await insertUserMessage(
      session,
      content,
      threadParentId,
      broadcastToChannel,
      attachments,
      offlineDispatch,
    );
    // The message never reached the DB (viewer role, rate limit, server error).
    // The optimistic row is already rolled back; say why and abort before
    // dispatch/stream run against a messageId the server has never seen.
    if (!userMsg) {
      applyScopedMessage(session.id, {
        id: crypto.randomUUID(),
        session_id: session.id,
        role: 'assistant',
        content: `Couldn't send your message — ${errorMessage(sendError)}`,
        thread_parent_id: threadParentId ?? null,
        created_at: new Date().toISOString(),
      });
      // Not delivered: the composer restores the draft so the words the user
      // typed are not destroyed along with the send.
      return { delivered: false, failure: classifyWriteFailure(sendError, { online: navigator.onLine }) };
    }
    if (queued) {
      const queuedNotice = offlineDispatch.route === 'post_only'
        ? 'Queued on this device. It will post when you reconnect.'
        : offlineDispatch.route === 'direct_ai'
          ? 'Queued on this device. It will post and run the selected AI reply when you reconnect.'
          : 'Queued on this device. It will post and wake the agent when you reconnect.';
      applyScopedMessage(session.id, {
        id: crypto.randomUUID(),
        session_id: session.id,
        role: 'assistant',
        sender_name: 'Agensis',
        content: queuedNotice,
        thread_parent_id: threadParentId ?? null,
        created_at: new Date().toISOString(),
      });
      return { delivered: true, failure: null };
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

    const hasMention = Boolean(firstAgentMention(content)) || mentionsChannel(content);
    const threadHasAgentTarget = Boolean(threadParentId && hasAgentTargetInThread(contextMessages));
    const directParticipant = directAgentParticipantRecord(session);
    const directAgentChannel = Boolean(directParticipant);
    // A "Direct messages" session is always agent-routable, even if its participant
    // record is degraded/missing (legacy DMs) — the server resolves the target
    // agent by folder + title. Without this, a DM with a null direct participant
    // would hit neither directAgentChannel nor autoChannel (autoChannel excludes
    // DMs) and silently never dispatch, so the agent never replies.
    const folderDm = session.folder === 'Direct messages';
    // A non-DM channel lets participant agents chime in on an un-addressed
    // message — but only when the channel's own reply timing allows it. Same
    // decision the server makes (shared/channelMentions.cjs), asked here so a
    // 'mention'-timed channel makes no request at all rather than one that comes
    // back refused. DMs route via their direct participant or the folder
    // fallback above and are never governed by the mode.
    const autoChannel = session.folder !== 'Direct messages'
      && allowsUnpromptedReply({ conversationMode: session.conversation_mode });
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
      if (dispatched === 'dispatched') return { delivered: true, failure: null };
      // The channel answers only when asked and nobody was asked. The message is
      // posted and that is the whole intent — no fallback reply, no notice.
      if (dispatched === 'declined') return { delivered: true, failure: null };
      // Dispatch failed. If there's a direct-AI fallback (agent/direct
      // participant) fall through to it; otherwise surface the failure instead
      // of returning silently and leaving the user's message looking sent (M6).
      // Only append the notice when the target is the on-screen session — the
      // `messages` state belongs to the active session, so writing a foreign
      // session_id row into it would surface the error in the wrong pane.
      if (!agent && !directParticipant) {
        applyScopedMessage(session.id, {
          id: crypto.randomUUID(),
          session_id: session.id,
          role: 'assistant',
          content: "Couldn't reach the agent — your message was posted but no reply was generated. Please try sending it again.",
          thread_parent_id: threadParentId ?? null,
          created_at: new Date().toISOString(),
        });
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
  }, [
    activeSession,
    messages,
    applyScopedMessage,
    workspaceId,
    insertUserMessage,
    autoTitleSession,
    buildContextStrings,
    dispatchToAgent,
    streamDirectAI,
  ]);

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
  ): Promise<{ status: 'pending' | 'merged' | 'empty' | 'error'; parent?: ChatSession }> => {
    if (!workspaceId || !navigator.onLine) return { status: 'error' };
    if (pendingMergeForksRef.current.has(fork.id)) {
      return {
        status: 'pending',
        parent: sessions.find(session => session.id === fork.split_parent_id),
      };
    }
    const parentId = fork.split_parent_id;
    const splitAt = fork.split_at;
    if (!parentId || !splitAt) return { status: 'error' };

    const parent = sessions.find(s => s.id === parentId);
    if (!parent) return { status: 'error' };

    // Pull both full transcripts; isolate each branch's post-split divergence.
    const [parentRes, forkRes] = await Promise.all([
      backendClient.from('messages').select('*').eq('session_id', parentId)
        .order('created_at', { ascending: false }).limit(MERGE_BRANCH_MESSAGE_LIMIT + 1),
      backendClient.from('messages').select('*').eq('session_id', fork.id)
        .order('created_at', { ascending: false }).limit(MERGE_BRANCH_MESSAGE_LIMIT + 1),
    ]);
    if (parentRes.error || forkRes.error) return { status: 'error' };
    const parentRows = (parentRes.data || []) as Message[];
    const forkRows = (forkRes.data || []) as Message[];
    const divergence = splitDivergence(fork, parentRows, forkRows);
    if (!divergence.ok) return { status: 'error' };
    const parentDiverged = divergence.parent;
    const forkDiverged = divergence.fork;
    const parentTop = channelMessages(parentRows.filter((m: Message) => !m.deleted_at));

    // Nothing happened in the fork after the split → merge is pure cleanup.
    if (forkDiverged.length === 0) {
      if (!await closeSessionControl(fork.id)) return { status: 'error', parent };
      closedSessionIdsRef.current.add(fork.id);
      setClosedSessionIds(prev => prev.includes(fork.id) ? prev : [...prev, fork.id]);
      setSessions(prev => prev.filter(s => s.id !== fork.id));
      setActiveSession(parent);
      return { status: 'empty', parent };
    }

    const prompt = buildMergeSynthesisPrompt(
      fork.title || 'Untitled',
      parentDiverged,
      forkDiverged,
    );

    // Land on the parent so the synthesis renders in place, then dispatch.
    setActiveSession(parent);
    const { message: userMsg } = await insertUserMessage(parent, prompt);
    // A rejected insert leaves nothing for the agent to answer, so treat it
    // exactly like a failed dispatch below: keep the fork, surface the failure.
    const dispatched: DispatchOutcome = userMsg
      ? await dispatchToAgent(parent, userMsg, prompt, parentTop, null, null)
      : 'failed';

    // If the synthesis dispatch failed, keep the fork (do NOT soft-delete) so
    // the merge can be retried, and surface the failure instead of silently
    // destroying the branch with no synthesis (M6). 'declined' counts as a
    // failure HERE even though it is a success elsewhere: a merge exists to
    // produce a synthesis, and a channel set to answer only when asked has not
    // been asked — soft-deleting the fork would destroy the branch and leave
    // nothing in its place.
    if (dispatched !== 'dispatched') {
      applyScopedMessage(parent.id, {
        id: crypto.randomUUID(),
        session_id: parent.id,
        role: 'assistant',
        content: dispatched === 'declined'
          ? 'This channel is set so nobody has to answer unless asked, so no agent picked up the merge — the split branch has been kept. @mention the agent you want to synthesize it.'
          : "Couldn't reach the agent to synthesize the merge — the split branch has been kept. Please try merging again.",
        created_at: new Date().toISOString(),
      });
      return { status: 'error', parent };
    }
    if (!userMsg) return { status: 'error', parent };
    const mergeSeedId = userMsg.id;

    // Dispatch only proves that work STARTED. Keep the source fork until a
    // durable, non-placeholder synthesis reply is observed under this exact
    // merge seed. If the agent fails, the tab closes, or realtime never
    // reconnects, the fork remains available for retry instead of being lost.
    pendingMergeForksRef.current.add(fork.id);
    let finished = false;
    let settling = false;
    let timeoutId = 0;
    let stopPoller = () => {};
    let channel = null as ReturnType<typeof backendClient.channel> | null;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeoutId);
      stopPoller();
      void channel?.unsubscribe();
      mergeWatchCleanupRefs.current.delete(cleanup);
      pendingMergeForksRef.current.delete(fork.id);
    };
    const settle = async (message: Message) => {
      if (finished || settling || !isDurableMergeSynthesis(message, mergeSeedId)) return;
      settling = true;
      const closed = await closeSessionControl(fork.id);
      if (!closed) {
        settling = false;
        throw new Error('The merged branch could not be closed yet');
      }
      cleanup();
      void redactCachedSessionMessages(fork.id).catch(() => {});
      clearSessionState(fork.id);
    };
    channel = backendClient
      .channel(`merge-synthesis:${parent.id}:${mergeSeedId}`)
      .on<Message>(
        'db_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `session_id=eq.${parent.id}`,
        },
        payload => {
          if (payload.new) void settle(payload.new).catch(() => {});
        },
      )
      .subscribe();
    const poller = createMergeSynthesisPoller({
      mergeSeedId,
      load: async () => {
        const existing = await backendClient
          .from<Message>('messages')
          .select('*')
          .eq('session_id', parent.id)
          .eq('thread_parent_id', mergeSeedId)
          .order('created_at', { ascending: false })
          .limit(10);
        if (existing.error) throw existing.error;
        return Array.isArray(existing.data) ? existing.data : [];
      },
      onFound: settle,
    });
    stopPoller = () => poller.stop();
    timeoutId = window.setTimeout(cleanup, 30 * 60 * 1000);
    mergeWatchCleanupRefs.current.add(cleanup);
    void poller.start();

    return { status: 'pending', parent };
  }, [
    workspaceId,
    sessions,
    insertUserMessage,
    dispatchToAgent,
    applyScopedMessage,
    clearSessionState,
    setActiveSession,
    setSessions,
  ]);

  // Soft delete: never hard-delete a session — stamp deleted_at so the data
  // is retained (for audit/merge/history) and filtered out of every load path
  // (see fetchSessions). Row disappears from the UI immediately.
  const deleteSession = useCallback(async (id: string): Promise<boolean> => {
    if (!await closeSessionControl(id)) return false;
    void redactCachedSessionMessages(id).catch(() => {});
    clearSessionState(id);
    return true;
  }, [clearSessionState]);

  // Clear + close a conversation: soft-delete every message in the thread AND
  // soft-delete (close) the session, in one action. Nothing is hard-deleted —
  // both the messages and the session keep their rows (stamped deleted_at) so the
  // data is retained, but they're filtered out of every read path (sidebar, DM
  // resolution, message fetch, agent search/digest/context). Used by the DM row's
  // "Delete conversation" action.
  const closeAndClearSession = useCallback(async (id: string) => {
    const response = await fetch(apiUrl(`/backend/sessions/${encodeURIComponent(id)}/clear`), {
      method: 'POST',
      headers: apiAuthHeaders(),
    }).catch(() => null);
    if (!response?.ok) return false;
    announceActivityRedaction({ sessionId: id });
    void redactCachedSessionMessages(id).catch(() => {});
    clearSessionState(id);
    return true;
  }, [clearSessionState]);

  return {
    sessions,
    closedSessionIds,
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
    escalateSessionToChannel,
    updateSession,
    patchSessionLocal,
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
  return redactDeletedMessage({
    ...message,
    content: messageText(message.content),
  });
}
