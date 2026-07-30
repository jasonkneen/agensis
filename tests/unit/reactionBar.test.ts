import { describe, expect, it } from 'vitest';
import {
  FREQUENT_REACTION_LIMIT,
  REACTION_PICKER_GROUPS,
  describeReactors,
  frequentReactions,
  noteReactionUse,
  reactionPillLabel,
  reactionPills,
  reactionToggleOp,
  searchReactions,
  type ReactionUse,
} from '../../src/lib/reactionBar';

// The reactions bar's logic, extracted so it can be tested at all: the frontend
// runner only sees tests/unit/**/*.test.ts, `.test.tsx` is outside the glob, and
// there is no @testing-library/react here.

const ME = 'me-1';
const THEM = 'them-1';

describe('reactionPills', () => {
  it('detects your own reaction by currentUserId', () => {
    const [pill] = reactionPills({ '👍': [THEM, ME] }, ME);
    expect(pill.mine).toBe(true);
    expect(pill.count).toBe(2);
  });

  it('does not claim a reaction as yours when someone else holds it', () => {
    expect(reactionPills({ '👍': [THEM] }, ME)[0].mine).toBe(false);
  });

  it('claims nothing when there is no signed-in user', () => {
    // The old code fell back to the literal string 'me' for an unknown user,
    // which made every anonymous view look like it had reacted.
    expect(reactionPills({ '👍': [THEM] }, null)[0].mine).toBe(false);
  });

  it('orders by count, then by the reaction itself', () => {
    // Object key order is insertion order, so without this the row re-ordered
    // whenever a reaction was removed and re-added — and two people looking at
    // the same message could see different orders.
    const pills = reactionPills({ '🎉': [THEM], '👍': ['a', 'b'], '✅': [THEM] }, ME);
    expect(pills.map(pill => pill.reaction)).toEqual(['👍', '✅', '🎉']);
  });

  it('drops a reaction nobody holds rather than drawing a zero', () => {
    // The stored map deletes the key when the last holder leaves; a row written
    // before that invariant existed still carries `[]`.
    expect(reactionPills({ '👍': [], '✅': [ME] }, ME).map(p => p.reaction)).toEqual(['✅']);
  });

  it('survives a null or malformed map', () => {
    expect(reactionPills(null, ME)).toEqual([]);
    expect(reactionPills({ '👍': 'nope' } as never, ME)).toEqual([]);
  });
});

describe('reactionToggleOp', () => {
  it('removes what you hold and adds what you do not', () => {
    const [mine] = reactionPills({ '👍': [ME] }, ME);
    const [theirs] = reactionPills({ '🎉': [THEM] }, ME);
    expect(reactionToggleOp(mine, ME)).toBe('remove');
    expect(reactionToggleOp(theirs, ME)).toBe('add');
    expect(reactionToggleOp(undefined, ME)).toBe('add');
  });
});

describe('reactionPillLabel', () => {
  it('says the count and the toggle state in words', () => {
    // A screen reader gets none of the visual story — not the glyph, not the
    // tint that means "you reacted". aria-pressed carries the toggle state and
    // this carries the rest.
    const [mine] = reactionPills({ '👍': [ME, THEM] }, ME);
    const [theirs] = reactionPills({ '🎉': [THEM] }, ME);
    expect(reactionPillLabel(mine)).toBe('👍, 2 reactions, you reacted');
    expect(reactionPillLabel(theirs)).toBe('🎉, 1 reaction');
  });
});

