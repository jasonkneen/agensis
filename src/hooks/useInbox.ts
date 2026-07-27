import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import {
  applyReadPlan,
  groupInboxItems,
  planReadMarker,
  revertReadPlan,
  type InboxGroup,
} from '../components/inbox/inboxModel';
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
  /**
   * Advance this context's read marker. Resolves TRUE only when the marker is
   * durable — the server accepted it, or already holds one at least as new.
   * Resolves false on a rejected/failed write, having put the rows back to
   * unread, so no caller can report success over a read that will come back on
   * the next reload.
   */
  markRead: (contextKey: string) => Promise<boolean>;
  /**
   * Close a blocker. 'answered' writes `response` back for the agent to read;
   * 'dismissed' retires one that stopped mattering. Resolves false on failure so
   * the caller can keep the row rather than lying about it.
   */
  resolveBlocker: (entityId: string, status: 'answered' | 'dismissed', response?: string) => Promise<boolean>;
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
  // re-select of an older item can never walk a marker backwards. Cleared for a
  // context whose write failed, so the retry actually goes out.
  const sentMarkers = useRef<Map<string, number>>(new Map());

  const markRead = useCallback(async (contextKey: string): Promise<boolean> => {
    if (!workspaceId || !contextKey) return false;

    // All of the "which items, which marker, is this newer than what we sent"
    // reasoning is pure and lives in inboxModel — including the millisecond
    // resolution the marker is compared at, which is the whole reason read
    // state survives a reload. See the note above isUnreadAt.
    const plan = planReadMarker(items, contextKey, sentMarkers.current.get(contextKey) ?? null);
    if (!plan) return false;

    // Optimistic: the row goes read the moment it is opened, before the network.
    // The badge moves by exactly what the list moved by — same plan, same
    // number — so the two cannot drift apart between refetches. (The server's
    // count legitimately runs ahead of the visible rows: it counts the whole
    // candidate window, the list is capped at INBOX_LIMIT.)
    if (plan.flippedIds.length > 0) {
      setItems(prev => applyReadPlan(prev, plan));
      setUnreadCount(prev => Math.max(0, prev - plan.flippedIds.length));
    }

    // Re-opening the same group with nothing newer in it would only re-send a
    // marker the server already holds — skip the POST, keep the local flip.
    if (!plan.needsSend) return true;
    sentMarkers.current.set(contextKey, plan.readAtMs);

    try {
      const response = await fetch(apiUrl('/backend/inbox/read'), {
        method: 'POST',
        headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, contextKey, readAt: plan.readAtIso }),
      });
      if (!response.ok) throw new Error(`Inbox read HTTP ${response.status}`);
      return true;
    } catch (error) {
      // The row was marked read on screen and the server never agreed. Leaving
      // it that way is precisely the bug this feature had: the user reloads and
      // it is unread again, with nothing having warned them. Put it back and
      // report the failure, so the caller can say so.
      console.warn('inbox: read marker not persisted', error);
      sentMarkers.current.delete(contextKey);
      if (plan.flippedIds.length > 0) {
        setItems(prev => revertReadPlan(prev, plan));
        setUnreadCount(prev => prev + plan.flippedIds.length);
      }
      return false;
    }
  }, [workspaceId, items]);

  // Close a blocker off. 'answered' carries a human reply the agent reads back
  // (MCP list_thread_items tells agents to check status + response, so resolving
  // with a comment is what actually wakes the agent up); 'dismissed' just retires
  // one that stopped mattering. The inbox query already excludes dismissed rows,
  // and answered ones drop out too, so either way the item leaves the list.
  const resolveBlocker = useCallback(async (
    entityId: string,
    status: 'answered' | 'dismissed',
    response = '',
  ) => {
    if (!entityId) return false;
    const values: Record<string, unknown> = { status };
    if (response.trim()) values.response = response.trim();

    const { error } = await backendClient
      .from('thread_items')
      .update(values)
      .eq('id', entityId);
    if (error) {
      console.warn('inbox: blocker not resolved', error);
      return false;
    }

    // Drop it locally rather than refetching, so the list does not reshuffle
    // under the cursor while the user is still reading.
    setItems(prev => prev.filter(item => item.entityId !== entityId));
    return true;
  }, []);

  const groups = useMemo(() => groupInboxItems(items), [items]);

  return { items, groups, unreadCount, loading, markRead, resolveBlocker, refetch: fetchInbox };
}
