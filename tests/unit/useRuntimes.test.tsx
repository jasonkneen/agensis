import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRuntimes } from '../../src/hooks/useRuntimes';

function routeFetch(routes: Array<{ test: RegExp; method?: string; payload: unknown; ok?: boolean; status?: number }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const hit = routes.find((r) => r.test.test(String(url)) && (!r.method || r.method === method));
    return { ok: hit?.ok ?? true, status: hit?.status ?? 200, json: async () => hit?.payload ?? { data: null, error: null } } as unknown as Response;
  });
}

describe('useRuntimes', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('loads runtimes on mount', async () => {
    vi.stubGlobal('fetch', routeFetch([
      { test: /\/runtimes$/, payload: { data: { runtimes: [{ id: 'rt-1', name: 'Cursor', status: 'approved' }] }, error: null } },
    ]));
    const { result } = renderHook(() => useRuntimes('ws-1', { pollMs: 0 }));
    await waitFor(() => expect(result.current.runtimes).toHaveLength(1));
    expect(result.current.runtimes[0].id).toBe('rt-1');
  });

  it('approve POSTs then refreshes', async () => {
    const fetchMock = routeFetch([
      { test: /\/runtimes$/, payload: { data: { runtimes: [{ id: 'rt-1', name: 'Cursor', status: 'pending' }] }, error: null } },
      { test: /\/runtimes\/rt-1\/approve$/, method: 'POST', payload: { data: { runtime: { id: 'rt-1', status: 'approved' } }, error: null } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRuntimes('ws-1', { pollMs: 0 }));
    await waitFor(() => expect(result.current.runtimes).toHaveLength(1));
    await act(async () => { await result.current.approve('rt-1'); });
    expect(fetchMock.mock.calls.some(([u, i]) =>
      /\/runtimes\/rt-1\/approve$/.test(String(u)) && (i as RequestInit)?.method === 'POST')).toBe(true);
  });

  it('revoke POSTs the revoke action then refreshes', async () => {
    const fetchMock = routeFetch([
      { test: /\/runtimes$/, payload: { data: { runtimes: [{ id: 'rt-1', name: 'Cursor', status: 'approved' }] }, error: null } },
      { test: /\/runtimes\/rt-1\/revoke$/, method: 'POST', payload: { data: { runtime: { id: 'rt-1', status: 'revoked' } }, error: null } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRuntimes('ws-1', { pollMs: 0 }));
    await waitFor(() => expect(result.current.runtimes).toHaveLength(1));
    await act(async () => { await result.current.revoke('rt-1'); });
    expect(fetchMock.mock.calls.some(([u]) => /\/runtimes\/rt-1\/revoke$/.test(String(u)))).toBe(true);
  });

  it('setAutoApprove PATCHes and returns the new flag; generateJoinToken POSTs', async () => {
    const fetchMock = routeFetch([
      { test: /\/runtimes$/, payload: { data: { runtimes: [] }, error: null } },
      { test: /\/runtime-auto-approve$/, method: 'PATCH', payload: { data: { autoApprove: true }, error: null } },
      { test: /\/runtime-join-token$/, method: 'POST', payload: { data: { token: 'agj_x', autoApprove: true, endpoint: 'e', config: {}, claudeMcpAdd: 'c' }, error: null } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRuntimes('ws-1', { pollMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let flag: boolean | undefined;
    await act(async () => { flag = await result.current.setAutoApprove(true); });
    expect(flag).toBe(true);
    let join: Awaited<ReturnType<typeof result.current.generateJoinToken>>;
    await act(async () => { join = await result.current.generateJoinToken(); });
    expect(join?.token).toBe('agj_x');
  });

  it('setAutoApprove/generateJoinToken are no-ops without a workspace', async () => {
    vi.stubGlobal('fetch', routeFetch([]));
    const { result } = renderHook(() => useRuntimes(null, { pollMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(await result.current.setAutoApprove(true)).toBe(false);
    expect(await result.current.generateJoinToken()).toBeNull();
  });

  it('surfaces an error when the list request fails', async () => {
    vi.stubGlobal('fetch', routeFetch([
      { test: /\/runtimes$/, ok: false, status: 500, payload: { error: { message: 'boom' } } },
    ]));
    const { result } = renderHook(() => useRuntimes('ws-1', { pollMs: 0 }));
    await waitFor(() => expect(result.current.error).toMatch(/boom/));
  });

  it('is inert without a workspace', async () => {
    const fetchMock = routeFetch([]);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRuntimes(null, { pollMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.runtimes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
