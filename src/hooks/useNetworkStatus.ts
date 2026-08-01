import { useState, useEffect, useCallback, useRef } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { peekQueue, dequeue, recordSyncFailure, clearQueue as clearOfflineQueue } from '../lib/offlineDb';
import type { OfflineMessageDispatch } from '../lib/offlineBackend';

const DISPATCH_DECLINED_ON_MENTION_ONLY = 'channel_replies_on_mention_only';

class QueuedMessageDispatchPendingError extends Error {
  readonly keepQueued = true;
}

export function keepQueuedMessageDispatch(error: unknown): boolean {
  return error instanceof QueuedMessageDispatchPendingError
    || Boolean(error && typeof error === 'object' && (error as { keepQueued?: unknown }).keepQueued === true);
}

async function consumeAiReplay(response: Response): Promise<void> {
  if (!response.body) throw new Error('AI replay returned no stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamError = '';
  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6);
    if (data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data) as { error?: unknown };
      if (!streamError && typeof parsed.error === 'string' && parsed.error.trim()) {
        streamError = parsed.error.trim();
      }
    } catch {
      // Ignore malformed provider frames; the server has already decided the
      // durable reply outcome, and a malformed non-error frame is not a reason
      // to replay a user message indefinitely.
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
  }
  buffer += decoder.decode();
  buffer.split('\n').forEach(consumeLine);
  if (streamError) throw new Error(streamError);
}

async function replayDirectAiMessage(
  intent: OfflineMessageDispatch,
  row: Record<string, unknown>,
  messageId: string,
  sessionId: string,
): Promise<void> {
  const replyMessageId = String(intent.replyMessageId || crypto.randomUUID());
  const response = await fetch(apiUrl('/backend/ai-chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({
      workspaceId: intent.workspaceId,
      sessionId,
      messageId: replyMessageId,
      seedMessageId: messageId,
      threadParentId: intent.threadParentId ?? null,
      replyAgentId: intent.replyAgentId || null,
      model: intent.model || 'auto',
      // The persisted seed and its session history are the authoritative
      // context. This small fallback transcript only satisfies legacy route
      // adapters; named-agent turns are re-grounded server-side.
      messages: [{ role: 'user', content: String(intent.content || row.content || '') }],
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message || `AI replay failed (${response.status})`);
  }
  await consumeAiReplay(response);
}

export async function replayQueuedMessage(payload: Record<string, unknown>): Promise<void> {
  const message = payload.message;
  const dispatch = payload.dispatch;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Queued message payload is invalid');
  }
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    throw new Error('Queued message dispatch is invalid');
  }
  const row = message as Record<string, unknown>;
  const intent = dispatch as unknown as OfflineMessageDispatch;
  const messageId = String(row.id || '');
  const sessionId = String(row.session_id || intent.sessionId || '');
  if (!messageId || !sessionId || !intent.workspaceId) {
    throw new Error('Queued message identity is incomplete');
  }

  // A previous attempt may have committed the INSERT and then lost the network
  // before dispatch. Probe by the compound session/id scope so retrying remains
  // idempotent instead of failing forever on the primary key.
  const existing = await backendClient
    .from('messages')
    .select('id')
    .eq('session_id', sessionId)
    .eq('id', messageId)
    .limit(1);
  if (existing.error) throw existing.error;
  if (!Array.isArray(existing.data) || existing.data.length === 0) {
    const inserted = await backendClient.from('messages').insert(row);
    if (inserted.error) throw inserted.error;
  }

  // New queue entries carry the route chosen while the composer still had the
  // original session/model/agent state. Old entries predate that field and
  // retain the historical agent-dispatch behaviour for compatibility.
  const route = intent.route || 'agent';
  if (route === 'post_only') return;
  if (route === 'direct_ai') {
    await replayDirectAiMessage(intent, row, messageId, sessionId);
    return;
  }

  const response = await fetch(apiUrl('/backend/agents/dispatch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({
      workspaceId: intent.workspaceId,
      sessionId,
      messageId,
      content: String(intent.content || row.content || ''),
      threadParentId: intent.threadParentId ?? null,
      autoThread: intent.autoThread === true,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message || `Dispatch failed (${response.status})`);
  }
  const body = await response.json().catch(() => null);
  const decision = body?.data && typeof body.data === 'object' ? body.data : body;
  if (decision?.dispatched === true) return;
  if (
    decision?.dispatched === false
    && decision?.reason === DISPATCH_DECLINED_ON_MENTION_ONLY
  ) {
    // Mention-only is a completed routing decision: the message intentionally
    // wakes nobody, so this replay entry can be removed.
    return;
  }
  if (intent.fallback === 'direct_ai') {
    await replayDirectAiMessage(intent, row, messageId, sessionId);
    return;
  }
  // A 2xx transport response is not proof that an agent was dispatched.
  // Netlify deliberately reports serverless_dispatch_unavailable this way.
  // Keep the durable intent until a websocket-capable backend can make the
  // routing decision; otherwise reconnect silently posts the message and loses
  // the reply forever.
  throw new QueuedMessageDispatchPendingError(
    `Message was saved, but agent dispatch is still pending${decision?.reason ? ` (${decision.reason})` : ''}`,
  );
}

