import { describe, expect, it } from 'vitest';
import {
  dismissableInvites,
  dismissedCount,
  inviteLifecycleState,
  isInviteDismissable,
  isInviteSpent,
  visibleInvites,
  type DismissableInvite,
} from '../../src/lib/inviteDismissal';

// The dangerous case is the one that must REFUSE: a still-active invite link
// must never be dismissable. Hiding it would leave a link that still grants
// access with nowhere left to see or revoke it — the list is the only surface
// it appears on. Everything else here is bookkeeping around that.

const NOW = Date.parse('2026-07-26T12:00:00Z');
const YESTERDAY = new Date(NOW - 86_400_000).toISOString();
const NEXT_WEEK = new Date(NOW + 7 * 86_400_000).toISOString();

function invite(overrides: Partial<DismissableInvite> = {}): DismissableInvite & { id: string } {
  return {
    id: 'i1',
    status: 'pending',
    expires_at: NEXT_WEEK,
    dismissed_at: null,
    ...overrides,
  };
}

describe('inviteLifecycleState', () => {
  it('calls a pending invite with a future expiry active', () => {
    expect(inviteLifecycleState(invite(), NOW)).toBe('active');
  });

  it('calls a pending invite with no expiry at all active', () => {
    expect(inviteLifecycleState(invite({ expires_at: null }), NOW)).toBe('active');
  });

  it('calls a pending invite past its expiry expired', () => {
    expect(inviteLifecycleState(invite({ expires_at: YESTERDAY }), NOW)).toBe('expired');
  });

  it('treats the exact expiry instant as expired', () => {
    expect(inviteLifecycleState(invite({ expires_at: new Date(NOW).toISOString() }), NOW)).toBe('expired');
  });

  it('reports revoked and accepted from the status column', () => {
    expect(inviteLifecycleState(invite({ status: 'revoked' }), NOW)).toBe('revoked');
    expect(inviteLifecycleState(invite({ status: 'accepted' }), NOW)).toBe('accepted');
  });

  it('prefers accepted over expired — someone got in through it', () => {
    expect(inviteLifecycleState(invite({ status: 'accepted', expires_at: YESTERDAY }), NOW)).toBe('accepted');
  });

  it('treats an unparseable expiry as no expiry, leaving the link active', () => {
    // Fail towards "still live", never towards "safe to hide".
    expect(inviteLifecycleState(invite({ expires_at: 'not-a-date' }), NOW)).toBe('active');
  });
});

describe('isInviteDismissable', () => {
  it('refuses an active link', () => {
    expect(isInviteSpent(invite(), NOW)).toBe(false);
    expect(isInviteDismissable(invite(), NOW)).toBe(false);
  });

  it('refuses an active link even when it has already been dismissed somehow', () => {
    expect(isInviteDismissable(invite({ dismissed_at: YESTERDAY }), NOW)).toBe(false);
  });

  it('allows a revoked link', () => {
    expect(isInviteDismissable(invite({ status: 'revoked' }), NOW)).toBe(true);
  });

  it('allows an accepted link', () => {
    expect(isInviteDismissable(invite({ status: 'accepted' }), NOW)).toBe(true);
  });

  it('allows an expired link', () => {
    expect(isInviteDismissable(invite({ expires_at: YESTERDAY }), NOW)).toBe(true);
  });

  it('refuses a spent link that is already dismissed', () => {
    expect(isInviteDismissable(invite({ status: 'revoked', dismissed_at: YESTERDAY }), NOW)).toBe(false);
  });
});

describe('visibleInvites', () => {
  const live = invite({ id: 'live' });
  const revoked = invite({ id: 'revoked', status: 'revoked' });
  const tidied = invite({ id: 'tidied', status: 'revoked', dismissed_at: YESTERDAY });
  const all = [live, revoked, tidied];

  it('hides dismissed rows by default', () => {
    expect(visibleInvites(all, false).map(i => i.id)).toEqual(['live', 'revoked']);
  });

  it('shows every dismissed row when asked — that is the way back', () => {
    expect(visibleInvites(all, true).map(i => i.id)).toEqual(['live', 'revoked', 'tidied']);
  });

  it('never hides an active link in either mode', () => {
    expect(visibleInvites(all, false).some(i => i.id === 'live')).toBe(true);
    expect(visibleInvites(all, true).some(i => i.id === 'live')).toBe(true);
  });

  it('does not mutate the input', () => {
    const copy = [...all];
    visibleInvites(all, true);
    visibleInvites(all, false);
    expect(all).toEqual(copy);
  });
});

describe('dismissableInvites', () => {
  it('picks exactly the spent, not-yet-dismissed rows for a bulk clear', () => {
    const rows = [
      invite({ id: 'live' }),
      invite({ id: 'revoked', status: 'revoked' }),
      invite({ id: 'accepted', status: 'accepted' }),
      invite({ id: 'expired', expires_at: YESTERDAY }),
      invite({ id: 'already', status: 'revoked', dismissed_at: YESTERDAY }),
    ];
    expect(dismissableInvites(rows, NOW).map(i => i.id)).toEqual(['revoked', 'accepted', 'expired']);
  });

  it('returns nothing when every link is still live', () => {
    expect(dismissableInvites([invite({ id: 'a' }), invite({ id: 'b', expires_at: null })], NOW)).toEqual([]);
  });
});

describe('dismissedCount', () => {
  it('counts only dismissed rows', () => {
    expect(dismissedCount([
      invite(),
      invite({ status: 'revoked', dismissed_at: YESTERDAY }),
      invite({ status: 'accepted', dismissed_at: YESTERDAY }),
    ])).toBe(2);
  });
});
