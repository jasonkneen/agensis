// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SocketListener = (event: { data?: string }) => void;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Set<SocketListener>>();

  constructor() {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener) {
    let group = this.listeners.get(type);
    if (!group) {
      group = new Set();
      this.listeners.set(type, group);
    }
    group.add(listener);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit('open', {});
  }

  message(value: unknown) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  private emit(type: string, event: { data?: string }) {
    for (const listener of this.listeners.get(type) || []) listener(event);
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

describe('backend system event envelopes', () => {
  it('delivers unsubscribe frames in both top-level and payload wire shapes', async () => {
    const { backendClient, onRealtimeUnsubscribed } = await import('../../src/lib/backendClient');
    const received: Array<{ channel: string; reason: string }> = [];
    const stop = onRealtimeUnsubscribed(payload => received.push(payload));
    const channel = backendClient.channel('test:system-events')
      .on('db_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {})
      .subscribe();
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    socket.message({
      type: 'system',
      event: 'unsubscribed',
      channel: 'session_read_state:one',
      reason: 'access_revoked',
    });
    socket.message({
      type: 'system',
      event: 'unsubscribed',
      payload: {
        channel: 'session_read_state:two',
        reason: 'access_revoked',
      },
    });

    expect(received).toEqual([
      { channel: 'session_read_state:one', reason: 'access_revoked' },
      { channel: 'session_read_state:two', reason: 'access_revoked' },
    ]);
    stop();
    await channel.unsubscribe();
  });

  it('delivers read-receipt preference changes in both top-level and payload wire shapes', async () => {
    const { backendClient, onReadReceiptPreference } = await import('../../src/lib/backendClient');
    const received: Array<{ userId: string; enabled: boolean }> = [];
    const stop = onReadReceiptPreference(payload => received.push(payload));
    const channel = backendClient.channel('test:receipt-preference')
      .on('db_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {})
      .subscribe();
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    socket.message({
      type: 'system',
      event: 'read_receipts_preference',
      userId: 'user-1',
      enabled: false,
    });
    socket.message({
      type: 'system',
      event: 'read_receipts_preference',
      payload: { userId: 'user-1', enabled: true },
    });
    socket.message({
      type: 'system',
      event: 'read_receipts_preference',
      payload: { userId: 'user-1', enabled: 'true' },
    });

    expect(received).toEqual([
      { userId: 'user-1', enabled: false },
      { userId: 'user-1', enabled: true },
    ]);
    stop();
    await channel.unsubscribe();
  });
});
