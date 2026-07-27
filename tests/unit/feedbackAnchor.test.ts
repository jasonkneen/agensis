import { describe, expect, it } from 'vitest'
import {
  clampFeedbackAnchor,
  DEFAULT_FEEDBACK_ANCHOR,
  expandRect,
  FEEDBACK_BUTTON_SIZE,
  feedbackAnchorPreference,
  feedbackAnchorRect,
  isPointerNearFeedback,
  NO_FEEDBACK_DODGE,
  resolveFeedbackDodge,
  type FeedbackRect,
} from '../../src/lib/feedbackAnchor'
import { readPreference } from '../../src/lib/viewPreferences'
import { WORKSPACE_DOCK_BOTTOM_OFFSET, WORKSPACE_DOCK_HEIGHT } from '../../src/lib/workspaceLayout'

const WIDE = { width: 1600, height: 900 }
const NARROW = { width: 500, height: 800 }

/** The band the window dock owns, in viewport coordinates. */
function dockTop(height: number): number {
  return height - (WORKSPACE_DOCK_BOTTOM_OFFSET + WORKSPACE_DOCK_HEIGHT)
}

describe('clampFeedbackAnchor', () => {
  it('leaves the default home position alone — it is clear of the dock by design', () => {
    expect(clampFeedbackAnchor(DEFAULT_FEEDBACK_ANCHOR, WIDE)).toEqual(DEFAULT_FEEDBACK_ANCHOR)
  })

  it('pulls a position chosen on a wide window back onto a narrow one', () => {
    // 900px in from the right edge is a comfortable middle-left spot on a
    // 1600px window, and 400px past the left edge of a 500px one.
    const stored = { right: 900, bottom: 300 }
    expect(feedbackAnchorRect(stored, NARROW).left).toBeLessThan(0)

    const clamped = clampFeedbackAnchor(stored, NARROW)
    const rect = feedbackAnchorRect(clamped, NARROW)
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.right).toBeLessThanOrEqual(NARROW.width)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.bottom).toBeLessThanOrEqual(NARROW.height)
    // Pushed to the far edge, not re-centred: it stays as close to where the
    // user left it as the window allows.
    expect(clamped.right).toBe(NARROW.width - FEEDBACK_BUTTON_SIZE)
  })

  it('does not rewrite the stored value — a wider window gets the original spot back', () => {
    const stored = { right: 900, bottom: 300 }
    expect(clampFeedbackAnchor(stored, WIDE)).toEqual(stored)
  })

  it('lifts a position that would land under the window dock', () => {
    const viewport = { width: 1200, height: 800 }
    // Bottom centre: squarely in the dock's band.
    const stored = { right: 580, bottom: 4 }
    const under = feedbackAnchorRect(stored, viewport)
    expect(under.bottom).toBeGreaterThan(dockTop(viewport.height))

    const clamped = clampFeedbackAnchor(stored, viewport)
    expect(clamped.right).toBe(580)
    const rect = feedbackAnchorRect(clamped, viewport)
    expect(rect.bottom).toBeLessThanOrEqual(dockTop(viewport.height))
  })

  it('leaves the bottom corners alone — the dock is a centre band, not a full-width bar', () => {
    const viewport = { width: 1200, height: 800 }
    for (const anchor of [{ right: 16, bottom: 4 }, { right: 1200 - 40 - 16, bottom: 4 }]) {
      expect(clampFeedbackAnchor(anchor, viewport)).toEqual(anchor)
    }
  })

  it('has no dock to avoid in a viewport too narrow to have a centre band', () => {
    const viewport = { width: 160, height: 600 }
    const anchor = { right: 60, bottom: 4 }
    expect(clampFeedbackAnchor(anchor, viewport)).toEqual(anchor)
  })

  it('clamps a negative inset to the edge rather than off it', () => {
    expect(clampFeedbackAnchor({ right: -200, bottom: -50 }, WIDE)).toEqual({ right: 0, bottom: 0 })
  })

  it('clamps an inset past the far edge', () => {
    const clamped = clampFeedbackAnchor({ right: 99999, bottom: 99999 }, WIDE)
    expect(clamped).toEqual({
      right: WIDE.width - FEEDBACK_BUTTON_SIZE,
      bottom: WIDE.height - FEEDBACK_BUTTON_SIZE,
    })
  })

  it('leaves the anchor untouched before the viewport has been measured', () => {
    const anchor = { right: 900, bottom: 400 }
    expect(clampFeedbackAnchor(anchor, { width: 0, height: 0 })).toEqual(anchor)
  })

  it('survives a NaN in storage without producing a NaN position', () => {
    const clamped = clampFeedbackAnchor({ right: Number.NaN, bottom: 4 }, WIDE)
    expect(Number.isFinite(clamped.right)).toBe(true)
    expect(Number.isFinite(clamped.bottom)).toBe(true)
  })
})

