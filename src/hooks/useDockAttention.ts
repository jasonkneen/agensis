import { useEffect, useRef, useState } from 'react';

// macOS-style dock attention: fire a finite, one-shot bounce for a dock entry
// the moment its "busy" signal flips false → true, and never while it merely
// stays busy. Binding an animation to the standing busy state would bounce a
// long-running agent forever; we bounce on the *transition* only and clear each
// bounce after `durationMs` so it plays once.
//
// `busyById` is recomputed by the caller each render — we compare against the
// previous snapshot held in a ref, so a new Map identity per render is fine and
// never causes a spurious bounce. The first snapshot seeds silently, so already
// busy agents don't bounce on mount or when switching canvas layers.
export function useDockAttention(busyById: Map<string, boolean>, durationMs = 1300): Set<string> {
  const prevRef = useRef<Map<string, boolean> | null>(null);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [bouncing, setBouncing] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = new Map(busyById);

    // First render seeds the baseline without bouncing anything.
    if (prev === null) return;

    const newlyBusy: string[] = [];
    busyById.forEach((isBusy, id) => {
      if (isBusy && !prev.get(id)) newlyBusy.push(id);
    });
    if (newlyBusy.length === 0) return;

    setBouncing(current => {
      const next = new Set(current);
      for (const id of newlyBusy) next.add(id);
      return next;
    });

    for (const id of newlyBusy) {
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        setBouncing(current => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        timersRef.current.delete(id);
      }, durationMs);
      timersRef.current.set(id, timer);
    }
  }, [busyById, durationMs]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  return bouncing;
}
