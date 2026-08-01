import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeUnsubscribedPayload } from '../../src/lib/backendClient';

const mocks = vi.hoisted(() => {
  let listener: ((payload: RealtimeUnsubscribedPayload) => void) | null = null;
  return {
    get listener() { return listener; },
    onRealtimeUnsubscribed: vi.fn((callback: (payload: RealtimeUnsubscribedPayload) => void) => {
      listener = callback;
      return () => { listener = null; };
    }),
    redactCachedSessionMessages: vi.fn(async () => {}),
    announceActivityRedaction: vi.fn(),
  };
});

vi.mock('../../src/lib/backendClient', () => ({
  onRealtimeUnsubscribed: mocks.onRealtimeUnsubscribed,
}));
vi.mock('../../src/lib/offlineBackend', () => ({
  redactCachedSessionMessages: mocks.redactCachedSessionMessages,
}));
vi.mock('../../src/lib/activityRedaction', () => ({
  announceActivityRedaction: mocks.announceActivityRedaction,
}));

import {
  revocationTargetsSession,
  useSessionRevocationSignal,
} from '../../src/hooks/useSessionRevocationSignal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function Probe({
  sessionId,
  onRevoked,
}: {
  sessionId: string | null;
  onRevoked: (sessionId: string) => void;
}) {
  useSessionRevocationSignal(sessionId, onRevoked);
  return null;
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('session revocation signal', () => {
  it('matches only an exact session channel suffix with an access revocation', () => {
    expect(revocationTargetsSession(
      { channel: 'messages:session-1', reason: 'access_revoked' },
      'session-1',
    )).toBe(true);
    expect(revocationTargetsSession(
      { channel: 'session-1', reason: 'access_revoked' },
      'session-1',
    )).toBe(true);
    expect(revocationTargetsSession(
      { channel: 'messages:not-session-1', reason: 'access_revoked' },
      'session-1',
    )).toBe(false);
    expect(revocationTargetsSession(
      { channel: 'messages:session-1', reason: 'read_receipts_disabled' },
      'session-1',
    )).toBe(false);
  });

  it('redacts durable state and mounted state immediately, using the latest callback', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const first = vi.fn();
    const latest = vi.fn();

    await act(async () => {
      root?.render(createElement(Probe, { sessionId: 'session-1', onRevoked: first }));
    });
    await act(async () => {
      root?.render(createElement(Probe, { sessionId: 'session-1', onRevoked: latest }));
    });
    expect(mocks.listener).not.toBeNull();

    act(() => {
      mocks.listener?.({ channel: 'messages:session-2', reason: 'access_revoked' });
      mocks.listener?.({ channel: 'messages:session-1', reason: 'access_revoked' });
    });

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenCalledWith('session-1');
    expect(mocks.redactCachedSessionMessages).toHaveBeenCalledWith('session-1');
    expect(mocks.announceActivityRedaction).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });
});
