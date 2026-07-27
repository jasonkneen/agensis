import { useCallback, useEffect, useRef, useState } from 'react';
import { readPreference, writePreference, type PreferenceCodec } from '../lib/viewPreferences';

/**
 * `useState` for a filter or view toggle that has to still be there tomorrow.
 *
 * Drop-in for `useState`: same `[value, setValue]` tuple, same functional
 * updater. What it adds is that the value is READ BACK FROM STORAGE DURING THE
 * FIRST RENDER, not in an effect afterwards — a window that paints the default
 * and then corrects itself is a visible content jump, and on the Tasks window
 * it would flash every done task on screen before hiding them again.
 *
 * `key` comes from `viewPreferenceKey(name, workspaceId)` and is null while
 * there is no workspace, which simply means "in memory only".
 *
 * Two ordering hazards this exists to get right once:
 *
 *   - When the key changes under a mounted component (workspace switch, or the
 *     workspace id arriving after boot) the value is re-read IN RENDER, so the
 *     other workspace's choice never paints.
 *   - The write is gated on the key being unchanged. Without that, a key change
 *     would first persist the outgoing workspace's value under the incoming
 *     workspace's key. It also means a default that came straight out of
 *     storage is never written back, so changing a default later still reaches
 *     everyone who has not actually chosen anything.
 *
 * `codec` must be a stable reference (a module-level constant), like any hook dep.
 */
export function usePersistedPreference<T>(
  key: string | null,
  codec: PreferenceCodec<T>,
  fallback: T,
): [T, (next: T | ((current: T) => T)) => void] {
  // Key and value move together in ONE state object so they can never disagree
  // about which workspace the value belongs to.
  const [state, setState] = useState<{ key: string | null; value: T }>(
    () => ({ key, value: readPreference(key, codec, fallback) }),
  );

  const written = useRef(state);

  useEffect(() => {
    const previous = written.current;
    written.current = state;
    // Same key, different value => the user changed something. Anything else is
    // hydration or a workspace switch, and must not write.
    if (previous.key === state.key && !Object.is(previous.value, state.value)) {
      writePreference(state.key, codec, state.value);
    }
  }, [state, codec]);

  const setValue = useCallback((next: T | ((current: T) => T)) => {
    setState(current => ({
      key: current.key,
      value: typeof next === 'function' ? (next as (current: T) => T)(current.value) : next,
    }));
  }, []);

  // Render-phase re-read on a key change. React's supported "derived from
  // props" pattern: it re-renders this component immediately, before anything
  // is committed, so the previous workspace's value never reaches the screen.
  let live = state;
  if (live.key !== key) {
    live = { key, value: readPreference(key, codec, fallback) };
    setState(live);
  }

  return [live.value, setValue];
}
