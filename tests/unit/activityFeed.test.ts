import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FADE_TAIL,
  ACTIVITY_MIN_OPACITY,
  ACTIVITY_PEEK_COUNT,
  activityRowOpacity,
  hasHiddenActivity,
  shouldAnimateEntry,
  takeActivityWindow,
} from '@/lib/activityFeed';

const rows = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`);

describe('takeActivityWindow', () => {
  it('keeps the list short by default', () => {
    expect(takeActivityWindow(rows(100), false)).toHaveLength(ACTIVITY_PEEK_COUNT);
  });

  it('takes the NEWEST rows — the list is newest-first, so a head not a tail', () => {
    expect(takeActivityWindow(rows(100), false)[0]).toBe('e0');
  });

  it('gives everything back once expanded', () => {
    expect(takeActivityWindow(rows(100), true)).toHaveLength(100);
  });

  it('does not pad a list shorter than the window', () => {
    expect(takeActivityWindow(rows(3), false)).toEqual(['e0', 'e1', 'e2']);
  });

  it('never hands back the caller’s array to mutate', () => {
    const src = rows(3);
    expect(takeActivityWindow(src, true)).not.toBe(src);
  });
});

describe('hasHiddenActivity', () => {
  it('is true only when collapsing actually hid something', () => {
    expect(hasHiddenActivity(100, false)).toBe(true);
    expect(hasHiddenActivity(100, true)).toBe(false);
    expect(hasHiddenActivity(ACTIVITY_PEEK_COUNT, false)).toBe(false);
    expect(hasHiddenActivity(ACTIVITY_PEEK_COUNT + 1, false)).toBe(true);
  });
});

describe('activityRowOpacity', () => {
  const N = ACTIVITY_PEEK_COUNT;

  it('leaves the newest rows at full strength', () => {
    expect(activityRowOpacity(0, N, false)).toBe(1);
    expect(activityRowOpacity(N - ACTIVITY_FADE_TAIL - 1, N, false)).toBe(1);
  });

  it('fades only the tail, and monotonically', () => {
    const tail = Array.from({ length: ACTIVITY_FADE_TAIL }, (_, i) =>
      activityRowOpacity(N - ACTIVITY_FADE_TAIL + i, N, false));
    for (let i = 1; i < tail.length; i += 1) {
      expect(tail[i], `row ${i} must be fainter than row ${i - 1}`).toBeLessThan(tail[i - 1]);
    }
    expect(tail[0]).toBeLessThan(1);
  });

  it('bottoms out at the floor, never at zero — 0 reads as a rendering bug', () => {
    expect(activityRowOpacity(N - 1, N, false)).toBe(ACTIVITY_MIN_OPACITY);
    expect(activityRowOpacity(N - 1, N, false)).toBeGreaterThan(0);
  });

  it('restores every row when expanded — that is what makes scrolling feel like recovery', () => {
    for (let i = 0; i < N; i += 1) expect(activityRowOpacity(i, N, true)).toBe(1);
  });

  it('never fades a list too short to have a tail', () => {
    for (let i = 0; i < ACTIVITY_FADE_TAIL; i += 1) {
      expect(activityRowOpacity(i, ACTIVITY_FADE_TAIL, false)).toBe(1);
    }
  });

  it('stays within [floor, 1] for every position, including out-of-range indices', () => {
    for (const i of [-3, 0, 5, N - 1, N + 40]) {
      const o = activityRowOpacity(i, N, false);
      expect(o).toBeGreaterThanOrEqual(ACTIVITY_MIN_OPACITY);
      expect(o).toBeLessThanOrEqual(1);
    }
  });
});

describe('shouldAnimateEntry', () => {
  it('animates the newest row when a genuinely new event arrives', () => {
    expect(shouldAnimateEntry('e-new', 'e-new', 'e-old')).toBe(true);
  });

  it('does not animate on first paint — every row would fire at once', () => {
    expect(shouldAnimateEntry('e-new', 'e-new', null)).toBe(false);
  });

  it('does not re-animate the same row on an unrelated re-render', () => {
    expect(shouldAnimateEntry('e-new', 'e-new', 'e-new')).toBe(false);
  });

  it('never animates a row that is not the newest', () => {
    expect(shouldAnimateEntry('e-second', 'e-new', 'e-old')).toBe(false);
  });

  it('is inert with nothing to compare against', () => {
    expect(shouldAnimateEntry('e', null, 'e-old')).toBe(false);
  });
});
