import { describe, expect, it } from 'vitest';
import { clampPaneSplit, type PaneSplitBounds } from '../../src/lib/paneSplit';
import { clampSplitPrimary } from '../../src/lib/splitPane';
import { MEMORY_SPLIT_BOUNDS, MEMORY_SPLIT_WIDE_PX } from '../../src/lib/memorySplit';
import { AGENT_SPLIT_BOUNDS, agentSplitGridHeight } from '../../src/lib/agentsView';

// A clamp for a draggable divider.
//
// HEADS UP — `src/lib/paneSplit.ts` is NOT the clamp the app runs. It arrived on
// the superseded half of a duplicated feature (commit 0fa2fad, titled "SUPERSEDED
// by worktree-memory-pane — do not merge") and landed anyway. The live one is
// `clampSplitPrimary` in `src/lib/splitPane.ts`, reached through
// `hooks/useSplitResize.ts` by all four dividers, and covered by
// `tests/unit/splitPane.test.ts`. Nothing under `src/components/**` imports
// `paneSplit`, `usePaneSplit` or `memorySplit`; deleting the three of them
// together with the top two blocks here is a live proposal, not done here
// because removing source is not this change's job.
//
// The failure it exists to prevent is silent: a divider position is persisted,
// so a size chosen in a big window is restored into a small one, and without a
// clamp that leaves a pane at zero — content that is present, invisible, and
// explains nothing. Same class as the persisted owner-filter that hid every
// agent along with the control that cleared it.
//
// So the cases below are all about a stored number meeting a container that
// cannot honour it.

const BOUNDS: PaneSplitBounds = { minLeading: 100, minTrailing: 200, defaultRatio: 0.4 };

describe('clampPaneSplit', () => {
  it('divides an untouched split by the default ratio', () => {
    expect(clampPaneSplit(null, 1000, BOUNDS)).toBe(400);
    // 0 is what the pixel codec stores for "never dragged".
    expect(clampPaneSplit(0, 1000, BOUNDS)).toBe(400);
    // A ratio, not a fixed number: a bigger container gives the leading pane more.
    expect(clampPaneSplit(null, 2000, BOUNDS)).toBe(800);
  });

  it('honours a stored size that fits, leaving the rest to the trailing pane', () => {
    expect(clampPaneSplit(550, 1000, BOUNDS)).toBe(550);
    expect(clampPaneSplit(100, 1000, BOUNDS)).toBe(100);
    expect(clampPaneSplit(800, 1000, BOUNDS)).toBe(800);
  });

  it('CLAMPS A SPLIT STORED IN A BIG CONTAINER INTO A SMALL ONE', () => {
    const stored = clampPaneSplit(760, 1000, BOUNDS);
    expect(stored).toBe(760);
    // Restored into a 500px container, 760 would leave the trailing pane at
    // -260 — i.e. gone, with nothing on screen saying it exists.
    const small = clampPaneSplit(760, 500, BOUNDS);
    expect(small).toBe(300);
    expect(500 - small).toBeGreaterThanOrEqual(BOUNDS.minTrailing);
    expect(small).toBeGreaterThanOrEqual(BOUNDS.minLeading);
  });

  it('never lets either pane fall below its minimum', () => {
    // Dragged all the way in…
    expect(clampPaneSplit(1, 1000, BOUNDS)).toBe(BOUNDS.minLeading);
    // …and all the way out, past where the trailing pane would disappear.
    expect(clampPaneSplit(5000, 1000, BOUNDS)).toBe(1000 - BOUNDS.minTrailing);
    expect(clampPaneSplit(999, 1000, BOUNDS)).toBe(1000 - BOUNDS.minTrailing);
  });

  it('shrinks BOTH panes when the container cannot seat both minimums', () => {
    // 200px cannot hold 100 + 200. One pane winning would mean the other is not
    // on screen at all, so they take proportional shares instead.
    const size = clampPaneSplit(5000, 200, BOUNDS);
    expect(size).toBe(Math.round(200 * (100 / 300)));
    expect(size).toBeGreaterThan(0);
    expect(200 - size).toBeGreaterThan(0);
    // No stored value can change it — there is no room for a choice.
    expect(clampPaneSplit(1, 200, BOUNDS)).toBe(size);
    expect(clampPaneSplit(null, 200, BOUNDS)).toBe(size);
  });

  it('is exact at the boundary where both minimums just fit', () => {
    const exact = BOUNDS.minLeading + BOUNDS.minTrailing;
    expect(clampPaneSplit(5000, exact, BOUNDS)).toBe(BOUNDS.minLeading);
    expect(clampPaneSplit(5000, exact + 1, BOUNDS)).toBe(BOUNDS.minLeading + 1);
  });

  it('answers the leading minimum, never zero, on an unmeasured container', () => {
    // The first frame, and jsdom, where clientWidth is 0. A pane painted with
    // no size is the thing this whole function is for.
    expect(clampPaneSplit(null, 0, BOUNDS)).toBe(BOUNDS.minLeading);
    expect(clampPaneSplit(null, Number.NaN, BOUNDS)).toBe(BOUNDS.minLeading);
    expect(clampPaneSplit(400, 0, BOUNDS)).toBe(400);
    expect(clampPaneSplit(20, 0, BOUNDS)).toBe(BOUNDS.minLeading);
  });

  it('treats a non-finite stored value as no choice, not as a huge one', () => {
    expect(clampPaneSplit(Number.NaN, 1000, BOUNDS)).toBe(400);
    expect(clampPaneSplit(Number.POSITIVE_INFINITY, 1000, BOUNDS)).toBe(400);
    expect(clampPaneSplit(-40, 1000, BOUNDS)).toBe(400);
    // An unmeasurable container is the same case as an unmeasured one.
    expect(clampPaneSplit(400, Number.POSITIVE_INFINITY, BOUNDS)).toBe(400);
    expect(clampPaneSplit(400, -500, BOUNDS)).toBe(400);
  });

  it('always returns a whole number of pixels', () => {
    for (const [stored, container] of [[null, 777], [333.7, 901], [null, 201], [5000, 555]] as const) {
      expect(Number.isInteger(clampPaneSplit(stored, container, BOUNDS))).toBe(true);
    }
  });
});

