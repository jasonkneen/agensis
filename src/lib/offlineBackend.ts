import { backendClient } from './backendClient';
import { enqueue, cacheSet, cacheGet, cacheApplyInsert, cacheApplyUpdate, cacheApplyDelete } from './offlineDb';

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

// The three mutation helpers accept an optional `cacheKey` (the same key the
// hook passes to cachedFetch). When a mutation is queued offline, the cached
// collection under that key is updated too, so a reload while still offline
// reflects the change instead of the stale snapshot (M8).
export async function offlineInsert(
  table: string,
  payload: Record<string, unknown>,
  cacheKey?: string,
): Promise<Record<string, unknown> | null> {
  const now = new Date().toISOString();
  const record = {
    ...payload,
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
  };

  if (navigator.onLine) {
    const { data, error } = await backendClient.from(table).insert(record).select().single();
    if (!error && data) {
      return data;
    }
    if (error && !isTransportFailure(error)) {
      console.warn(`[offlineInsert] Backend rejected insert into ${table}`, error);
      return null;
    }
    console.warn(`[offlineInsert] Falling back to offline queue for ${table}`, error);
  }

  await enqueue({ table, operation: 'insert', payload: record });
  if (cacheKey) await cacheApplyInsert(cacheKey, record);
  return record;
}

export async function offlineUpdate(
  table: string,
  id: string,
  updates: Record<string, unknown>,
  cacheKey?: string,
): Promise<Record<string, unknown> | null> {
  const now = new Date().toISOString();
  const serverPayload = { ...updates, updated_at: now };
  const fullPayload = { ...serverPayload, id };

  if (navigator.onLine) {
    const { data, error } = await backendClient.from(table).update(serverPayload).eq('id', id).select().single();
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
): Promise<boolean> {
  if (navigator.onLine) {
    const { error } = await backendClient.from(table).delete().eq('id', id);
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
