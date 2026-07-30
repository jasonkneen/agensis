import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { usePermissionRequests } from './usePermissionRequests';
import { useThreadInbox } from './useThreadInbox';
import {
  applyReadPlan,
  groupInboxItems,
  planReadMarker,
  revertReadPlan,
  type InboxGroup,
} from '../components/inbox/inboxModel';
import {
  approvalInboxItems,
  isApprovalContextKey,
  isThreadContextKey,
  mergeInboxItems,
  threadInboxItems,
  threadParentIdFromKey,
  unreadItemCount,
} from '../components/inbox/inboxSources';
import type {
  InboxFilter, InboxItem, PermissionRequest, PermissionScope, ThreadItem, WorkspaceAgent,
} from '../types';

const INBOX_LIMIT = 50;

const NO_AGENTS: WorkspaceAgent[] = [];

interface InboxPayload {
  items: InboxItem[];
  unreadCount: number;
}

export interface UseInboxResult {
  /** Every feed merged: the server's inbox, pending approvals, followed threads. */
  items: InboxItem[];
  /** Items collapsed per contextKey, approvals then blockers first. See inboxModel. */
  groups: InboxGroup[];
  unreadCount: number;
  loading: boolean;
  /** Pending approvals by their inbox contextKey, so a row can offer the buttons. */
  approvalsByKey: ReadonlyMap<string, PermissionRequest>;
  /** True while a decision is in flight, so the buttons can go quiet. */
  decidingApproval: boolean;
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
  /**
   * Answer a parked tool call. Goes through the dedicated route (never a table
   * write) because the server has to push the answer down the socket the daemon
   * is holding open, and refuses the whole decision if that push fails.
   * Resolves an error string, '' on success.
   */
  decideApproval: (requestId: string, behavior: 'allow' | 'deny', scope?: PermissionScope) => Promise<string>;
  refetch: () => void;
}

/**
 * The triage inbox. Aggregation only — every category reads data another part
 * of the app already writes (thread_items, the comment tables, activity_events,
 * agent_jobs), so this hook has exactly one bespoke route to call.
 *
 * ...and then two more feeds merged on top of it, because two of the things
 * most obviously "addressed to you" are not in that query and never could be:
 *
 *   APPROVALS  a daemon's parked tool call (agent_permission_requests). Its
 *              turn is stopped, and it expires in ten minutes. Until this, the
 *              only place it appeared was the one transcript it was raised in,
 *              so an approval raised while you were reading anything else timed
 *              out unseen.
 *   THREADS    replies under message threads you follow (the /threads route,
 *              which already owns the follow rule: a thread is yours when a
 *              HUMAN took a turn in it).
 *
 * Both already had a route, a realtime subscription and a read model. Nothing
 * new is written here — components/inbox/inboxSources reshapes them into
 * `InboxItem` so grouping, ordering, read state and the row renderer treat them
 * like everything else.
 *
 * Read state is a per-user, per-context marker advanced MONOTONICALLY, so it
 * syncs across devices and never un-reads something.
 */
export function useInbox(
  workspaceId: string | null,
  filter: InboxFilter = 'all',
  /** Only used to name the agent that raised an approval; the row degrades to
   *  "An agent" without it, and nothing else changes. */
  agents: readonly WorkspaceAgent[] = NO_AGENTS,
): UseInboxResult {
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

  // --- The two feeds the inbox query cannot see --------------------------
  //
  // Both hooks own their own loading and their own realtime. Approvals in
  // particular are live over `agent_permission_requests`, which is what makes
  // the inbox usable for them at all: a request appears the moment a daemon
  // parks a call, and leaves the moment anybody answers it — including from the
  // chat transcript, on another device.
  const {
    requests: permissionRequests,
    decide: decidePermission,
    busyId: decidingId,
    reload: reloadPermissions,
  } = usePermissionRequests(workspaceId);
  const {
    items: threadUpdates,
    markThreadRead,
    refetch: refetchThreads,
  } = useThreadInbox(workspaceId);

  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      const name = String(agent.name || agent.handle || '').trim();
      if (agent.id && name) map.set(String(agent.id), name);
    }
    return map;
  }, [agents]);

  // Sampled ONCE per change of the requests themselves, never on a timer. The
  // only clock-dependent decision here is "has this expired", and this surface
  // has a standing rule against anything that re-renders on an interval.
  const approvalItems = useMemo(
    () => approvalInboxItems(permissionRequests, Date.now(), agentNames),
    [permissionRequests, agentNames],
  );
  const threadItems = useMemo(() => threadInboxItems(threadUpdates), [threadUpdates]);

  // Server items first — see mergeInboxItems for why the order matters.
  const allItems = useMemo(
    () => mergeInboxItems(items, approvalItems, threadItems),
    [items, approvalItems, threadItems],
  );

  const approvalsByKey = useMemo(() => {
    const map = new Map<string, PermissionRequest>();
    for (const request of permissionRequests) map.set(`approval:${request.id}`, request);
    return map;
  }, [permissionRequests]);

  // Markers only move forward: remember the newest readAt sent per context so a
  // re-select of an older item can never walk a marker backwards. Cleared for a
  // context whose write failed, so the retry actually goes out.
  const sentMarkers = useRef<Map<string, number>>(new Map());

  const markRead = useCallback(async (contextKey: string): Promise<boolean> => {
    if (!workspaceId || !contextKey) return false;

    // A pending approval has no read state, deliberately. The agent is still
    // stopped whether or not you have looked at the row, so letting it go quiet
    // would drop it out of the Unread filter while the turn it holds stays
    // parked. It leaves this list by being ANSWERED. Reported as success
    // because nothing failed — there was simply nothing to mark.
    if (isApprovalContextKey(contextKey)) return true;

    // Threads keep their own marker under the same `msgthread:` key the sidebar
    // writes, through the same /backend/inbox/read route. One read model, two
    // surfaces — a second one would eventually disagree with this one about
    // what "read" means.
    if (isThreadContextKey(contextKey)) {
      return markThreadRead(threadParentIdFromKey(contextKey));
    }

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
  }, [workspaceId, items, markThreadRead]);

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

  /**
   * Answer a parked tool call from the inbox.
   *
   * The row does not need removing by hand: the route returns the settled
   * request, usePermissionRequests replaces its copy, and approvalInboxItems
   * drops anything that is no longer pending. One source of truth for "is this
   * still open", so the inbox and the transcript card cannot disagree.
   */
  const decideApproval = useCallback(async (
    requestId: string,
    behavior: 'allow' | 'deny',
    scope: PermissionScope = 'once',
  ): Promise<string> => {
    const { error } = await decidePermission(requestId, behavior, scope);
    return error;
  }, [decidePermission]);

  const groups = useMemo(() => groupInboxItems(allItems), [allItems]);

  // The badge counts the merged set, not just the server's slice — a pending
  // approval nobody has answered is the single most important thing this number
  // can be telling you about, and it is not in the server's count at all.
  const mergedUnreadCount = useMemo(
    () => unreadCount + unreadItemCount(approvalItems) + unreadItemCount(threadItems),
    [unreadCount, approvalItems, threadItems],
  );

  const refetch = useCallback(() => {
    void fetchInbox();
    void reloadPermissions();
    refetchThreads();
  }, [fetchInbox, reloadPermissions, refetchThreads]);

  return {
    items: allItems,
    groups,
    unreadCount: mergedUnreadCount,
    loading,
    approvalsByKey,
    decidingApproval: decidingId !== '',
    markRead,
    resolveBlocker,
    decideApproval,
    refetch,
  };
}
