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

/**
 * A parent message that is ONLY an attachment manifest is not a title.
 *
 * `buildFileContext` (ComposerAddContent) writes uploads into the message as
 * "[Linked files]" followed by one "- name (source): path" line per file, and
 * that text stays in the message on purpose — it is what the agent reads. As a
 * thread NAME it is worthless: four uploads in a row produce four sidebar rows
 * that all read "[Linked files] - Screenshot 2026-07-27 at …", truncated, and
 * a list whose rows cannot be told apart is not a list.
 */
const ATTACHMENT_ONLY_PREVIEW = /^\[(linked files|image|images|attachment|attachments|file|files)\]/i;

/**
 * What the row is called.
 *
 * A thread is named by the message that started it — unless that message says
 * nothing a reader can use, which is the common case for a thread hung off an
 * upload or a tool step. Then the most useful name available is what the thread
 * is ABOUT, i.e. its latest reply; the session is the last resort. Order is
 * deliberate: the reply distinguishes rows from each other, the session name
 * does not (every thread in one channel would get the same title).
 */
export function threadRowTitle(
  item: Pick<ThreadInboxItem, 'parentPreview' | 'sessionTitle'> & Partial<Pick<ThreadInboxItem, 'lastReplyPreview'>>,
): string {
  const preview = item.parentPreview.replace(/\s+/g, ' ').trim();
  // An empty parent is real: a message can be an attachment, an image, or a
  // tool step with no text.
  if (preview && !ATTACHMENT_ONLY_PREVIEW.test(preview)) return preview;
  const lastReply = (item.lastReplyPreview || '').replace(/\s+/g, ' ').trim();
  if (lastReply) return lastReply;
  const session = item.sessionTitle.trim();
  return session ? `Thread in ${session}` : 'Thread';
}

/**
 * Where the thread lives, for the row's leading icon. The sidebar's other lists
 * all lead with one, and a thread's SOURCE is the one fact that separates
 * otherwise-similar rows — so the icon carries information rather than
 * decorating the row.
 */
export function threadRowSource(item: Pick<ThreadInboxItem, 'sessionFolder'>): 'dm' | 'channel' {
  return item.sessionFolder.trim().toLowerCase() === 'direct messages' ? 'dm' : 'channel';
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
