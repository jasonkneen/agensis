import { describe, expect, it } from 'vitest'
import {
  TASK_PANEL_BOARD_RESERVE,
  TASK_PANEL_MAX_WIDTH,
  TASK_PANEL_MIN_WIDTH,
  clampTaskPanelWidth,
} from '../../src/lib/taskPanelWidth'

describe('clampTaskPanelWidth', () => {
  it('never exceeds the container minus the reserved board width', () => {
    // The original bug: a hard 320px panel in a narrow window ran off the right
    // edge and its content became unreachable.
    const container = 700
    expect(clampTaskPanelWidth(600, container)).toBe(container - TASK_PANEL_BOARD_RESERVE)
  })

  it('honours the hard maximum in a wide container', () => {
    expect(clampTaskPanelWidth(5000, 4000)).toBe(TASK_PANEL_MAX_WIDTH)
  })

  it('honours the hard minimum', () => {
    expect(clampTaskPanelWidth(10, 2000)).toBe(TASK_PANEL_MIN_WIDTH)
  })

  it('keeps a usable editor even when the container cannot spare the room', () => {
    // Minimum beats available room on purpose — better the board scrolls than
    // we render an unusable sliver of an editor.
    expect(clampTaskPanelWidth(400, 300)).toBe(TASK_PANEL_MIN_WIDTH)
    expect(clampTaskPanelWidth(400, 0)).toBe(TASK_PANEL_MIN_WIDTH)
  })

  it('falls back to the hard max when the container is not measured yet', () => {
    // null = first paint, before the ResizeObserver has fired. Falling back to
    // the minimum here would make the panel visibly jump on open.
    expect(clampTaskPanelWidth(500, null)).toBe(500)
    expect(clampTaskPanelWidth(900, null)).toBe(TASK_PANEL_MAX_WIDTH)
  })

  it('returns whole pixels', () => {
    expect(Number.isInteger(clampTaskPanelWidth(383.7, 2000))).toBe(true)
    expect(clampTaskPanelWidth(383.7, 2000)).toBe(384)
  })

  it('is idempotent — clamping a clamped value changes nothing', () => {
    const once = clampTaskPanelWidth(600, 700)
    expect(clampTaskPanelWidth(once, 700)).toBe(once)
  })
})
