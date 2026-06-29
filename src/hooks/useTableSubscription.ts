import { useEffect, useRef } from 'react';
import {
  tableRealtimeManager,
  createDeduper,
  type TableSubscriptionConfig,
  type RealtimeDeduper,
} from '../lib/realtimeManager';
import type { DbChangePayload } from '../types/realtime';

export type { TableSubscriptionConfig } from '../lib/realtimeManager';

export interface UseTableSubscriptionOptions extends TableSubscriptionConfig {
  /** When false, the hook does not subscribe (mirrors `if (!x) return` guards). */
  enabled?: boolean;
}

/**
 * Subscribe a component/hook to a table's db changes via the shared
 * `tableRealtimeManager`. Auto-unsubscribes on unmount.
 *
 * The `callback` is held in a ref so it never appears in the effect deps: the
 * subscription re-runs ONLY when the scope (channelName/table/event/schema/
 * filter/enabled) changes — exactly the cadence each migrated hook had with its
 * raw `[workspaceId]` / `[sessionId]` effect. This keeps subscribe/unsubscribe
 * balanced (and StrictMode-safe) instead of churning on every render.
 */
export function useTableSubscription<T = unknown>(
  options: UseTableSubscriptionOptions,
  callback: (payload: DbChangePayload<T>) => void,
): void {
  const { enabled = true, channelName, table, event, schema, filter } = options;

  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = tableRealtimeManager.subscribe(
      { channelName, table, event, schema, filter },
      (payload) => cbRef.current(payload as DbChangePayload<T>),
    );
    return unsubscribe;
    // Only re-subscribe when the scope changes (all primitives), never on a new
    // callback identity.
  }, [enabled, channelName, table, event, schema, filter]);
}

/**
 * Returns a stable per-mount {@link RealtimeDeduper}. Each hook instance gets its
 * own deduper so two components sharing one underlying channel each apply every
 * change once to their own state (sharing a deduper would starve the second).
 */
export function useRealtimeDeduper(): RealtimeDeduper {
  const ref = useRef<RealtimeDeduper | null>(null);
  if (ref.current === null) ref.current = createDeduper();
  return ref.current;
}
