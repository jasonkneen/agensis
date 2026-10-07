import { useEffect, useState } from 'react';

/**
 * Seconds since the current agent started working, ticking four times a
 * second. The timer lives here, not in the chat window, so each tick
 * re-renders this one span instead of the whole transcript. `resetKey`
 * restarts the count when the turn changes hands.
 */
export function ElapsedTimer({ resetKey, className }: { resetKey: string; className?: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [resetKey]);

  return <span className={className ?? 'shrink-0 text-xs tabular-nums text-muted-foreground'}>{elapsed}s</span>;
}
