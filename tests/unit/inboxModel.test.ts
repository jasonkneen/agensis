// Guards the triage model behind the inbox surface (src/components/inbox/).
//
// The two behaviours worth locking down are the ones that make the inbox usable
// while an agent is actively working:
//   * a burst of replies on one thread collapses to ONE row, keyed by a stable
//     conversation id (contextKey) — so a new arrival cannot move the selection;
//   * blockers sort above everything else, however recent the rest is.
//
// Written with createElement rather than JSX so it stays a .ts file and vitest's
// existing `tests/unit/**/*.test.ts` include needs no config change.

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxCategory, InboxItem } from '../../src/types';
import {
  buildInboxRows,
  countByCategory,
  groupInboxItems,
  inboxEmptyState,
  relativeTime,
} from '../../src/components/inbox/inboxModel';
import { InboxList } from '../../src/components/inbox/InboxWindowContent';

function item(overrides: Partial<InboxItem> & { id: string; createdAt: string }): InboxItem {
  return {
    category: 'mention' as InboxCategory,
    title: `title ${overrides.id}`,
    body: '',
    contextKey: `thread:${overrides.id}`,
    sessionId: null,
    entityType: null,
    entityId: null,
    actorName: '',
    unread: false,
    ...overrides,
  };
}

const T = (minutesAgo: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString();

describe('groupInboxItems', () => {
  it('collapses a burst on one thread into a single row keyed by contextKey', () => {
    const groups = groupInboxItems([
      item({ id: 'a1', createdAt: T(30), contextKey: 'thread:abc', title: 'first' }),
      item({ id: 'a2', createdAt: T(20), contextKey: 'thread:abc', title: 'second' }),
      item({ id: 'a3', createdAt: T(10), contextKey: 'thread:abc', title: 'third' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('thread:abc');
    expect(groups[0].items).toHaveLength(3);
    // newest first
    expect(groups[0].items.map(i => i.id)).toEqual(['a3', 'a2', 'a1']);
    expect(groups[0].latestAt).toBe(T(10));
  });

  it('keeps the selected group key stable when a newer item joins that thread', () => {
    const first = groupInboxItems([
      item({ id: 'a1', createdAt: T(30), contextKey: 'thread:abc' }),
      item({ id: 'b1', createdAt: T(25), contextKey: 'thread:xyz' }),
    ]);
    // The user has the OLDER thread open — the one a new arrival will re-sort past.
    const selectedKey = first[1].key;
    expect(selectedKey).toBe('thread:abc');

    const after = groupInboxItems([
      item({ id: 'a1', createdAt: T(30), contextKey: 'thread:abc' }),
      item({ id: 'b1', createdAt: T(25), contextKey: 'thread:xyz' }),
      item({ id: 'a2', createdAt: T(1), contextKey: 'thread:abc' }),
    ]);
    // The user's selection must still resolve to a group after the arrival.
    expect(after.some(group => group.key === selectedKey)).toBe(true);
    expect(after.find(group => group.key === selectedKey)?.items).toHaveLength(2);
  });

  it('sorts blockers above everything else regardless of recency', () => {
    const groups = groupInboxItems([
      item({ id: 'fresh', createdAt: T(0), contextKey: 'thread:fresh', category: 'comment' }),
      item({ id: 'old-block', createdAt: T(600), contextKey: 'blocker:1', category: 'blocker' }),
      item({ id: 'mid', createdAt: T(5), contextKey: 'thread:mid', category: 'mention' }),
    ]);
    expect(groups.map(g => g.key)).toEqual(['blocker:1', 'thread:fresh', 'thread:mid']);
  });

  it('takes the most urgent category present in a mixed group', () => {
    const groups = groupInboxItems([
      item({ id: 'x1', createdAt: T(9), contextKey: 'thread:abc', category: 'mention' }),
      item({ id: 'x2', createdAt: T(30), contextKey: 'thread:abc', category: 'blocker', title: 'need a call' }),
      item({ id: 'x3', createdAt: T(1), contextKey: 'thread:abc', category: 'mention' }),
    ]);
    expect(groups[0].category).toBe('blocker');
    // The row reads as the blocker, not as the chatty tail that arrived after it.
    expect(groups[0].title).toBe('need a call');
  });

  it('counts unread items per group and inherits the first session id', () => {
    const groups = groupInboxItems([
      item({ id: 'u1', createdAt: T(9), contextKey: 'thread:abc', unread: true }),
      item({ id: 'u2', createdAt: T(8), contextKey: 'thread:abc', unread: false, sessionId: 'sess-1' }),
      item({ id: 'u3', createdAt: T(7), contextKey: 'thread:abc', unread: true }),
    ]);
    expect(groups[0].unreadCount).toBe(2);
    expect(groups[0].sessionId).toBe('sess-1');
  });

  it('falls back to the item id when a row has no contextKey', () => {
    const groups = groupInboxItems([
      item({ id: 'orphan', createdAt: T(3), contextKey: '' }),
      item({ id: 'orphan2', createdAt: T(2), contextKey: '' }),
    ]);
    expect(groups.map(g => g.key).sort()).toEqual(['orphan', 'orphan2']);
  });

  it('orders deterministically when two rows share a timestamp', () => {
    const build = () => groupInboxItems([
      item({ id: 'b', createdAt: T(5), contextKey: 'thread:b' }),
      item({ id: 'a', createdAt: T(5), contextKey: 'thread:a' }),
    ]).map(g => g.key);
    expect(build()).toEqual(build());
    expect(build()).toEqual(['thread:a', 'thread:b']);
  });

  it('returns nothing for an empty inbox', () => {
    expect(groupInboxItems([])).toEqual([]);
  });
});

describe('countByCategory', () => {
  it('counts groups per category, not raw rows', () => {
    const groups = groupInboxItems([
      item({ id: 'c1', createdAt: T(9), contextKey: 'thread:abc', category: 'comment' }),
      item({ id: 'c2', createdAt: T(8), contextKey: 'thread:abc', category: 'comment' }),
      item({ id: 'k1', createdAt: T(7), contextKey: 'blocker:1', category: 'blocker' }),
    ]);
    const counts = countByCategory(groups);
    expect(counts.all).toBe(2);
    expect(counts.comment).toBe(1);
    expect(counts.blocker).toBe(1);
    expect(counts.error).toBe(0);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');

  it('buckets recent times without a live clock', () => {
    expect(relativeTime('2026-01-01T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-01-01T11:45:00.000Z', now)).toBe('15m ago');
    expect(relativeTime('2026-01-01T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2025-12-30T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('falls back to a date past a week', () => {
    expect(relativeTime('2025-11-01T12:00:00.000Z', now)).not.toMatch(/ago/);
  });

  it('never renders a negative age for a clock-skewed row', () => {
    expect(relativeTime('2026-01-01T12:05:00.000Z', now)).toBe('just now');
  });

  it('returns empty string for an unparseable timestamp', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('inboxEmptyState', () => {
  it('says something useful per filter instead of "No items"', () => {
    const filters = ['all', 'blocker', 'comment', 'mention', 'error'] as const;
    const titles = filters.map(f => inboxEmptyState(f).title);
    expect(new Set(titles).size).toBe(filters.length);
    for (const filter of filters) {
      const empty = inboxEmptyState(filter);
      expect(empty.title).not.toMatch(/^no items$/i);
      expect(empty.description.length).toBeGreaterThan(20);
    }
  });
});

describe('InboxList rendering', () => {
  const noop = () => {};
  const now = Date.parse('2026-01-01T12:00:00.000Z');

  function render(items: InboxItem[], selectedKey: string | null = null, loading = false) {
    const rows = buildInboxRows(groupInboxItems(items), now);
    return renderToStaticMarkup(createElement(InboxList, {
      rows,
      filter: 'all' as const,
      loading,
      selectedKey,
      narrow: selectedKey !== null,
      onSelect: noop,
    }));
  }

  it('renders the blocker above the newer comment and labels it', () => {
    const html = render([
      item({ id: 'c1', createdAt: T(1), contextKey: 'thread:c', category: 'comment', title: 'Nice work' }),
      item({ id: 'k1', createdAt: T(120), contextKey: 'blocker:1', category: 'blocker', title: 'Ship or wait?' }),
    ]);
    expect(html.indexOf('Ship or wait?')).toBeGreaterThan(-1);
    expect(html.indexOf('Ship or wait?')).toBeLessThan(html.indexOf('Nice work'));
    expect(html).toContain('Needs you');
    expect(html).toContain('Everything else');
  });

  it('marks unread rows and collapses a burst into one row with a +N chip', () => {
    const html = render([
      item({ id: 'a1', createdAt: T(9), contextKey: 'thread:abc', title: 'Older doc reply', unread: true }),
      item({ id: 'a2', createdAt: T(8), contextKey: 'thread:abc', title: 'Newest doc reply', unread: true }),
    ]);
    // Two unread items, ONE unread marker — the burst is one row, not two.
    expect((html.match(/aria-label="Unread"/g) || []).length).toBe(1);
    expect(html).toContain('+1');
    // The row leads with the newest item; the tail lives in the detail pane.
    expect(html).toContain('Newest doc reply');
    expect(html).not.toContain('Older doc reply');
  });

  it('shows the per-filter empty copy when there is nothing to triage', () => {
    const html = render([]);
    expect(html).toContain(inboxEmptyState('all').title);
  });

  it('shows a loading state instead of the empty state on first load', () => {
    const html = render([], null, true);
    expect(html).toContain('Collecting what needs you');
    expect(html).not.toContain(inboxEmptyState('all').title);
  });
});
