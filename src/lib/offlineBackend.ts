import { backendClient } from './backendClient';
import {
  enqueue,
  cacheSet,
  cacheGet,
  cacheApplyInsert,
  cacheApplyUpdate,
  cacheApplyDelete,
  cacheApplyMessagePageInsert,
  purgeQueuedSessionMutations,
} from './offlineDb';

type BackendError = { message: string; code?: string | null } | null | undefined;

// H10: only a genuine transport failure may be queued for later replay. A backend
// rejection (403 RBAC, 400 validation, 401 expired token) is NOT an offline
// condition — queuing it reports success to the user and then silently discards
// the edit when the queued mutation dead-letters after 5 attempts.
//
// backendClient's postJson collapses both failure modes into { message, code }
// with no status: a rejected fetch surfaces the browser's network message (or the
// literal 'Network error'), while an HTTP error response surfaces the server's
// message or 'Request failed (<status>)'. So match on that, plus navigator.onLine
// for a connection that dropped mid-request.
const TRANSPORT_ERROR_PATTERN = /network error|failed to fetch|networkerror|load failed|fetch failed|connection (?:refused|reset|closed|failed)|err_(?:internet_disconnected|network|connection_)/i;

function isTransportFailure(error: BackendError): boolean {
  if (!error) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return TRANSPORT_ERROR_PATTERN.test(error.message || '');
}

// What a mutation actually did. `offlineInsert` collapses this to data-or-null,
// which is why a rejected write used to reach the UI as an indistinguishable
// `null` and got rendered as "nothing happened" — the caller had no error to
// report even when the server had explained itself. Callers that tell the user
// anything should use the *Result variants.
export interface OfflineWriteResult<T> {
  data: T | null;
  error: { message: string; code?: string | null } | null;
  /** True when the write is sitting in the replay queue, not in the DB yet. */
  queued: boolean;
}

export type OfflineMessageRoute = 'agent' | 'direct_ai' | 'post_only';

export type OfflineMessageFallback = 'direct_ai' | 'none';

export interface OfflineMessageDispatch {
  workspaceId: string;
  sessionId: string;
  messageId: string;
  content: string;
  threadParentId?: string | null;
  autoThread?: boolean;
  /** The route selected before the message was queued. Never infer this at replay time. */
  route?: OfflineMessageRoute;
  /** A failed agent dispatch may fall through to the selected direct-AI route. */
  fallback?: OfflineMessageFallback;
  /** Server-owned persisted reply id used when replaying the direct-AI lane. */
  replyMessageId?: string | null;
  /** The selected model/participant snapshot for the direct-AI lane. */
  model?: string | null;
  replyAgentId?: string | null;
}

function offlineRecord(payload: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    ...payload,
    id: payload.id || crypto.randomUUID(),
    created_at: payload.created_at || now,
    updated_at: payload.updated_at || now,
  };
}

// The three mutation helpers accept an optional `cacheKey` (the same key the
// hook passes to cachedFetch). When a mutation is queued offline, the cached
// collection under that key is updated too, so a reload while still offline
// reflects the change instead of the stale snapshot (M8).
export async function offlineInsertResult(
  table: string,
  payload: Record<string, unknown>,
  cacheKey?: string,
): Promise<OfflineWriteResult<Record<string, unknown>>> {
  const record = offlineRecord(payload);

  if (navigator.onLine) {
    const { data, error } = await backendClient.from(table).insert(record).select().single();
    if (!error && data) {
      return { data, error: null, queued: false };
    }
    if (error && !isTransportFailure(error)) {
      console.warn(`[offlineInsert] Backend rejected insert into ${table}`, error);
      return { data: null, error, queued: false };
    }
    console.warn(`[offlineInsert] Falling back to offline queue for ${table}`, error);
  }

  await enqueue({ table, operation: 'insert', payload: record });
  if (cacheKey) await cacheApplyInsert(cacheKey, record);
  return { data: record, error: null, queued: true };
}

