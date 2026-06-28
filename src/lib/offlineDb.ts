const DB_NAME = 'agensis_offline';
const DB_VERSION = 1;
const QUEUE_STORE = 'sync_queue';
const CACHE_STORE = 'data_cache';

interface SyncEntry {
  id?: number;
  table: string;
  operation: 'insert' | 'update' | 'delete';
  payload: Record<string, unknown>;
  created_at: number;
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
  db.close();
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

export async function queueCount(): Promise<number> {
  const db = await openDb();
  const count = await req(tx(db, QUEUE_STORE, 'readonly').count());
  db.close();
  return count;
}
