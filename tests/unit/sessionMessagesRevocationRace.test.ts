import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionMessages } from '../../src/hooks/useSessionMessages';
import type { Message } from '../../src/types';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

function response(data: unknown): Response {
  return { ok: true, json: async () => ({ data }) } as Response;
}

const mocks = vi.hoisted(() => ({
  onRevoked: null as ((sessionId: string) => void) | null,
}));

vi.mock('../../src/lib/backendClient', () => ({
  apiUrl: (path: string) => path,
  apiAuthHeaders: () => ({}),
}));
vi.mock('../../src/lib/offlineBackend', () => ({
  cachedFetch: vi.fn((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
}));
vi.mock('../../src/hooks/useTableSubscription', () => ({
  useTableSubscription: vi.fn(),
  useRealtimeDeduper: () => ({ shouldProcess: () => true }),
}));
vi.mock('../../src/hooks/useSessionClosureSignal', () => ({
  useSessionClosureSignal: vi.fn(),
}));
vi.mock('../../src/hooks/useSessionRevocationSignal', () => ({
  useSessionRevocationSignal: vi.fn((_sessionId: string | null, onRevoked: (sessionId: string) => void) => {
    mocks.onRevoked = onRevoked;
  }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;
let latest: ReturnType<typeof useSessionMessages>;

function Probe({ sessionId }: { sessionId: string | null }) {
  latest = useSessionMessages(sessionId);
  return null;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
  mocks.onRevoked = null;
});

describe('session message revocation races', () => {
  it('does not prepend an earlier page that resolves after revocation', async () => {
    const earlier = deferred<Response>();
    const initial: Message = {
      id: 'newest',
      session_id: 'session-1',
      role: 'user',
      content: 'newest message',
      created_at: '2026-09-04T10:00:00.000Z',
    } as Message;
    const old: Message = {
      id: 'older',
      session_id: 'session-1',
      role: 'assistant',
      content: 'revoked message',
      created_at: '2026-09-04T09:00:00.000Z',
    } as Message;
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('before=')
      ? earlier.promise
      : Promise.resolve(response({ messages: [initial], hasMore: true }))));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Probe, { sessionId: 'session-1' }));
      await settle();
    });
    expect(latest.messages.map(message => message.id)).toEqual(['newest']);

    act(() => latest.loadEarlier());
    act(() => mocks.onRevoked?.('session-1'));
    expect(latest.messages).toEqual([]);
    expect(latest.hasMore).toBe(false);

    await act(async () => {
      earlier.resolve(response({ messages: [old], hasMore: false }));
      await earlier.promise;
      await settle();
    });
    expect(latest.messages).toEqual([]);
    expect(latest.hasMore).toBe(false);
    expect(latest.loadingEarlier).toBe(false);
  });
});
