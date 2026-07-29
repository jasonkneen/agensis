import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BroadcastSendMessage } from '../../src/types/realtime';

// The real hook against a fake transport, because the two claims that matter
// are only true end to end.
//
// THE FAKE IS A DUMB BYTE PIPE ON PURPOSE. It records what the hook sent and
// lets the test hand-construct what arrives. It never derives an inbound frame
// from an outbound one — a fake that replays the emitter tests the fake — and
// it does not import TYPING_TTL_MS, so the expiry assertions below are made
// against a literal 6000 that the production constant has to keep agreeing
// with.

type Handler = (message: { payload: unknown }) => void;

const channels: FakeChannel[] = [];

class FakeChannel {
  name: string;
  sent: BroadcastSendMessage[] = [];
  handlers = new Map<string, Handler[]>();
  subscribed = false;

  constructor(name: string) {
    this.name = name;
  }

  on(_type: string, config: { event: string }, callback: Handler) {
    const list = this.handlers.get(config.event) || [];
    list.push(callback);
    this.handlers.set(config.event, list);
    return this;
  }

  subscribe(callback?: (status: string) => void) {
    this.subscribed = true;
    callback?.('SUBSCRIBED');
    return this;
  }

  unsubscribe() {
    this.subscribed = false;
    return Promise.resolve();
  }

  send(message: BroadcastSendMessage) {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** Inbound. Hand-built by the test; never derived from `sent`. */
  deliver(event: string, payload: unknown) {
    for (const handler of this.handlers.get(event) || []) handler({ payload });
  }

  framesFor(event: string) {
    return this.sent.filter(frame => frame.event === event);
  }
}

vi.mock('../../src/lib/backendClient', () => ({
  backendClient: {
    channel: (name: string) => {
      const channel = new FakeChannel(name);
      channels.push(channel);
      return channel;
    },
  },
}));

const { useItemPresence } = await import('../../src/hooks/useItemPresence');

type HookResult = ReturnType<typeof useItemPresence>;

const LOCAL_USER = 'user-local';
const PEER = 'user-peer';
const SESSION = 'session-1';
const T0 = 1_700_000_000_000;

let container: HTMLDivElement;
let root: Root;
let latest: HookResult;

function Harness({ onRender }: { onRender: (value: HookResult) => void }) {
  const presence = useItemPresence(
    'ws-1',
    [],
    'base',
    LOCAL_USER,
    'ada@example.test',
    'all',
  );
  useEffect(() => { onRender(presence); });
  return null;
}

function mount() {
  act(() => {
    root.render(createElement(Harness, { onRender: (value: HookResult) => { latest = value; } }));
  });
  const channel = channels.find(c => c.name === 'item-presence:ws-1');
  if (!channel) throw new Error('presence channel was never opened');
  return channel;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  channels.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('setTyping on the wire', () => {
  it('never sends a window snapshot, whatever the composer does', () => {
    // THE test. `setTyping` used to call sendSnapshot() — a ~2 KB payload
    // carrying every open window, fanned out to every socket in the workspace.
    // Wired to a keystroke handler that is ~50 KB/s from one person typing one
    // sentence in a five-person workspace, on the exact path
    // plans/012-cut-idle-realtime-chatter.md was written to reduce.
    const channel = mount();
    channel.sent.length = 0;

    act(() => {
      for (let i = 0; i < 20; i++) latest.setTyping('chat', SESSION, true);
    });

    expect(channel.framesFor('presence_snapshot')).toHaveLength(0);
    expect(channel.sent).toHaveLength(1);
    for (const frame of channel.sent) {
      expect(frame.event).toBe('typing');
      expect(JSON.stringify(frame.payload).length).toBeLessThan(256);
    }
  });

  it('throttles a continuous typist to one frame per 4s', () => {
    const channel = mount();
    channel.sent.length = 0;

    // 5s of typing at ~48wpm. setSystemTime moves the clock WITHOUT running the
    // heartbeat, so nothing else lands on the wire to confuse the count.
    act(() => {
      for (let i = 0; i < 20; i++) {
        vi.setSystemTime(T0 + i * 250);
        latest.setTyping('chat', SESSION, true);
      }
    });

    expect(channel.framesFor('typing')).toHaveLength(2);
    expect(channel.framesFor('presence_snapshot')).toHaveLength(0);
  });

  it('sends a relative ttlMs, never an absolute deadline', () => {
    const channel = mount();
    channel.sent.length = 0;
    act(() => { latest.setTyping('chat', SESSION, true); });

    const payload = channel.framesFor('typing')[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ v: 1, userId: LOCAL_USER, scope: 'chat', itemId: SESSION });
    expect(payload.ttlMs).toBe(6000);
    expect(payload).not.toHaveProperty('until');
    expect(payload).not.toHaveProperty('lastSeen');
    // A duration, not a timestamp: nothing in the frame is near epoch-now.
    expect(Number(payload.ttlMs)).toBeLessThan(T0);
  });

  it('sends one stop frame and then goes quiet', () => {
    const channel = mount();
    act(() => { latest.setTyping('chat', SESSION, true); });
    channel.sent.length = 0;

    act(() => {
      latest.setTyping('chat', SESSION, false);
      latest.setTyping('chat', SESSION, false);
    });

    const stops = channel.framesFor('typing');
    expect(stops).toHaveLength(1);
    expect((stops[0].payload as { ttlMs: number }).ttlMs).toBe(0);
  });
});

describe('received typing', () => {
  function typingFrame(overrides: Record<string, unknown> = {}) {
    return {
      v: 1,
      userId: PEER,
      name: 'grace',
      color: '#8b5cf6',
      scope: 'chat',
      itemId: SESSION,
      ttlMs: 6000,
      ...overrides,
    };
  }

  it('lights the sidebar row up', () => {
    const channel = mount();
    act(() => { channel.deliver('typing', typingFrame()); });

    expect(latest.chatPresence[SESSION]).toEqual([
      { userId: PEER, name: 'grace', color: '#8b5cf6', typing: true },
    ]);
  });

  it('clears itself after the TTL with no stop frame ever delivered', () => {
    // The answer to "what does the UI show when the signal simply stops": it
    // stops on its own. This is the guard against the "Thinking 2m 11s" class of
    // bug — an indicator that outlives the thing it describes.
    const channel = mount();
    act(() => { channel.deliver('typing', typingFrame()); });
    expect(latest.chatPresence[SESSION]).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(8000); });
    expect(latest.chatPresence[SESSION]).toBeUndefined();
  });

