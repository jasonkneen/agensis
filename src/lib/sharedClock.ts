/**
 * One process-wide clock for relative-time labels ("24 minutes ago").
 *
 * Relative labels computed at render time silently go stale — a row rendered as
 * "1 minute ago" still says that ten minutes later. The naive fix (a setInterval
 * per row) costs one timer per visible message and re-renders the whole timeline.
 * Instead this module owns a SINGLE interval shared by every subscriber, started
 * on the first subscribe and cleared on the last unsubscribe, so a screen with no
 * relative timestamps runs no timer at all.
 *
 * Granularity is one minute because that is the finest step the labels can show;
 * ticking faster would re-render for a value that cannot change. A component that
 * mounts mid-tick therefore reads a value up to `MINUTE_TICK_MS` stale, which at
 * worst shows "just now" for a 70-second-old reply — within the label's own
 * resolution.
 */
export const MINUTE_TICK_MS = 60_000;

const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

/** Current shared "now", stable between ticks so it is a valid store snapshot. */
export function readSharedNow(): number {
  return now;
}

/** Subscribe to the shared tick. Returns an unsubscribe function. */
export function subscribeToSharedClock(onTick: () => void): () => void {
  subscribers.add(onTick);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of [...subscribers]) notify();
    }, MINUTE_TICK_MS);
  }
  return () => {
    subscribers.delete(onTick);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Test-only: number of live subscribers / whether the single timer is running. */
export function sharedClockState(): { subscribers: number; running: boolean } {
  return { subscribers: subscribers.size, running: timer !== null };
}
