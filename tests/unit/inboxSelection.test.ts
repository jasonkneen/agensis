// Guards the bulk-selection model behind the inbox surface
// (src/components/inbox/inboxSelection.ts). The model, not the rendering.
//
// The behaviours that actually matter here are the ones where getting it wrong
// is either silent or destructive:
//   * shift-click has to range in BOTH directions, because half of them are
//     drags upward and a range that only works downward looks like a dead click;
//   * select-all with a filter on must select the FILTERED rows only — a bulk
//     action that reaches a row the user cannot see is the whole nightmare;
//   * a row is a conversation, so dismissing one has to close every blocker
//     under it, or the row comes straight back with the ones nobody answered;
//   * a batch of N per-item calls has to report what really happened. "Done"
//     over a half-applied batch leaves an agent waiting forever on an answer
//     the human believes they gave.

import { describe, it, expect } from 'vitest';
import type { InboxCategory, InboxItem } from '../../src/types';
import { groupInboxItems, type InboxGroup } from '../../src/components/inbox/inboxModel';
import {
  NO_SELECTION,
  availableBulkActions,
  beginSelection,
  bulkResultMessage,
  clearSelection,
  dismissableBlockerIds,
  isAllSelected,
  isSelecting,
  pruneSelection,
  runBulk,
  selectAll,
  selectRange,
  selectedGroups,
  summarizeSelection,
  toggleSelection,
  unreadGroupKeys,
} from '../../src/components/inbox/inboxSelection';

const T = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString();

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

/** Five plain rows, keys a..e in list order. */
function fiveRows(): InboxGroup[] {
  return groupInboxItems([
    item({ id: 'a', createdAt: T(10), contextKey: 'a' }),
    item({ id: 'b', createdAt: T(20), contextKey: 'b' }),
    item({ id: 'c', createdAt: T(30), contextKey: 'c' }),
    item({ id: 'd', createdAt: T(40), contextKey: 'd' }),
    item({ id: 'e', createdAt: T(50), contextKey: 'e' }),
  ]);
}

const keysOf = (groups: InboxGroup[]) => groups.map(group => group.key);
const sorted = (selection: { keys: ReadonlySet<string> }) => [...selection.keys].sort();

describe('selection mode is derived from the selection itself', () => {
  it('is off with nothing selected', () => {
    expect(isSelecting(NO_SELECTION)).toBe(false);
  });

  it('turns on when an avatar starts a selection, with that row selected', () => {
    const state = beginSelection('c');
    expect(isSelecting(state)).toBe(true);
    expect(sorted(state)).toEqual(['c']);
    expect(state.anchor).toBe('c');
  });

  it('LEAVES the mode when the last selected row is deselected', () => {
    const one = beginSelection('c');
    const two = toggleSelection(one, 'd');
    expect(isSelecting(two)).toBe(true);

    const back = toggleSelection(two, 'd');
    expect(isSelecting(back)).toBe(true);

    const none = toggleSelection(back, 'c');
    expect(isSelecting(none)).toBe(false);
    expect(sorted(none)).toEqual([]);
    // No orphan anchor left pointing at a row nothing is selecting from.
    expect(none.anchor).toBeNull();
  });

  it('clearSelection empties it outright', () => {
    expect(isSelecting(clearSelection())).toBe(false);
  });
});

describe('toggle', () => {
  it('adds and removes, moving the anchor to the row last touched', () => {
    let state = beginSelection('a');
    state = toggleSelection(state, 'c');
    expect(sorted(state)).toEqual(['a', 'c']);
    expect(state.anchor).toBe('c');

    state = toggleSelection(state, 'a');
    expect(sorted(state)).toEqual(['c']);
    // Deselecting is still "touching" that row.
    expect(state.anchor).toBe('a');
  });
});

describe('shift-click range', () => {
  const order = keysOf(fiveRows());

  it('ranges DOWNWARD from the anchor, inclusive', () => {
    const state = selectRange(beginSelection('b'), 'd', order);
    expect(sorted(state)).toEqual(['b', 'c', 'd']);
  });

  it('ranges UPWARD from the anchor, inclusive', () => {
    const state = selectRange(beginSelection('d'), 'b', order);
    expect(sorted(state)).toEqual(['b', 'c', 'd']);
  });

  it('keeps the anchor put, so successive shift-clicks widen from the same origin', () => {
    const first = selectRange(beginSelection('c'), 'd', order);
    expect(first.anchor).toBe('c');
    const second = selectRange(first, 'a', order);
    expect(sorted(second)).toEqual(['a', 'b', 'c', 'd']);
    expect(second.anchor).toBe('c');
  });

  it('keeps rows selected outside the range', () => {
    let state = beginSelection('e');
    state = toggleSelection(state, 'a');
    state = selectRange(state, 'b', order);
    expect(sorted(state)).toEqual(['a', 'b', 'e']);
  });

  it('degrades to a plain toggle with no usable anchor, rather than no-opping', () => {
    const fresh = selectRange(NO_SELECTION, 'c', order);
    expect(sorted(fresh)).toEqual(['c']);

    // Anchor has since left the list (resolved, or filtered away).
    const stale = selectRange({ keys: new Set(['a']), anchor: 'zzz' }, 'c', order);
    expect(sorted(stale)).toEqual(['a', 'c']);
  });

  it('ignores a target that is not in the list', () => {
    const state = beginSelection('b');
    expect(selectRange(state, 'nope', order)).toBe(state);
  });
});

