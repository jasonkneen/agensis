import type { InboxCategory, InboxFilter, InboxItem } from '../../types';

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

export const CATEGORY_LABEL: Record<InboxCategory, string> = {
  blocker: 'Blocker',
  error: 'Error',
  mention: 'Mention',
  comment: 'Comment',
};

export const INBOX_FILTERS: Array<{ id: InboxFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'blocker', label: 'Blockers' },
  { id: 'comment', label: 'Comments' },
  { id: 'mention', label: 'Mentions' },
  { id: 'error', label: 'Errors' },
];

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
 * the intended behaviour, not a bug.
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

/** A group plus its already-formatted timestamp — see relativeTime on staleness. */
export interface InboxRowModel {
  group: InboxGroup;
  when: string;
}

export function buildInboxRows(groups: InboxGroup[], now: number): InboxRowModel[] {
  return groups.map(group => ({ group, when: relativeTime(group.latestAt, now) }));
}

export function absoluteTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Per-filter empty copy. "No items" tells the user nothing — these say what the tab is for. */
export function inboxEmptyState(filter: InboxFilter): { title: string; description: string } {
  switch (filter) {
    case 'blocker':
      return {
        title: 'Nothing is blocked',
        description: 'When an agent hits a decision it cannot make, it raises a blocker and it lands here.',
      };
    case 'comment':
      return {
        title: 'No comments waiting',
        description: 'Replies on documents, tasks and memory files show up here instead of scrolling past you.',
      };
    case 'mention':
      return {
        title: 'Nobody has @-mentioned you',
        description: 'Mentions from teammates and agents collect here so they do not get lost in a channel.',
      };
    case 'error':
      return {
        title: 'No failed agent runs',
        description: 'A job that errors out lands here with its thread, so you can restart it from the source.',
      };
    default:
      return {
        title: 'Inbox zero',
        description: 'Blockers, comments, mentions and failed runs land here when something needs a human.',
      };
  }
}

/** Per-tab counts for the filter rail. Blockers/errors count groups, not raw rows. */
export function countByCategory(groups: InboxGroup[]): Record<InboxFilter, number> {
  const counts: Record<InboxFilter, number> = {
    all: groups.length,
    blocker: 0,
    comment: 0,
    mention: 0,
    error: 0,
  };
  for (const group of groups) counts[group.category] += 1;
  return counts;
}
