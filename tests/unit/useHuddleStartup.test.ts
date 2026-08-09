import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const realtime = vi.hoisted(() => ({
  huddle: null as null | ((payload: Record<string, unknown>) => void),
}));

vi.mock('@/hooks/useTableSubscription', () => ({
  useRealtimeDeduper: () => ({ shouldProcess: () => true }),
  useTableSubscription: (
    options: { table?: string },
    callback: (payload: Record<string, unknown>) => void,
  ) => {
    if (options.table === 'huddles') realtime.huddle = callback;
  },
}));

const { useHuddle } = await import('../../src/hooks/useHuddle');

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  realtime.huddle = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('app-level huddle startup request ownership', () => {
  it('does not turn the creation fanout into a redundant GET beside startOrJoin', async () => {
    let finishPost: ((response: Response) => void) | undefined;
    const postResponse = new Promise<Response>((resolve) => { finishPost = resolve; });
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return postResponse;
      return new Response(JSON.stringify({ data: { huddle: null, events: [] } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    let started: Promise<unknown> | undefined;
    function Harness() {
      const { startOrJoin } = useHuddle('ws-1', 'session-1', 0, false);
      useEffect(() => {
        started = startOrJoin();
      }, [startOrJoin]);
      return null;
    }

    act(() => root.render(createElement(Harness)));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');

    act(() => {
      realtime.huddle?.({
        eventType: 'INSERT',
        new: { id: 'huddle-1', session_id: 'session-1' },
        old: null,
      });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishPost?.(new Response(JSON.stringify({
      data: {
        huddle: { id: 'huddle-1', session_id: 'session-1' },
        events: [],
        token: 'token',
        url: 'wss://livekit.test',
        roomName: 'agensis-huddle-1',
      },
    }), { status: 200 }));
    await act(async () => { await started; });
  });
});
