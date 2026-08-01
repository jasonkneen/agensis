import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/lib/backendClient');
  vi.resetModules();
  vi.unstubAllGlobals();
});

function payload() {
  return {
    message: {
      id: 'message-1',
      session_id: 'session-1',
      role: 'user',
      content: 'resume this work',
    },
    dispatch: {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      content: 'resume this work',
      threadParentId: 'thread-1',
      autoThread: true,
    },
  };
}

describe('offline message replay', () => {
  function backendProbe() {
    return {
      from() {
        return {
          select() {
            const query = {
              eq() { return query; },
              limit: async () => ({ data: [{ id: 'message-1' }], error: null }),
            };
            return query;
          },
          async insert() { return { data: null, error: null }; },
        };
      },
    };
  }

  it.each([
    ['already committed', true, 0],
    ['not committed', false, 1],
  ])('dispatches once when the message is %s', async (_label, alreadyCommitted, expectedInserts) => {
    const inserts: unknown[] = [];
    const selectFilters: Array<[string, string]> = [];
    const backendClient = {
      from(table: string) {
        expect(table).toBe('messages');
        return {
          select() {
            const query = {
              eq(column: string, value: string) {
                selectFilters.push([column, value]);
                return query;
              },
              limit: async () => ({
                data: alreadyCommitted ? [{ id: 'message-1' }] : [],
                error: null,
              }),
            };
            return query;
          },
          async insert(row: unknown) {
            inserts.push(row);
            return { data: null, error: null };
          },
        };
      },
    };
    vi.doMock('../../src/lib/backendClient', () => ({
      apiAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      apiUrl: (path: string) => path,
      backendClient,
    }));
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: { dispatched: true }, error: null }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { replayQueuedMessage } = await import('../../src/hooks/useNetworkStatus');
    await replayQueuedMessage(payload());

    expect(selectFilters).toEqual([
      ['session_id', 'session-1'],
      ['id', 'message-1'],
    ]);
    expect(inserts).toHaveLength(expectedInserts);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      content: 'resume this work',
      threadParentId: 'thread-1',
      autoThread: true,
    });
  });

  it('does not report success when dispatch rejects after an idempotent insert probe', async () => {
    const backendClient = {
      from() {
        return {
          select() {
            const query = {
              eq() { return query; },
              limit: async () => ({ data: [{ id: 'message-1' }], error: null }),
            };
            return query;
          },
          async insert() { return { data: null, error: null }; },
        };
      },
    };
    vi.doMock('../../src/lib/backendClient', () => ({
      apiAuthHeaders: () => ({}),
      apiUrl: (path: string) => path,
      backendClient,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Conversation access was revoked' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));

    const { replayQueuedMessage } = await import('../../src/hooks/useNetworkStatus');
    await expect(replayQueuedMessage(payload())).rejects.toThrow('Conversation access was revoked');
  });

  it('accepts mention-only as a completed routing decision', async () => {
    const backendClient = {
      from() {
        return {
          select() {
            const query = {
              eq() { return query; },
              limit: async () => ({ data: [{ id: 'message-1' }], error: null }),
            };
            return query;
          },
          async insert() { return { data: null, error: null }; },
        };
      },
    };
    vi.doMock('../../src/lib/backendClient', () => ({
      apiAuthHeaders: () => ({}),
      apiUrl: (path: string) => path,
      backendClient,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        dispatched: false,
        reason: 'channel_replies_on_mention_only',
      },
      error: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { replayQueuedMessage } = await import('../../src/hooks/useNetworkStatus');
    await replayQueuedMessage(payload());
  });

  it('replays a post-only intent without waking an agent', async () => {
    vi.doMock('../../src/lib/backendClient', () => ({
      apiAuthHeaders: () => ({}),
      apiUrl: (path: string) => path,
      backendClient: backendProbe(),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { replayQueuedMessage } = await import('../../src/hooks/useNetworkStatus');

    await expect(replayQueuedMessage({
      ...payload(),
      dispatch: { ...payload().dispatch, route: 'post_only' },
    })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replays a direct-AI intent through the persisted ai-chat lane', async () => {
    vi.doMock('../../src/lib/backendClient', () => ({
      apiAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      apiUrl: (path: string) => path,
      backendClient: backendProbe(),
    }));
    const fetchMock = vi.fn(async () => new Response('data: {"done":true}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { replayQueuedMessage } = await import('../../src/hooks/useNetworkStatus');

    await replayQueuedMessage({
      ...payload(),
      dispatch: {
        ...payload().dispatch,
        route: 'direct_ai',
        replyMessageId: 'reply-1',
        model: 'openai/gpt-5',
        replyAgentId: 'agent-1',
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/backend/ai-chat');
    expect(JSON.parse(String(init.body))).toMatchObject({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      messageId: 'reply-1',
      seedMessageId: 'message-1',
      threadParentId: 'thread-1',
      replyAgentId: 'agent-1',
      model: 'openai/gpt-5',
    });
  });

  it('falls back from an unavailable agent dispatch to the captured direct-AI lane', async () => {
    vi.doMock('../../src/lib/backendClient', () => ({
      apiAuthHeaders: () => ({}),
      apiUrl: (path: string) => path,
      backendClient: backendProbe(),
    }));
    const fetchMock = vi.fn(async (url: string) => url === '/backend/agents/dispatch'
      ? new Response(JSON.stringify({ data: { dispatched: false, reason: 'serverless_dispatch_unavailable' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
      : new Response('data: {"done":true}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const { replayQueuedMessage } = await import('../../src/hooks/useNetworkStatus');

    await replayQueuedMessage({
      ...payload(),
      dispatch: {
        ...payload().dispatch,
        route: 'agent',
        fallback: 'direct_ai',
        replyMessageId: 'reply-2',
        model: 'openai/gpt-5',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/backend/agents/dispatch',
      '/backend/ai-chat',
    ]);
  });

  it.each([
    ['serverless dispatch unavailable', {
      data: { dispatched: false, reason: 'serverless_dispatch_unavailable' },
      error: null,
    }],
    ['malformed success body', {}],
  ])('keeps the durable reply intent when the 2xx response is %s', async (_label, responseBody) => {
    const backendClient = {
      from() {
        return {
          select() {
            const query = {
              eq() { return query; },
              limit: async () => ({ data: [{ id: 'message-1' }], error: null }),
            };
            return query;
          },
          async insert() { return { data: null, error: null }; },
        };
      },
    };
    vi.doMock('../../src/lib/backendClient', () => ({
      apiAuthHeaders: () => ({}),
      apiUrl: (path: string) => path,
      backendClient,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const { keepQueuedMessageDispatch, replayQueuedMessage } = await import('../../src/hooks/useNetworkStatus');
    const failure = await replayQueuedMessage(payload()).then(
      () => null,
      error => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(keepQueuedMessageDispatch(failure)).toBe(true);
  });
});
