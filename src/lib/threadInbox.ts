// ---------------------------------------------------------------------------
// The sidebar's Threads list — the decisions, separated from the rendering.
//
// The server decides WHICH threads a person follows and whether each is unread
// (server/thread-inbox.cjs). This module decides how the list READS: what a row
// is called when the parent message is empty, how the section is counted, and
// what "needs reading" means for ordering.
//
// Kept pure so the ordering rule is a test rather than a claim. The whole point
// of the section is that the thing needing attention is at the top; a sort that
// is subtly wrong is invisible until someone misses a reply.
// ---------------------------------------------------------------------------

export interface ThreadInboxItem {
  parentId: string;
  sessionId: string | null;
  sessionTitle: string;
  sessionFolder: string;
  parentPreview: string;
  parentSender: string;
  replyCount: number;
  lastReplyAt: string;
  lastReplyPreview: string;
  lastReplySender: string;
  unread: boolean;
}

/** What the row is called. A thread is named by the message that started it. */
export function threadRowTitle(item: Pick<ThreadInboxItem, 'parentPreview' | 'sessionTitle'>): string {
  const preview = item.parentPreview.replace(/\s+/g, ' ').trim();
  // An empty parent is real: a message can be an attachment, an image, or a
  // tool step with no text. Falling back to the session keeps the row
  // identifiable instead of rendering a blank line the user cannot click with
  // any confidence.
  if (preview) return preview;
  const session = item.sessionTitle.trim();
  return session ? `Thread in ${session}` : 'Thread';
}

/** "3 replies" / "1 reply". The count is the point of the row. */
export function threadReplyLabel(replyCount: number): string {
  const n = Math.max(0, Math.trunc(replyCount));
  return `${n} ${n === 1 ? 'reply' : 'replies'}`;
}

/**
 * Unread first, then newest reply. The server already returns newest-first, so
 * this only lifts the unread block — a stable partition rather than a re-sort,
 * so two threads that are both unread keep their recency order.
 *
 * Slack does the same thing, and the reason is worth stating: a list sorted
 * purely by recency buries an unread reply from this morning under read
 * chatter from this afternoon, which defeats the section.
 */
export function sortThreadInbox(items: readonly ThreadInboxItem[]): ThreadInboxItem[] {
  const unread: ThreadInboxItem[] = [];
  const read: ThreadInboxItem[] = [];
  for (const item of items) (item.unread ? unread : read).push(item);
  return [...unread, ...read];
}

/**
 * What the section badge shows: the number needing attention, not the total.
 * A count of every thread that exists is a number nobody acts on — it never
 * reaches zero, so it never means anything.
 */
export function threadInboxBadgeCount(items: readonly ThreadInboxItem[]): number {
  return items.reduce((n, item) => n + (item.unread ? 1 : 0), 0);
}
