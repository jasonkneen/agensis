// ---------------------------------------------------------------------------
// Where the feedback launcher sits, and how it gets out of the way.
//
// Two decisions, both pure, both easy to get subtly wrong in a component:
//
//   clampFeedbackAnchor — a POSITION the user chose is a stored number, and the
//     window it was chosen in is gone. Half the width later that number puts the
//     button off-canvas, or under the window dock. Clamping is not a nicety: an
//     off-canvas launcher is the one control a stuck user cannot reach.
//
//   resolveFeedbackDodge — the button is deliberately solid and high-contrast,
//     which is exactly why it covers things. Given its rect and the rect of a
//     control underneath it, this says how far to slide so the control is
//     clickable — without ever hiding the button or making it inert.
//
// No DOM, no React, no window. The component measures; this decides.
// ---------------------------------------------------------------------------

import type { PreferenceCodec } from './viewPreferences';
import { WORKSPACE_CHROME_GAP, WORKSPACE_DOCK_BOTTOM_OFFSET, WORKSPACE_DOCK_HEIGHT } from './workspaceLayout';

/** The launcher is a 40px circle. Exported so the component and tests agree. */
export const FEEDBACK_BUTTON_SIZE = 40;

/** Breathing room between the button and whatever it is avoiding. */
export const FEEDBACK_EDGE_GAP = 8;

/**
 * The window dock is bottom-CENTRE with a `calc(100% - 12rem)` max width, which
 * leaves ~96px (half of 12rem) clear at each end. That clear strip is where the
 * launcher's home position lives, so the dock is modelled as a centre band
 * rather than a full-width bar — otherwise every bottom position would be
 * rejected, including the default one.
 */
export const FEEDBACK_DOCK_SIDE_CLEARANCE = 96;

/**
 * A stored position, as insets from the BOTTOM-RIGHT corner.
 *
 * Right/bottom rather than left/top because that is the corner the control
 * belongs to: growing the window then leaves it where it was instead of
 * stranding it in the middle of the new space.
 */
export interface FeedbackAnchor {
  /** px from the viewport's right edge to the button's right edge. */
  right: number;
  /** px from the viewport's bottom edge to the button's bottom edge. */
  bottom: number;
}

export interface FeedbackViewport {
  width: number;
  height: number;
}

