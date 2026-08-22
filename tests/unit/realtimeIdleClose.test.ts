import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The shared realtime socket is closed when the last channel unregisters. Doing
// that *synchronously* is wrong twice over:
//
//   1. "No channels" is usually momentary — a StrictMode remount, or a route
//      change that unsubscribes the old screen a tick before the new screen
//      subscribes. Each one cost a full reconnect.
//   2. If the socket is still CONNECTING, close() aborts the handshake and the
//      browser logs "WebSocket is closed before the connection is established."
//
// So the close is deferred by a grace period, and — if the socket is still
// CONNECTING when it fires — deferred again until 'open'.

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  closeCalls = 0;
  private listeners = new Map<string, Array<(ev?: unknown) => void>>();

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev?: unknown) => void, opts?: { once?: boolean }) {
    const wrapped = opts?.once
      ? (ev?: unknown) => {
          this.listeners.set(type, (this.listeners.get(type) ?? []).filter(f => f !== wrapped));
          fn(ev);
        }
      : fn;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }

  send() { /* not exercised here */ }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeSocket.CLOSED;
  }

  /** Drive the handshake completing. */
  open() {
    this.readyState = FakeSocket.OPEN;
    for (const fn of [...(this.listeners.get('open') ?? [])]) fn();
  }
}

let backendClient: typeof import('../../src/lib/backendClient').backendClient;

beforeEach(async () => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers();
  vi.resetModules();
  ({ backendClient } = await import('../../src/lib/backendClient'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function subscribe(name: string) {
  const ch = backendClient.channel(name);
  ch.subscribe();
  return ch;
}

describe('realtime socket idle close', () => {
  it('does not close the socket synchronously when the last channel unregisters', () => {
    const ch = subscribe('t:1');
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    expect(socket.readyState).toBe(FakeSocket.CONNECTING);

    ch.unsubscribe();

    // This is the regression: a synchronous close() here, mid-handshake, is
    // what produced the console error.
    expect(socket.closeCalls).toBe(0);
  });

  it('keeps the socket when another channel registers inside the grace window', () => {
    const first = subscribe('t:1');
    const socket = FakeSocket.instances[0];

    first.unsubscribe();      // StrictMode cleanup
    subscribe('t:1');         // StrictMode re-setup, same tick

    vi.advanceTimersByTime(5000);

    expect(socket.closeCalls).toBe(0);
    // No reconnect churn: still exactly one socket for the whole sequence.
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('waits for the handshake before closing a still-CONNECTING socket', () => {
    const ch = subscribe('t:1');
    const socket = FakeSocket.instances[0];

    ch.unsubscribe();
    vi.advanceTimersByTime(5000);

    // Grace period elapsed and nobody re-registered — but the socket never
    // opened, so closing it now would abort the handshake.
    expect(socket.readyState).toBe(FakeSocket.CONNECTING);
    expect(socket.closeCalls).toBe(0);

    socket.open();
    expect(socket.closeCalls).toBe(1);
  });

  it('closes an OPEN socket once the grace window really has elapsed', () => {
    const ch = subscribe('t:1');
    const socket = FakeSocket.instances[0];
    socket.open();

    ch.unsubscribe();
    expect(socket.closeCalls).toBe(0);

    vi.advanceTimersByTime(5000);
    expect(socket.closeCalls).toBe(1);
  });
});