describe('resolveFeedbackDodge', () => {
  const button: FeedbackRect = { left: 100, top: 100, right: 140, bottom: 140 }

  it('does not move for something it is not covering', () => {
    const clear: FeedbackRect = { left: 300, top: 300, right: 400, bottom: 330 }
    expect(resolveFeedbackDodge(button, clear)).toBe(NO_FEEDBACK_DODGE)
  })

  it('slides up far enough to clear an action row underneath it', () => {
    const row: FeedbackRect = { left: 110, top: 120, right: 260, bottom: 148 }
    const dodge = resolveFeedbackDodge(button, row)
    expect(dodge.dx).toBe(0)
    expect(dodge.dy).toBeLessThan(0)
    // Fully clear, with the gap, not merely half-uncovered.
    expect(button.bottom + dodge.dy).toBeLessThanOrEqual(row.top - 8)
  })

  it('goes left when there is no room above', () => {
    const top: FeedbackRect = { left: 200, top: 10, right: 240, bottom: 50 }
    const row: FeedbackRect = { left: 210, top: 20, right: 600, bottom: 48 }
    const dodge = resolveFeedbackDodge(top, row)
    expect(dodge.dy).toBe(0)
    expect(dodge.dx).toBeLessThan(0)
    expect(top.right + dodge.dx).toBeLessThanOrEqual(row.left - 8)
    expect(top.left + dodge.dx).toBeGreaterThanOrEqual(0)
  })

  it('stays put rather than fleeing off-screen when nothing fits', () => {
    const cornered: FeedbackRect = { left: 10, top: 10, right: 50, bottom: 50 }
    const huge: FeedbackRect = { left: 0, top: 0, right: 400, bottom: 60 }
    expect(resolveFeedbackDodge(cornered, huge)).toBe(NO_FEEDBACK_DODGE)
  })

  it('never moves downward, where the dock lives', () => {
    const above: FeedbackRect = { left: 110, top: 80, right: 260, bottom: 110 }
    const dodge = resolveFeedbackDodge(button, above)
    expect(dodge.dy).toBeLessThanOrEqual(0)
  })
})

describe('isPointerNearFeedback', () => {
  const home: FeedbackRect = { left: 100, top: 100, right: 140, bottom: 140 }
  const dodged: FeedbackRect = { left: 100, top: 60, right: 140, bottom: 100 }

  it('counts the spot the button came FROM, so it does not snap back under the pointer', () => {
    expect(isPointerNearFeedback({ x: 120, y: 120 }, home, dodged, 20)).toBe(true)
  })

  it('counts the spot the button moved TO', () => {
    expect(isPointerNearFeedback({ x: 120, y: 80 }, home, dodged, 20)).toBe(true)
  })

  it('releases once the pointer is properly away', () => {
    expect(isPointerNearFeedback({ x: 400, y: 400 }, home, dodged, 20)).toBe(false)
    expect(isPointerNearFeedback({ x: 120, y: 200 }, home, dodged, 20)).toBe(false)
  })
})

describe('expandRect', () => {
  it('grows on every side', () => {
    expect(expandRect({ left: 10, top: 20, right: 30, bottom: 40 }, 5))
      .toEqual({ left: 5, top: 15, right: 35, bottom: 45 })
  })
})

describe('feedbackAnchorPreference', () => {
  it('round-trips a position', () => {
    const raw = feedbackAnchorPreference.serialize({ right: 120.4, bottom: 60.6 })
    expect(feedbackAnchorPreference.parse(raw)).toEqual({ right: 120, bottom: 61 })
  })

  it('rejects anything that is not a pair of finite numbers', () => {
    for (const raw of ['null', '[]', '"120,60"', '{"right":"120","bottom":60}', '{"right":120}']) {
      expect(feedbackAnchorPreference.parse(raw)).toBeNull()
    }
  })

  it('falls back to the default rather than throwing on a hand-edited key', () => {
    const storage = { getItem: () => 'not json at all', setItem: () => {} }
    expect(readPreference('agensis.feedback.anchor:u1', feedbackAnchorPreference, DEFAULT_FEEDBACK_ANCHOR, storage))
      .toEqual(DEFAULT_FEEDBACK_ANCHOR)
  })

  it('keeps one user\'s position out of another user\'s key', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
    }
    storage.setItem('agensis.feedback.anchor:user-a', feedbackAnchorPreference.serialize({ right: 400, bottom: 300 }))
    expect(readPreference('agensis.feedback.anchor:user-b', feedbackAnchorPreference, DEFAULT_FEEDBACK_ANCHOR, storage))
      .toEqual(DEFAULT_FEEDBACK_ANCHOR)
  })
})