describe('select all / none', () => {
  it('selects every visible row', () => {
    const order = keysOf(fiveRows());
    const state = selectAll(NO_SELECTION, order);
    expect(sorted(state)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(isAllSelected(state, order)).toBe(true);
  });

  it('WITH A FILTER ACTIVE selects only the filtered rows', () => {
    const groups = groupInboxItems([
      item({ id: 'a', createdAt: T(10), contextKey: 'a', unread: true }),
      item({ id: 'b', createdAt: T(20), contextKey: 'b' }),
      item({ id: 'c', createdAt: T(30), contextKey: 'c', unread: true }),
      item({ id: 'd', createdAt: T(40), contextKey: 'd' }),
    ]);
    const unreadOnly = keysOf(groups.filter(group => group.unreadCount > 0));
    expect(unreadOnly).toEqual(['a', 'c']);

    const state = selectAll(NO_SELECTION, unreadOnly);
    expect(sorted(state)).toEqual(['a', 'c']);
    // "All" means all of what is on screen, so the header still reads as all.
    expect(isAllSelected(state, unreadOnly)).toBe(true);
    // …and it is emphatically not all of the inbox.
    expect(isAllSelected(state, keysOf(groups))).toBe(false);
  });

  it('is never "all selected" on an empty list', () => {
    expect(isAllSelected(NO_SELECTION, [])).toBe(false);
    expect(isAllSelected(selectAll(NO_SELECTION, []), [])).toBe(false);
  });

  it('keeps the anchor when it is still visible, and rehomes it when not', () => {
    const order = keysOf(fiveRows());
    expect(selectAll(beginSelection('d'), order).anchor).toBe('d');
    expect(selectAll({ keys: new Set(['x']), anchor: 'x' }, order).anchor).toBe('a');
  });
});

describe('pruneSelection', () => {
  const order = keysOf(fiveRows());

  it('drops rows that have left the list', () => {
    const state = selectAll(NO_SELECTION, order);
    const pruned = pruneSelection(state, ['a', 'c']);
    expect(sorted(pruned)).toEqual(['a', 'c']);
  });

  it('returns the SAME object when nothing changed, so it cannot loop a render', () => {
    const state = selectAll(NO_SELECTION, order);
    expect(pruneSelection(state, order)).toBe(state);
    expect(pruneSelection(NO_SELECTION, order)).toBe(NO_SELECTION);
  });

  it('leaves selection mode when every selected row has gone', () => {
    const state = beginSelection('a');
    const pruned = pruneSelection(state, ['b', 'c']);
    expect(isSelecting(pruned)).toBe(false);
    expect(pruned.anchor).toBeNull();
  });

  it('clears an anchor that is no longer visible but keeps the rest', () => {
    const state = selectRange(beginSelection('a'), 'c', order);
    const pruned = pruneSelection(state, ['b', 'c']);
    expect(sorted(pruned)).toEqual(['b', 'c']);
    expect(pruned.anchor).toBeNull();
  });
});

describe('a row is a whole conversation', () => {
  // One contextKey holding three items, two of them unanswered blockers.
  const groups = groupInboxItems([
    item({ id: 'b1', createdAt: T(10), contextKey: 'thread:x', category: 'blocker', entityId: 'e1', unread: true }),
    item({ id: 'b2', createdAt: T(20), contextKey: 'thread:x', category: 'blocker', entityId: 'e2' }),
    item({ id: 'm1', createdAt: T(30), contextKey: 'thread:x', category: 'mention' }),
    item({ id: 'p1', createdAt: T(40), contextKey: 'thread:y', category: 'comment' }),
  ]);

  it('selecting the row selects every item under it', () => {
    const state = beginSelection('thread:x');
    expect(selectedGroups(groups, state).map(group => group.items.length)).toEqual([3]);
    expect(summarizeSelection(groups, state)).toEqual({
      groups: 1,
      items: 3,
      unreadGroups: 1,
      blockerItems: 2,
    });
  });

  it('dismiss collects EVERY blocker in the group, not just the lead item', () => {
    expect(dismissableBlockerIds(groups, beginSelection('thread:x'))).toEqual(['e1', 'e2']);
  });

  it('skips blockers with no entity id, and never repeats one', () => {
    const messy = groupInboxItems([
      item({ id: 'g1', createdAt: T(10), contextKey: 'k', category: 'blocker', entityId: 'same' }),
      item({ id: 'g2', createdAt: T(20), contextKey: 'k', category: 'blocker', entityId: 'same' }),
      item({ id: 'g3', createdAt: T(30), contextKey: 'k', category: 'blocker', entityId: null }),
    ]);
    expect(dismissableBlockerIds(messy, beginSelection('k'))).toEqual(['same']);
  });

  it('returns selected rows in LIST order, not in the order they were clicked', () => {
    const order = keysOf(fiveRows());
    let state = beginSelection('d');
    state = toggleSelection(state, 'a');
    state = toggleSelection(state, 'c');
    expect(selectedGroups(fiveRows(), state).map(group => group.key)).toEqual(['a', 'c', 'd']);
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('only sends a read marker for rows that have something unread', () => {
    const mixed = groupInboxItems([
      item({ id: 'u', createdAt: T(10), contextKey: 'u', unread: true }),
      item({ id: 'r', createdAt: T(20), contextKey: 'r' }),
    ]);
    expect(unreadGroupKeys(mixed, selectAll(NO_SELECTION, ['u', 'r']))).toEqual(['u']);
  });
});

describe('availableBulkActions', () => {
  const groups = groupInboxItems([
    item({ id: 'b1', createdAt: T(10), contextKey: 'blocked', category: 'blocker', entityId: 'e1', unread: true }),
    item({ id: 'm1', createdAt: T(20), contextKey: 'read-mention' }),
    item({ id: 'm2', createdAt: T(30), contextKey: 'unread-mention', unread: true }),
  ]);

  it('offers nothing when nothing is selected', () => {
    expect(availableBulkActions(groups, NO_SELECTION)).toEqual([]);
  });

  it('offers mark-read only when something selected is actually unread', () => {
    const read = availableBulkActions(groups, beginSelection('read-mention'));
    expect(read.map(action => action.id)).toEqual([]);

    const unread = availableBulkActions(groups, beginSelection('unread-mention'));
    expect(unread.map(action => action.id)).toEqual(['mark-read']);
    expect(unread[0].destructive).toBe(false);
  });

  it('offers dismiss only when a blocker is selected, and marks it destructive', () => {
    const actions = availableBulkActions(groups, beginSelection('blocked'));
    expect(actions.map(action => action.id)).toEqual(['mark-read', 'dismiss']);
    const dismiss = actions.find(action => action.id === 'dismiss');
    expect(dismiss).toMatchObject({ destructive: true, count: 1 });
  });

  it('counts dismiss in ITEMS and mark-read in ROWS', () => {
    const stacked = groupInboxItems([
      item({ id: 'b1', createdAt: T(10), contextKey: 'x', category: 'blocker', entityId: 'e1', unread: true }),
      item({ id: 'b2', createdAt: T(20), contextKey: 'x', category: 'blocker', entityId: 'e2', unread: true }),
      item({ id: 'b3', createdAt: T(30), contextKey: 'y', category: 'blocker', entityId: 'e3', unread: true }),
    ]);
    const actions = availableBulkActions(stacked, selectAll(NO_SELECTION, ['x', 'y']));
    expect(actions.find(action => action.id === 'mark-read')?.count).toBe(2);
    expect(actions.find(action => action.id === 'dismiss')?.count).toBe(3);
  });

  it('never offers Resolve — an answer cannot be shared across questions', () => {
    const ids = availableBulkActions(groups, selectAll(NO_SELECTION, ['blocked', 'unread-mention']))
      .map(action => action.id);
    expect(ids).not.toContain('resolve');
  });
});

describe('runBulk', () => {
  it('runs every input and counts successes', async () => {
    const seen: number[] = [];
    const result = await runBulk([1, 2, 3, 4, 5], async value => {
      seen.push(value);
      return true;
    }, 2);
    expect(result).toEqual({ ok: 5, failed: 0 });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await runBulk(Array.from({ length: 12 }, (_, i) => i), async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return true;
    }, 3);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('reports partial failure honestly instead of assuming success', async () => {
    const result = await runBulk(['a', 'b', 'c', 'd'], async value => value !== 'b' && value !== 'd');
    expect(result).toEqual({ ok: 2, failed: 2 });
  });

  it('counts a thrown call as a failure and still finishes the rest', async () => {
    const result = await runBulk([1, 2, 3], async value => {
      if (value === 2) throw new Error('boom');
      return true;
    });
    expect(result).toEqual({ ok: 2, failed: 1 });
  });

  it('handles an empty batch without hanging', async () => {
    expect(await runBulk([], async () => true)).toEqual({ ok: 0, failed: 0 });
  });
});

describe('bulkResultMessage', () => {
  it('says how many of how many, always', () => {
    expect(bulkResultMessage('Dismissed', { ok: 3, failed: 0 })).toBe('Dismissed 3 of 3.');
  });

  it('names the failures rather than rounding them away', () => {
    expect(bulkResultMessage('Dismissed', { ok: 3, failed: 2 })).toBe('Dismissed 3 of 5 — 2 failed.');
  });

  it('does not claim a success when none landed', () => {
    expect(bulkResultMessage('Dismissed', { ok: 0, failed: 4 })).toBe('None of the 4 could be dismissed.');
  });
});