describe('describeReactors', () => {
  const names: Record<string, string> = { u1: 'Ana', u2: 'Ben', u3: 'Cara', u4: 'Dev', u5: 'Eve', u6: 'Fay' };
  const resolve = (id: string) => names[id] ?? null;

  it('names the reactors', () => {
    const [pill] = reactionPills({ '👍': ['u1', 'u2'] }, null);
    expect(describeReactors(pill, resolve, null)).toBe('Ana and Ben reacted with 👍');
  });

  it('calls you "You" rather than by name', () => {
    const [pill] = reactionPills({ '👍': [ME, 'u1'] }, ME);
    expect(describeReactors(pill, resolve, ME)).toBe('You and Ana reacted with 👍');
  });

  it('truncates at five names plus "and N others"', () => {
    const [pill] = reactionPills({ '👍': ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'] }, null);
    expect(describeReactors(pill, resolve, null)).toBe('Ana, Ben, Cara, Dev, Eve and 1 other reacted with 👍');
  });

  it('renders an unresolvable id as "Someone", never a raw uuid', () => {
    const [pill] = reactionPills({ '👍': ['3f7c1a52-0000-4000-8000-000000000000'] }, null);
    const text = describeReactors(pill, () => null, null);
    expect(text).toBe('Someone reacted with 👍');
    expect(text).not.toContain('3f7c1a52');
  });
});

describe('searchReactions', () => {
  it('returns everything for an empty query, so the grid never vanishes', () => {
    expect(searchReactions('').length).toBeGreaterThan(50);
    expect(searchReactions('   ').length).toBe(searchReactions('').length);
  });

  it('finds by keyword, not just by glyph', () => {
    expect(searchReactions('lgtm')).toContain('👍');
    expect(searchReactions('ship')).toContain('🚀');
    expect(searchReactions('bug')).toContain('🐛');
  });

  it('finds by pasting the emoji itself', () => {
    expect(searchReactions('🔥')).toEqual(['🔥']);
  });

  it('returns nothing for a term nothing carries', () => {
    expect(searchReactions('zzzzz')).toEqual([]);
  });
});

describe('frequentReactions', () => {
  it('ranks by count, then by recency', () => {
    // Without the recency tiebreak a dozen once-used reactions sit in whatever
    // order storage happened to hold, so the row is stable but arbitrary and the
    // one you used a minute ago is not in it.
    const uses: ReactionUse[] = [
      { reaction: '🎉', count: 1, lastUsedAt: 10 },
      { reaction: '👍', count: 5, lastUsedAt: 1 },
      { reaction: '✅', count: 1, lastUsedAt: 99 },
    ];
    expect(frequentReactions(uses).slice(0, 3)).toEqual(['👍', '✅', '🎉']);
  });

  it('seeds from the Common group so a new account gets a useful row', () => {
    const seeded = frequentReactions([]);
    expect(seeded).toEqual([...REACTION_PICKER_GROUPS[0].reactions].slice(0, FREQUENT_REACTION_LIMIT));
  });

  it('does not duplicate a used reaction that is also in the seed', () => {
    const seeded = frequentReactions([{ reaction: '👍', count: 3, lastUsedAt: 1 }]);
    expect(seeded.filter(reaction => reaction === '👍')).toHaveLength(1);
    expect(seeded).toHaveLength(FREQUENT_REACTION_LIMIT);
  });

  it('ignores an entry nobody has actually used', () => {
    expect(frequentReactions([{ reaction: '🧪', count: 0, lastUsedAt: 99 }])[0]).not.toBe('🧪');
  });
});

describe('noteReactionUse', () => {
  it('counts a first use and increments a repeat', () => {
    const once = noteReactionUse([], '🔥', 100);
    expect(once).toEqual([{ reaction: '🔥', count: 1, lastUsedAt: 100 }]);
    expect(noteReactionUse(once, '🔥', 200)).toEqual([{ reaction: '🔥', count: 2, lastUsedAt: 200 }]);
  });

  it('does not mutate the list it was given', () => {
    const before: ReactionUse[] = [{ reaction: '🔥', count: 1, lastUsedAt: 100 }];
    noteReactionUse(before, '🔥', 200);
    expect(before).toEqual([{ reaction: '🔥', count: 1, lastUsedAt: 100 }]);
  });

  it('stays bounded, because this list lives in localStorage for the life of the account', () => {
    let uses: ReactionUse[] = [];
    for (let i = 0; i < 60; i += 1) uses = noteReactionUse(uses, `r${i}`, i);
    expect(uses.length).toBeLessThanOrEqual(40);
  });
});

describe('the emoji rule', () => {
  it('the picker groups are the ONLY emoji this module renders', () => {
    // Reactions are the deliberate exception to "no decorative emoji in UI
    // chrome", and the line is that the glyph is user-selected CONTENT. Labels,
    // tooltips and counts are chrome and stay text; the read indicator is a
    // lucide SVG. This asserts the content side is non-empty and de-duplicated
    // so a group edit cannot silently ship the same glyph twice.
    const all = REACTION_PICKER_GROUPS.flatMap(group => group.reactions);
    expect(all.length).toBeGreaterThan(50);
    expect(new Set(all).size).toBe(all.length);
    for (const group of REACTION_PICKER_GROUPS) expect(group.reactions.length).toBeGreaterThan(0);
  });
});
