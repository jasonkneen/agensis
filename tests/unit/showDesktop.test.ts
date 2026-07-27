import { describe, expect, it } from 'vitest'
import {
  clearShowDesktopStash,
  isShowingDesktop,
  resolveShowDesktop,
  type ShowDesktopStash,
  type ShowDesktopWindow,
} from '../../src/lib/showDesktop'

function win(id: string, opts: { canvasId?: string | null; minimized?: boolean } = {}): ShowDesktopWindow {
  return { id, canvasId: opts.canvasId, minimized: opts.minimized ?? false }
}

/** Apply a decision to a window list the way App does, so presses can be chained. */
function press(
  windows: ShowDesktopWindow[],
  canvasId: string | null | undefined,
  stash: ShowDesktopStash,
) {
  const decision = resolveShowDesktop(windows, canvasId, stash)
  const touched = new Set(decision.windowIds)
  const next = decision.action === 'none'
    ? windows
    : windows.map(w => (touched.has(w.id) ? { ...w, minimized: decision.action === 'hide' } : w))
  return { windows: next, stash: decision.stash, action: decision.action, windowIds: decision.windowIds }
}

describe('resolveShowDesktop', () => {
  it('does nothing on a desktop with no windows at all', () => {
    const decision = resolveShowDesktop([], undefined, {})
    expect(decision.action).toBe('none')
    expect(decision.windowIds).toEqual([])
    expect(decision.stash).toEqual({})
  })

  it('does nothing when the only windows were minimised by hand, not by the button', () => {
    const windows = [win('a', { minimized: true }), win('b', { minimized: true })]
    const decision = resolveShowDesktop(windows, undefined, {})
    expect(decision.action).toBe('none')
    expect(decision.windowIds).toEqual([])
  })

  it('hides every visible window on the desktop and stashes them', () => {
    const windows = [win('a'), win('b'), win('c', { minimized: true })]
    const decision = resolveShowDesktop(windows, undefined, {})
    expect(decision.action).toBe('hide')
    // 'c' was already down and is NOT the button's to restore later.
    expect(decision.windowIds).toEqual(['a', 'b'])
    expect(decision.stash).toEqual({ base: ['a', 'b'] })
  })

  it('restores exactly what it hid on the second press', () => {
    const first = press([win('a'), win('b'), win('c', { minimized: true })], undefined, {})
    expect(first.action).toBe('hide')
    expect(first.windows.every(w => w.minimized)).toBe(true)

    const second = press(first.windows, undefined, first.stash)
    expect(second.action).toBe('restore')
    expect(second.windows.find(w => w.id === 'a')?.minimized).toBe(false)
    expect(second.windows.find(w => w.id === 'b')?.minimized).toBe(false)
    // The hand-minimised one stays down — the button never took it.
    expect(second.windows.find(w => w.id === 'c')?.minimized).toBe(true)
    expect(second.stash).toEqual({})
  })

  it('does not clobber a window opened while the desktop is showing', () => {
    const hidden = press([win('a'), win('b')], undefined, {})
    expect(hidden.stash).toEqual({ base: ['a', 'b'] })

    // A new window opens on the bare desktop.
    const withNew = [...hidden.windows, win('c')]
    expect(isShowingDesktop(withNew, undefined, hidden.stash)).toBe(false)

    // Pressing again puts the new one away too, on top of the existing stash.
    const hiddenAgain = press(withNew, undefined, hidden.stash)
    expect(hiddenAgain.action).toBe('hide')
    expect(hiddenAgain.windowIds).toEqual(['c'])
    expect(hiddenAgain.stash).toEqual({ base: ['a', 'b', 'c'] })

    // And the next press brings back all three, not just the newcomer.
    const restored = press(hiddenAgain.windows, undefined, hiddenAgain.stash)
    expect(restored.action).toBe('restore')
    expect(restored.windows.map(w => w.minimized)).toEqual([false, false, false])
    expect(restored.stash).toEqual({})
  })

  it('never stashes the same window twice when it is hidden, restored from the dock, and hidden again', () => {
    const hidden = press([win('a'), win('b')], undefined, {})
    // 'a' comes back from the dock on its own.
    const partly = hidden.windows.map(w => (w.id === 'a' ? { ...w, minimized: false } : w))
    const hiddenAgain = press(partly, undefined, hidden.stash)
    expect(hiddenAgain.action).toBe('hide')
    expect(hiddenAgain.stash).toEqual({ base: ['b', 'a'] })
  })

  it('acts only on the active desktop', () => {
    const windows = [win('a', { canvasId: 'main' }), win('b', { canvasId: 'other' })]
    const decision = resolveShowDesktop(windows, 'main', {})
    expect(decision.windowIds).toEqual(['a'])
    expect(decision.stash).toEqual({ main: ['a'] })

    // The other desktop keeps its own stash and its own windows.
    const both = resolveShowDesktop(windows, 'other', decision.stash)
    expect(both.windowIds).toEqual(['b'])
    expect(both.stash).toEqual({ main: ['a'], other: ['b'] })
  })

  it('treats an undefined canvasId as the base desktop', () => {
    const decision = resolveShowDesktop([win('a', { canvasId: undefined })], null, {})
    expect(decision.stash).toEqual({ base: ['a'] })
  })

  it('prunes closed windows out of the stash instead of staying pressed forever', () => {
    const hidden = press([win('a'), win('b')], undefined, {})
    // Both are closed from the dock while down.
    const decision = resolveShowDesktop([], undefined, hidden.stash)
    expect(decision.action).toBe('none')
    expect(decision.stash).toEqual({})
  })

  it('restores only the survivors when some stashed windows were closed', () => {
    const hidden = press([win('a'), win('b')], undefined, {})
    const survivors = hidden.windows.filter(w => w.id === 'b')
    const decision = resolveShowDesktop(survivors, undefined, hidden.stash)
    expect(decision.action).toBe('restore')
    expect(decision.windowIds).toEqual(['b'])
    expect(decision.stash).toEqual({})
  })
})

describe('isShowingDesktop', () => {
  it('is false for an empty desktop nobody pressed the button on', () => {
    expect(isShowingDesktop([], undefined, {})).toBe(false)
  })

  it('is false while anything is visible', () => {
    expect(isShowingDesktop([win('a')], undefined, { base: ['b'] })).toBe(false)
  })

  it('is true once the button has put the visible windows away', () => {
    const hidden = press([win('a')], undefined, {})
    expect(isShowingDesktop(hidden.windows, undefined, hidden.stash)).toBe(true)
  })

  it('is false when the stash names windows that no longer exist', () => {
    expect(isShowingDesktop([], undefined, { base: ['gone'] })).toBe(false)
  })

  it('is scoped per desktop', () => {
    const windows = [win('a', { canvasId: 'main', minimized: true }), win('b', { canvasId: 'other' })]
    const stash = { main: ['a'] }
    expect(isShowingDesktop(windows, 'main', stash)).toBe(true)
    expect(isShowingDesktop(windows, 'other', stash)).toBe(false)
  })
})

describe('clearShowDesktopStash', () => {
  it('empties every desktop, because a workspace switch closes every window', () => {
    expect(clearShowDesktopStash()).toEqual({})
  })
})
