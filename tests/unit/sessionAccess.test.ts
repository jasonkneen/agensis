// ============================================================================
// tests/unit/sessionAccess.test.ts
// ----------------------------------------------------------------------------
// The rules behind "Who can read this conversation". MUST live under
// tests/unit/**/*.test.ts — vitest.config.ts includes only that glob, and a
// test anywhere else silently never runs.
//
// Every case here exists because getting it wrong would produce a control that
// LIES: a Remove button on somebody the server refuses to remove, a renewal
// path that hides the person needing renewal, or an expired grant presented as
// though it still let someone in.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  ACCESS_AUDIT_NOTE,
  GRANT_EXPIRY_CHOICES,
  accessMemberLabel,
  accessSummary,
  canRevoke,
  expiryLabel,
  grantCandidates,
  isParticipant,
  sortAccessMembers,
  type SessionAccessMember,
} from '../../src/lib/sessionAccess';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function member(overrides: Partial<SessionAccessMember> = {}): SessionAccessMember {
  return {
    userId: 'user-1',
    name: 'Ada',
    source: 'grant',
    grantedBy: 'admin-1',
    expiresAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

describe('canRevoke', () => {
  it('offers Remove on a grant and never on a participant', () => {
    // The DELETE route matches `source = 'grant'` only, so a Remove button on a
    // participant would be a button that 404s — and worse, would suggest the
    // owner of a DM can be tidied out of it.
    expect(canRevoke(member({ source: 'grant' }))).toBe(true);
    expect(canRevoke(member({ source: 'participant' }))).toBe(false);
    expect(isParticipant(member({ source: 'participant' }))).toBe(true);
  });

  it('stays revocable after the grant has expired', () => {
    // An expired grant is still a row, and cleaning it up is a real thing to
    // want. `active` is about what the row CONFERS, not whether it exists.
    expect(canRevoke(member({ active: false, expiresAt: '2026-07-02T00:00:00.000Z' }))).toBe(true);
  });
});

describe('sortAccessMembers', () => {
  it('puts the conversation members above the people let in', () => {
    // The server orders by `source asc`, which sorts 'grant' ABOVE
    // 'participant' alphabetically. If this function ever just passed the
    // server's order through, the guests would head the list.
    //
    // The GRANTS ARE THE OLDEST ROWS here, deliberately. With participants
    // created first, sorting on createdAt alone produces the same answer as
    // sorting on source-then-createdAt, and the case cannot see the difference
    // — the first version of this test was exactly that vacuous.
    const sorted = sortAccessMembers([
      member({ userId: 'g1', source: 'grant', createdAt: '2026-07-02T00:00:00.000Z' }),
      member({ userId: 'p1', source: 'participant', createdAt: '2026-07-05T00:00:00.000Z' }),
      member({ userId: 'p2', source: 'participant', createdAt: '2026-07-04T00:00:00.000Z' }),
      member({ userId: 'g2', source: 'grant', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    expect(sorted.map(entry => entry.userId)).toEqual(['p2', 'p1', 'g2', 'g1']);
  });

  it('does not mutate the array it was given', () => {
    const input = [
      member({ userId: 'g1', source: 'grant' }),
      member({ userId: 'p1', source: 'participant' }),
    ];
    sortAccessMembers(input);
    expect(input.map(entry => entry.userId)).toEqual(['g1', 'p1']);
  });
});

describe('grantCandidates', () => {
  const users = [
    { user_id: 'p1', email: 'owner@example.com' },
    { user_id: 'g1', email: 'guest@example.com' },
    { user_id: 'x1', email: 'nobody@example.com' },
  ];

  it('hides participants and live grants, because granting either changes nothing', () => {
    const candidates = grantCandidates(users, [
      member({ userId: 'p1', source: 'participant' }),
      member({ userId: 'g1', source: 'grant', active: true }),
    ]);
    expect(candidates.map(entry => entry.user_id)).toEqual(['x1']);
  });

  it('KEEPS somebody whose grant expired — re-granting is the only renewal path', () => {
    // POST upserts onto the existing row, so picking an expired grantee again
    // is exactly how their access comes back. Filtering them out on `!active`
    // (or on "has a row") would leave an expired grant with no way to renew it
    // short of revoking first, which is not a step anyone would guess.
    const candidates = grantCandidates(users, [
      member({ userId: 'p1', source: 'participant' }),
      member({ userId: 'g1', source: 'grant', active: false, expiresAt: '2026-07-02T00:00:00.000Z' }),
    ]);
    // Sorted by email: guest@ then nobody@. p1 is the participant and is gone.
    expect(candidates.map(entry => entry.user_id)).toEqual(['g1', 'x1']);
  });

  it('offers nobody when everyone already has access', () => {
    const candidates = grantCandidates(users, [
      member({ userId: 'p1', source: 'participant' }),
      member({ userId: 'g1', source: 'grant' }),
      member({ userId: 'x1', source: 'grant' }),
    ]);
    expect(candidates).toEqual([]);
  });

  it('drops a user row with no id rather than offering an unusable option', () => {
    expect(grantCandidates([{ user_id: '', email: 'ghost@example.com' }], [])).toEqual([]);
  });
});

describe('expiryLabel', () => {
  it('separates never-expires from already-expired', () => {
    // Collapsing these would show a row that confers nothing as permanent.
    expect(expiryLabel(null, NOW)).toBe('No expiry');
    expect(expiryLabel(new Date(NOW - DAY).toISOString(), NOW)).toBe('Expired');
  });

  it('counts whole days remaining', () => {
    expect(expiryLabel(new Date(NOW + 7 * DAY).toISOString(), NOW)).toBe('Expires in 7 days');
    expect(expiryLabel(new Date(NOW + 2 * DAY).toISOString(), NOW)).toBe('Expires in 2 days');
    expect(expiryLabel(new Date(NOW + DAY + 1000).toISOString(), NOW)).toBe('Expires tomorrow');
    expect(expiryLabel(new Date(NOW + 3 * 60 * 60 * 1000).toISOString(), NOW)).toBe('Expires today');
  });

  it('treats an unparseable timestamp as no expiry rather than as expired', () => {
    // Reading a garbage value as 'Expired' would tell an admin that access they
    // still have has lapsed, and send them to re-grant something already live.
    expect(expiryLabel('not-a-date', NOW)).toBe('No expiry');
  });
});

describe('accessSummary', () => {
  it('counts the three states separately', () => {
    // Three DIFFERENT counts, so swapping any two of the predicates changes the
    // string. With one live grant and one expired one the case cannot tell
    // `active` from `!active` at all.
    expect(accessSummary([
      member({ userId: 'p1', source: 'participant' }),
      member({ userId: 'p2', source: 'participant' }),
      member({ userId: 'p3', source: 'participant' }),
      member({ userId: 'g1', source: 'grant', active: true }),
      member({ userId: 'g2', source: 'grant', active: true }),
      member({ userId: 'g3', source: 'grant', active: false }),
    ])).toBe('3 in this conversation · 2 given access · 1 expired');
  });

  it('says nothing about grants when there are none', () => {
    expect(accessSummary([member({ source: 'participant' })])).toBe('1 in this conversation');
  });
});

describe('accessMemberLabel', () => {
  it('falls back to a short id when the join found no name or email', () => {
    expect(accessMemberLabel({ name: 'Ada', userId: 'abcdef01-2345' })).toBe('Ada');
    expect(accessMemberLabel({ name: '   ', userId: 'abcdef01-2345' })).toBe('User abcdef01');
  });
});

describe('the shapes the routes constrain', () => {
  it('never offers an expiry the route would reject', () => {
    // POST validates 1..365, with absent meaning open-ended. 0 is the UI's
    // spelling of absent and must be the only value below 1.
    for (const choice of GRANT_EXPIRY_CHOICES) {
      expect(choice.days === 0 || (choice.days >= 1 && choice.days <= 365)).toBe(true);
    }
    expect(GRANT_EXPIRY_CHOICES.some(choice => choice.days === 0)).toBe(true);
  });

  it('says both what the log records and what it does not', () => {
    // The negative half is the load-bearing one: denied reads are not audited,
    // so an empty log read as "nobody tried" would be a false clean bill.
    expect(ACCESS_AUDIT_NOTE).toContain('audit log');
    expect(ACCESS_AUDIT_NOTE).toContain('not recorded');
  });
});
