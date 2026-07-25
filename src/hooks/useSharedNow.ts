import { useSyncExternalStore } from 'react';
import { readSharedNow, subscribeToSharedClock } from '../lib/sharedClock';

/**
 * Re-render this component once a minute off the single shared clock (see
 * `src/lib/sharedClock.ts`), so relative-time labels keep counting up.
 *
 * Call it from the smallest component that renders the label — the tick
 * re-renders every subscriber, so subscribing high in the tree re-renders the
 * whole subtree once a minute.
 */
export function useSharedNow(): number {
  return useSyncExternalStore(subscribeToSharedClock, readSharedNow, readSharedNow);
}
