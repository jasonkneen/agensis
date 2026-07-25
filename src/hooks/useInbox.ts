import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { groupInboxItems, type InboxGroup } from '../components/inbox/inboxModel';
import type { InboxFilter, InboxItem, ThreadItem } from '../types';

const INBOX_LIMIT = 50;

interface InboxPayload {
  items: InboxItem[];
  unreadCount: number;
}

export interface UseInboxResult {
  items: InboxItem[];
  /** Items collapsed per contextKey, blockers first. Stable keys — see inboxModel. */
  groups: InboxGroup[];
  unreadCount: number;
  loading: boolean;
  markRead: (contextKey: string) => Promise<void>;
  refetch: () => void;
}

/**
 * The triage inbox. Aggregation only — every category reads data another part
 * of the app already writes (thread_items, the comment tables, activity_events,
 * agent_jobs), so this hook has exactly one bespoke route to call.
 *
 * Read state is a per-user, per-context marker advanced MONOTONICALLY, so it
 * syncs across devices and never un-reads something.
 */
export function useInbox(workspaceId: string | null, filter: InboxFilter = 'all'): UseInboxResult {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchInbox = useCallback(async () => {
    if (!workspaceId) {
      setItems([]);
      setUnreadCount(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<InboxPayload>(`inbox_${workspaceId}_${filter}`, async () => {
      const path = `/backend/workspaces/${encodeURIComponent(workspaceId)}/inbox`
        + `?filter=${encodeURIComponent(filter)}&limit=${INBOX_LIMIT}`;
      const response = await fetch(apiUrl(path), { headers: apiAuthHeaders() });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || `Inbox HTTP ${response.status}`);
      const result = payload?.data ?? null;
      return {
        items: Array.isArray(result?.items) ? result.items : [],
        unreadCount: typeof result?.unreadCount === 'number' ? result.unreadCount : 0,
      };
    });
    if (data) {
      setItems(data.items);
      setUnreadCount(data.unreadCount);
    }
    setLoading(false);
  }, [workspaceId, filter]);

  useEffect(() => {
    fetchInbox();
  }, [fetchInbox]);

  // Blockers are the category the inbox exists for, and they arrive while the
  // user is reading — so this one table is watched live. Everything else is
  // pulled on open/refresh; the inbox is a triage surface, not a firehose.
  const deduper = useRealtimeDeduper();
  useTableSubscription<ThreadItem>(
    {
      enabled: !!workspaceId,
      channelName: `inbox_thread_items:${workspaceId}`,
      table: 'thread_items',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      const row = payload.new ?? payload.old;
      if (row?.kind !== 'blocker') return;
      fetchInbox();
    },
  );

  // Markers only move forward: remember the newest readAt sent per context so a
  // re-select of an older item can never walk a marker backwards.
  const sentMarkers = useRef<Map<string, number>>(new Map());

  const markRead = useCallback(async (contextKey: string) => {
    if (!workspaceId || !contextKey) return;

    let readAt = 0;
    for (const item of items) {
      if (item.contextKey !== contextKey) continue;
      const at = Date.parse(item.createdAt);
      if (Number.isFinite(at) && at > readAt) readAt = at;
    }
    if (!readAt) return;

    // Optimistic: the row goes read the moment it is opened, before the network.
    let flipped = 0;
    setItems(prev => prev.map(item => {
      if (item.contextKey !== contextKey || !item.unread) return item;
      if (Date.parse(item.createdAt) > readAt) return item;
      flipped += 1;
      return { ...item, unread: false };
    }));
    setUnreadCount(prev => Math.max(0, prev - flipped));

    // Re-opening the same group with nothing newer in it would only re-send a
    // marker the server already holds — skip the POST, keep the local flip.
    const previous = sentMarkers.current.get(contextKey) ?? 0;
    if (readAt <= previous) return;
    sentMarkers.current.set(contextKey, readAt);

    try {
      const response = await fetch(apiUrl('/backend/inbox/read'), {
        method: 'POST',
        headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, contextKey, readAt: new Date(readAt).toISOString() }),
      });
      if (!response.ok) throw new Error(`Inbox read HTTP ${response.status}`);
    } catch (error) {
      // Read state is low stakes and the marker is monotonic server-side, so a
      // dropped POST self-heals on the next open. Never bounce the row back to
      // unread under the user's cursor.
      console.warn('inbox: read marker not persisted', error);
    }
  }, [workspaceId, items]);

  const groups = useMemo(() => groupInboxItems(items), [items]);

  return { items, groups, unreadCount, loading, markRead, refetch: fetchInbox };
}
