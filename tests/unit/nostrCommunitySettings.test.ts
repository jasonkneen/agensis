import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NostrCommunitySetup } from '../../src/components/chat/NostrCommunitySetup';
import { Dialog, DialogContent } from '../../src/components/ui/dialog';
import type { NostrChannel, NostrConnection } from '../../src/lib/nostrCommunities';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

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
  existingConnection: NostrConnection = connection,
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
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('Nostr community settings re-entry', () => {
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
