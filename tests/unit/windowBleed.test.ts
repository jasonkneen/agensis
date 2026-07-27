import { describe, it, expect } from 'vitest';
import { computeFlushEdges, computeFullBleed, type WindowEdge } from '../../src/lib/windowBleed';

const VIEWPORT = { width: 1000, height: 800 };
const edges = (...e: WindowEdge[]) => new Set<WindowEdge>(e);

describe('computeFlushEdges', () => {
  it('flags every edge for a window that fills the viewport', () => {
    const flush = computeFlushEdges({ x: 0, y: 0, width: 1000, height: 800 }, VIEWPORT);
    expect(flush).toEqual(edges('left', 'top', 'right', 'bottom'));
  });

  it('flags no edge for a small centered window', () => {
    const flush = computeFlushEdges({ x: 300, y: 250, width: 300, height: 250 }, VIEWPORT);
    expect(flush.size).toBe(0);
  });

  it('flags the left/top/bottom edges of a left tile in a vertical split', () => {
    const flush = computeFlushEdges({ x: 0, y: 0, width: 500, height: 800 }, VIEWPORT);
    expect(flush).toEqual(edges('left', 'top', 'bottom'));
  });

  it('honours the tolerance so sub-pixel gaps still count as flush', () => {
    const flush = computeFlushEdges({ x: 1, y: 1, width: 998, height: 798 }, VIEWPORT);
    expect(flush).toEqual(edges('left', 'top', 'right', 'bottom'));
  });

  it('returns nothing when the viewport has not been measured yet', () => {
    const flush = computeFlushEdges({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 });
    expect(flush.size).toBe(0);
  });
});

describe('computeFullBleed', () => {
  it('makes a maximized window bleed on all four edges and square its corners', () => {
    const result = computeFullBleed({
      isMobile: false,
      isMaximized: true,
      adjacentEdges: null,
      flushEdges: edges(), // not yet measured — maximized still bleeds all four
    });
    expect(result.isFullBleed).toBe(true);
    expect(result.squareCorners).toBe(true);
    expect(result.bleedEdges).toEqual(edges('left', 'right', 'top', 'bottom'));
  });

  it('treats a single window that fills the panel as full bleed', () => {
    const result = computeFullBleed({
      isMobile: false,
      isMaximized: false,
      adjacentEdges: null,
      flushEdges: edges('left', 'right', 'top', 'bottom'),
    });
    expect(result.isFullBleed).toBe(true);
    expect(result.squareCorners).toBe(true);
    expect(result.bleedEdges).toEqual(edges('left', 'right', 'top', 'bottom'));
  });

  it('keeps a tile of a panel-filling split ROUNDED — tiled panes are never full bleed', () => {
    // Left tile of a vertical split: shares its right edge, flush on the other
    // three. This used to be full bleed + square, so a split read as one welded
    // surface. It is deliberately not, now: the wrapper (shadow, neo border) and
    // the surface (glass) carry the radius on different boxes, so a squared seam
    // left a square shadow "ear" past the rounded glass. Tiled panes are rounded
    // cards separated by GROUP_GUTTER instead. Do not "restore" this to true
    // without also solving the two-box radius problem.
    const left = computeFullBleed({
      isMobile: false,
      isMaximized: false,
      adjacentEdges: edges('right'),
      flushEdges: edges('left', 'top', 'bottom'),
    });
    expect(left.isFullBleed).toBe(false);
    expect(left.squareCorners).toBe(false);
    expect(left.bleedEdges.size).toBe(0);
  });

  it('still full-bleeds a MAXIMIZED window even if it reports a shared edge', () => {
    // Maximize wins over grouping: a maximized window is one surface covering
    // the panel, whatever stale adjacency was measured before it maximized.
    const result = computeFullBleed({
      isMobile: false,
      isMaximized: true,
      adjacentEdges: edges('right'),
      flushEdges: edges('left', 'top', 'bottom', 'right'),
    });
    expect(result.isFullBleed).toBe(true);
    expect(result.squareCorners).toBe(true);
  });

  it('keeps a smaller floating window rounded with no bleed', () => {
    const result = computeFullBleed({
      isMobile: false,
      isMaximized: false,
      adjacentEdges: null,
      flushEdges: edges(),
    });
    expect(result.isFullBleed).toBe(false);
    expect(result.squareCorners).toBe(false);
    expect(result.bleedEdges.size).toBe(0);
  });

  it('keeps a floating split that does NOT fill the panel rounded (outer edges not flush)', () => {
    // Two tiles floating in the middle: shared edge, but outer edges are not flush.
    const result = computeFullBleed({
      isMobile: false,
      isMaximized: false,
      adjacentEdges: edges('right'),
      flushEdges: edges('top'), // touches top only — panel not filled
    });
    expect(result.isFullBleed).toBe(false);
    expect(result.bleedEdges.size).toBe(0);
  });

  it('never bleeds on mobile (mobile keeps its own edge-to-edge layout)', () => {
    const result = computeFullBleed({
      isMobile: true,
      isMaximized: true,
      adjacentEdges: null,
      flushEdges: edges('left', 'right', 'top', 'bottom'),
    });
    expect(result.isFullBleed).toBe(false);
    expect(result.squareCorners).toBe(false);
    expect(result.bleedEdges.size).toBe(0);
  });
});
