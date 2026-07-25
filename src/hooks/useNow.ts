import { useEffect, useState } from 'react';

/**
 * Re-render THIS component every `intervalMs` so a clock it renders keeps
 * counting. Pass 0 to stop the timer (the value freezes at the last tick).
 *
 * Mount it only at the leaf that actually paints the digits: every tick
 * re-renders whatever component called it, and the whole point of the elapsed
 * badge is that a tick costs one <span>, not a subtree. It is deliberately NOT
 * a shared clock (see src/lib/sharedClock.ts for the once-a-minute shared one):
 * a 1Hz clock shared by every subscriber re-renders them all on the same edge.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!(intervalMs > 0)) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