/** A plain rect in viewport coordinates — what `getBoundingClientRect` gives. */
export interface FeedbackRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Home: the bottom-right corner, vertically centred on the dock's band. */
export const DEFAULT_FEEDBACK_ANCHOR: FeedbackAnchor = {
  right: WORKSPACE_CHROME_GAP + 8,
  bottom: WORKSPACE_DOCK_BOTTOM_OFFSET + Math.round((WORKSPACE_DOCK_HEIGHT - FEEDBACK_BUTTON_SIZE) / 2),
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** The rect an anchor paints to, given a viewport. */
export function feedbackAnchorRect(
  anchor: FeedbackAnchor,
  viewport: FeedbackViewport,
  size: number = FEEDBACK_BUTTON_SIZE,
): FeedbackRect {
  const right = viewport.width - anchor.right;
  const bottom = viewport.height - anchor.bottom;
  return { left: right - size, top: bottom - size, right, bottom };
}

function overlaps(a: FeedbackRect, b: FeedbackRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Pull a stored position back into the window that exists now.
 *
 * Two things it guarantees:
 *
 *   1. **Fully on screen.** A position saved against a 1600px window puts the
 *      button 900px from the right edge; in a 500px window that is 400px past
 *      the left edge and gone. The inset is clamped so the whole 40px square is
 *      inside the viewport, at either extreme.
 *   2. **Not under the dock.** The dock is a fixed band at the bottom centre and
 *      it paints ABOVE nothing — the launcher would simply sit on top of it and
 *      cover somebody's open panels. A position landing in that band is lifted
 *      clear of it rather than nudged sideways, because sideways has two answers
 *      and up has one.
 *
 * A zero-sized viewport (before the first measure) is left alone: clamping into
 * nothing would move every stored position to the corner and then persist it.
 */
export function clampFeedbackAnchor(
  anchor: FeedbackAnchor,
  viewport: FeedbackViewport,
  size: number = FEEDBACK_BUTTON_SIZE,
): FeedbackAnchor {
  if (!(viewport.width > 0) || !(viewport.height > 0)) return anchor;

  const right = clamp(anchor.right, 0, Math.max(0, viewport.width - size));
  let bottom = clamp(anchor.bottom, 0, Math.max(0, viewport.height - size));

  const dockTop = viewport.height - (WORKSPACE_DOCK_BOTTOM_OFFSET + WORKSPACE_DOCK_HEIGHT);
  const dockBand: FeedbackRect = {
    left: FEEDBACK_DOCK_SIDE_CLEARANCE,
    top: dockTop,
    right: viewport.width - FEEDBACK_DOCK_SIDE_CLEARANCE,
    bottom: viewport.height,
  };
  // A viewport too narrow to have a centre band has no dock to avoid.
  if (dockBand.right > dockBand.left && overlaps(feedbackAnchorRect({ right, bottom }, viewport, size), dockBand)) {
    bottom = clamp(
      WORKSPACE_DOCK_BOTTOM_OFFSET + WORKSPACE_DOCK_HEIGHT + FEEDBACK_EDGE_GAP,
      0,
      Math.max(0, viewport.height - size),
    );
  }

  return { right, bottom };
}

/** A transient slide, px. Never stored — the button's home does not move. */
export interface FeedbackDodge {
  dx: number;
  dy: number;
}

export const NO_FEEDBACK_DODGE: FeedbackDodge = { dx: 0, dy: 0 };

/**
 * How far to slide so `obstruction` becomes clickable.
 *
 * UP first: the things this covers in practice are message action bars, and the
 * dock lives below, so downward is the one direction guaranteed to trade one
 * collision for another. LEFT is the fallback for an obstruction with no room
 * above it. If neither fits, the answer is "do not move" — a launcher parked
 * somewhere absurd is worse than one that occasionally overlaps, and the user
 * can always drag it.
 *
 * The travel clears the obstruction's edge by `gap`, so the control underneath
 * is fully exposed rather than half-uncovered.
 */
export function resolveFeedbackDodge(
  button: FeedbackRect,
  obstruction: FeedbackRect,
  gap: number = FEEDBACK_EDGE_GAP,
): FeedbackDodge {
  if (!overlaps(button, obstruction)) return NO_FEEDBACK_DODGE;

  const up = obstruction.top - gap - button.bottom;
  if (up < 0 && button.top + up >= 0) return { dx: 0, dy: up };

  const left = obstruction.left - gap - button.right;
  if (left < 0 && button.left + left >= 0) return { dx: left, dy: 0 };

  return NO_FEEDBACK_DODGE;
}

/** Grow a rect by `margin` on every side. */
export function expandRect(rect: FeedbackRect, margin: number): FeedbackRect {
  return {
    left: rect.left - margin,
    top: rect.top - margin,
    right: rect.right + margin,
    bottom: rect.bottom + margin,
  };
}

/**
 * Is the pointer still in the neighbourhood of a dodged button?
 *
 * The union of where it WAS and where it slid to, plus a margin. A dodge is
 * released when the pointer leaves that region — not on the button's own
 * `pointerleave`, which fires the instant the button slides out from under the
 * pointer and would put it straight back, forever.
 */
export function isPointerNearFeedback(
  point: { x: number; y: number },
  home: FeedbackRect,
  dodged: FeedbackRect,
  margin: number,
): boolean {
  const union = expandRect({
    left: Math.min(home.left, dodged.left),
    top: Math.min(home.top, dodged.top),
    right: Math.max(home.right, dodged.right),
    bottom: Math.max(home.bottom, dodged.bottom),
  }, margin);
  return point.x >= union.left && point.x <= union.right && point.y >= union.top && point.y <= union.bottom;
}

/**
 * Storage codec for the anchor.
 *
 * Anything that is not a pair of finite numbers reads back as `null`, which
 * `readPreference` turns into the default — so a hand-edited or half-written key
 * cannot strand the launcher off-screen before the clamp ever sees it.
 */
export const feedbackAnchorPreference: PreferenceCodec<FeedbackAnchor> = {
  parse: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { right, bottom } = parsed as { right?: unknown; bottom?: unknown };
    if (typeof right !== 'number' || typeof bottom !== 'number') return null;
    if (!Number.isFinite(right) || !Number.isFinite(bottom)) return null;
    return { right, bottom };
  },
  serialize: value => JSON.stringify({ right: Math.round(value.right), bottom: Math.round(value.bottom) }),
};