/**
 * Persist an offline chat send as one replayable intent. A plain queued INSERT
 * is insufficient: inserting a message does not wake an agent. The network
 * synchronizer therefore replays the idempotent insert and the normal dispatch
 * request together before removing this entry.
 */
export async function offlineMessageSendResult(
  payload: Record<string, unknown>,
  dispatch: OfflineMessageDispatch,
): Promise<OfflineWriteResult<Record<string, unknown>>> {
  const now = new Date().toISOString();
  // messages intentionally has no updated_at column. Keep its queued row shape
  // identical to the ordinary insert path instead of reusing offlineRecord.
  const record = {
    ...payload,
    id: payload.id || crypto.randomUUID(),
    created_at: payload.created_at || now,
  };
  if (navigator.onLine) {
    const { data, error } = await backendClient.from('messages').insert(record).select().single();
    if (!error && data) return { data, error: null, queued: false };
    if (error && !isTransportFailure(error)) {
      return { data: null, error, queued: false };
    }
  }

  await enqueue({
    table: 'messages',
    operation: 'message_send',
    payload: { message: record, dispatch },
  });
  await cacheApplyMessagePageInsert(`messages_page_${dispatch.sessionId}`, record);
  return { data: record, error: null, queued: true };
}

export async function offlineInsert(
  table: string,
  payload: Record<string, unknown>,
  cacheKey?: string,
): Promise<Record<string, unknown> | null> {
  return (await offlineInsertResult(table, payload, cacheKey)).data;
}

export async function offlineUpdate(
  table: string,
  id: string,
  updates: Record<string, unknown>,
  cacheKey?: string,
  filters: Record<string, string> = {},
): Promise<Record<string, unknown> | null> {
  const now = new Date().toISOString();
  const serverPayload = { ...updates, updated_at: now };
  const fullPayload = { ...serverPayload, id };

  if (navigator.onLine) {
    let query = backendClient.from(table).update(serverPayload).eq('id', id);
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query.select().single();
    if (!error && data) return data;
    if (error && !isTransportFailure(error)) {
      console.warn(`[offlineUpdate] Backend rejected update to ${table}`, error);
      return null;
    }
  }

  await enqueue({ table, operation: 'update', payload: fullPayload });
  if (cacheKey) await cacheApplyUpdate(cacheKey, id, serverPayload);
  return fullPayload;
}

export async function offlineDelete(
  table: string,
  id: string,
  cacheKey?: string,
  filters: Record<string, string> = {},
): Promise<boolean> {
  if (navigator.onLine) {
    let query = backendClient.from(table).delete().eq('id', id);
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { error } = await query;
    if (!error) return true;
    if (!isTransportFailure(error)) {
      console.warn(`[offlineDelete] Backend rejected delete from ${table}`, error);
      return false;
    }
  }

  await enqueue({ table, operation: 'delete', payload: { id } });
  if (cacheKey) await cacheApplyDelete(cacheKey, id);
  return true;
}

export async function cachedFetch<T>(
  cacheKey: string,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  if (navigator.onLine) {
    try {
      const data = await fetcher();
      if (data != null) {
        await cacheSet(cacheKey, data);
      }
      return data;
    } catch {
      return cacheGet<T>(cacheKey);
    }
  }

  return cacheGet<T>(cacheKey);
}

/**
 * A conversation-close event is a privacy boundary, not ordinary cache
 * invalidation. Replace the persisted transcript snapshot with an empty page
 * immediately so reopening the window while offline cannot resurrect message
 * bodies that another participant has just deleted.
 */
export function redactCachedSessionMessages(sessionId: string): Promise<void> {
  const id = String(sessionId || '').trim();
  if (!id) return Promise.resolve();
  return Promise.all([
    cacheSet(`messages_page_${id}`, { messages: [], hasMore: false }),
    purgeQueuedSessionMutations(id),
  ]).then(() => undefined);
}
