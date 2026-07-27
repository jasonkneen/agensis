// Where a draggable divider sits, for any two-pane split in the app.
//
// This is the fourth resizable divider here (the inbox list, the Tenants
// account list, the Agents window's grid/map split, and now the Memory
// window's files/preview split), and the part that is worth having exactly
// once is not the pointer plumbing — it is the CLAMP.
//
// A divider position is persisted, which is how it becomes a trap. A width
// chosen in a wide window and restored in a narrow one, or a height chosen in
// a tall window and restored in a short one, can leave a pane at zero size:
// content that is present, invisible, and says nothing about why. That is the
// same class of failure as the persisted owner-filter that hid every agent
// AND the control that cleared it (tests/smoke/README.md).
//
// So a stored number is never used as the layout. It is a REQUEST, and
// `clampPaneSplit` is the answer, recomputed from the live container size on
// every render. Because the clamp is DERIVED rather than written back,
// shrinking a window and growing it again returns the split the user actually
// chose, instead of quietly destroying it.
//
// Deliberately free of React and of any `window` reference, so the whole
// decision is testable by handing it two numbers.

export interface PaneSplitBounds {
  /** Floor for the first pane (above, or left of, the divider), px. */
  minLeading: number;
  /** Floor for the second pane, px. */
  minTrailing: number;
  /** The leading pane's share before anyone has touched the divider, 0–1. */
  defaultRatio: number;
}

/** A stored value that is actually a measurement, or null for "never dragged". */
function requested(stored: number | null): number | null {
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? stored : null;
}

/**
 * The size the LEADING pane gets, in px, from what was stored and the size the
 * two panes have to share (`containerPx` — both panes, so the trailing pane
 * simply takes the remainder).
 *
 * - No stored request (null, 0, NaN, a negative) means never dragged, and the
 *   default ratio applies — so a bigger window opens with a proportionally
 *   bigger leading pane rather than a fixed one.
 * - Both floors are honoured, and THE TRAILING PANE'S FLOOR WINS over the
 *   leading pane's request: dragging outward can never push the other pane off
 *   the edge.
 * - When the container cannot hold both floors, the two shrink in proportion
 *   rather than one of them taking everything. Both panes stay on screen and
 *   scroll internally; the alternative is a pane of zero size, which is the
 *   invisible-content failure this function exists to prevent.
 * - An unmeasured container (0, NaN — the first frame, or jsdom) answers the
 *   leading floor rather than 0, so a pane is never painted with no size.
 */
export function clampPaneSplit(stored: number | null, containerPx: number, bounds: PaneSplitBounds): number {
  const { minLeading, minTrailing, defaultRatio } = bounds;
  const container = Number.isFinite(containerPx) ? containerPx : 0;
  const want = requested(stored);

  if (container <= 0) {
    return Math.round(Math.max(minLeading, want ?? 0));
  }

  const floors = minLeading + minTrailing;
  if (container <= floors) {
    return Math.round(container * (minLeading / floors));
  }

  const target = want ?? container * defaultRatio;
  const ceiling = container - minTrailing;
  return Math.round(Math.min(Math.max(target, minLeading), ceiling));
}
