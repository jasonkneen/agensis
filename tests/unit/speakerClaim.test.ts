import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSpeakerClaims, claimSpeaker, holdsSpeaker, releaseSpeaker, subscribeSpeakerReleases,
} from '../../src/lib/speakerClaim';

// agensis is ONE page of in-page windows, so the same DM can be mounted twice at
// once. Each mount polls the same transcript and speaks every new reply, so two
// mounts read every reply twice a beat apart — heard as two voices. Each speaker
// is correct in isolation, so the invariant has to live outside all of them.
describe('speakerClaim', () => {
  beforeEach(() => __resetSpeakerClaims());

  it('the FIRST claimant speaks and the second does not', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    expect(claimSpeaker('dm-1', a)).toBe(true);
    expect(claimSpeaker('dm-1', b)).toBe(false);
    expect(holdsSpeaker('dm-1', a)).toBe(true);
    expect(holdsSpeaker('dm-1', b)).toBe(false);
  });

  it('re-claiming is idempotent — effects may run more than once', () => {
    const a = Symbol('a');
    expect(claimSpeaker('dm-1', a)).toBe(true);
    expect(claimSpeaker('dm-1', a)).toBe(true);
  });

  it('different sessions never contend', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    expect(claimSpeaker('dm-1', a)).toBe(true);
    expect(claimSpeaker('dm-2', b)).toBe(true);
  });

  it('releasing hands the voice to a waiting mount, not to silence', () => {
    // Closing the window that held the claim must not leave the huddle mute.
    const a = Symbol('a');
    const b = Symbol('b');
    claimSpeaker('dm-1', a);
    const listener = vi.fn(() => { claimSpeaker('dm-1', b); });
    subscribeSpeakerReleases(listener);
    releaseSpeaker('dm-1', a);
    expect(listener).toHaveBeenCalled();
    expect(holdsSpeaker('dm-1', b)).toBe(true);
  });

  it('a NON-holder cannot release the session out from under the holder', () => {
    // An unmount racing another mount's claim must not steal the session.
    const a = Symbol('a');
    const b = Symbol('b');
    claimSpeaker('dm-1', a);
    releaseSpeaker('dm-1', b);
    expect(holdsSpeaker('dm-1', a)).toBe(true);
  });

  it('an empty session id is never claimable', () => {
    expect(claimSpeaker('', Symbol('a'))).toBe(false);
  });

  it('a listener that unsubscribes while being notified does not break the loop', () => {
    const a = Symbol('a');
    claimSpeaker('dm-1', a);
    let unsubscribe = () => {};
    const second = vi.fn();
    unsubscribe = subscribeSpeakerReleases(() => unsubscribe());
    subscribeSpeakerReleases(second);
    expect(() => releaseSpeaker('dm-1', a)).not.toThrow();
    expect(second).toHaveBeenCalled();
  });
});
