const DB_NAME = 'agensis_offline';
const DB_VERSION = 1;
const QUEUE_STORE = 'sync_queue';
const CACHE_STORE = 'data_cache';

// Bounds so a long offline session (or a wedged sync) can't grow IndexedDB
// without limit. Oldest entries are evicted first once either bound is exceeded.
const MAX_QUEUE_ENTRIES = 5000;
const QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// A queued mutation that keeps failing (duplicate PK, FK violation on a deleted
// parent, etc.) is dropped after this many flush attempts so it can't retry
// forever and pin the sync-error banner (M9).
const MAX_SYNC_ATTEMPTS = 5;

interface SyncEntry {
  id?: number;
  table: string;
  operation: 'insert' | 'update' | 'delete';
  payload: Record<string, unknown>;
  created_at: number;
  attempts?: number;
}

interface CacheEntry {
  key: string;
  data: unknown;
  updated_at: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode) {
  return db.transaction(store, mode).objectStore(store);
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function enqueue(entry: Omit<SyncEntry, 'id' | 'created_at'>): Promise<void> {
  const db = await openDb();
  await req(tx(db, QUEUE_STORE, 'readwrite').add({
    ...entry,
    created_at: Date.now(),
  }));
  await pruneQueue(db);
  db.close();
}

// Evict expired and overflow entries so a long offline stretch (or a wedged sync)
// can't grow the queue without limit. getAll() returns rows in key (insertion)
// order, so the lowest ids are the oldest and get dropped first.
async function pruneQueue(db: IDBDatabase): Promise<void> {
  const now = Date.now();
  const all = (await req(tx(db, QUEUE_STORE, 'readonly').getAll())) as SyncEntry[];
  const survivors: SyncEntry[] = [];
  const toDelete: number[] = [];
  for (const item of all) {
    if (typeof item.id !== 'number') continue;
    if (now - item.created_at > QUEUE_TTL_MS) toDelete.push(item.id);
    else survivors.push(item);
  }
  const overflow = survivors.length - MAX_QUEUE_ENTRIES;
  if (overflow > 0) {
    for (const item of survivors.slice(0, overflow)) {
      if (typeof item.id === 'number') toDelete.push(item.id);
    }
  }
  if (toDelete.length === 0) return;
  const store = tx(db, QUEUE_STORE, 'readwrite');
  await Promise.all(toDelete.map((id) => req(store.delete(id))));
}

export async function peekQueue(): Promise<SyncEntry[]> {
  const db = await openDb();
  const items = await req(tx(db, QUEUE_STORE, 'readonly').getAll()) as SyncEntry[];
  db.close();
  return items;
}

export async function dequeue(id: number): Promise<void> {
  const db = await openDb();
  await req(tx(db, QUEUE_STORE, 'readwrite').delete(id));
  db.close();
}

export async function clearQueue(): Promise<void> {
  const db = await openDb();
  await req(tx(db, QUEUE_STORE, 'readwrite').clear());
  db.close();
}

// Record a failed flush attempt: increment the entry's attempt counter, and
// drop it (dead-letter) once MAX_SYNC_ATTEMPTS is reached so a permanently
// failing "poison" entry stops retrying every 30s forever (M9). Returns whether
// the entry was dropped and its attempt count.
export async function recordSyncFailure(id: number): Promise<{ dropped: boolean; attempts: number }> {
  const db = await openDb();
  try {
    const entry = (await req(tx(db, QUEUE_STORE, 'readonly').get(id))) as SyncEntry | undefined;
    if (!entry) return { dropped: false, attempts: 0 };
    const attempts = (entry.attempts ?? 0) + 1;
    if (attempts >= MAX_SYNC_ATTEMPTS) {
      await req(tx(db, QUEUE_STORE, 'readwrite').delete(id));
      return { dropped: true, attempts };
    }
    await req(tx(db, QUEUE_STORE, 'readwrite').put({ ...entry, attempts }));
    return { dropped: false, attempts };
  } finally {
    db.close();
  }
}

export async function cacheSet(key: string, data: unknown): Promise<void> {
  const db = await openDb();
  const entry: CacheEntry = { key, data, updated_at: Date.now() };
  await req(tx(db, CACHE_STORE, 'readwrite').put(entry));
  db.close();
}

export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  const db = await openDb();
  const result = await req(tx(db, CACHE_STORE, 'readonly').get(key)) as CacheEntry | undefined;
  db.close();
  return result ? (result.data as T) : null;
}

// Keep the cached collection for `key` coherent with an offline mutation so a
// reload while still offline reflects the queued change instead of the stale
// pre-mutation snapshot (M8). No-ops if the cache holds a non-array (or nothing)
// for that key — cachedFetch will repopulate it on the next successful fetch.
type CachedRow = Record<string, unknown> & { id?: unknown };

async function mutateCachedArray(key: string, fn: (rows: CachedRow[]) => CachedRow[]): Promise<void> {
  const existing = await cacheGet<unknown>(key);
  if (!Array.isArray(existing)) return;
  await cacheSet(key, fn(existing as CachedRow[]));
}

export function cacheApplyInsert(key: string, record: CachedRow): Promise<void> {
  return mutateCachedArray(key, rows => (rows.some(r => r?.id === record.id) ? rows : [...rows, record]));
}

export function cacheApplyUpdate(key: string, id: unknown, patch: CachedRow): Promise<void> {
  return mutateCachedArray(key, rows => rows.map(r => (r?.id === id ? { ...r, ...patch } : r)));
}

export function cacheApplyDelete(key: string, id: unknown): Promise<void> {
  return mutateCachedArray(key, rows => rows.filter(r => r?.id !== id));
}

export async function queueCount(): Promise<number> {
  const db = await openDb();
  const count = await req(tx(db, QUEUE_STORE, 'readonly').count());
  db.close();
  return count;
}
