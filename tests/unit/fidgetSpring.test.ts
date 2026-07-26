import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX,
  FIDGET_SPRING,
  MAX_FRAME_SECONDS,
  isSpringAtRest,
  releaseVelocity,
  rubberBand,
  stepSpring,
  type SpringState,
} from '../../src/lib/fidgetSpring';

// The point of extracting this physics is that "it always settles back" is a
// CLAIM, and a claim about an animation is otherwise only checkable by staring
// at it. Here a settle is 500 stepped frames and an assertion.

describe('rubberBand', () => {
  const LIMIT = 46;

  it('does not move when the pointer has not', () => {
    expect(rubberBand(0, LIMIT)).toBe(0);
  });

  it('always resists — the card moves LESS than the pointer did', () => {
    for (const delta of [1, 5, 20, 46, 100, 400, 5000]) {
      expect(rubberBand(delta, LIMIT)).toBeLessThan(delta);
    }
  });

  it('never exceeds the limit however hard you pull', () => {
    // The whole feel depends on this: an unbounded pull is a window drag.
    for (const delta of [100, 1_000, 100_000, 1e9]) {
      expect(rubberBand(delta, LIMIT)).toBeLessThan(LIMIT);
    }
  });

  it('is monotonic — pulling further always moves further', () => {
    let previous = 0;
    for (const delta of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
      const pulled = rubberBand(delta, LIMIT);
      expect(pulled).toBeGreaterThan(previous);
      previous = pulled;
    }
  });

  it('resists left exactly as it resists right', () => {
    for (const delta of [3, 25, 90, 600]) {
      expect(rubberBand(-delta, LIMIT)).toBeCloseTo(-rubberBand(delta, LIMIT), 10);
    }
  });

  it('refuses nonsense instead of emitting NaN into a transform', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(rubberBand(bad, LIMIT)).toBe(0);
      expect(rubberBand(10, bad)).toBe(0);
    }
    expect(rubberBand(10, 0)).toBe(0);
    expect(rubberBand(10, -5)).toBe(0);
  });
});

/** Run the spring to rest, or give up. Returns frames taken, -1 if it never settles. */
function settle(start: SpringState, maxFrames = 600, dt = 1 / 60): number {
  let state = start;
  for (let frame = 1; frame <= maxFrames; frame += 1) {
    state = stepSpring(state, dt, FIDGET_SPRING);
    if (!Number.isFinite(state.x) || !Number.isFinite(state.v)) return -1;
    if (isSpringAtRest(state)) return frame;
  }
  return -1;
}

describe('stepSpring', () => {
  it('ALWAYS settles back home, from a pull or a hard flick', () => {
    // The owner's actual requirement: "they always settle back".
    for (const start of [
      { x: 46, v: 0 },        // pulled to the limit and released still
      { x: -46, v: 0 },
      { x: 0, v: 1200 },      // flicked from rest
      { x: 30, v: -2400 },    // flicked back toward home, hard
      { x: -12, v: 3000 },    // flung across
      { x: 46, v: 6000 },     // absurd, past anything a hand can do
    ]) {
      const frames = settle(start);
      expect(frames, JSON.stringify(start)).toBeGreaterThan(0);
      // Under a second and a half at 60fps: long enough to enjoy, short
      // enough that the card is never "stuck out" when you look back.
      expect(frames, JSON.stringify(start)).toBeLessThan(90);
    }
  });

  it('overshoots on a flick — the inertia is real, not eased', () => {
    // A critically damped spring would never cross zero. Crossing is the wobble.
    let state: SpringState = { x: 40, v: 0 };
    let crossed = false;
    for (let frame = 0; frame < 200; frame += 1) {
      const next = stepSpring(state, 1 / 60, FIDGET_SPRING);
      if (Math.sign(next.x) !== Math.sign(state.x) && next.x !== 0) crossed = true;
      state = next;
    }
    expect(crossed).toBe(true);
  });

  it('moves toward home, never away, on the first frame', () => {
    expect(stepSpring({ x: 40, v: 0 }, 1 / 60).x).toBeLessThan(40);
    expect(stepSpring({ x: -40, v: 0 }, 1 / 60).x).toBeGreaterThan(-40);
  });

  it('a zero or nonsense frame changes nothing', () => {
    const state = { x: 10, v: 5 };
    for (const dt of [0, -1, Number.NaN, Infinity]) {
      expect(stepSpring(state, dt)).toBe(state);
    }
  });

  it('survives the backgrounded-tab frame when dt is clamped', () => {
    // A tab restored after a minute hands back one huge dt. The hook clamps to
    // MAX_FRAME_SECONDS; this proves the clamped value is stable rather than
    // launching the card, which an unclamped 60s step would.
    let state: SpringState = { x: 46, v: 0 };
    for (let i = 0; i < 300; i += 1) state = stepSpring(state, MAX_FRAME_SECONDS, FIDGET_SPRING);
    expect(Number.isFinite(state.x)).toBe(true);
    expect(Math.abs(state.x)).toBeLessThan(1);
  });
});

describe('isSpringAtRest', () => {
  it('is true only when home AND slow', () => {
    expect(isSpringAtRest({ x: 0, v: 0 })).toBe(true);
    expect(isSpringAtRest({ x: 0.01, v: 0.1 })).toBe(true);
    expect(isSpringAtRest({ x: 5, v: 0 })).toBe(false);
    // Passing through home at speed is the MIDDLE of a wobble, not the end.
    expect(isSpringAtRest({ x: 0, v: 400 })).toBe(false);
  });
});

describe('releaseVelocity', () => {
  it('needs two samples to have a velocity at all', () => {
    expect(releaseVelocity([])).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }])).toEqual({ vx: 0, vy: 0 });
  });

  it('measures a steady drag in px per second', () => {
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 50, x: 10, y: -5 },
      { t: 100, x: 20, y: -10 },
    ];
    const { vx, vy } = releaseVelocity(samples);
    expect(vx).toBeCloseTo(200, 5);   // 20px in 100ms
    expect(vy).toBeCloseTo(-100, 5);
  });

  it('a PAUSE before release means a velocity near zero', () => {
    // Holding still then letting go must not fling: samples outside the window
    // are ignored, so the recent (motionless) ones decide.
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 20, x: 40, y: 0 },   // fast, but long ago
      { t: 300, x: 40, y: 0 },
      { t: 340, x: 40, y: 0 },
    ];
    expect(releaseVelocity(samples).vx).toBeCloseTo(0, 5);
  });

  it('averages the window instead of trusting the final pair', () => {
    // Two samples 1px and 1ms apart divide out to 1000px/s and would launch
    // the card; the window smooths that into the real gesture speed.
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 60, x: 6, y: 0 },
      { t: 61, x: 7, y: 0 },
    ];
    expect(releaseVelocity(samples).vx).toBeLessThan(200);
  });

  it('ignores samples that arrive out of order in time', () => {
    expect(releaseVelocity([{ t: 100, x: 0, y: 0 }, { t: 100, x: 9, y: 9 }]))
      .toEqual({ vx: 0, vy: 0 });
  });
});

describe('DRAG_THRESHOLD_PX', () => {
  it('is small enough to feel instant, large enough to survive a click', () => {
    // A mouse travels 1-2px during an ordinary click. Below the threshold the
    // click passes through; at or above it the card is being fidgeted.
    expect(DRAG_THRESHOLD_PX).toBeGreaterThan(2);
    expect(DRAG_THRESHOLD_PX).toBeLessThan(10);
  });
});
