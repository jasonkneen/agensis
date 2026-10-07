// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor() {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    for (const listener of this.listeners.get('open') || []) listener({});
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  localStorage.clear();
  vi.resetModules();
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('realtime reconnect ordering', () => {
  it('re-subscribes every channel before flushing queued messages', async () => {
    const { backendClient } = await import('../../src/lib/backendClient');
    const channel = backendClient.channel('test:flush-order')
      .on('broadcast', { event: 'ping' }, () => {})
      .subscribe();
    // Queued while the socket is still connecting.
    await channel.send({ type: 'broadcast', event: 'ping', payload: { n: 1 } });

    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    const actions = socket.sent.map(frame => JSON.parse(frame).action);
    expect(actions).toContain('subscribe');
    expect(actions).toContain('broadcast');
    expect(actions.indexOf('subscribe')).toBeLessThan(actions.indexOf('broadcast'));
    await channel.unsubscribe();
  });
});
