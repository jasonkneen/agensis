import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNostrCommunities } from '../../src/hooks/useNostrCommunities';
import type { NostrConnection } from '../../src/lib/nostrCommunities';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useNostrCommunities>;

function connection(id: string, workspaceId: string): NostrConnection {
  return {
    id, workspaceId, relayHttpUrl: `https://${id}.test`, relayWsUrl: `wss://${id}.test`,
    communityId: id, host: `${id}.test`, name: id, description: '', relayPubkey: 'a'.repeat(64),
    memberPubkey: 'b'.repeat(64), policyVersion: '', status: 'connected', lastError: '', subscriptions: [],
  };
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(status < 400 ? { data, error: null } : { data: null, error: { message: 'failed' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function Probe({ workspaceId }: { workspaceId: string | null }) {
  latest = useNostrCommunities(workspaceId);
  return null;
}

function render(workspaceId: string | null) {
  act(() => root.render(createElement(Probe, { workspaceId })));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('useNostrCommunities', () => {
  it('does not expose stale workspace results when requests resolve out of order', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(input =>
      String(input).includes('/workspace-a/') ? a.promise : b.promise);

    render('workspace-a');
    render('workspace-b');
    b.resolve(response([connection('community-b', 'workspace-b')]));
    await settle();
    expect(latest.connections.map(value => value.id)).toEqual(['community-b']);
    expect(latest.resolved).toBe(true);

    a.resolve(response([connection('community-a', 'workspace-a')]));
    await settle();
    expect(latest.workspaceId).toBe('workspace-b');
    expect(latest.connections.map(value => value.id)).toEqual(['community-b']);
  });

  it('retains the last verified source metadata when a refetch fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response([connection('community-a', 'workspace-a')]))
      .mockResolvedValueOnce(response(null, 503));
    render('workspace-a');
    await settle();
    expect(latest.connections.map(value => value.id)).toEqual(['community-a']);

    await act(async () => { await latest.refetch(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest.connections.map(value => value.id)).toEqual(['community-a']);
    expect(latest.resolved).toBe(true);
    expect(latest.error).toBe('failed');
  });
});
