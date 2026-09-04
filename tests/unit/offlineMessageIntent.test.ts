import { beforeEach, describe, expect, it } from 'vitest';
import {
  cacheGet,
  cacheSet,
  clearOfflineData,
  enqueue,
  peekQueue,
  queueCount,
} from '../../src/lib/offlineDb';
import {
  offlineMessageSendResult,
  cachedFetch,
  redactCachedSessionMessages,
} from '../../src/lib/offlineBackend';

type Stored = Record<string, unknown>;
type RequestLike<T> = {
  result: T;
  error: null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
};

function request<T>(result: T, upgrade = false): RequestLike<T> {
  const value: RequestLike<T> = {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  };
  queueMicrotask(() => {
    if (upgrade) value.onupgradeneeded?.();
    value.onsuccess?.();
  });
  return value;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

class MemoryIndexedDb {
  private stores = new Map<string, {
    rows: Map<unknown, Stored>;
    keyPath: string;
    autoIncrement: boolean;
    nextKey: number;
  }>();

  open() {
    const stores = this.stores;
    const database = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (
        name: string,
        options: { keyPath?: string; autoIncrement?: boolean } = {},
      ) => {
        stores.set(name, {
          rows: new Map(),
          keyPath: options.keyPath || 'id',
          autoIncrement: options.autoIncrement === true,
          nextKey: 1,
        });
      },
      transaction: (name: string | string[]) => ({
        objectStore: (storeName?: string) => {
          const state = stores.get(storeName || (Array.isArray(name) ? name[0] : name));
          if (!state) throw new Error(`Missing object store: ${name}`);
          const keyOf = (entry: Stored) => entry[state.keyPath];
          return {
            add: (input: Stored) => {
              const entry = { ...input };
              let key = keyOf(entry);
              if (key == null && state.autoIncrement) {
                key = state.nextKey++;
                entry[state.keyPath] = key;
              }
              state.rows.set(key, entry);
              return request(key);
            },
            put: (input: Stored) => {
              const entry = { ...input };
              const key = keyOf(entry);
              state.rows.set(key, entry);
              return request(key);
            },
            get: (key: unknown) => request(state.rows.get(key)),
            getAll: () => request([...state.rows.values()].map(row => ({ ...row }))),
            delete: (key: unknown) => request((state.rows.delete(key), undefined)),
            clear: () => request((state.rows.clear(), undefined)),
            count: () => request(state.rows.size),
          };
        },
      }),
      close() {},
    };
    return request(database, true);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new MemoryIndexedDb(),
    configurable: true,
  });
  Object.defineProperty(navigator, 'onLine', {
    value: false,
    configurable: true,
  });
});

describe('durable offline message intents', () => {
  it('does not let a pending fetch restore a redacted transcript cache', async () => {
    await cacheSet('messages_page_session-1', {
      messages: [{ id: 'secret', session_id: 'session-1', content: 'old private body' }],
      hasMore: true,
    });
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const response = deferred<{ messages: Stored[]; hasMore: boolean }>();
    const pending = cachedFetch('messages_page_session-1', () => response.promise);

    await redactCachedSessionMessages('session-1');
    response.resolve({
      messages: [{ id: 'secret', session_id: 'session-1', content: 'new private body' }],
      hasMore: false,
    });

    await expect(pending).resolves.toBeNull();
    expect(await cacheGet('messages_page_session-1')).toEqual({ messages: [], hasMore: false });
  });

  it('does not let a pending fetch restore data after an account clear', async () => {
    await cacheSet('workspaces', [{ id: 'workspace-a', name: 'A' }]);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const response = deferred<Stored[]>();
    const pending = cachedFetch('workspaces', () => response.promise);

    await clearOfflineData();
    response.resolve([{ id: 'workspace-a', name: 'private A' }]);

    await expect(pending).resolves.toBeNull();
    expect(await cacheGet('workspaces')).toBeNull();
  });

  it('queues message persistence and agent dispatch as one intent and updates the cached page', async () => {
    await cacheSet('messages_page_session-1', {
      messages: [{
        id: 'older',
        session_id: 'session-1',
        role: 'user',
        content: 'older',
        created_at: '2026-07-31T11:59:00.000Z',
      }],
      hasMore: true,
    });

    const result = await offlineMessageSendResult({
      id: 'message-1',
      session_id: 'session-1',
      role: 'user',
      content: 'send this after reconnect',
      created_at: '2026-07-31T12:00:00.000Z',
    }, {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      content: 'send this after reconnect',
      threadParentId: null,
      autoThread: true,
    });

    expect(result.queued).toBe(true);
    expect(result.error).toBeNull();
    expect(result.data).not.toHaveProperty('updated_at');
    const queue = await peekQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: 1,
      table: 'messages',
      operation: 'message_send',
      payload: {
        message: {
          id: 'message-1',
          session_id: 'session-1',
          content: 'send this after reconnect',
        },
        dispatch: {
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          messageId: 'message-1',
          autoThread: true,
        },
      },
    });

    const cached = await cacheGet<{
      messages: Stored[];
      hasMore: boolean;
    }>('messages_page_session-1');
    expect(cached?.messages.map(row => row.id)).toEqual(['older', 'message-1']);
    expect(cached?.hasMore).toBe(true);
  });

  it('revocation removes every queued session mutation and every cached message body', async () => {
    await cacheSet('messages_page_session-1', {
      messages: [{ id: 'secret', session_id: 'session-1', content: 'private body' }],
      hasMore: true,
    });
    await offlineMessageSendResult({
      id: 'message-1',
      session_id: 'session-1',
      role: 'user',
      content: 'queued private body',
    }, {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      content: 'queued private body',
    });
    await enqueue({
      table: 'messages',
      operation: 'insert',
      payload: { id: 'message-2', session_id: 'session-1', content: 'legacy queued body' },
    });
    await enqueue({
      table: 'messages',
      operation: 'insert',
      payload: { id: 'other', session_id: 'session-2', content: 'keep this session' },
    });
    expect(await queueCount()).toBe(3);

    await redactCachedSessionMessages('session-1');

    expect(await cacheGet('messages_page_session-1')).toEqual({
      messages: [],
      hasMore: false,
    });
    const remaining = await peekQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.payload.session_id).toBe('session-2');
  });
});
