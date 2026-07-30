import { describe, expect, it } from 'vitest';
import { clampSplitPrimary, type SplitBounds } from '../../src/lib/splitPane';

// The one arithmetic behind every draggable divider in the app. What it has to
// get right is the case no rendering test can reach: a size stored when the
// window was one shape and restored when it is another.

const BOUNDS: SplitBounds = {
  minPrimaryPx: 200,
  minSecondaryPx: 300,
  defaultRatio: 0.4,
};

const CAPPED: SplitBounds = { ...BOUNDS, maxPrimaryPx: 400 };

describe('clampSplitPrimary', () => {
  it('divides an untouched split by the default ratio', () => {
    expect(clampSplitPrimary(null, 1000, BOUNDS)).toBe(400);
    // 0 is what a pixelPreference stores for "never dragged".
    expect(clampSplitPrimary(0, 1000, BOUNDS)).toBe(400);
    // …and it is a RATIO, so a bigger container opens bigger rather than fixed.
    expect(clampSplitPrimary(null, 2000, BOUNDS)).toBe(800);
  });

  it('honours a stored size that fits, leaving the rest to the secondary', () => {
    expect(clampSplitPrimary(350, 1000, BOUNDS)).toBe(350);
    expect(clampSplitPrimary(200, 1000, BOUNDS)).toBe(200);
    expect(clampSplitPrimary(700, 1000, BOUNDS)).toBe(700);
  });

  it('CLAMPS A SPLIT STORED IN A WIDE CONTAINER INTO A NARROW ONE', () => {
    // The trap this function exists for. 900px of primary was most of a 1400px
    // container; restored into 800px it would leave the secondary with -100.
    expect(clampSplitPrimary(900, 1400, BOUNDS)).toBe(900);
    expect(clampSplitPrimary(900, 800, BOUNDS)).toBe(500);
    // The secondary keeps exactly its floor, never less.
    expect(800 - clampSplitPrimary(900, 800, BOUNDS)).toBe(BOUNDS.minSecondaryPx);
  });

  it('NEVER PUTS EITHER PANE BELOW ITS MINIMUM', () => {
    for (const container of [520, 700, 900, 1200, 1600, 2400]) {
      for (const stored of [null, 0, 1, 40, 200, 640, 1500, 9000]) {
        const primary = clampSplitPrimary(stored, container, BOUNDS);
        const secondary = container - primary;
        expect(primary, `primary for stored=${stored} in ${container}`).toBeGreaterThan(0);
        expect(secondary, `secondary for stored=${stored} in ${container}`).toBeGreaterThan(0);
        if (container >= BOUNDS.minPrimaryPx + BOUNDS.minSecondaryPx) {
          expect(primary).toBeGreaterThanOrEqual(BOUNDS.minPrimaryPx);
          expect(secondary).toBeGreaterThanOrEqual(BOUNDS.minSecondaryPx);
        }
      }
    }
  });

  it('shrinks both in proportion when the container cannot seat both floors', () => {
    // 400px cannot hold 200 + 300. Neither pane gets zero: they share it in the
    // ratio of their floors and scroll internally.
    const primary = clampSplitPrimary(380, 400, BOUNDS);
    expect(primary).toBe(160);
    expect(400 - primary).toBe(240);
    expect(primary / (400 - primary)).toBeCloseTo(BOUNDS.minPrimaryPx / BOUNDS.minSecondaryPx, 5);
  });

  it('treats junk as "never dragged"', () => {
    for (const stored of [null, 0, -1, -900, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampSplitPrimary(stored, 1000, BOUNDS)).toBe(400);
    }
  });

  it('answers the floor for an unmeasured container rather than 0', () => {
    // The first frame before the ResizeObserver fires, and jsdom, both give 0.
    expect(clampSplitPrimary(null, 0, BOUNDS)).toBe(BOUNDS.minPrimaryPx);
    expect(clampSplitPrimary(0, Number.NaN, BOUNDS)).toBe(BOUNDS.minPrimaryPx);
    // A stored size survives an unmeasured container — it is re-clamped as soon
    // as a real measurement arrives.
    expect(clampSplitPrimary(350, 0, BOUNDS)).toBe(350);
  });

  it('is reversible: narrowing then widening returns the chosen size', () => {
    // Nothing is written back, so the stored request is untouched by the clamp.
    const stored = 900;
    expect(clampSplitPrimary(stored, 800, BOUNDS)).toBe(500);
    expect(clampSplitPrimary(stored, 1400, BOUNDS)).toBe(900);
  });

  describe('maxPrimaryPx', () => {
    it('caps a pane that stops being useful past a size', () => {
      expect(clampSplitPrimary(900, 1600, CAPPED)).toBe(400);
      // …including the untouched default, which would otherwise be 640.
      expect(clampSplitPrimary(null, 1600, CAPPED)).toBe(400);
    });

    it('never wins over the primary floor', () => {
      const tight: SplitBounds = { ...BOUNDS, maxPrimaryPx: 50 };
      expect(clampSplitPrimary(900, 1000, tight)).toBe(tight.minPrimaryPx);
      expect(clampSplitPrimary(900, 0, tight)).toBe(tight.minPrimaryPx);
    });

    it('yields to the container when the container is the tighter limit', () => {
      // 800 - 300 = 500 available, cap is 400: the cap wins.
      expect(clampSplitPrimary(900, 800, CAPPED)).toBe(400);
      // 650 - 300 = 350 available, cap is 400: the container wins.
      expect(clampSplitPrimary(900, 650, CAPPED)).toBe(350);
    });
  });
});
