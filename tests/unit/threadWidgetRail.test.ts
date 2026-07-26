import { describe, expect, it } from 'vitest';
import {
  CHAT_COLUMN_MAX_WIDTH,
  COMPOSER_SHELL_PADDING,
  RAIL_GUTTER_MIN_SURFACE_WIDTH,
  RAIL_MIN_SURFACE_WIDTH,
  RAIL_RESERVE_WIDTH,
  parseRailPreference,
  railLayout,
  railPreferenceKey,
  resolveRailState,
  toggledRailPreference,
  type RailPreference,
} from '../../src/lib/threadWidgetRail';

// The rail's whole job is to appear without being asked and then get out of the
// way — which makes two failure modes worth pinning down here rather than in a
// browser. One is a rail that feels possessed: you close it, an agent posts a
// to-do, and it shoves itself back over your reading. The other is the reason
// this module exists at all — a rail that pays for its own width out of the
// message column instead of out of the empty gutter beside it.

const ROOMY = 1440;   // gutter layout: column + rail both fit
const SNUG = 900;     // overlay layout: they don't
const TINY = 400;     // below RAIL_MIN_SURFACE_WIDTH

function state(hasContent: boolean, preference: RailPreference, surfaceWidth: number | null = ROOMY) {
  return resolveRailState({ hasContent, preference, surfaceWidth });
}

describe('railLayout', () => {
  it('sits beside the conversation once the surface fits both', () => {
    expect(railLayout(RAIL_GUTTER_MIN_SURFACE_WIDTH)).toBe('gutter');
    expect(railLayout(ROOMY)).toBe('gutter');
  });

  it('floats over the conversation when it would otherwise have to squeeze it', () => {
    expect(railLayout(RAIL_GUTTER_MIN_SURFACE_WIDTH - 1)).toBe('overlay');
    expect(railLayout(SNUG)).toBe('overlay');
    expect(railLayout(RAIL_MIN_SURFACE_WIDTH)).toBe('overlay');
  });

  it('is not shown at all below the minimum surface width', () => {
    expect(railLayout(RAIL_MIN_SURFACE_WIDTH - 1)).toBe('hidden');
    expect(railLayout(TINY)).toBe('hidden');
  });

  it('assumes room before the surface has been measured', () => {
    // A `null`/0 width is the first frame, not a narrow window. Failing closed
    // here would flash the rail shut on every session switch.
    expect(railLayout(null)).toBe('gutter');
    expect(railLayout(0)).toBe('gutter');
    expect(railLayout(Number.NaN)).toBe('gutter');
  });
});

describe('resolveRailState — showing itself', () => {
  it('stays closed while the session has nothing to show', () => {
    expect(state(false, 'auto').open).toBe(false);
  });

  it('opens itself as soon as content arrives', () => {
    expect(state(true, 'auto').open).toBe(true);
  });
});

describe('resolveRailState — a hand beats the automatic behaviour', () => {
  it('stays closed when more content arrives after the user closed it', () => {
    expect(state(true, 'closed').open).toBe(false);
  });

  it('stays open when the content empties after the user opened it', () => {
    expect(state(false, 'open').open).toBe(true);
  });

  it('records an explicit choice on every toggle, in both directions', () => {
    expect(toggledRailPreference(true)).toBe('closed');
    expect(toggledRailPreference(false)).toBe('open');
  });
});

describe('resolveRailState — too narrow wins over everything', () => {
  it('is closed below the minimum width whatever the user chose', () => {
    for (const preference of ['auto', 'open', 'closed'] as RailPreference[]) {
      const result = state(true, preference, TINY);
      expect(result.open).toBe(false);
      expect(result.layout).toBe('hidden');
      expect(result.reserve).toBe(0);
    }
  });
});

describe('resolveRailState — what it costs the message column', () => {
  it('reserves its own width beside the conversation when there is room', () => {
    expect(state(true, 'auto', ROOMY).reserve).toBe(RAIL_RESERVE_WIDTH);
  });

  it('reserves nothing while closed, so the toggle is the only thing that moves', () => {
    expect(state(false, 'auto', ROOMY).reserve).toBe(0);
    expect(state(true, 'closed', ROOMY).reserve).toBe(0);
  });

  it('reserves nothing when it would have to come out of the message column', () => {
    // Below the gutter threshold the rail floats instead: the column is the
    // same width open or closed at EVERY width, which is the claim this
    // module exists to make true.
    const open = state(true, 'auto', SNUG);
    expect(open.layout).toBe('overlay');
    expect(open.reserve).toBe(0);
  });

  it('never reserves more than the surface has spare above the column width', () => {
    const surface = RAIL_GUTTER_MIN_SURFACE_WIDTH;
    const { reserve } = state(true, 'auto', surface);
    // Both chat columns have to survive the reserve, not just the messages —
    // the composer starts COMPOSER_SHELL_PADDING in on each side, so it runs
    // out of room 16px before the message column does.
    expect(surface - reserve).toBeGreaterThanOrEqual(CHAT_COLUMN_MAX_WIDTH);
    expect(surface - reserve - COMPOSER_SHELL_PADDING * 2).toBeGreaterThanOrEqual(CHAT_COLUMN_MAX_WIDTH);
  });
});

describe('preference storage', () => {
  it('scopes the choice to one session', () => {
    expect(railPreferenceKey('abc')).toBe('thread-widgets-pref:abc');
    expect(railPreferenceKey('abc')).not.toBe(railPreferenceKey('def'));
  });

  it('reads back only the two explicit choices', () => {
    expect(parseRailPreference('open')).toBe('open');
    expect(parseRailPreference('closed')).toBe('closed');
  });

  it('treats a missing or corrupt value as no choice made', () => {
    expect(parseRailPreference(null)).toBe('auto');
    expect(parseRailPreference(undefined)).toBe('auto');
    expect(parseRailPreference('')).toBe('auto');
    expect(parseRailPreference('{"widgets":[]}')).toBe('auto');
  });
});
