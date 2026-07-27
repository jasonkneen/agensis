// How a draggable divider decides where it is allowed to sit.
//
// Four windows in this app put a divider between two panes — the inbox, the
// Tenants account list, the Agents "Both" view and the Memory file browser — and
// every one of them remembers where it was left. That memory is the hazard: a
// split chosen in a 1400px-wide window and restored into a 700px one can leave a
// pane at zero size, showing nothing and saying nothing about why.
//
// So the stored number is NEVER the layout. It is a REQUEST, and this function
// is the answer, recomputed from the live container on every render. Nothing is
// written back, which is what makes the clamp reversible: shrink the window and
// the split tightens, grow it again and the size the user actually chose comes
// back.
//
// Pure and React-free on purpose — this is the part that has to be provable, and
// the drag plumbing that calls it lives in hooks/useSplitResize.ts.

/** What one divider is allowed to do, in px of the container's main axis. */
export interface SplitBounds {
  /** Floor for the pane the stored measurement describes (top / left). */
  minPrimaryPx: number;
  /** Floor for the pane that takes the remainder (bottom / right). */
  minSecondaryPx: number;
  /** The primary's share before anyone has touched the divider, 0..1. */
  defaultRatio: number;
  /**
   * Optional ceiling on the primary, px — for a pane that stops being useful
   * past a width rather than one that should simply take the room (a file list
   * at 900px is a worse file list). Omitted means "as wide as the container
   * allows". It never wins over `minPrimaryPx`.
   */
  maxPrimaryPx?: number;
}

/** A stored value that is actually a measurement, or null for "never dragged". */
function requestedSplit(stored: number | null): number | null {
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? stored : null;
}

/**
 * The size the primary pane gets, in px, from what was stored and the size the
 * two panes have to share (`containerPx` — primary plus secondary, so the
 * secondary simply takes the remainder).
 *
 * - No stored request (null, 0, NaN, a negative) means never dragged, and
 *   `defaultRatio` applies — so a bigger window opens with a proportionally
 *   bigger primary rather than a fixed one.
 * - Both floors are honoured, and THE SECONDARY'S FLOOR WINS over the primary's
 *   request: dragging one way can never push the other pane off the edge.
 * - When the container cannot hold both floors, the two shrink in proportion
 *   rather than one taking everything. Both panes stay on screen and scroll
 *   internally; the alternative is a pane of zero size, which is the
 *   invisible-content failure this function exists to prevent.
 * - An unmeasured container (0, NaN — the first frame, or jsdom) answers the
 *   primary's floor rather than 0, so a pane is never painted with no size.
 * - `maxPrimaryPx`, when set, caps the primary but never below its floor.
 */
export function clampSplitPrimary(
  stored: number | null,
  containerPx: number,
  bounds: SplitBounds,
): number {
  const container = Number.isFinite(containerPx) ? containerPx : 0;
  const requested = requestedSplit(stored);
  const max = bounds.maxPrimaryPx ?? Number.POSITIVE_INFINITY;

  if (container <= 0) {
    return Math.round(Math.min(Math.max(bounds.minPrimaryPx, requested ?? 0), Math.max(bounds.minPrimaryPx, max)));
  }

  const floors = bounds.minPrimaryPx + bounds.minSecondaryPx;
  if (container <= floors) {
    return Math.round(container * (bounds.minPrimaryPx / floors));
  }

  const want = requested ?? container * bounds.defaultRatio;
  const ceiling = Math.max(bounds.minPrimaryPx, Math.min(container - bounds.minSecondaryPx, max));
  return Math.round(Math.min(Math.max(want, bounds.minPrimaryPx), ceiling));
}
