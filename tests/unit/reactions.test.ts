import { describe, expect, it } from 'vitest';
import { normalizeReactions, reactionChips, toggleReaction } from '../../src/lib/pm/reactions';

describe('normalizeReactions', () => {
  it('returns an empty map for anything that is not a plain object', () => {
    for (const raw of [null, undefined, 'x', 3, [], [['👍', ['u1']]]]) expect(normalizeReactions(raw)).toEqual({});
  });

  it('keeps string user ids, drops duplicates, non-strings and empty entries', () => {
    expect(normalizeReactions({ '👍': ['u1', 'u1', 5, '', null, 'u2'], '✅': [], '👀': 'u1', '🎉': ['u3'] })).toEqual({
      '👍': ['u1', 'u2'],
      '🎉': ['u3'],
    });
  });
});

describe('toggleReaction', () => {
  it('adds a reaction for a person', () => {
    expect(toggleReaction({}, '👍', 'u1')).toEqual({ '👍': ['u1'] });
  });

  it('adds a second person to an existing reaction', () => {
    expect(toggleReaction({ '👍': ['u1'] }, '👍', 'u2')).toEqual({ '👍': ['u1', 'u2'] });
  });

  it('removes the person on a second click, and drops the emoji when nobody is left', () => {
    expect(toggleReaction({ '👍': ['u1', 'u2'] }, '👍', 'u1')).toEqual({ '👍': ['u2'] });
    expect(toggleReaction({ '👍': ['u1'] }, '👍', 'u1')).toEqual({});
  });

  it('leaves other emoji alone and never mutates its input', () => {
    const before = { '👍': ['u1'], '✅': ['u2'] };
    const snapshot = JSON.stringify(before);
    expect(toggleReaction(before, '👀', 'u1')).toEqual({ '👍': ['u1'], '✅': ['u2'], '👀': ['u1'] });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('repairs bad stored data while toggling', () => {
    expect(toggleReaction('garbage', '🎉', 'u1')).toEqual({ '🎉': ['u1'] });
  });
});

describe('reactionChips', () => {
  it('counts people and marks the ones the viewer made', () => {
    expect(reactionChips({ '👍': ['u1', 'u2'], '✅': ['u2'] }, 'u1')).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '✅', count: 1, mine: false },
    ]);
  });

  it('marks nothing as mine without a viewer', () => {
    expect(reactionChips({ '👍': ['u1'] }, undefined)[0].mine).toBe(false);
  });
});
