// Full-bleed geometry for maximized / panel-filling windows.
//
// The workspace canvas keeps an 8px "chrome gap" around every window by padding
// the canvas column and letting the viewport (<main>) sit inside it. Floating
// panels therefore read as rounded cards floating on the canvas. When a window
// fills the whole panel, though, Jason wants it flush — no gap, square corners,
// "full bleed" into the main panel — and tiled splits that together fill the
// panel should conform to that, while a smaller split stays rounded like today.
//
// Rather than move the gap out of the column padding (which would shift every
// stored window coordinate), a full-bleed window's shell simply paints OVER the
// padding: it extends by the gap on each edge that's flush to the panel boundary
// and the viewport un-clips so the extension reaches the true panel edge.

export type WindowEdge = 'left' | 'right' | 'top' | 'bottom';

export const ALL_WINDOW_EDGES: readonly WindowEdge[] = ['left', 'right', 'top', 'bottom'];

/** Edges of `bounds` that touch the viewport boundary within `tolerance`. */
export function computeFlushEdges(
  bounds: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  tolerance = 2,
): Set<WindowEdge> {
  const edges = new Set<WindowEdge>();
  if (!(viewport.width > 0) || !(viewport.height > 0)) return edges;
  if (bounds.x <= tolerance) edges.add('left');
  if (bounds.y <= tolerance) edges.add('top');
  if (bounds.x + bounds.width >= viewport.width - tolerance) edges.add('right');
  if (bounds.y + bounds.height >= viewport.height - tolerance) edges.add('bottom');
  return edges;
}

export type FullBleedResult = {
  /** The window fills the panel (alone or as part of a tiled group). */
  isFullBleed: boolean;
  /** Edges to extend into the chrome gap so the surface reaches the panel edge. */
  bleedEdges: Set<WindowEdge>;
  /** Full-bleed windows drop their rounded corners entirely. */
  squareCorners: boolean;
};

/**
 * Decide whether a window is "full bleed" and which edges should extend into
 * the chrome gap.
 *
 * A window is full bleed when it's maximized, or when every one of its FREE
 * edges (the edges not shared with a tiled sibling) is flush to the panel
 * boundary. That single rule captures all of Jason's cases:
 *   - maximized single window        → all 4 edges free + flush → full bleed
 *   - a single window sized to fill   → all 4 edges free + flush → full bleed
 *   - two tiles that fill the panel   → each tile's free edges are flush → full bleed
 *   - a smaller floating window       → free edges not flush     → rounded, gap kept
 *   - a floating split (not filling)  → outer edges not flush     → rounded, gap kept
 *
 * Mobile keeps its own edge-to-edge single-window layout untouched.
 */
export function computeFullBleed(params: {
  isMobile: boolean;
  isMaximized: boolean;
  adjacentEdges?: Set<WindowEdge> | null;
  flushEdges: Set<WindowEdge>;
}): FullBleedResult {
  const { isMobile, isMaximized, adjacentEdges, flushEdges } = params;
  if (isMobile) {
    return { isFullBleed: false, bleedEdges: new Set(), squareCorners: false };
  }

  const shared = adjacentEdges ?? new Set<WindowEdge>();
  const freeEdges = ALL_WINDOW_EDGES.filter(edge => !shared.has(edge));
  const everyFreeEdgeFlush = freeEdges.length > 0 && freeEdges.every(edge => flushEdges.has(edge));
  const isFullBleed = isMaximized || everyFreeEdgeFlush;

  if (!isFullBleed) {
    return { isFullBleed: false, bleedEdges: new Set(), squareCorners: false };
  }

  // A maximized window fills the viewport by construction, so bleed on all four
  // edges even if a first-paint measurement hasn't landed yet. Tiled tiles bleed
  // only on their flush (free) edges — never the shared split edge.
  const bleedEdges = isMaximized
    ? new Set<WindowEdge>(ALL_WINDOW_EDGES)
    : new Set<WindowEdge>(freeEdges.filter(edge => flushEdges.has(edge)));

  return { isFullBleed: true, bleedEdges, squareCorners: true };
}
