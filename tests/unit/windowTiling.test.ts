import { describe, expect, it } from 'vitest'
import { getSplitTile, getComplementaryTile, boundsMatch, getTileEdge, type WindowBounds } from '../../src/hooks/useWindows'

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
