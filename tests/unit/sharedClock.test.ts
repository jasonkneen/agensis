import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MINUTE_TICK_MS,
  readSharedNow,
  sharedClockState,
  subscribeToSharedClock,
} from '../../src/lib/sharedClock';

// The point of this module is that N relative-time labels cost ONE timer, and
// zero labels cost zero timers. These tests pin both.

describe('sharedClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs no timer until something subscribes, and stops on the last unsubscribe', () => {
    expect(sharedClockState()).toEqual({ subscribers: 0, running: false });

    const off = subscribeToSharedClock(() => {});
    expect(sharedClockState()).toEqual({ subscribers: 1, running: true });

    off();
    expect(sharedClockState()).toEqual({ subscribers: 0, running: false });
  });

  it('shares a single interval across many subscribers', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const ticks = [0, 0, 0];
    const offs = ticks.map((_, i) => subscribeToSharedClock(() => { ticks[i] += 1; }));

    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(sharedClockState()).toEqual({ subscribers: 3, running: true });

    vi.advanceTimersByTime(MINUTE_TICK_MS);
    expect(ticks).toEqual([1, 1, 1]);

    // Dropping one subscriber must not stop the clock for the others.
    offs[0]();
    vi.advanceTimersByTime(MINUTE_TICK_MS);
    expect(ticks).toEqual([1, 2, 2]);

    offs.slice(1).forEach(off => off());
    setInterval.mockRestore();
  });

  it('advances the snapshot on each tick but keeps it stable between ticks', () => {
    const off = subscribeToSharedClock(() => {});
    const start = readSharedNow();
    expect(readSharedNow()).toBe(start);

    vi.advanceTimersByTime(MINUTE_TICK_MS);
    expect(readSharedNow()).toBe(start + MINUTE_TICK_MS);
    expect(readSharedNow()).toBe(start + MINUTE_TICK_MS);

    off();
  });

  it('keeps unsubscribing safe while a tick is being dispatched', () => {
    let calls = 0;
    const off = subscribeToSharedClock(() => {
      calls += 1;
      off();
    });

    vi.advanceTimersByTime(MINUTE_TICK_MS);
    expect(calls).toBe(1);
    expect(sharedClockState()).toEqual({ subscribers: 0, running: false });

    vi.advanceTimersByTime(MINUTE_TICK_MS * 5);
    expect(calls).toBe(1);
  });
});
