import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NostrCommunitySetup } from '../../src/components/chat/NostrCommunitySetup';
import { Dialog, DialogContent } from '../../src/components/ui/dialog';
import { nostrErrorMessage, NostrRequestError } from '../../src/lib/nostrCommunities';
import type { NostrChannel, NostrConnection } from '../../src/lib/nostrCommunities';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;

const connection: NostrConnection = {
  id: 'connection-1', workspaceId: 'workspace-1', relayHttpUrl: 'https://community.test',
  relayWsUrl: 'wss://community.test', communityId: 'community-1', host: 'community.test',
  name: 'Hermes Agents', description: '', relayPubkey: 'a'.repeat(64), memberPubkey: 'b'.repeat(64),
  policyVersion: '', status: 'connected', lastError: '', subscriptions: [],
};

function channel(overrides: Partial<NostrChannel> = {}): NostrChannel {
  return {
    id: 'support', name: 'support', description: '', type: 'stream', visibility: 'public',
    archived: false, joined: true, subscription: null, ...overrides,
  };
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(
  onCreate = vi.fn(async () => ({ id: 'session-new' })),
  onCommunityChange = vi.fn(),
  existingConnection: NostrConnection | null = connection,
) {
  root = createRoot(container);
  act(() => {
    root.render(createElement(Dialog, { open: true },
      createElement(DialogContent, null,
        createElement(NostrCommunitySetup, {
          workspaceId: 'workspace-1', existingConnection,
          onBack: () => {}, onClose: () => {}, onCreate, onCommunityChange,
        }),
      ),
    ));
  });
  return { onCreate, onCommunityChange };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('Nostr community settings re-entry', () => {
  it('distinguishes a stale Agensis preview route from a missing remote relay', () => {
    expect(nostrErrorMessage(new NostrRequestError(
      'Request failed (404)', 404, '/backend/nostr-communities/preview',
    ))).toContain('Agensis backend returned 404');
    expect(nostrErrorMessage(new NostrRequestError(
      'Could not read Nostr relay metadata: HTTP 404', 404, '/backend/nostr-communities/preview',
    ))).toContain('community host returned 404');
  });

  it('shows an actionable message when the Agensis preview route is stale', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    mount(undefined, undefined, null);
    const input = document.body.querySelector<HTMLInputElement>('#nostr-invite-url');
    expect(input).not.toBeNull();
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setInputValue?.call(input, 'https://community.test/invite/v2.example');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await act(async () => {
      await Promise.resolve();
    });
    const check = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('Check'));
    await act(async () => { check?.click(); });
    await settle();
    expect(document.body.textContent).toContain('Agensis backend returned 404');
  });

  it('shows an existing paused channel and resumes its subscription', async () => {
    const paused = {
      bridgeId: 'bridge-1', channelId: 'support', sessionId: 'session-1',
      enabled: false, status: 'disconnected', lastError: '',
    };
    const patchBodies: unknown[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        patchBodies.push(body);
        return response({ ...paused, enabled: body.enabled, status: body.enabled ? 'connected' : 'disconnected' });
      }
      return response([channel({ subscription: paused })]);
    });
    const { onCommunityChange } = mount();
    await settle();

    expect(document.body.textContent).toContain('Manage Hermes Agents');
    expect(document.body.textContent).toContain('Paused');
    const resume = document.body.querySelector<HTMLButtonElement>('[aria-label="Resume #support"]');
    expect(resume).not.toBeNull();
    await act(async () => { resume?.click(); });

    const resumeRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(new URL(String(resumeRequest?.[0]), 'http://local').pathname)
      .toBe('/backend/nostr-communities/connection-1/channels/support');
    expect(patchBodies).toEqual([{ enabled: true }]);
    expect(document.body.textContent).toContain('Live');
    expect(onCommunityChange).toHaveBeenCalledTimes(1);

    const pause = document.body.querySelector<HTMLButtonElement>('[aria-label="Pause #support"]');
    await act(async () => { pause?.click(); });
    expect(patchBodies).toEqual([{ enabled: true }, { enabled: false }]);
    expect(document.body.textContent).toContain('Paused');
    expect(onCommunityChange).toHaveBeenCalledTimes(2);
  });

  it('creates and maps a channel that was not imported during the first join', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') return response({ mapped: 1 }, 201);
      return response([channel({ id: 'random', name: 'random' })]);
    });
    const { onCreate, onCommunityChange } = mount();
    await settle();

    const select = document.body.querySelector<HTMLButtonElement>('[aria-label="Import #random"]');
    act(() => select?.click());
    const add = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('Import 1 channel'));
    await act(async () => { add?.click(); });

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: 'random' }));
    const mapRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(new URL(String(mapRequest?.[0]), 'http://local').pathname)
      .toBe('/backend/nostr-communities/connection-1/channels');
    expect(JSON.parse(String(mapRequest?.[1]?.body))).toEqual({
      mappings: [{ channelId: 'random', sessionId: 'session-new' }],
    });
    expect(onCommunityChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the paused state visible when resume is rejected', async () => {
    const paused = {
      bridgeId: 'bridge-1', channelId: 'support', sessionId: 'session-1',
      enabled: false, status: 'disconnected', lastError: '',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({ data: null, error: { message: 'Relay unavailable' } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      return response([channel({ subscription: paused })]);
    });
    mount();
    await settle();

    const resume = document.body.querySelector<HTMLButtonElement>('[aria-label="Resume #support"]');
    await act(async () => { resume?.click(); });
    expect(document.body.textContent).toContain('Paused');
    expect(document.body.textContent).toContain('Relay unavailable');
  });

  it('removes an imported channel without deleting the local Agensis history', async () => {
    const subscribed = {
      bridgeId: 'bridge-1', channelId: 'support', sessionId: 'session-1',
      enabled: true, status: 'connected', lastError: '',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE') return response({ removed: true, channelId: 'support', sessionId: 'session-1' });
      return response([channel({ subscription: subscribed })]);
    });
    const { onCommunityChange } = mount();
    await settle();

    const remove = document.body.querySelector<HTMLButtonElement>('[aria-label="Remove #support from Agensis"]');
    expect(remove).not.toBeNull();
    await act(async () => { remove?.click(); });
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Delete');
    await act(async () => { confirm?.click(); });
    await settle();

    const deleteRequest = fetchMock.mock.calls.find(([, request]) => request?.method === 'DELETE');
    expect(new URL(String(deleteRequest?.[0]), 'http://local').pathname)
      .toBe('/backend/nostr-communities/connection-1/channels/support');
    expect(document.body.textContent).not.toContain('Pause #support');
    expect(onCommunityChange).toHaveBeenCalledTimes(1);
  });

  it('deletes a community connection and closes the settings flow', async () => {
    const onClose = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE') return response(connection);
      return response([channel({ subscription: {
        bridgeId: 'bridge-1', channelId: 'support', sessionId: 'session-1',
        enabled: true, status: 'connected', lastError: '',
      } })]);
    });
    root = createRoot(container);
    act(() => {
      root.render(createElement(Dialog, { open: true },
        createElement(DialogContent, null,
          createElement(NostrCommunitySetup, {
            workspaceId: 'workspace-1', existingConnection: connection,
            onBack: () => {}, onClose, onCreate: async () => ({ id: 'session-new' }), onCommunityChange: vi.fn(),
          }),
        ),
      ));
    });
    await settle();

    const deleteConnection = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('Delete connection'));
    await act(async () => { deleteConnection?.click(); });
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Delete');
    await act(async () => { confirm?.click(); });
    await settle();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps offline imports manageable and offers invite-based reconnection', async () => {
    const paused = {
      bridgeId: 'bridge-1', channelId: 'support', sessionId: 'session-1',
      enabled: false, status: 'disconnected', lastError: '',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([channel({ subscription: paused })]));
    mount(undefined, undefined, { ...connection, status: 'disconnected' });
    await settle();

    expect(document.body.textContent).toContain('Connection paused for Hermes Agents');
    expect(document.body.textContent).toContain('#support');
    const reconnect = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('Reconnect with invite'));
    act(() => reconnect?.click());
    expect(document.body.querySelector('#nostr-invite-url')).not.toBeNull();
  });
});
