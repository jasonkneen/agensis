// ---------------------------------------------------------------------------
// ONE SPEAKER PER SESSION, app-wide.
//
// agensis is a single page holding many in-page windows, so the same DM or
// channel can be mounted more than once at the same time — two windows on one
// desktop, a window plus a snapped tile, the same DM reopened beside itself.
// Every mount of the huddle card runs its own speech-output hook, and each one
// polls the same transcript session and speaks every new reply. Two mounts
// therefore read every reply TWICE, a beat apart, which is heard as two voices
// talking over each other.
//
// That is invisible to any per-component fix: each speaker is behaving
// correctly in isolation. The invariant has to live outside them all, so it
// lives here — a module-level claim keyed by session id. The first mount to
// claim a session is the one that speaks; later mounts render their UI, show
// who is speaking, and stay silent until the holder releases (unmount, or the
// session changing under it).
//
// Module scope is exactly the right scope: it is per-page, and the windows that
// collide are all in one page. A second browser TAB has its own module instance
// and its own audio output, which is a different situation and correctly not
// this file's problem.
// ---------------------------------------------------------------------------

/** Session id -> the token currently allowed to speak for it. */
const holders = new Map<string, symbol>();

/** Notified when a claim is released so a waiting speaker can take over. */
const listeners = new Set<() => void>();

/**
 * Try to become the speaker for `sessionId`. Returns true if this token now
 * holds the claim — including when it already held it, so calling repeatedly
 * from a render or an effect is safe.
 */
export function claimSpeaker(sessionId: string, token: symbol): boolean {
  if (!sessionId) return false;
  const holder = holders.get(sessionId);
  if (holder === token) return true;
  if (holder === undefined) {
    holders.set(sessionId, token);
    return true;
  }
  return false;
}

/**
 * Give up the claim if this token holds it. A token that does not hold it is
 * ignored, so an unmount racing another mount's claim cannot steal the session
 * from the speaker that legitimately took over.
 */
export function releaseSpeaker(sessionId: string, token: symbol): void {
  if (!sessionId) return;
  if (holders.get(sessionId) !== token) return;
  holders.delete(sessionId);
  // Copied before iterating: a listener may unsubscribe while being notified.
  for (const listener of Array.from(listeners)) listener();
}

/** Whether this token is the one allowed to speak. */
export function holdsSpeaker(sessionId: string, token: symbol): boolean {
  return !!sessionId && holders.get(sessionId) === token;
}

/** Subscribe to releases, so a silent mount can retry its claim. */
export function subscribeSpeakerReleases(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests only — drop all claims between cases. */
export function __resetSpeakerClaims(): void {
  holders.clear();
  listeners.clear();
}
