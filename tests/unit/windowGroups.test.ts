import { describe, expect, it } from 'vitest'
import { computeGroupRole } from '../../src/lib/windowGroups'
import type { FloatingWindow } from '../../src/types'

// Minimal window factory — computeGroupRole only reads id/groupId/minimized/x/y.
function win(
  id: string,
  bounds: { x: number; y: number },
  groupId: string | null = null,
  minimized = false,
): FloatingWindow {
  return {
    id,
    type: 'chat',
    title: id,
    x: bounds.x,
    y: bounds.y,
    width: 400,
    height: 300,
    zIndex: 1,
    minimized,
    groupId,
  }
}

describe('computeGroupRole', () => {
  it('returns null for an ungrouped window', () => {
    const a = win('a', { x: 0, y: 0 })
    expect(computeGroupRole(a, [a])).toBeNull()
  })

  it('returns null when a group has only one visible member', () => {
    // Nothing to host: the survivor gets its own controls back.
    const a = win('a', { x: 0, y: 0 }, 'g1')
    const b = win('b', { x: 400, y: 0 }, 'g1', true) // minimized
    expect(computeGroupRole(a, [a, b])).toBeNull()
  })

  it('makes the topmost pane the host in a vertical stack', () => {
    const top = win('top', { x: 0, y: 0 }, 'g1')
    const bottom = win('bottom', { x: 0, y: 400 }, 'g1')
    const all = [bottom, top] // deliberately not in visual order
    expect(computeGroupRole(top, all)).toBe('host')
    expect(computeGroupRole(bottom, all)).toBe('member')
  })

  it('breaks a y-tie with x — leftmost wins', () => {
    const left = win('left', { x: 0, y: 100 }, 'g1')
    const right = win('right', { x: 500, y: 100 }, 'g1')
    const all = [right, left]
    expect(computeGroupRole(left, all)).toBe('host')
    expect(computeGroupRole(right, all)).toBe('member')
  })

  it('picks the top-left pane in the screenshot layout (full-width top, two below)', () => {
    const memory = win('memory', { x: 0, y: 0 }, 'g1')
    const scout = win('scout', { x: 0, y: 500 }, 'g1')
    const agents = win('agents', { x: 600, y: 500 }, 'g1')
    const all = [scout, agents, memory]
    expect(computeGroupRole(memory, all)).toBe('host')
    expect(computeGroupRole(scout, all)).toBe('member')
    expect(computeGroupRole(agents, all)).toBe('member')
  })

  it('is deterministic when two panes share x AND y', () => {
    const a = win('a', { x: 10, y: 10 }, 'g1')
    const b = win('b', { x: 10, y: 10 }, 'g1')
    // id is the final tiebreak, so the answer cannot depend on array order.
    expect(computeGroupRole(a, [a, b])).toBe('host')
    expect(computeGroupRole(a, [b, a])).toBe('host')
    expect(computeGroupRole(b, [a, b])).toBe('member')
  })

  it('never hands the chrome to a minimized pane', () => {
    // The minimized pane is top-left, but it cannot host — it is not on screen.
    const hidden = win('hidden', { x: 0, y: 0 }, 'g1', true)
    const a = win('a', { x: 0, y: 300 }, 'g1')
    const b = win('b', { x: 500, y: 300 }, 'g1')
    const all = [hidden, a, b]
    expect(computeGroupRole(hidden, all)).toBeNull()
    expect(computeGroupRole(a, all)).toBe('host')
    expect(computeGroupRole(b, all)).toBe('member')
  })

  it('keeps groups independent', () => {
    const g1a = win('g1a', { x: 0, y: 0 }, 'g1')
    const g1b = win('g1b', { x: 400, y: 0 }, 'g1')
    const g2a = win('g2a', { x: 0, y: 600 }, 'g2')
    const g2b = win('g2b', { x: 400, y: 600 }, 'g2')
    const all = [g1a, g1b, g2a, g2b]
    // g2a is lower down the screen but still hosts its OWN group.
    expect(computeGroupRole(g1a, all)).toBe('host')
    expect(computeGroupRole(g2a, all)).toBe('host')
    expect(computeGroupRole(g1b, all)).toBe('member')
    expect(computeGroupRole(g2b, all)).toBe('member')
  })
})
