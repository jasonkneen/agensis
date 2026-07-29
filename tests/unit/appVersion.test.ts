import { describe, it, expect, beforeEach } from 'vitest';
import {
  decideUpdateState,
  fetchRemoteVersion,
  latestReleaseId,
  readLastSeenRelease,
  writeLastSeenRelease,
} from '../../src/lib/appVersion';

// A fetch stub that returns a given status + json body.
function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('latestReleaseId', () => {
  it('is the newest (first) authored note', () => {
    expect(latestReleaseId([{ version: 'amp-orb' }, { version: 'older' }])).toBe('amp-orb');
  });

  it('is null with no notes, so nothing can count as unseen', () => {
    expect(latestReleaseId([])).toBeNull();
  });
});

describe('decideUpdateState', () => {
  it('reports "available" when a different build is live', () => {
    expect(
      decideUpdateState({
        current: 'a', remote: 'b', latestRelease: 'n1', lastSeenRelease: 'n1',
      }),
    ).toBe('available');
  });

  it('prioritises "available" over an unseen note — reload first, recap after', () => {
    expect(
      decideUpdateState({
        current: 'a', remote: 'b', latestRelease: 'n2', lastSeenRelease: 'n1',
      }),
    ).toBe('available');
  });

  it('reports "updated" when a note exists that the user has not been shown', () => {
    expect(
      decideUpdateState({
        current: 'b', remote: 'b', latestRelease: 'n2', lastSeenRelease: 'n1',
      }),
    ).toBe('updated');
  });

  // THE REGRESSION. This used to return 'updated' because the recap was keyed on
  // BUILD_ID: any push to main — a skill file, a test, a backend-only change —
  // minted a new build id and re-showed release notes the user had already read.
  it('stays "current" when only the build changed and no new note was authored', () => {
    expect(
      decideUpdateState({
        current: 'bdd3e38', remote: 'bdd3e38', latestRelease: 'n1', lastSeenRelease: 'n1',
      }),
    ).toBe('current');
  });

  it('does not nag a first-ever visitor (lastSeenRelease null)', () => {
    expect(
      decideUpdateState({
        current: 'b', remote: 'b', latestRelease: 'n1', lastSeenRelease: null,
      }),
    ).toBe('current');
    expect(
      decideUpdateState({
        current: 'b', remote: null, latestRelease: 'n1', lastSeenRelease: null,
      }),
    ).toBe('current');
  });

  // Also the migration landing: a user carrying only the old build key reads as
  // null here, so they get one silent baseline write instead of a stale recap.
  it('stays silent when the notes failed to load rather than guessing', () => {
    expect(
      decideUpdateState({
        current: 'b', remote: 'b', latestRelease: null, lastSeenRelease: 'n1',
      }),
    ).toBe('current');
  });

  it('treats a failed remote fetch (null) as "no newer version"', () => {
    expect(
      decideUpdateState({
        current: 'b', remote: null, latestRelease: 'n1', lastSeenRelease: 'n1',
      }),
    ).toBe('current');
  });
});

describe('lastSeenRelease persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips through localStorage', () => {
    expect(readLastSeenRelease()).toBeNull();
    writeLastSeenRelease('amp-orb-runtime');
    expect(readLastSeenRelease()).toBe('amp-orb-runtime');
  });

  it('ignores a legacy build key, so an existing user gets no stale recap', () => {
    localStorage.setItem('agensis:last-seen-build', 'bdd3e38');
    expect(readLastSeenRelease()).toBeNull();
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

// The nag: "What's new" was offered on EVERY deploy. Most deploys ship no
// release note at all — a fix, a test, a skill file — so the button opened
// notes whose newest entry was days old. On a busy day that is a dozen prompts
// to re-read the same stale entry. This is the predicate AppUpdateManager uses
// to decide whether there is anything worth reading.
describe('offering "What\'s new" on a stale tab', () => {
  const hasUnseenNotes = (latest: string | null, lastSeen: string | null) =>
    Boolean(latest) && lastSeen !== latest;

  it('does not offer notes when the deploy authored none', () => {
    expect(hasUnseenNotes('amp-orb', 'amp-orb')).toBe(false);
  });

  it('offers them when a note the user has not read exists', () => {
    expect(hasUnseenNotes('inbox-rework', 'amp-orb')).toBe(true);
  });

  it('does not offer notes when there are none at all', () => {
    expect(hasUnseenNotes(null, null)).toBe(false);
  });

  // A first-ever visitor on a stale tab: nothing recorded yet, but the newest
  // note is genuinely unread, so it is honest to offer it.
  it('offers them to someone with no baseline recorded', () => {
    expect(hasUnseenNotes('amp-orb', null)).toBe(true);
  });
});
