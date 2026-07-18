import { describe, it, expect, vi, beforeEach } from 'vitest';

// Item 8 — StrictMode double-fire cleanup for the shared realtime manager.
//
// React 19 StrictMode intentionally runs an effect's setup+cleanup twice on
// mount (setup, cleanup, setup) to surface non-idempotent effects. The
// TableRealtimeManager's subscribe() returns an unsubscribe guarded by an
// `active` flag and ref-counts listeners per descriptor, so this churn must:
//   - never tear down a channel that still has a live listener,
//   - never double-decrement the ref count (a second cleanup call is a no-op),
//   - leave exactly ONE underlying channel per descriptor after the dust settles.
//
// We mock backendClient so we can count channel creations and unsubscribes.

const channelFactory = vi.fn();
const unsubscribeSpy = vi.fn();

vi.mock('../../src/lib/backendClient', () => {
  return {
    backendClient: {
      channel: (name: string) => {
        channelFactory(name);
        const handle = {
          on() { return handle; },
          subscribe() { return handle; },
          unsubscribe() { unsubscribeSpy(name); },
        };
        return handle;
      },
    },
  };
});

// Import AFTER the mock is registered.
const { tableRealtimeManager } = await import('../../src/lib/realtimeManager');

const CONFIG = { table: 'documents', event: '*', schema: 'public', channelName: 'documents:ws-1' } as const;

beforeEach(() => {
  channelFactory.mockClear();
  unsubscribeSpy.mockClear();
});

describe('TableRealtimeManager StrictMode double-fire', () => {
  it('simulated StrictMode mount (setup → cleanup → setup) leaves one live channel', () => {
    const listener = vi.fn();
    // First setup.
    const unsub1 = tableRealtimeManager.subscribe(CONFIG, listener);
    // StrictMode immediately tears the first setup down...
    unsub1();
    // ...then runs setup again.
    const unsub2 = tableRealtimeManager.subscribe(CONFIG, listener);

    // Exactly one channel should be live now. (Two were created across the
    // churn — one per setup — but the first was torn down, so net = 1 open.)
    expect(channelFactory).toHaveBeenCalledTimes(2);
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);

    // Real unmount.
    unsub2();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(2);
  });

  it('a second cleanup call is a no-op (idempotent unsubscribe)', () => {
    const listener = vi.fn();
    const unsub = tableRealtimeManager.subscribe(CONFIG, listener);
    unsub();
    const unsubCountAfterFirst = unsubscribeSpy.mock.calls.length;
    // Call cleanup again — the `active` guard must make this a no-op.
    unsub();
    unsub();
    expect(unsubscribeSpy.mock.calls.length).toBe(unsubCountAfterFirst);
  });

  it('two listeners share one channel; teardown waits for the last to leave', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const unsubA = tableRealtimeManager.subscribe(CONFIG, l1);
    const unsubB = tableRealtimeManager.subscribe(CONFIG, l2);

    // One shared channel for the same descriptor.
    expect(channelFactory).toHaveBeenCalledTimes(1);

    // First leaves — channel stays up (l2 still there).
    unsubA();
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    // Last leaves — now it tears down.
    unsubB();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('re-subscribing after full teardown creates a fresh channel', () => {
    const listener = vi.fn();
    const unsub1 = tableRealtimeManager.subscribe(CONFIG, listener);
    unsub1();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);

    // A new subscribe after the entry was deleted must open a new channel.
    const unsub2 = tableRealtimeManager.subscribe(CONFIG, listener);
    expect(channelFactory).toHaveBeenCalledTimes(2);
    unsub2();
  });
});
