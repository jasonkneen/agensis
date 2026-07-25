import type { InboxCategory, InboxItem } from '../../types';

// ---------------------------------------------------------------------------
// Pure triage model. No React, no DOM, no clock reads — everything that decides
// what the inbox SHOWS lives here so it can be unit tested, and so the surface
// itself stays a thin renderer.
// ---------------------------------------------------------------------------

/** Most urgent first. A group takes the rank of the most urgent item in it. */
export const CATEGORY_RANK: Record<InboxCategory, number> = {
  blocker: 0,
  error: 1,
  mention: 2,
  comment: 3,
};

/**
 * A burst of replies on one thread is ONE row. The group's identity is its
 * `contextKey` — a stable conversation id, never an array index and never the
 * newest item's id, so an item arriving mid-read cannot move the user's
 * selection or reading place.
 */
export interface InboxGroup {
  /** contextKey — stable across new arrivals; also the read-state key. */
  key: string;
  /** Most urgent category present in the group. */
  category: InboxCategory;
  title: string;
  body: string;
  actorName: string;
  /** Newest first. */
  items: InboxItem[];
  /** ISO of the newest item in the group. */
  latestAt: string;
  unreadCount: number;
  sessionId: string | null;
  entityType: string | null;
  entityId: string | null;
}

function newestFirst(a: InboxItem, b: InboxItem): number {
  const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (delta !== 0 && Number.isFinite(delta)) return delta;
  // Deterministic tiebreak — two rows written in the same millisecond must not
  // swap places between renders.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function timeOf(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Collapse items into per-context groups, blockers pinned to the top and
 * everything else by recency. Items with no contextKey fall back to their own
 * id so a malformed row still shows up as its own row instead of merging into
 * a phantom '' group.
 */
export function groupInboxItems(items: InboxItem[]): InboxGroup[] {
  const buckets = new Map<string, InboxItem[]>();
  for (const item of items) {
    const key = item.contextKey || item.id;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const groups: InboxGroup[] = [];
  buckets.forEach((bucketItems, key) => {
    const sorted = bucketItems.slice().sort(newestFirst);
    // The group reads as its most urgent member: a thread carrying a blocker and
    // three activity events is a BLOCKER, however chatty the tail is.
    const category = sorted.reduce<InboxCategory>(
      (worst, item) => (CATEGORY_RANK[item.category] < CATEGORY_RANK[worst] ? item.category : worst),
      sorted[0].category,
    );
    const lead = sorted.find(item => item.category === category) ?? sorted[0];
    groups.push({
      key,
      category,
      title: lead.title,
      body: lead.body,
      actorName: lead.actorName,
      items: sorted,
      latestAt: sorted[0].createdAt,
      unreadCount: sorted.filter(item => item.unread).length,
      sessionId: sorted.find(item => item.sessionId)?.sessionId ?? null,
      entityType: lead.entityType ?? sorted.find(item => item.entityType)?.entityType ?? null,
      entityId: lead.entityId ?? sorted.find(item => item.entityId)?.entityId ?? null,
    });
  });

  return groups.sort((a, b) => {
    const aBlocked = a.category === 'blocker' ? 0 : 1;
    const bBlocked = b.category === 'blocker' ? 0 : 1;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;
    const delta = timeOf(b.latestAt) - timeOf(a.latestAt);
    if (delta !== 0) return delta;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** The read marker to send for a group: its newest item. Markers only ever move forward. */
export function groupReadAt(group: InboxGroup): string {
  return group.latestAt;
}

/**
 * Relative time, computed ONCE against a caller-supplied `now`. Deliberately
 * not live: nothing in this feature runs on a timer, so a label going stale is
 * the intended behaviour, not a bug. Used for the thread tail in the detail
 * pane, where "3h ago" reads better than a wall of repeated dates.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The LIST timestamp: absolute, never relative.
 *
 * "3h ago" is the one label in a no-timer app that is guaranteed to be a lie
 * the moment the tab has been open a while. A clock time cannot go stale, so
 * the list stays truthful without anything ticking:
 *
 *   today       -> "2:34 PM"
 *   yesterday   -> "Yesterday"
 *   this year   -> "Apr 2"
 *   older       -> "Apr 2, 2025"
 */
export function inboxTimestamp(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const date = new Date(then);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  // Built by calendar date rather than by subtracting 86_400_000, so the day
  // either side of a DST change is still one day.
  const startOfYesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();

  if (then >= startOfToday) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (then >= startOfYesterday) return 'Yesterday';
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function absoluteTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// --- Row copy -------------------------------------------------------------
//
// The server composes `title` differently per category (see buildInboxSql), so
// the split between "what kind of thing is this" (line 2) and "what does it
// say" (line 3) has to be made here rather than assumed.
//
//   blocker  title = the agent's question, body = a response that is usually ''
//   comment  title = "Comment on <doc/task/path>",  body = the comment text
//   mention  title = "<Sender>: <first 80 chars>",  body = the full message
//   error    title = "<Agent> run failed",          body = the error text

/** Line 2: what kind of thing this is, and what it is attached to. */
export interface InboxTypeLabel {
  text: string;
  /** A neutral chip — the document/task/file the item hangs off, when known. */
  chip: string | null;
  /** Only the two "a human has to move this" categories carry a hue. */
  tone: 'blocker' | 'error' | 'muted';
}

const COMMENT_PREFIX = 'Comment on ';

export function inboxTypeLabel(group: InboxGroup): InboxTypeLabel {
  switch (group.category) {
    case 'blocker':
      return { text: 'Needs your decision', chip: null, tone: 'blocker' };
    case 'error':
      return { text: 'Run failed', chip: null, tone: 'error' };
    case 'comment': {
      // The server literally builds `'Comment on ' || <name>`, so this split is
      // deterministic — but it falls back to the whole title if that ever stops
      // being true, rather than rendering a mangled chip.
      const target = group.title.startsWith(COMMENT_PREFIX)
        ? group.title.slice(COMMENT_PREFIX.length).trim()
        : '';
      return target
        ? { text: 'Comment on', chip: target, tone: 'muted' }
        : { text: group.title || 'Comment', chip: null, tone: 'muted' };
    }
    default:
      return { text: 'Mentioned you', chip: null, tone: 'muted' };
  }
}

/**
 * Line 3. There is no separate subject line — the preview IS the subject, so
 * whichever field actually carries the words wins.
 */
export function inboxPreview(group: InboxGroup): string {
  if (group.category === 'blocker') return group.title.trim();
  const body = group.body.trim();
  if (body) return body;
  if (group.category === 'mention') {
    // "Jane: hey @you can you look at…" — the sender is already line 1.
    const split = group.title.indexOf(': ');
    if (split > 0) return group.title.slice(split + 2).trim();
  }
  return group.title.trim();
}

/** Line 1. Never blank — an unnamed row still has to say who it is from. */
export function senderLabel(group: InboxGroup): string {
  const name = group.actorName.trim();
  if (name) return name;
  return group.category === 'blocker' || group.category === 'error' ? 'An agent' : 'Someone';
}

/** Up to two initials for the avatar; '' when there is nothing usable to show. */
export function senderInitials(label: string): string {
  const words = label
    .replace(/[^\p{L}\p{N}\s._-]+/gu, ' ')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  const letters = words.slice(0, 2).map(word => word[0]);
  return letters.join('').toUpperCase();
}

/** A group plus everything the row needs, all resolved at data-load time. */
export interface InboxRowModel {
  group: InboxGroup;
  /** Absolute — see inboxTimestamp. Never ticks. */
  when: string;
  label: InboxTypeLabel;
  sender: string;
  initials: string;
  preview: string;
}

export function buildInboxRows(groups: InboxGroup[], now: number): InboxRowModel[] {
  return groups.map(group => {
    const sender = senderLabel(group);
    return {
      group,
      when: inboxTimestamp(group.latestAt, now),
      label: inboxTypeLabel(group),
      sender,
      initials: senderInitials(sender),
      preview: inboxPreview(group),
    };
  });
}

/** Two lines of plain text. "No items" tells the user nothing; these say why. */
export function inboxEmptyState(unreadOnly: boolean): { title: string; description: string } {
  return unreadOnly
    ? {
        title: 'No unread messages',
        description: 'Turn off the unread filter to see everything that has already been read.',
      }
    : {
        title: 'Inbox zero',
        description: 'Blockers, comments, mentions and failed runs land here when something needs a human.',
      };
}