export function useNetworkStatus(userId: string | null) {
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncingRef = useRef(false);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const flushQueue = useCallback(async () => {
    if (!userId || syncingRef.current || !navigator.onLine) return;
    syncingRef.current = true;
    setSyncing(true);

    try {
      const items = (await peekQueue()).sort((a, b) => a.created_at - b.created_at);
      setPendingCount(items.length);

      if (items.length === 0) {
        setSyncError(null);
      }

      let failedCount = 0;
      let droppedCount = 0;

      for (const item of items) {
        try {
          if (item.operation === 'insert') {
            const { error } = await backendClient.from(item.table).insert(item.payload);
            if (error) throw error;
          } else if (item.operation === 'message_send') {
            await replayQueuedMessage(item.payload);
          } else if (item.operation === 'update') {
            const { id: rowId, ...rest } = item.payload as Record<string, unknown> & { id: string };
            const { error } = await backendClient.from(item.table).update(rest).eq('id', rowId);
            if (error) throw error;
          } else if (item.operation === 'delete') {
            const { error } = await backendClient.from(item.table).delete().eq('id', item.payload.id as string);
            if (error) throw error;
          }
          if (item.id != null) await dequeue(item.id);
          setPendingCount(prev => Math.max(0, prev - 1));
        } catch (error) {
          // Count a failed attempt; drop the entry once it has failed too many
          // times so a permanently-broken "poison" change stops retrying every
          // 30s and pinning the error banner (M9).
          let dropped = false;
          if (item.id != null && !(
            item.operation === 'message_send'
            && keepQueuedMessageDispatch(error)
          )) {
            const result = await recordSyncFailure(item.id);
            dropped = result.dropped;
          }
          if (dropped) {
            droppedCount++;
            setPendingCount(prev => Math.max(0, prev - 1));
          } else {
            failedCount++;
          }
          console.error(`[offline-sync] Failed to flush queued change${dropped ? ' (discarded after too many attempts)' : ' (will retry)'}`, {
            table: item.table,
            operation: item.operation,
            rowId: item.operation === 'message_send'
              ? (item.payload.message as Record<string, unknown> | undefined)?.id
              : item.payload.id,
            error,
          });
        }
      }

      if (failedCount > 0) {
        setSyncError(`${failedCount} queued change${failedCount === 1 ? '' : 's'} failed to sync — will retry`);
      } else if (droppedCount > 0) {
        setSyncError(`${droppedCount} queued change${droppedCount === 1 ? '' : 's'} couldn't be synced and ${droppedCount === 1 ? 'was' : 'were'} discarded`);
      } else {
        setSyncError(null);
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      const remaining = await peekQueue();
      setPendingCount(remaining.length);
    }
  }, [userId]);

  useEffect(() => {
    if (online && userId) flushQueue();
  }, [online, userId, flushQueue]);

  useEffect(() => {
    if (!online || !userId) return;
    const interval = setInterval(flushQueue, 30_000);
    return () => clearInterval(interval);
  }, [online, userId, flushQueue]);

  const clearPendingQueue = useCallback(async () => {
    await clearOfflineQueue();
    setPendingCount(0);
    setSyncError(null);
  }, []);

  useEffect(() => {
    if (!userId) {
      setPendingCount(0);
      setSyncError(null);
      return;
    }
    peekQueue().then(items => setPendingCount(items.length));
  }, [userId]);

  return { online, syncing, pendingCount, syncError, flushQueue, clearPendingQueue };
}