describe('the Memory window file list', () => {
  const { minLeading, minTrailing } = MEMORY_SPLIT_BOUNDS;
  const clamp = (stored: number | null, container: number) => clampPaneSplit(stored, container, MEMORY_SPLIT_BOUNDS);

  it('leaves room for both panes at the width where the split first appears', () => {
    // The split is only shown at all above MEMORY_SPLIT_WIDE_PX, so the
    // proportional-shrink branch must be unreachable in normal use.
    expect(minLeading + minTrailing).toBeLessThan(MEMORY_SPLIT_WIDE_PX);
    const atThreshold = clamp(null, MEMORY_SPLIT_WIDE_PX);
    expect(atThreshold).toBeGreaterThanOrEqual(minLeading);
    expect(MEMORY_SPLIT_WIDE_PX - atThreshold).toBeGreaterThanOrEqual(minTrailing);
  });

  it('opens at roughly the width the list used to be hard-coded to', () => {
    // 340px in a 1000px pane, before it became a share.
    expect(clamp(null, 1000)).toBe(340);
  });

  it('clamps a wide-window list width into a narrow window', () => {
    // 900px of list is reasonable on a 1600px screen; restored at 1000px it
    // would leave 100px of document.
    expect(clamp(900, 1600)).toBe(900);
    expect(clamp(900, 1000)).toBe(1000 - minTrailing);
    expect(1000 - clamp(900, 1000)).toBe(minTrailing);
  });

  it('keeps the document readable no matter how far the divider is dragged', () => {
    for (const container of [960, 1200, 1600, 2400]) {
      for (const stored of [1, 50, 400, 5000]) {
        const size = clamp(stored, container);
        expect(size).toBeGreaterThanOrEqual(minLeading);
        expect(container - size).toBeGreaterThanOrEqual(minTrailing);
      }
    }
  });
});

describe('the Agents window Both split still goes through the shared clamp', () => {
  // AGENT_SPLIT_BOUNDS is a `SplitBounds` (minPrimaryPx / minSecondaryPx), so the
  // shared clamp it delegates to is `clampSplitPrimary` in lib/splitPane.ts — the
  // one useSplitResize and all four dividers actually run. This assertion used to
  // name `clampPaneSplit` from lib/paneSplit.ts instead, whose bounds are
  // minLeading / minTrailing: both floors read as `undefined` and every expected
  // value was NaN, so the check could never pass. See the note above.
  it('agentSplitGridHeight is clampSplitPrimary with the grid/map floors', () => {
    for (const [stored, container] of [[null, 800], [620, 420], [4000, 800], [1, 800], [null, 200]] as const) {
      const actual = agentSplitGridHeight(stored, container);
      expect(Number.isFinite(actual), `${stored}/${container}`).toBe(true);
      expect(actual).toBe(clampSplitPrimary(stored, container, AGENT_SPLIT_BOUNDS));
    }
  });
});
