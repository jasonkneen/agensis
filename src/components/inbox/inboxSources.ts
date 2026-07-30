import type { InboxItem, PermissionRequest } from '../../types';
import { isPermissionRequestOpen, permissionRequestSummary } from '../chat/permissionRequests';
import { threadRowTitle, type ThreadInboxItem } from '../../lib/threadInbox';

// ---------------------------------------------------------------------------
// The two things waiting on a human that the inbox QUERY cannot see.
//
// server/index.cjs builds the inbox from five tables it owns. Two more sources
// already exist elsewhere in the app, each with its own route, its own realtime
// subscription and its own rules about what counts:
//
//   approvals  agent_permission_requests — a daemon has PARKED a tool call and
//              its turn is stopped until somebody clicks. Ten-minute fuse, then
//              the call is refused. Nothing about this was visible outside the
//              one transcript it happened in, so an approval raised while you
//              were looking anywhere else simply expired.
//
//   threads    the followed-message-thread list (server/thread-inbox.cjs). The
//              follow rule there is already the right one — a thread counts as
//              yours when a HUMAN took a turn in it — which is exactly "relevant
//              updates from threads" and not the agent-to-agent firehose.
//
// This module turns both into `InboxItem`, so everything downstream — grouping,
// ordering, read state, the row renderer, bulk selection — works on them with
// no special cases. That is the whole design: ONE list model, several feeds.
//
// PURE. No React, no fetch, no clock of its own (callers pass `now`), so the
// question "what belongs in the inbox" is a test rather than a claim.
// ---------------------------------------------------------------------------

/**
 * Read-state namespaces.
 *
 * `msgthread:` is NOT a new one — it is the key server/thread-inbox.cjs already
 * writes markers under, so a thread read in the sidebar is read here and vice
 * versa. Inventing a second key for the same object is how two surfaces end up
 * disagreeing about what you have seen.
 */
export const APPROVAL_CONTEXT_PREFIX = 'approval:';
export const THREAD_CONTEXT_PREFIX = 'msgthread:';

export function isApprovalContextKey(key: string): boolean {
  return key.startsWith(APPROVAL_CONTEXT_PREFIX);
}

export function isThreadContextKey(key: string): boolean {
  return key.startsWith(THREAD_CONTEXT_PREFIX);
}

/** The message id a `msgthread:` key points at, or '' when it is not one. */
export function threadParentIdFromKey(key: string): string {
  return isThreadContextKey(key) ? key.slice(THREAD_CONTEXT_PREFIX.length) : '';
}

/**
 * Pending approvals, as inbox items.
 *
 * Only requests that are STILL ANSWERABLE appear. usePermissionRequests keeps
 * settled rows in its list on purpose (the transcript card reads its outcome
 * from them), so filtering here is not optional — without it the inbox would
 * offer buttons for calls that were decided an hour ago.
 *
 * `now` is passed in rather than read, because expiry is the one thing in this
 * feature that genuinely moves on a clock and a test has to be able to sit on
 * both sides of it.
 */
export function approvalInboxItems(
  requests: readonly PermissionRequest[],
  now: number,
  agentNames: ReadonlyMap<string, string> = new Map(),
): InboxItem[] {
  const items: InboxItem[] = [];
  for (const request of requests) {
    if (!isPermissionRequestOpen(request, now)) continue;
    items.push({
      id: `${APPROVAL_CONTEXT_PREFIX}${request.id}`,
      category: 'approval',
      // The daemon's own sentence when it sent one, else `Tool · detail`.
      title: permissionRequestSummary(request),
      body: request.description || '',
      contextKey: `${APPROVAL_CONTEXT_PREFIX}${request.id}`,
      sessionId: request.sessionId || null,
      entityType: 'permission_request',
      entityId: request.id,
      actorName: agentNames.get(request.agentId) || '',
      createdAt: request.createdAt || new Date(now).toISOString(),
      // ALWAYS unread, and there is no marker for it.
      //
      // A pending approval is not a notification you can acknowledge — the
      // agent is still stopped whether or not you have looked at it. Letting it
      // go quiet on selection would drop it out of the Unread filter while the
      // turn it is holding stays parked, which is precisely the failure this
      // category was added to prevent. It leaves the list by being ANSWERED.
      unread: true,
    });
  }
  return items;
}

