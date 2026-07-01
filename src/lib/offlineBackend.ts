import { backendClient } from './backendClient';
import { enqueue, cacheSet, cacheGet, cacheApplyInsert, cacheApplyUpdate, cacheApplyDelete } from './offlineDb';

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
