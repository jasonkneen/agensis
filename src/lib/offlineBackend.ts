import { backendClient } from './backendClient';
import { enqueue, cacheSet, cacheGet } from './offlineDb';

export async function offlineInsert(
  table: string,
  payload: Record<string, unknown>,
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
  return record;
}

export async function offlineUpdate(
  table: string,
  id: string,
  updates: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const fullPayload = { ...updates, id, updated_at: new Date().toISOString() };

  if (navigator.onLine) {
    const { data, error } = await backendClient.from(table).update(updates).eq('id', id).select().single();
    if (!error && data) return data;
  }

  await enqueue({ table, operation: 'update', payload: fullPayload });
  return fullPayload;
}

export async function offlineDelete(
  table: string,
  id: string,
): Promise<boolean> {
  if (navigator.onLine) {
    const { error } = await backendClient.from(table).delete().eq('id', id);
    if (!error) return true;
  }

  await enqueue({ table, operation: 'delete', payload: { id } });
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