  it('survives a sender whose clock is five minutes behind', () => {
    // The frame carries a duration, so the receiver's arrival time is the only
    // clock involved.
    const channel = mount();
    act(() => { channel.deliver('typing', typingFrame({ ttlMs: 6000 })); });

    act(() => { vi.advanceTimersByTime(4000); });
    expect(latest.chatPresence[SESSION]).toHaveLength(1);
  });

  it('ignores the local user echoed back by the relay', () => {
    // relayBroadcast does not exclude the sender.
    const channel = mount();
    act(() => { channel.deliver('typing', typingFrame({ userId: LOCAL_USER })); });
    expect(latest.chatPresence[SESSION]).toBeUndefined();
  });

  it('drops a peer immediately on presence_leave', () => {
    const channel = mount();
    act(() => { channel.deliver('typing', typingFrame()); });
    act(() => { channel.deliver('presence_leave', { userId: PEER }); });
    expect(latest.chatPresence[SESSION]).toBeUndefined();
  });

  it('routes a document frame to documentPresence, not chatPresence', () => {
    const channel = mount();
    act(() => { channel.deliver('typing', typingFrame({ scope: 'document', itemId: 'doc-9' })); });
    expect(latest.documentPresence['doc-9']).toHaveLength(1);
    expect(latest.chatPresence['doc-9']).toBeUndefined();
  });
});