/**
 * Followed message threads, as inbox items.
 *
 * The server decided which threads these are and whether each is unread; this
 * only reshapes them. `lastReplyAt` is the item's time, because a thread's
 * place in the list is set by the reply you have not read, not by when the
 * conversation started.
 */
export function threadInboxItems(threads: readonly ThreadInboxItem[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const thread of threads) {
    const parentId = String(thread.parentId || '').trim();
    if (!parentId) continue;
    items.push({
      id: `${THREAD_CONTEXT_PREFIX}${parentId}`,
      category: 'thread',
      // What the thread is CALLED — falls back through the latest reply and the
      // session name when the parent message is an upload with no words in it.
      title: threadRowTitle(thread),
      body: thread.lastReplyPreview || '',
      contextKey: `${THREAD_CONTEXT_PREFIX}${parentId}`,
      sessionId: thread.sessionId || null,
      // The thread ROOT, so opening this can focus the thread panel on it
      // rather than dropping the reader at the bottom of a channel.
      entityType: 'message',
      entityId: parentId,
      actorName: thread.lastReplySender || thread.parentSender || '',
      createdAt: thread.lastReplyAt || '',
      unread: thread.unread === true,
    });
  }
  return items;
}

/**
 * One list from several feeds, first occurrence of an id winning.
 *
 * The server's own items are passed first, so if a future inbox branch ever
 * starts emitting one of these ids the authoritative row is the one that
 * survives — a client-side reshape must never shadow the real thing.
 *
 * Order is not decided here. `groupInboxItems` sorts, and it has to be the only
 * place that does, or the list and the detail pane can disagree about which row
 * is which.
 */
export function mergeInboxItems(...lists: readonly (readonly InboxItem[])[]): InboxItem[] {
  const merged: InboxItem[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * The badge number: unread items across the whole merged set.
 *
 * Counted over ITEMS rather than rows for the same reason the server counts
 * that way — a thread with four unread replies is four things you have not
 * read, and a badge that said "1" would understate what is waiting.
 */
export function unreadItemCount(items: readonly InboxItem[]): number {
  return items.reduce((total, item) => total + (item.unread ? 1 : 0), 0);
}

// --- What "open this" means, per category ---------------------------------

export interface InboxOpenTarget {
  sessionId: string;
  /**
   * The message to focus the chat's THREAD PANEL on, or null to just open the
   * conversation. This is the "…and just that part of the chat that's relevant"
   * half: landing someone at the bottom of a 400-message channel is not showing
   * them the reply they came for.
   */
  threadParentId: string | null;
}

/**
 * Where a row goes when you open it.
 *
 * Only `thread` items carry a thread root, and that is a deliberate limit
 * rather than an oversight. A thread item's `entityId` IS the parent of a real
 * message thread — the server selected it as one. A mention's entityId is just
 * the message that mentioned you, which may itself be a reply; focusing the
 * thread panel on a reply shows an EMPTY thread, because the panel lists rows
 * whose thread_parent_id matches. Opening the conversation is the honest
 * fallback, and it is what those categories did before.
 */
export function inboxOpenTarget(
  group: Pick<InboxItemLocation, 'category' | 'sessionId' | 'entityType' | 'entityId'>,
): InboxOpenTarget | null {
  const sessionId = String(group.sessionId || '').trim();
  if (!sessionId) return null;
  const entityId = String(group.entityId || '').trim();
  const threadParentId = group.category === 'thread' && group.entityType === 'message' && entityId
    ? entityId
    : null;
  return { sessionId, threadParentId };
}

/** The fields inboxOpenTarget reads — satisfied by both InboxItem and InboxGroup. */
type InboxItemLocation = Pick<InboxItem, 'category' | 'sessionId' | 'entityType' | 'entityId'>;
