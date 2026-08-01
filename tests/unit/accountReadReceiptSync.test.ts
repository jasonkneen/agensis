// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let receiptCallback: ((payload: {
  eventType?: string;
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
}) => void) | null = null;
const unsubscribeCallbacks = new Set<(payload: { channel: string; reason: string }) => void>();
const preferenceCallbacks = new Set<(payload: { userId: string; enabled: boolean }) => void>();

vi.mock('../../src/hooks/useTableSubscription', () => ({
  useTableSubscription: (_options: unknown, callback: typeof receiptCallback) => {
    receiptCallback = callback;
  },
}));

vi.mock('../../src/lib/backendClient', () => ({
  apiAuthHeaders: () => ({}),
  apiUrl: (value: string) => value,
  onRealtimeUnsubscribed: (callback: (payload: { channel: string; reason: string }) => void) => {
    unsubscribeCallbacks.add(callback);
    return () => { unsubscribeCallbacks.delete(callback); };
  },
  onReadReceiptPreference: (callback: (payload: { userId: string; enabled: boolean }) => void) => {
    preferenceCallbacks.add(callback);
    return () => { preferenceCallbacks.delete(callback); };
  },
}));

const { AccountDialog } = await import('../../src/components/account/AccountDialog');
const { useReadReceipts } = await import('../../src/hooks/useReadReceipts');
const { useUserProfile } = await import('../../src/hooks/useUserProfile');
const { publishUserProfileSync } = await import('../../src/lib/userProfileSync');

const USER = '11111111-1111-4111-8111-111111111111';
const READER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const MARKER = '55555555-5555-4555-8555-555555555555';
const MESSAGE = '66666666-6666-4666-8666-666666666666';
const PROFILE = {
  id: USER,
  email: 'reader@example.com',
  display_name: 'Reader',
  accent_color: '#00a95c',
  share_read_receipts: true,
  created_at: '2026-07-31T00:00:00.000Z',
};

let root: Root;
let container: HTMLDivElement;
let patchBodies: Array<Record<string, unknown>>;

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    marker_id: MARKER,
    event_version: '1',
    session_id: SESSION,
    user_id: READER,
    agent_id: null,
    thread_parent_id: null,
    last_seen_message_id: MESSAGE,
    read_at: '2026-07-31T12:00:00.000Z',
    ...overrides,
  };
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = globalThis.MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

beforeEach(() => {
  patchBodies = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/backend/users/me') && init?.method === 'PATCH') {
      const update = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
      patchBodies.push(update);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { ...PROFILE, ...update } }),
      } as Response;
    }
    if (url.endsWith('/backend/users/me')) {
      return { ok: true, status: 200, json: async () => ({ data: PROFILE }) } as Response;
    }
    if (url.endsWith(`/backend/sessions/${SESSION}/read-state`)) {
      return { ok: true, status: 200, json: async () => ({ data: { markers: [] } }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) } as Response;
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  receiptCallback = null;
  unsubscribeCallbacks.clear();
  preferenceCallbacks.clear();
  vi.unstubAllGlobals();
});

function OpenChatReceiptView() {
  const { profile } = useUserProfile(USER);
  const enabled = profile?.share_read_receipts !== false;
  const receipts = useReadReceipts({
    sessionId: SESSION,
    currentUserId: USER,
    enabled,
  });
  return React.createElement('output', {
    'data-testid': 'chat-receipts',
    'data-receipts-enabled': String(enabled),
  },
    receipts.markers.map(marker => marker.reader_id).join(','));
}

