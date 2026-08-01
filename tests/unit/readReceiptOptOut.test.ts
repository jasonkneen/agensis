// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let receiptCallback: ((payload: {
  eventType?: string;
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
}) => void) | null = null;
let unsubscribeCallback: ((payload: { channel: string; reason: string }) => void) | null = null;
let subscriptionEnabled = false;

vi.mock('../../src/hooks/useTableSubscription', () => ({
  useTableSubscription: (
    options: { enabled?: boolean },
    callback: typeof receiptCallback,
  ) => {
    subscriptionEnabled = options.enabled !== false;
    receiptCallback = callback;
  },
}));

vi.mock('../../src/lib/backendClient', () => ({
  apiAuthHeaders: () => ({}),
  apiUrl: (value: string) => value,
  onRealtimeUnsubscribed: (callback: typeof unsubscribeCallback) => {
    unsubscribeCallback = callback;
    return () => { if (unsubscribeCallback === callback) unsubscribeCallback = null; };
  },
}));

const { useReadReceipts } = await import('../../src/hooks/useReadReceipts');

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const READER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OLD_MARKER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NEW_MARKER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

function markerRow({
  markerId = OLD_MARKER,
  eventVersion = '1',
  messageId = MESSAGE,
  readAt = '2026-07-31T12:00:00.000Z',
}: {
  markerId?: string;
  eventVersion?: string;
  messageId?: string;
  readAt?: string;
} = {}) {
  return {
    marker_id: markerId,
    event_version: eventVersion,
    session_id: SESSION,
    user_id: READER,
    agent_id: null,
    thread_parent_id: null,
    last_seen_message_id: messageId,
    read_at: readAt,
  };
}

function ReceiptView() {
  const { markers } = useReadReceipts({
    sessionId: SESSION,
    currentUserId: 'current-user',
    active: true,
    enabled: true,
  });
  return React.createElement('div', {
    'data-marker-id': markers[0]?.marker_id || '',
    'data-message-id': markers[0]?.last_seen_message_id || '',
  }, markers.map(marker => marker.reader_id).join(','));
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const mounted of roots.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
  receiptCallback = null;
  unsubscribeCallback = null;
  subscriptionEnabled = false;
  vi.unstubAllGlobals();
});

describe('read-receipt opt-out invalidation', () => {
  it('removes an existing eye when the server deletes the marker', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });

    act(() => {
      root.render(React.createElement(ReceiptView));
    });
    expect(receiptCallback).not.toBeNull();

    const row = markerRow();
    act(() => receiptCallback?.({ eventType: 'INSERT', new: row }));
    expect(container.textContent).toBe(READER);

    act(() => receiptCallback?.({ eventType: 'DELETE', old: row, new: {} }));
    expect(container.textContent).toBe('');
  });

  it('clears markers and disables the exact receipt channel when the server revokes it', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });

    act(() => {
      root.render(React.createElement(ReceiptView));
    });
    const row = markerRow();
    act(() => receiptCallback?.({ eventType: 'INSERT', new: row }));
    expect(container.textContent).toBe(READER);
    expect(subscriptionEnabled).toBe(true);

    act(() => unsubscribeCallback?.({
      channel: `session_read_state:${SESSION}`,
      reason: 'access_revoked',
    }));

    expect(container.textContent).toBe('');
    expect(subscriptionEnabled).toBe(false);
  });

  it('keeps its marker for an unrelated revoked channel', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });

    act(() => root.render(React.createElement(ReceiptView)));
    act(() => receiptCallback?.({
      eventType: 'INSERT',
      new: markerRow(),
    }));
    act(() => unsubscribeCallback?.({ channel: 'tasks:workspace-1', reason: 'access_revoked' }));

    expect(container.textContent).toBe(READER);
    expect(subscriptionEnabled).toBe(true);
  });

  it('a higher event generation replaces the pre-opt-out row even when the new read position is earlier', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });

    act(() => root.render(React.createElement(ReceiptView)));
    act(() => receiptCallback?.({
      eventType: 'INSERT',
      new: markerRow({
        markerId: OLD_MARKER,
        eventVersion: '10',
        messageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        readAt: '2026-07-31T12:05:00.000Z',
      }),
    }));
    act(() => receiptCallback?.({
      eventType: 'INSERT',
      new: markerRow({
        markerId: NEW_MARKER,
        eventVersion: '11',
        messageId: MESSAGE,
        readAt: '2026-07-31T12:00:00.000Z',
      }),
    }));

    expect(container.firstElementChild?.getAttribute('data-marker-id')).toBe(NEW_MARKER);
    expect(container.firstElementChild?.getAttribute('data-message-id')).toBe(MESSAGE);
  });

  it('retains a newer marker when the older opt-out DELETE arrives after re-enable', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });

    act(() => root.render(React.createElement(ReceiptView)));
    const oldRow = markerRow({ markerId: OLD_MARKER, eventVersion: '10' });
    const newRow = markerRow({ markerId: NEW_MARKER, eventVersion: '11' });
    act(() => receiptCallback?.({ eventType: 'INSERT', new: oldRow }));
    act(() => receiptCallback?.({ eventType: 'INSERT', new: newRow }));
    act(() => receiptCallback?.({
      eventType: 'DELETE',
      old: oldRow,
      new: {},
    }));

    expect(container.textContent).toBe(READER);
    expect(container.firstElementChild?.getAttribute('data-marker-id')).toBe(NEW_MARKER);
  });
});
