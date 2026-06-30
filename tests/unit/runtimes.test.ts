import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runtimeStatusLabel,
  describeRunMode,
  isRuntimeOnline,
  runtimeOptionsForAgent,
  RUNTIME_PRESENCE_TTL_MS,
  fetchRuntimes,
  createJoinToken,
  setRuntimeStatus,
  setRuntimeAutoApprove,
  mapAgentRuntime,
} from '../../src/lib/runtimes';
import type { AgentRuntime } from '../../src/types';

const NOW = 1_000_000_000_000;
function runtime(p: Partial<AgentRuntime>): AgentRuntime {
  return { id: 'r', name: 'RT', status: 'approved', ...p };
}

describe('pure transforms', () => {
  it('runtimeStatusLabel maps each status and echoes an unknown one', () => {
    expect(runtimeStatusLabel('approved')).toBe('Approved');
    expect(runtimeStatusLabel('pending')).toBe('Pending approval');
    expect(runtimeStatusLabel('revoked')).toBe('Revoked');
    // Defensive default branch for any future/unknown status value.
    expect(runtimeStatusLabel('mystery' as unknown as 'approved')).toBe('mystery');
  });

  it('describeRunMode covers all modes incl. default', () => {
    expect(describeRunMode('daemon')).toBe('Remote daemon');
    expect(describeRunMode('external')).toBe('External runtime');
    expect(describeRunMode('builtin')).toBe('Built-in');
    expect(describeRunMode(undefined)).toBe('Built-in');
  });

  it('isRuntimeOnline trusts the server flag when present', () => {
    expect(isRuntimeOnline({ online: true, last_seen_at: null }, NOW)).toBe(true);
    expect(isRuntimeOnline({ online: false, last_seen_at: new Date(NOW).toISOString() }, NOW)).toBe(false);
  });

  it('isRuntimeOnline falls back to last_seen_at within the TTL', () => {
    const fresh = new Date(NOW - 1_000).toISOString();
    const stale = new Date(NOW - RUNTIME_PRESENCE_TTL_MS - 1).toISOString();
    expect(isRuntimeOnline({ last_seen_at: fresh }, NOW)).toBe(true);
    expect(isRuntimeOnline({ last_seen_at: stale }, NOW)).toBe(false);
    expect(isRuntimeOnline({ last_seen_at: null }, NOW)).toBe(false);
  });

  it('runtimeOptionsForAgent lists only approved runtimes with an online suffix', () => {
    const opts = runtimeOptionsForAgent([
      runtime({ id: 'a', name: 'Cursor', status: 'approved', online: true }),
      runtime({ id: 'b', name: 'Pending', status: 'pending' }),
      runtime({ id: 'c', name: 'Codex', status: 'approved', online: false }),
      runtime({ id: 'd', name: 'Gone', status: 'revoked' }),
    ], NOW);
    expect(opts.map((o) => o.value)).toEqual(['a', 'c']);
    expect(opts[0].label).toBe('Cursor • online');
    expect(opts[1].label).toBe('Codex');
  });
});

describe('REST wrappers', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function stubFetch(payload: unknown, ok = true, status = 200) {
    const fn = vi.fn(async () => ({ ok, status, json: async () => payload } as unknown as Response));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('fetchRuntimes GETs the workspace runtimes and unwraps data.runtimes', async () => {
    const fn = stubFetch({ data: { runtimes: [{ id: 'r1', name: 'RT', status: 'approved' }] }, error: null });
    const list = await fetchRuntimes('ws-1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('r1');
    expect(String(fn.mock.calls[0][0])).toContain('/backend/workspaces/ws-1/runtimes');
  });

  it('createJoinToken POSTs and returns the token payload', async () => {
    const fn = stubFetch({ data: { token: 'agj_x', autoApprove: false, endpoint: 'http://x/mcp', config: {}, claudeMcpAdd: 'cmd' }, error: null });
    const out = await createJoinToken('ws-1');
    expect(out.token).toBe('agj_x');
    expect(fn.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(String(fn.mock.calls[0][0])).toContain('/runtime-join-token');
  });

  it('setRuntimeStatus hits the approve/revoke action route', async () => {
    const fn = stubFetch({ data: { runtime: { id: 'r1', name: 'RT', status: 'approved' } }, error: null });
    const rt = await setRuntimeStatus('r1', 'approve');
    expect(rt.status).toBe('approved');
    expect(String(fn.mock.calls[0][0])).toContain('/backend/runtimes/r1/approve');
  });

  it('setRuntimeAutoApprove PATCHes the flag and returns it', async () => {
    const fn = stubFetch({ data: { autoApprove: true }, error: null });
    const on = await setRuntimeAutoApprove('ws-1', true);
    expect(on).toBe(true);
    expect(fn.mock.calls[0][1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)).toEqual({ autoApprove: true });
  });

  it('mapAgentRuntime POSTs the runtimeId to the agent route', async () => {
    const fn = stubFetch({ data: { agent: { id: 'a1' } }, error: null });
    await mapAgentRuntime('a1', 'r1');
    expect(String(fn.mock.calls[0][0])).toContain('/backend/agents/a1/runtime');
    expect(JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)).toEqual({ runtimeId: 'r1' });
  });

  it('throws the server error message on a non-ok response', async () => {
    stubFetch({ error: { message: 'Runtime not found' } }, false, 404);
    await expect(setRuntimeStatus('bad', 'approve')).rejects.toThrow(/Runtime not found/);
  });
});