function ProfileProbe({ userId }: { userId: string }) {
  const { profile } = useUserProfile(userId);
  return React.createElement('output', {
    'data-testid': 'profile-probe',
    'data-user-id': profile?.id || '',
    'data-display-name': profile?.display_name || '',
    'data-receipts-enabled': String(profile?.share_read_receipts !== false),
  });
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('account read-receipt profile sync', () => {
  it('saving opt-out in AccountDialog immediately clears an already-open chat', async () => {
    await act(async () => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement(AccountDialog, {
          open: true,
          onOpenChange: () => {},
          userId: USER,
          userEmail: PROFILE.email,
        }),
        React.createElement(OpenChatReceiptView),
      ));
    });
    await flush();

    act(() => receiptCallback?.({
      eventType: 'INSERT',
      new: receiptRow(),
    }));
    const chat = document.body.querySelector('[data-testid="chat-receipts"]');
    expect(chat?.textContent).toBe(READER);

    const checkbox = document.body.querySelector<HTMLElement>('[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => { checkbox?.click(); });
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'Save profile');
    expect(save).toBeDefined();
    await act(async () => { save?.click(); });
    await flush();

    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]?.share_read_receipts).toBe(false);
    expect(chat?.textContent).toBe('');
  });

  it('uses the distinct server reason for profile-wide device invalidation', async () => {
    await act(async () => { root.render(React.createElement(OpenChatReceiptView)); });
    await flush();
    const chat = document.body.querySelector('[data-testid="chat-receipts"]');

    act(() => receiptCallback?.({
      eventType: 'INSERT',
      new: receiptRow(),
    }));
    expect(chat?.textContent).toBe(READER);
    expect(chat?.getAttribute('data-receipts-enabled')).toBe('true');

    act(() => {
      for (const callback of Array.from(unsubscribeCallbacks)) callback({
        channel: `session_read_state:${SESSION}`,
        reason: 'read_receipts_disabled',
      });
    });

    expect(chat?.textContent).toBe('');
    expect(chat?.getAttribute('data-receipts-enabled')).toBe('false');
  });

  it('keeps the account preference enabled for a generic session access revoke', async () => {
    await act(async () => { root.render(React.createElement(OpenChatReceiptView)); });
    await flush();
    const chat = document.body.querySelector('[data-testid="chat-receipts"]');

    act(() => receiptCallback?.({
      eventType: 'INSERT',
      new: receiptRow(),
    }));
    act(() => {
      for (const callback of Array.from(unsubscribeCallbacks)) callback({
        channel: `session_read_state:${SESSION}`,
        reason: 'access_revoked',
      });
    });

    expect(chat?.textContent).toBe('');
    expect(chat?.getAttribute('data-receipts-enabled')).toBe('true');
  });

  it('applies cross-device receipt preference changes in both directions', async () => {
    await act(async () => { root.render(React.createElement(OpenChatReceiptView)); });
    await flush();
    const chat = document.body.querySelector('[data-testid="chat-receipts"]');

    act(() => receiptCallback?.({ eventType: 'INSERT', new: receiptRow() }));
    expect(chat?.textContent).toBe(READER);

    act(() => {
      for (const callback of Array.from(preferenceCallbacks)) callback({ userId: USER, enabled: false });
    });
    expect(chat?.textContent).toBe('');
    expect(chat?.getAttribute('data-receipts-enabled')).toBe('false');

    act(() => {
      for (const callback of Array.from(preferenceCallbacks)) callback({ userId: USER, enabled: true });
    });
    expect(chat?.getAttribute('data-receipts-enabled')).toBe('true');

    act(() => receiptCallback?.({
      eventType: 'INSERT',
      new: receiptRow({ marker_id: '77777777-7777-4777-8777-777777777777', event_version: '2' }),
    }));
    expect(chat?.textContent).toBe(READER);
  });

  it('resets revisions and pending overlays when the signed-in account changes', async () => {
    const USER_B = '44444444-4444-4444-8444-444444444444';
    const profileA = { ...PROFILE, display_name: 'Account A' };
    const profileB = {
      ...PROFILE,
      id: USER_B,
      email: 'account-b@example.com',
      display_name: 'Account B',
      share_read_receipts: true,
    };
    let resolveA!: (value: Response) => void;
    let resolveB!: (value: Response) => void;
    const responseA = new Promise<Response>(resolve => { resolveA = resolve; });
    const responseB = new Promise<Response>(resolve => { resolveB = resolve; });
    let requestCount = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      requestCount += 1;
      return requestCount === 1 ? responseA : responseB;
    }));

    await act(async () => {
      root.render(React.createElement(ProfileProbe, { userId: USER }));
      await Promise.resolve();
    });
    act(() => publishUserProfileSync({
      userId: USER,
      profile: { ...profileA, display_name: 'Account A pending' },
    }));

    await act(async () => {
      root.render(React.createElement(ProfileProbe, { userId: USER_B }));
      await Promise.resolve();
    });
    act(() => publishUserProfileSync({
      userId: USER_B,
      patch: { share_read_receipts: false },
    }));

    await act(async () => {
      resolveA({
        ok: true,
        status: 200,
        json: async () => ({ data: profileA }),
      } as Response);
      await responseA;
      await Promise.resolve();
    });
    let probe = document.body.querySelector('[data-testid="profile-probe"]');
    expect(probe?.getAttribute('data-user-id')).not.toBe(USER);
    expect(probe?.getAttribute('data-display-name')).not.toBe('Account A pending');

    await act(async () => {
      resolveB({
        ok: true,
        status: 200,
        json: async () => ({ data: profileB }),
      } as Response);
      await responseB;
      await Promise.resolve();
    });
    probe = document.body.querySelector('[data-testid="profile-probe"]');
    expect(probe?.getAttribute('data-user-id')).toBe(USER_B);
    expect(probe?.getAttribute('data-display-name')).toBe('Account B');
    expect(probe?.getAttribute('data-receipts-enabled')).toBe('false');
  });
});
