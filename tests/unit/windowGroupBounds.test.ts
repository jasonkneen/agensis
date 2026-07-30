import { describe, expect, it } from 'vitest'
import { computeGroupBounds, normalizeGroupBounds } from '../../src/lib/windowGroups'
import type { FloatingWindow } from '../../src/types'

function win(
  id: string,
  x: number, y: number, width: number, height: number,
  groupId: string | null = 'g1',
  minimized = false,
): FloatingWindow {
  return { id, type: 'chat', title: id, x, y, width, height, zIndex: 1, minimized, groupId }
}

describe('computeGroupBounds', () => {
  it('returns the union box of the visible members', () => {
    const a = win('a', 100, 50, 400, 600)
    const b = win('b', 500, 50, 300, 600)
    expect(computeGroupBounds('g1', [a, b])).toEqual({ x: 100, y: 50, width: 700, height: 600 })
  })

  it('returns null when there is no composite window to frame', () => {
    const solo = win('a', 0, 0, 400, 400)
    expect(computeGroupBounds('g1', [solo])).toBeNull()
    expect(computeGroupBounds('nope', [solo, win('b', 400, 0, 400, 400)])).toBeNull()
  })

  it('ignores minimized members', () => {
    const a = win('a', 0, 0, 400, 400)
    const b = win('b', 400, 0, 400, 400)
    const hidden = win('c', 0, 900, 400, 400, 'g1', true)
    expect(computeGroupBounds('g1', [a, b, hidden])).toEqual({ x: 0, y: 0, width: 800, height: 400 })
  })

  it('spans a ragged group (the bug: panes of different heights)', () => {
    const tall = win('tall', 0, 0, 400, 700)
    const short = win('short', 400, 0, 400, 640)
    expect(computeGroupBounds('g1', [tall, short])).toEqual({ x: 0, y: 0, width: 800, height: 700 })
  })
})

describe('normalizeGroupBounds', () => {
  it('gives two side-by-side panes of different heights a shared bottom edge', () => {
    // This is the screenshot bug: AI Agents and Schedules snapped as a pair but
    // ended ~30px apart at the bottom, so the group did not read as one window.
    const tall = win('tall', 0, 0, 400, 700)
    const short = win('short', 400, 0, 400, 670)
    const fixed = normalizeGroupBounds('g1', [tall, short])
    expect(fixed.get('tall')).toEqual({ x: 0, y: 0, width: 400, height: 700 })
    expect(fixed.get('short')).toEqual({ x: 400, y: 0, width: 400, height: 700 })
  })

  it('closes a small horizontal gap between panes onto one gridline', () => {
    const left = win('left', 0, 0, 400, 600)
    const right = win('right', 409, 0, 391, 600) // 9px adrift
    const fixed = normalizeGroupBounds('g1', [left, right])
    const l = fixed.get('left')!
    const r = fixed.get('right')!
    expect(l.x + l.width).toBe(r.x) // no gap, no overlap
    expect(l.x).toBe(0)
    expect(r.x + r.width).toBe(800)
  })

  it('leaves an already-clean group untouched', () => {
    const a = win('a', 10, 20, 400, 600)
    const b = win('b', 410, 20, 400, 600)
    const fixed = normalizeGroupBounds('g1', [a, b])
    expect(fixed.get('a')).toEqual({ x: 10, y: 20, width: 400, height: 600 })
    expect(fixed.get('b')).toEqual({ x: 410, y: 20, width: 400, height: 600 })
  })

  it('handles the screenshot layout: full-width top, two panes below', () => {
    const top = win('top', 0, 0, 800, 300)
    const bl = win('bl', 0, 300, 400, 500)
    const br = win('br', 400, 302, 400, 496) // drifted on both axes
    const fixed = normalizeGroupBounds('g1', [top, bl, br])
    expect(fixed.get('top')).toEqual({ x: 0, y: 0, width: 800, height: 300 })
    expect(fixed.get('bl')).toEqual({ x: 0, y: 300, width: 400, height: 500 })
    expect(fixed.get('br')).toEqual({ x: 400, y: 300, width: 400, height: 500 })
  })

  it('does not merge genuinely distinct gridlines', () => {
    // A 3-column row: the middle column must survive, not collapse into a neighbour.
    const a = win('a', 0, 0, 300, 600)
    const b = win('b', 300, 0, 300, 600)
    const c = win('c', 600, 0, 300, 600)
    const fixed = normalizeGroupBounds('g1', [a, b, c])
    expect(fixed.get('a')!.width).toBe(300)
    expect(fixed.get('b')).toEqual({ x: 300, y: 0, width: 300, height: 600 })
    expect(fixed.get('c')!.x).toBe(600)
  })

  it('returns an empty map when there is no group to normalize', () => {
    expect(normalizeGroupBounds('g1', [win('a', 0, 0, 400, 400)]).size).toBe(0)
  })
})
