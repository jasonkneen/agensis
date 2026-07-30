// Client-side build/version tracking for the "what's new" update flow.
//
// Two ids are in play:
//   - BUILD_ID   — baked into THIS bundle at build time (immutable once shipped).
//   - remote id  — read fresh from /version.json (reflects the latest deploy).
// When they diverge, a newer frontend has published but we're still running the
// old one → offer a reload. We also remember the last build the user actually
// acknowledged (localStorage) so the first load AFTER an update can show a
// "you're now on the latest — here's what changed" note exactly once.

// Injected by Vite `define`. `typeof` guard (never bare) because vitest doesn't
// apply the app's define, so the symbol is genuinely undeclared there.
export const BUILD_ID: string =
  typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

// Injected by Vite `define` from package.json. `typeof` guard as above.
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

export interface RemoteVersion {
  buildId: string;
  commit: string | null;
  builtAt: string | null;
}

// 'available' — a newer build is live; we're stale and should reload.
// 'updated'   — we're now running a build the user hasn't seen the notes for.
// 'current'   — nothing to show.
export type UpdateState = 'available' | 'updated' | 'current';

// Keyed on the newest RELEASE NOTE, not on BUILD_ID.
//
// It used to be `agensis:last-seen-build`, and that is what made the dialog feel
// broken: BUILD_ID is the git commit, so every push to main — a skill file, a
// test, a backend-only change — produced a new build id and re-showed "here's
// what changed" with release notes the user had already read. The popup fired on
// deploy frequency; the content only changed when someone authored a note.
// Keying on the note itself means the recap appears exactly when there is
// something new to recap.
//
// Migration: a user carrying only the old build key reads as `null` here, which
// is the first-ever-visitor path — one silent baseline write, no popup. That is
// the intended landing, since by definition they have already seen the newest
// note that exists today.
const LAST_SEEN_RELEASE_KEY = 'agensis:last-seen-release';

export function readLastSeenRelease(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_RELEASE_KEY);
  } catch {
    return null;
  }
}

export function writeLastSeenRelease(id: string): void {
  try {
    localStorage.setItem(LAST_SEEN_RELEASE_KEY, id);
  } catch {
    /* private mode / storage disabled — non-fatal, we just re-nudge next time */
  }
}

/** The id we track "seen" against: the newest authored note's version slug. */
export function latestReleaseId(
  notes: ReadonlyArray<{ version: string }>,
): string | null {
  return notes.length ? notes[0].version : null;
}

// Pure decision so it can be unit-tested without a DOM or network.
//   current         — the build id compiled into the running bundle (BUILD_ID).
//   remote          — version.json's buildId, or null if the fetch failed / dev.
//   latestRelease   — newest authored note's version, or null if none/unfetched.
//   lastSeenRelease — newest note the user has been shown, null on first visit.
export function decideUpdateState(opts: {
  current: string;
  remote: string | null;
  latestRelease: string | null;
  lastSeenRelease: string | null;
}): UpdateState {
  const { current, remote, latestRelease, lastSeenRelease } = opts;
  // A different build is live than the one we're running → we're stale. This one
  // IS correctly build-keyed: it's about the bundle in this tab, not the notes.
  if (remote && remote !== current) return 'available';
  // We're on the latest bundle, and a note exists that we've never shown.
  // (lastSeenRelease === null is a first-ever visitor — record silently.)
  if (latestRelease && lastSeenRelease !== null && lastSeenRelease !== latestRelease) {
    return 'updated';
  }
  return 'current';
}

// Fetches /version.json with cache bypassed so we always see the true latest.
// Returns null on any failure (dev has no version.json; offline; malformed) —
// callers treat null as "no newer version known", never as an error.
export async function fetchRemoteVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteVersion | null> {
  try {
    const res = await fetchImpl('/version.json', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<RemoteVersion> | null;
    if (!body || typeof body.buildId !== 'string' || !body.buildId) return null;
    return {
      buildId: body.buildId,
      commit: typeof body.commit === 'string' ? body.commit : null,
      builtAt: typeof body.builtAt === 'string' ? body.builtAt : null,
    };
  } catch {
    return null;
  }
}
