import { describe, expect, it } from 'vitest'
import { getSplitTile, getComplementaryTile, boundsMatch, getTileEdge, canSplitContainer, type WindowBounds } from '../../src/hooks/useWindows'

const container: WindowBounds = { x: 0, y: 0, width: 1000, height: 800 }

describe('getSplitTile', () => {
  it('left tile takes the left half, full height, anchored at origin', () => {
    expect(getSplitTile(container, 'left')).toEqual({ x: 0, y: 0, width: 500, height: 800 })
  })

  it('right tile takes the right half, pushed to the right edge', () => {
    expect(getSplitTile(container, 'right')).toEqual({ x: 500, y: 0, width: 500, height: 800 })
  })

  it('top tile takes the top half, full width', () => {
    expect(getSplitTile(container, 'top')).toEqual({ x: 0, y: 0, width: 1000, height: 400 })
  })

  it('bottom tile takes the bottom half, pushed to the bottom edge', () => {
    expect(getSplitTile(container, 'bottom')).toEqual({ x: 0, y: 400, width: 1000, height: 400 })
  })

  it('honors the container origin offset (no clamp on a large container)', () => {
    const offset: WindowBounds = { x: 100, y: 50, width: 1000, height: 800 }
    expect(getSplitTile(offset, 'right').x).toBe(600) // 100 + (1000 - 500)
    expect(getSplitTile(offset, 'bottom').y).toBe(450) // 50 + (800 - 400)
  })

  it('clamps a half below the minimum window size to the minimum', () => {
    // width 400 -> half 200, but MIN_WINDOW_WIDTH (320) wins
    const tiny: WindowBounds = { x: 0, y: 0, width: 400, height: 300 }
    expect(getSplitTile(tiny, 'left').width).toBe(320)
  })
})

describe('getComplementaryTile', () => {
  it('left + its complement partition the container with no overlap or gap', () => {
    const left = getSplitTile(container, 'left')
    const comp = getComplementaryTile(container, 'left')
    expect(comp).toEqual({ x: 500, y: 0, width: 500, height: 800 })
    expect(left.x + left.width).toBe(comp.x)
    expect(left.width + comp.width).toBe(container.width)
  })

  it('top + its complement partition the height', () => {
    const top = getSplitTile(container, 'top')
    const comp = getComplementaryTile(container, 'top')
    expect(comp).toEqual({ x: 0, y: 400, width: 1000, height: 400 })
    expect(top.height + comp.height).toBe(container.height)
  })
})

describe('boundsMatch', () => {
  it('matches identical bounds', () => {
    expect(boundsMatch({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 })).toBe(true)
  })

  it('matches within the tile tolerance (12px)', () => {
    expect(boundsMatch({ x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 0, width: 100, height: 100 })).toBe(true)
  })

  it('rejects bounds beyond the tolerance', () => {
    expect(boundsMatch({ x: 0, y: 0, width: 100, height: 100 }, { x: 20, y: 0, width: 100, height: 100 })).toBe(false)
  })
})

describe('getTileEdge', () => {
  it('recognizes a window snapped to each edge', () => {
    expect(getTileEdge(getSplitTile(container, 'left'), container)).toBe('left')
    expect(getTileEdge(getSplitTile(container, 'right'), container)).toBe('right')
    expect(getTileEdge(getSplitTile(container, 'top'), container)).toBe('top')
    expect(getTileEdge(getSplitTile(container, 'bottom'), container)).toBe('bottom')
  })

  it('recognizes a snapped window within tolerance', () => {
    const nudged = { ...getSplitTile(container, 'left'), x: 8 }
    expect(getTileEdge(nudged, container)).toBe('left')
  })

  it('returns null for a free-floating window', () => {
    expect(getTileEdge({ x: 200, y: 150, width: 400, height: 300 }, container)).toBeNull()
  })
})

describe('canSplitContainer', () => {
  it('refuses a horizontal split when the container cannot hold two minimum-width tiles', () => {
    // MIN_WINDOW_WIDTH is 320, so anything under 640 cannot be halved.
    expect(canSplitContainer({ x: 0, y: 0, width: 500, height: 800 }, 'left')).toBe(false)
    expect(canSplitContainer({ x: 0, y: 0, width: 639, height: 800 }, 'right')).toBe(false)
    expect(canSplitContainer({ x: 0, y: 0, width: 640, height: 800 }, 'left')).toBe(true)
  })

  it('refuses a vertical split when the container cannot hold two minimum-height tiles', () => {
    // MIN_WINDOW_HEIGHT is 260, so anything under 520 cannot be halved.
    expect(canSplitContainer({ x: 0, y: 0, width: 1000, height: 400 }, 'top')).toBe(false)
    expect(canSplitContainer({ x: 0, y: 0, width: 1000, height: 519 }, 'bottom')).toBe(false)
    expect(canSplitContainer({ x: 0, y: 0, width: 1000, height: 520 }, 'top')).toBe(true)
  })

  it('judges each axis independently', () => {
    // Wide but short: horizontal split fine, vertical split impossible.
    const wideShort: WindowBounds = { x: 0, y: 0, width: 1200, height: 300 }
    expect(canSplitContainer(wideShort, 'left')).toBe(true)
    expect(canSplitContainer(wideShort, 'top')).toBe(false)
  })
})

describe('split + complement partition exactly (the overlap regression)', () => {
  // The bug this pins: a 500px container produced a 320px dragged tile at
  // x=180 and a 320px partner at x=0 — 140px of overlap presented as a clean
  // tiled pair. Any container that canSplitContainer accepts must partition
  // with no overlap and no gap.
  const sizes = [640, 641, 700, 999, 1000, 1001, 1920]

  for (const width of sizes) {
    for (const edge of ['left', 'right'] as const) {
      it(`width ${width}, ${edge}: tiles tile the container exactly`, () => {
        const box: WindowBounds = { x: 40, y: 20, width, height: 800 }
        expect(canSplitContainer(box, edge)).toBe(true)
        const tile = getSplitTile(box, edge)
        const comp = getComplementaryTile(box, edge)
        expect(tile.width + comp.width).toBe(Math.round(width))
        // Neither tile may start before the container or end past it.
        expect(Math.min(tile.x, comp.x)).toBe(box.x)
        expect(Math.max(tile.x + tile.width, comp.x + comp.width)).toBe(box.x + Math.round(width))
        // And they must not overlap: the right-hand tile starts where the
        // left-hand one ends.
        const [first, second] = tile.x <= comp.x ? [tile, comp] : [comp, tile]
        expect(first.x + first.width).toBe(second.x)
      })
    }
  }

  for (const height of [520, 521, 800, 1080]) {
    for (const edge of ['top', 'bottom'] as const) {
      it(`height ${height}, ${edge}: tiles tile the container exactly`, () => {
        const box: WindowBounds = { x: 0, y: 30, width: 1000, height }
        expect(canSplitContainer(box, edge)).toBe(true)
        const tile = getSplitTile(box, edge)
        const comp = getComplementaryTile(box, edge)
        expect(tile.height + comp.height).toBe(Math.round(height))
        const [first, second] = tile.y <= comp.y ? [tile, comp] : [comp, tile]
        expect(first.y + first.height).toBe(second.y)
      })
    }
  }
})
