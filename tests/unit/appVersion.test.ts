import { describe, it, expect, beforeEach } from 'vitest';
import {
  decideUpdateState,
  fetchRemoteVersion,
  readLastSeenBuild,
  writeLastSeenBuild,
} from '../../src/lib/appVersion';

// A fetch stub that returns a given status + json body.
function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('decideUpdateState', () => {
  it('reports "available" when a different build is live', () => {
    expect(
      decideUpdateState({ current: 'a', remote: 'b', lastSeen: 'a' }),
    ).toBe('available');
  });

  it('prioritises "available" even if lastSeen is also stale', () => {
    expect(
      decideUpdateState({ current: 'a', remote: 'b', lastSeen: 'z' }),
    ).toBe('available');
  });

  it('reports "updated" when running a build the user has not seen', () => {
    expect(
      decideUpdateState({ current: 'b', remote: 'b', lastSeen: 'a' }),
    ).toBe('updated');
  });

  it('reports "current" when lastSeen matches the running build', () => {
    expect(
      decideUpdateState({ current: 'b', remote: 'b', lastSeen: 'b' }),
    ).toBe('current');
  });

  it('does not nag a first-ever visitor (lastSeen null)', () => {
    expect(
      decideUpdateState({ current: 'b', remote: 'b', lastSeen: null }),
    ).toBe('current');
    expect(
      decideUpdateState({ current: 'b', remote: null, lastSeen: null }),
    ).toBe('current');
  });

  it('treats a failed remote fetch (null) as "no newer version"', () => {
    expect(
      decideUpdateState({ current: 'b', remote: null, lastSeen: 'b' }),
    ).toBe('current');
  });
});

describe('lastSeen persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips through localStorage', () => {
    expect(readLastSeenBuild()).toBeNull();
    writeLastSeenBuild('build-123');
    expect(readLastSeenBuild()).toBe('build-123');
  });
});

describe('fetchRemoteVersion', () => {
  it('parses a well-formed version.json', async () => {
    const v = await fetchRemoteVersion(
      stubFetch(200, { buildId: 'sha1', commit: 'sha1', builtAt: '2026-07-04T00:00:00Z' }),
    );
    expect(v).toEqual({ buildId: 'sha1', commit: 'sha1', builtAt: '2026-07-04T00:00:00Z' });
  });

  it('normalises missing optional fields to null', async () => {
    const v = await fetchRemoteVersion(stubFetch(200, { buildId: 'sha1' }));
    expect(v).toEqual({ buildId: 'sha1', commit: null, builtAt: null });
  });

  it('returns null on a non-2xx response', async () => {
    expect(await fetchRemoteVersion(stubFetch(404, {}))).toBeNull();
  });

  it('returns null when buildId is missing or empty', async () => {
    expect(await fetchRemoteVersion(stubFetch(200, { commit: 'x' }))).toBeNull();
    expect(await fetchRemoteVersion(stubFetch(200, { buildId: '' }))).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchRemoteVersion(throwing)).toBeNull();
  });
});
