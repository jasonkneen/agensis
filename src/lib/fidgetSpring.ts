// ---------------------------------------------------------------------------
// Fidget physics: pull a thing, feel it resist, let go, watch it settle.
//
// Two separate behaviours, deliberately kept apart:
//
//   rubberBand — WHILE dragging. The card does not track the pointer 1:1; the
//     further you pull, the less it moves, asymptotically approaching a limit.
//     That resistance is the whole feel: 1:1 tracking reads as "I am moving a
//     window", damped tracking reads as "this is attached to something".
//
//   stepSpring — AFTER release. A damped spring pulls the offset back to zero,
//     carrying the release velocity in, so a flick overshoots and swings back
//     while a slow drag just eases home. Underdamped on purpose: critical
//     damping is correct for UI that must not distract, and wrong for a toy.
//
// Both are pure functions over plain numbers — no DOM, no React, no time
// source. The caller owns the clock, which is what makes the settle behaviour
// testable at all: a test steps 500 frames in a microsecond and asserts the
// thing actually comes to rest rather than jittering forever.
// ---------------------------------------------------------------------------

/** Spring constants. Tuned by feel, exposed so a test can prove the extremes. */
export interface SpringConfig {
  /** Pull toward home. Higher = snappier return. */
  stiffness: number;
  /** Velocity bleed. Lower = more overshoot and wobble. */
  damping: number;
}

export const FIDGET_SPRING: SpringConfig = { stiffness: 260, damping: 17 };

/** Past this, the offset is visually home and the animation can stop. */
const REST_OFFSET_PX = 0.08;
const REST_VELOCITY_PX_S = 0.6;

/**
 * How far the card actually moves when the pointer has moved `delta` px.
 *
 * Asymptotic: the result approaches `limit` but never reaches it, however hard
 * you pull. Sign-preserving, so pulling left resists exactly like right.
 *
 * `limit` is the practical ceiling in px — around a third of a card is enough
 * to feel elastic without the card colliding with its neighbours.
 */
export function rubberBand(delta: number, limit: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const magnitude = Math.abs(delta);
  // Classic asymptotic ease: at delta == limit the output is ~half of limit,
  // and it flattens from there. The 0.55 constant sets how quickly resistance
  // arrives — lower feels heavier, higher feels looser.
  const pulled = (1 - 1 / (magnitude * 0.55 / limit + 1)) * limit;
  return delta < 0 ? -pulled : pulled;
}

export interface SpringState {
  /** Offset from home, px. */
  x: number;
  /** Velocity, px/second. */
  v: number;
}

/**
 * Advance one axis by `dt` seconds. Semi-implicit Euler: cheap, stable at the
 * frame rates a browser actually delivers, and it cannot blow up the way
 * explicit Euler does when a tab is backgrounded and dt arrives huge — the
 * caller is still expected to clamp dt (see MAX_FRAME_SECONDS).
 */
export function stepSpring(state: SpringState, dt: number, config: SpringConfig = FIDGET_SPRING): SpringState {
  if (!Number.isFinite(dt) || dt <= 0) return state;
  const acceleration = -config.stiffness * state.x - config.damping * state.v;
  const v = state.v + acceleration * dt;
  return { x: state.x + v * dt, v };
}

/** Home, and slow enough that another frame would not be visible. */
export function isSpringAtRest(state: SpringState): boolean {
  return Math.abs(state.x) < REST_OFFSET_PX && Math.abs(state.v) < REST_VELOCITY_PX_S;
}

/**
 * A backgrounded tab hands back one enormous dt on return. Integrating it in
 * one step would fling the card across the screen, so long gaps are treated as
 * a single slow frame instead.
 */
export const MAX_FRAME_SECONDS = 1 / 30;

/**
 * Release velocity from the last few pointer samples, px/second.
 *
 * Averaged over a short window rather than taken from the final pair: the last
 * two samples before release are often 1-2px apart in a millisecond, which
 * divides out to an absurd velocity and launches the card. Samples older than
 * `windowMs` are ignored so a pause mid-drag ends with a velocity near zero,
 * which is what a pause should mean.
 */
export function releaseVelocity(
  samples: readonly { t: number; x: number; y: number }[],
  windowMs = 90,
): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const elapsed = (last.t - first.t) / 1000;
  if (elapsed <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.x - first.x) / elapsed, vy: (last.y - first.y) / elapsed };
}

/**
 * Pointer movement below this is a click, not a drag.
 *
 * Without it, the 1-2px a mouse travels during an ordinary click would start a
 * drag and swallow the click — every card would need pixel-perfect stillness
 * to open. Above it the click is suppressed, because a fidget is not a select.
 */
export const DRAG_THRESHOLD_PX = 4;
