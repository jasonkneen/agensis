// Guards the triage model behind the inbox surface (src/components/inbox/).
//
// The behaviours worth locking down are the ones that make the inbox usable
// while an agent is actively working:
//   * a burst of replies on one thread collapses to ONE row, keyed by a stable
//     conversation id (contextKey) — so a new arrival cannot move the selection;
//   * blockers sort above everything else, however recent the rest is;
//   * the list renders as a FLAT stream — no section headers, no reply counts —
//     and its timestamps are absolute, so nothing in this feature ever needs a
//     timer to stay truthful.
//
// Written with createElement rather than JSX so it stays a .ts file and vitest's
// existing `tests/unit/**/*.test.ts` include needs no config change.

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxCategory, InboxItem } from '../../src/types';
import {
  advanceMarker,
  applyReadPlan,
  buildInboxRows,
  groupInboxItems,
  inboxEmptyState,
  inboxPreview,
  inboxTimestamp,
  inboxTypeLabel,
  isUnreadAt,
  markerTime,
  planReadMarker,
  relativeTime,
  revertReadPlan,
  senderInitials,
  senderLabel,
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

describe('inboxTimestamp', () => {
  // Local-time construction throughout: these labels are what a human in this
  // timezone would call these instants, which is the whole point of the function.
  const now = new Date(2026, 3, 10, 14, 30, 0).getTime();

  it('shows a clock time for today, so the label can never go stale', () => {
    const label = inboxTimestamp(new Date(2026, 3, 10, 9, 5, 0).toISOString(), now);
    expect(label).toMatch(/9[:.]05/);
    expect(label).not.toMatch(/ago/);
  });

  it('names yesterday instead of dating it', () => {
    expect(inboxTimestamp(new Date(2026, 3, 9, 23, 59, 0).toISOString(), now)).toBe('Yesterday');
  });

  it('drops the year within the current year and keeps it outside', () => {
    expect(inboxTimestamp(new Date(2026, 2, 2, 12, 0, 0).toISOString(), now)).not.toMatch(/2026/);
    expect(inboxTimestamp(new Date(2025, 2, 2, 12, 0, 0).toISOString(), now)).toMatch(/2025/);
  });

  it('returns empty string for an unparseable timestamp', () => {
    expect(inboxTimestamp('not-a-date', now)).toBe('');
  });
});

describe('row copy', () => {
  const group = (overrides: Partial<InboxItem> & { id: string }) =>
    groupInboxItems([item({ createdAt: T(1), ...overrides })])[0];

  it('reads a blocker as its question, labelled as needing a decision', () => {
    const blocker = group({ id: 'k1', category: 'blocker', title: 'Ship or wait?', body: '' });
    expect(inboxTypeLabel(blocker)).toEqual({ text: 'Needs your decision', chip: null, tone: 'blocker' });
    expect(inboxPreview(blocker)).toBe('Ship or wait?');
  });

  it('splits the server-composed comment title into a label and a neutral chip', () => {
    const comment = group({
      id: 'c1',
      category: 'comment',
      title: 'Comment on Design doc',
      body: 'this heading is wrong',
    });
    expect(inboxTypeLabel(comment)).toEqual({ text: 'Comment on', chip: 'Design doc', tone: 'muted' });
    expect(inboxPreview(comment)).toBe('this heading is wrong');
  });

  it('keeps a comment title whole when it does not carry the known prefix', () => {
    const comment = group({ id: 'c2', category: 'comment', title: 'Something else entirely' });
    expect(inboxTypeLabel(comment)).toEqual({ text: 'Something else entirely', chip: null, tone: 'muted' });
  });

  it('strips the duplicated sender prefix off a mention with no body', () => {
    const mention = group({ id: 'm1', category: 'mention', title: 'Jane: look at @you', body: '' });
    expect(inboxTypeLabel(mention).text).toBe('Mentioned you');
    expect(inboxPreview(mention)).toBe('look at @you');
  });

  it('labels a failed run without repeating the agent name already on line 1', () => {
    const failed = group({ id: 'e1', category: 'error', title: 'Scout run failed', body: 'exit 1' });
    expect(inboxTypeLabel(failed)).toEqual({ text: 'Run failed', chip: null, tone: 'error' });
    expect(inboxPreview(failed)).toBe('exit 1');
  });

  it('never leaves the sender blank, and takes at most two initials', () => {
    expect(senderLabel(group({ id: 's1', category: 'blocker', actorName: '' }))).toBe('An agent');
    expect(senderLabel(group({ id: 's2', category: 'comment', actorName: '' }))).toBe('Someone');
    expect(senderLabel(group({ id: 's3', actorName: '  Ada Lovelace ' }))).toBe('Ada Lovelace');
    expect(senderInitials('Ada Lovelace')).toBe('AL');
    expect(senderInitials('scout')).toBe('S');
    expect(senderInitials('agent-code-review')).toBe('AC');
    expect(senderInitials('!!!')).toBe('');
  });
});

describe('inboxEmptyState', () => {
  it('says something useful per mode instead of "No items"', () => {
    for (const unreadOnly of [false, true]) {
      const empty = inboxEmptyState(unreadOnly);
      expect(empty.title).not.toMatch(/^no items$/i);
      expect(empty.description.length).toBeGreaterThan(20);
    }
    expect(inboxEmptyState(true).title).not.toBe(inboxEmptyState(false).title);
  });
});

describe('InboxList rendering', () => {
  const noop = () => {};
  const now = Date.parse('2026-01-01T12:00:00.000Z');

  function render(items: InboxItem[], selectedKey: string | null = null, loading = false) {
    const rows = buildInboxRows(groupInboxItems(items), now);
    return renderToStaticMarkup(createElement(InboxList, {
      rows,
      unreadOnly: false,
      loading,
      selectedKey,
      onSelect: noop,
      onMarkRead: noop,
    }));
  }

  const mixed = () => [
    item({ id: 'c1', createdAt: T(1), contextKey: 'thread:c', category: 'comment', title: 'Comment on Roadmap', body: 'Nice work' }),
    item({ id: 'k1', createdAt: T(120), contextKey: 'blocker:1', category: 'blocker', title: 'Ship or wait?' }),
  ];

  it('renders the blocker above the newer comment and labels it', () => {
    const html = render(mixed());
    expect(html.indexOf('Ship or wait?')).toBeGreaterThan(-1);
    expect(html.indexOf('Ship or wait?')).toBeLessThan(html.indexOf('Nice work'));
    expect(html).toContain('Needs your decision');
  });

  it('is a flat stream — no section headers, no reply counts', () => {
    const html = render(mixed());
    expect(html).not.toContain('Everything else');
    expect(html).not.toContain('>Needs you<');
    expect(html).not.toMatch(/>\+\d+</);
  });

  it('marks a burst as ONE unread row led by the newest item', () => {
    const html = render([
      item({ id: 'a1', createdAt: T(9), contextKey: 'thread:abc', body: 'Older doc reply', unread: true }),
      item({ id: 'a2', createdAt: T(8), contextKey: 'thread:abc', body: 'Newest doc reply', unread: true }),
    ]);
    // Two unread items, ONE unread marker — the burst is one row, not two.
    expect((html.match(/aria-label="Unread"/g) || []).length).toBe(1);
    // The row leads with the newest item; the tail lives in the detail pane.
    expect(html).toContain('Newest doc reply');
    expect(html).not.toContain('Older doc reply');
  });

  it('renders an absolute timestamp, never a relative one', () => {
    const html = render([item({ id: 'a1', createdAt: T(200), contextKey: 'thread:abc', body: 'hi' })]);
    expect(html).not.toMatch(/\d+[mhd] ago/);
    expect(html).not.toContain('just now');
  });

  it('shows the empty copy when there is nothing to triage', () => {
    const html = render([]);
    expect(html).toContain(inboxEmptyState(false).title);
  });

  it('shows a skeleton instead of the empty state on first load', () => {
    const html = render([], null, true);
    expect(html).toContain('data-inbox-skeleton');
    expect(html).not.toContain(inboxEmptyState(false).title);
  });
});

// ---------------------------------------------------------------------------
// Read state.
//
// This is the part that shipped broken. The marker is written from an ISO-8601
// string (milliseconds); the item it points at is a Postgres timestamptz
// (microseconds). Compared naively, an item is newer than the marker written
// FROM it by up to 999µs, so every row came back unread after a reload — 45 of
// 45 live markers were being defeated exactly this way. The rule that fixes it
// is "compare at wire resolution", and it has to hold identically here and in
// the server's unread predicate or the list and the badge disagree.
// ---------------------------------------------------------------------------

describe('read marker resolution', () => {
  it('floors a timestamp to the precision the wire can carry', () => {
    // What a microsecond-precision row degrades to once it has been an ISO string.
    expect(markerTime('2026-07-19T01:39:04.638Z')).toBe(Date.parse('2026-07-19T01:39:04.638Z'));
    expect(markerTime('nonsense')).toBeNull();
  });

  it('treats an item in the same millisecond as the marker as READ', () => {
    // The regression, stated directly: created_at 04.638748 vs marker 04.638000.
    const marker = markerTime('2026-07-19T01:39:04.638Z')!;
    expect(isUnreadAt({ createdAt: '2026-07-19T01:39:04.638Z' }, marker)).toBe(false);
  });

  it('treats an item newer than the marker as unread', () => {
    const marker = markerTime('2026-07-19T01:39:04.638Z')!;
    expect(isUnreadAt({ createdAt: '2026-07-19T01:39:04.639Z' }, marker)).toBe(true);
  });

  it('treats everything as unread when there is no marker at all', () => {
    expect(isUnreadAt({ createdAt: T(1) }, null)).toBe(true);
  });
});

describe('advanceMarker', () => {
  it('only ever moves forward', () => {
    const older = Date.parse(T(30));
    const newer = Date.parse(T(10));
    expect(advanceMarker(older, newer)).toBe(newer);
    expect(advanceMarker(newer, older)).toBe(newer);
    expect(advanceMarker(newer, newer)).toBe(newer);
  });

  it('takes the first real value it is given, and ignores unusable ones', () => {
    const at = Date.parse(T(5));
    expect(advanceMarker(null, at)).toBe(at);
    expect(advanceMarker(at, null)).toBe(at);
    expect(advanceMarker(null, null)).toBeNull();
  });
});

describe('planReadMarker', () => {
  const thread = [
    item({ id: 'a1', createdAt: T(30), contextKey: 'thread:abc', unread: false }),
    item({ id: 'a2', createdAt: T(20), contextKey: 'thread:abc', unread: true }),
    item({ id: 'a3', createdAt: T(10), contextKey: 'thread:abc', unread: true }),
    item({ id: 'b1', createdAt: T(5), contextKey: 'thread:other', unread: true }),
  ];

  it('marks to the NEWEST item in the context and flips only what was unread', () => {
    const plan = planReadMarker(thread, 'thread:abc', null)!;
    expect(plan.readAtIso).toBe(T(10));
    // a1 was already read; b1 belongs to another conversation.
    expect(plan.flippedIds).toEqual(['a2', 'a3']);
    expect(plan.needsSend).toBe(true);
  });

  it('leaves an item that arrived AFTER the marker unread', () => {
    // The marker the user's device already sent is older than the new arrival.
    const sent = Date.parse(T(20));
    const plan = planReadMarker(thread, 'thread:abc', sent)!;
    // The plan still advances to the newest item...
    expect(plan.readAtIso).toBe(T(10));
    expect(plan.needsSend).toBe(true);
    // ...and an item newer than THAT is untouched by applying it.
    const withArrival = [...thread, item({ id: 'a4', createdAt: T(2), contextKey: 'thread:abc', unread: true })];
    const stale = planReadMarker(thread, 'thread:abc', null)!;
    const after = applyReadPlan(withArrival, stale);
    expect(after.find(i => i.id === 'a4')!.unread).toBe(true);
    expect(after.find(i => i.id === 'a3')!.unread).toBe(false);
  });

  it('does not re-send a marker the server already holds', () => {
    const sent = Date.parse(T(10));
    const plan = planReadMarker(thread, 'thread:abc', sent)!;
    expect(plan.needsSend).toBe(false);
  });

  it('never walks a marker backwards when the same group is read on two devices', () => {
    // Device A read the whole thread. Device B, still showing a stale list that
    // stops at a2, reads the "same" group — its marker is older.
    const deviceA = planReadMarker(thread, 'thread:abc', null)!;
    const staleList = thread.filter(i => i.id !== 'a3');
    const deviceB = planReadMarker(staleList, 'thread:abc', deviceA.readAtMs)!;
    expect(deviceB.readAtMs).toBeLessThan(deviceA.readAtMs);
    // ...so it is never sent, and a3 does not come back to life.
    expect(deviceB.needsSend).toBe(false);
    expect(advanceMarker(deviceA.readAtMs, deviceB.readAtMs)).toBe(deviceA.readAtMs);
  });

  it('returns nothing for a context with no items, or no context at all', () => {
    expect(planReadMarker(thread, 'thread:missing', null)).toBeNull();
    expect(planReadMarker(thread, '', null)).toBeNull();
  });
});

describe('applyReadPlan / revertReadPlan', () => {
  const mixedGroup = [
    item({ id: 'a1', createdAt: T(30), contextKey: 'thread:abc', unread: false }),
    item({ id: 'a2', createdAt: T(20), contextKey: 'thread:abc', unread: true }),
    item({ id: 'b1', createdAt: T(5), contextKey: 'thread:other', unread: true }),
  ];

  it('flips exactly the planned items and leaves the rest alone', () => {
    const plan = planReadMarker(mixedGroup, 'thread:abc', null)!;
    const after = applyReadPlan(mixedGroup, plan);
    expect(after.map(i => i.unread)).toEqual([false, false, true]);
  });

  it('puts back exactly what it flipped when the write fails', () => {
    const plan = planReadMarker(mixedGroup, 'thread:abc', null)!;
    const reverted = revertReadPlan(applyReadPlan(mixedGroup, plan), plan);
    // a1 was already read BEFORE the action and must not be resurrected.
    expect(reverted.map(i => i.unread)).toEqual([false, true, true]);
  });

  it('is a no-op, identity included, when there was nothing unread to flip', () => {
    const allRead = mixedGroup.map(i => ({ ...i, unread: false }));
    const plan = planReadMarker(allRead, 'thread:abc', null)!;
    expect(plan.flippedIds).toEqual([]);
    expect(applyReadPlan(allRead, plan)).toBe(allRead);
    expect(revertReadPlan(allRead, plan)).toBe(allRead);
  });
});
