import { backendClient } from './backendClient';
import type { DbChangePayload } from '../types/realtime';

// ---------------------------------------------------------------------------
// Centralized table-realtime manager (H2 + M8)
//
// `backendClient` already owns the WebSocket transport: a single socket shared
// by every `LocalChannel`. This layer sits ABOVE that. It owns a map keyed by
// the *subscription descriptor* (schema + table + event + filter, scoped by the
// channel name a hook would have used) -> Set<Listener>, and opens exactly ONE
// underlying `LocalChannel` per descriptor. Every db change for that descriptor
// is fanned out to all listeners. It reference-counts: the last listener to
// leave tears the underlying channel down.
//
// Net effect: N components using the same hook for the same scope share one
// channel + one subscribe frame instead of N. Per-change delivery semantics are
// unchanged because `LocalChannel.handleMessage` already matches db_changes by
// table/schema/event/filter (not by channel name).
// ---------------------------------------------------------------------------

export interface TableSubscriptionConfig {
  /** Table to subscribe to, e.g. 'documents'. */
  table: string;
  /** Event to listen for. Defaults to '*'. Must match today's per-hook value. */
  event?: string;
  /** Postgres schema. Defaults to 'public'. */
  schema?: string;
  /** Row filter, e.g. 'workspace_id=eq.<id>'. */
  filter?: string;
  /**
   * Wire channel name. Preserve the exact name each hook used today (e.g.
   * `documents:<workspaceId>`) so the subscribe/unsubscribe frames sent to the
   * server are byte-for-byte identical. Defaults to a derived name.
   */
  channelName?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPayload = DbChangePayload<any>;
type Listener = (payload: AnyPayload) => void;
type LocalChannelHandle = ReturnType<typeof backendClient.channel>;

interface ChannelEntry {
  channel: LocalChannelHandle;
  listeners: Set<Listener>;
}

function descriptorKey(config: TableSubscriptionConfig): string {
  const schema = config.schema ?? 'public';
  const event = config.event ?? '*';
  const filter = config.filter ?? '';
  const name = config.channelName ?? `realtime:${schema}.${config.table}`;
  // Channel name is part of the key so two scopes that differ only by filter
  // (and therefore by name today) never collapse into one entry.
  return [name, schema, config.table, event, filter].join('|');
}

class TableRealtimeManager {
  private entries = new Map<string, ChannelEntry>();

  /**
   * Subscribe `listener` to db changes matching `config`. Returns an idempotent
   * unsubscribe function. The underlying `LocalChannel` is created on the first
   * listener for a descriptor and torn down when the last one leaves.
   */
  subscribe(config: TableSubscriptionConfig, listener: Listener): () => void {
    const key = descriptorKey(config);
    let entry = this.entries.get(key);

    if (!entry) {
      const channelName = config.channelName ?? `realtime:${config.schema ?? 'public'}.${config.table}`;
      const listeners = new Set<Listener>();
      const channel = backendClient
        .channel(channelName)
        .on(
          'db_changes',
          {
            event: config.event ?? '*',
            schema: config.schema ?? 'public',
            table: config.table,
            ...(config.filter ? { filter: config.filter } : {}),
          },
          (payload: AnyPayload) => {
            // Snapshot so a listener unsubscribing mid-fanout can't mutate the
            // set we're iterating.
            for (const fn of Array.from(listeners)) fn(payload);
          },
        )
        .subscribe();
      entry = { channel, listeners };
      this.entries.set(key, entry);
    }

    entry.listeners.add(listener);

    let active = true;
    return () => {
      if (!active) return; // balance StrictMode double-invoke / double-cleanup
      active = false;
      const current = this.entries.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        this.entries.delete(key);
        current.channel.unsubscribe();
      }
    };
  }
}

export const tableRealtimeManager = new TableRealtimeManager();

// ---------------------------------------------------------------------------
// Deduper
//
// An optimistic update + the server ack + the realtime broadcast for the SAME
// row should not be applied 3x. The optimistic + ack paths are direct setState
// calls in the mutation functions and are already id-guarded (idempotent). This
// deduper additionally drops *repeat realtime deliveries* of an already-applied
// `(id, version)` — using `version`, or `updated_at` when `version` is absent,
// as the freshness key. It is conservative: when neither key is present it
// always processes (so behavior matches today's "apply every event"), and it
// always processes DELETEs (evicting the id so a later re-insert isn't dropped).
// ---------------------------------------------------------------------------

export interface RealtimeDeduper {
  /** Returns false if this event is a repeat of an already-applied (id,version). */
  shouldProcess(payload: AnyPayload): boolean;
  reset(): void;
}

export function createDeduper(maxEntries = 500): RealtimeDeduper {
  // id -> last-applied freshness key. Map preserves insertion order, used as a
  // crude LRU bound.
  const seen = new Map<string, string>();

  return {
    shouldProcess(payload: AnyPayload): boolean {
      const eventType = payload?.eventType;
      const row = (payload?.new ?? payload?.old) as Record<string, unknown> | undefined;
      const rawId = row?.id;
      if (rawId == null) return true; // no id -> can't dedupe, process
      const id = String(rawId);

      if (eventType === 'DELETE') {
        seen.delete(id);
        return true;
      }

      const freshness = row?.version ?? row?.updated_at;
      if (freshness == null) return true; // no freshness key -> process

      const fk = String(freshness);
      if (seen.get(id) === fk) return false; // already applied this version

      // Refresh LRU position and apply the cap.
      seen.delete(id);
      seen.set(id, fk);
      if (seen.size > maxEntries) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
    reset() {
      seen.clear();
    },
  };
}
