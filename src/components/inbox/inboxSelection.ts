import type { InboxGroup } from './inboxModel';

// ---------------------------------------------------------------------------
// Bulk selection, as a pure model. No React, no DOM, no clock — same rule as
// inboxModel.ts, so every decision below is unit-testable.
//
// Three things are worth stating up front, because they are the parts a reader
// will otherwise have to reverse-engineer from the renderer:
//
//   1. SELECTION MODE IS DERIVED, not stored. `keys.size > 0` IS the mode. That
//      makes "deselecting the last row leaves selection mode" fall out of the
//      data rather than needing a flag that can disagree with it — there is no
//      state in which the bar is up and nothing is selected.
//
//   2. A ROW IS A GROUP, AND A GROUP IS ITS WHOLE CONVERSATION. The list renders
//      InboxGroups keyed by contextKey, and a group can hold several items. So
//      selecting a row selects every item under it: marking it read advances the
//      one read marker past the group's newest item, and dismissing it resolves
//      EVERY blocker item in the group — not just the lead item whose entityId
//      the group happens to expose. See `dismissableBlockerIds`.
//
//   3. SELECTION ONLY EVER COVERS VISIBLE ROWS. Select-all takes the visible
//      keys, and `pruneSelection` drops anything that has left the list (filter
//      flipped, item resolved, realtime refetch). A bulk action must never touch
//      a row the user cannot see.
// ---------------------------------------------------------------------------

export interface InboxSelection {
  /** Selected group keys (contextKeys). Empty ⇒ not in selection mode. */
  keys: ReadonlySet<string>;
  /**
   * The last row the user touched directly, and the origin a shift-click ranges
   * from. Shift-click does NOT move it, so successive shift-clicks widen the
   * range from the same origin rather than walking it along.
   */
  anchor: string | null;
}

export const NO_SELECTION: InboxSelection = { keys: new Set<string>(), anchor: null };

/** The mode is the data: one selected row means the selection bar is up. */
export function isSelecting(selection: InboxSelection): boolean {
  return selection.keys.size > 0;
}

/** Enter selection mode with one row already selected (the avatar that was clicked). */
export function beginSelection(key: string): InboxSelection {
  return { keys: new Set([key]), anchor: key };
}

export function clearSelection(): InboxSelection {
  return NO_SELECTION;
}

/** Toggle one row. Emptying the set leaves selection mode, so the anchor goes too. */
export function toggleSelection(selection: InboxSelection, key: string): InboxSelection {
  const keys = new Set(selection.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { keys, anchor: keys.size === 0 ? null : key };
}

/**
 * Shift-click: add every row between the anchor and `key`, inclusive, in either
 * direction. With no usable anchor (nothing touched yet, or the anchor has since
 * left the list) this degrades to a plain toggle rather than doing nothing —
 * a shift-click that silently no-ops reads as a broken list.
 */
export function selectRange(
  selection: InboxSelection,
  key: string,
  orderedKeys: readonly string[],
): InboxSelection {
  const to = orderedKeys.indexOf(key);
  if (to < 0) return selection;

  const anchor = selection.anchor;
  const from = anchor === null ? -1 : orderedKeys.indexOf(anchor);
  if (from < 0) return toggleSelection(selection, key);

  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const keys = new Set(selection.keys);
  for (let index = lo; index <= hi; index += 1) keys.add(orderedKeys[index]);
  return { keys, anchor };
}

/** Select every VISIBLE row — with a filter on, that is the filtered set only. */
export function selectAll(
  selection: InboxSelection,
  orderedKeys: readonly string[],
): InboxSelection {
  if (orderedKeys.length === 0) return selection;
  return {
    keys: new Set(orderedKeys),
    anchor: selection.anchor !== null && orderedKeys.includes(selection.anchor)
      ? selection.anchor
      : orderedKeys[0],
  };
}

export function isAllSelected(
  selection: InboxSelection,
  orderedKeys: readonly string[],
): boolean {
  if (orderedKeys.length === 0) return false;
  return orderedKeys.every(key => selection.keys.has(key));
}

/**
 * Drop keys that are no longer in the list. Returns the SAME object when nothing
 * changed — this runs on every data load, and a fresh object each time would
 * re-render the whole list (and, from an effect, loop).
 */
export function pruneSelection(
  selection: InboxSelection,
  visibleKeys: readonly string[],
): InboxSelection {
  if (selection.keys.size === 0) return selection;
  const visible = new Set(visibleKeys);
  const kept: string[] = [];
  selection.keys.forEach(key => {
    if (visible.has(key)) kept.push(key);
  });
  const anchor = selection.anchor !== null && visible.has(selection.anchor) ? selection.anchor : null;
  if (kept.length === selection.keys.size && anchor === selection.anchor) return selection;
  if (kept.length === 0) return NO_SELECTION;
  return { keys: new Set(kept), anchor };
}

/** Selected groups, in list order — never in Set insertion order. */
export function selectedGroups(
  groups: readonly InboxGroup[],
  selection: InboxSelection,
): InboxGroup[] {
  return groups.filter(group => selection.keys.has(group.key));
}

export interface InboxSelectionSummary {
  /** Rows selected. */
  groups: number;
  /** Underlying items across those rows — a row is a conversation, not one message. */
  items: number;
  /** Rows carrying at least one unread item. */
  unreadGroups: number;
  /** Individual blocker items that can be dismissed. */
  blockerItems: number;
}

export function summarizeSelection(
  groups: readonly InboxGroup[],
  selection: InboxSelection,
): InboxSelectionSummary {
  const chosen = selectedGroups(groups, selection);
  return {
    groups: chosen.length,
    items: chosen.reduce((total, group) => total + group.items.length, 0),
    unreadGroups: chosen.filter(group => group.unreadCount > 0).length,
    blockerItems: dismissableBlockerIds(groups, selection).length,
  };
}

/** Group keys to send a read marker for. Already-read rows are skipped, not re-sent. */
export function unreadGroupKeys(
  groups: readonly InboxGroup[],
  selection: InboxSelection,
): string[] {
  return selectedGroups(groups, selection)
    .filter(group => group.unreadCount > 0)
    .map(group => group.key);
}

/**
 * EVERY blocker item under the selected rows, not one per row. A thread that
 * stacked up three questions is one row; dismissing it has to close all three or
 * the row comes straight back with the two nobody answered.
 */
export function dismissableBlockerIds(
  groups: readonly InboxGroup[],
  selection: InboxSelection,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const group of selectedGroups(groups, selection)) {
    for (const item of group.items) {
      if (item.category !== 'blocker') continue;
      const id = item.entityId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// --- Which actions a selection may offer ----------------------------------
//
// Deliberately short. The inbox can do exactly three things to an item:
// mark it read, resolve a blocker WITH an answer, or dismiss a blocker. Only
// two of those survive being applied to a set:
//
//   mark-read   idempotent, reversible-in-spirit, needs no input     -> offered
//   dismiss     needs no input, but retires an agent's question      -> offered, with a confirm
//   resolve     REFUSED. Resolving writes a human answer back for the agent to
//               read; one answer cannot be the answer to five different
//               questions, and the empty-answer case ("Resolve" with a blank
//               box) would silently unblock five agents with nothing to go on.
//               It stays per-item in the detail pane, where the answer belongs.
//
// "Open chat" is also absent: it is per-item navigation, and N of it is N
// windows nobody asked for.

export type InboxBulkActionId = 'mark-read' | 'dismiss';

export interface InboxBulkAction {
  id: InboxBulkActionId;
  label: string;
  /** How many underlying things this would touch — shown in the confirm copy. */
  count: number;
  /** Destructive actions must be confirmed before they run. */
  destructive: boolean;
}

export function availableBulkActions(
  groups: readonly InboxGroup[],
  selection: InboxSelection,
): InboxBulkAction[] {
  if (!isSelecting(selection)) return [];
  const actions: InboxBulkAction[] = [];

  const unread = unreadGroupKeys(groups, selection).length;
  if (unread > 0) {
    actions.push({ id: 'mark-read', label: 'Mark read', count: unread, destructive: false });
  }

  const blockers = dismissableBlockerIds(groups, selection).length;
  if (blockers > 0) {
    actions.push({ id: 'dismiss', label: 'Dismiss', count: blockers, destructive: true });
  }

  return actions;
}

// --- Running a bulk action ------------------------------------------------

export interface BulkRunResult {
  ok: number;
  failed: number;
}

/**
 * Every mutation the inbox owns is per-item, so a bulk action is N calls. Run
 * them a few at a time — a 50-row select-all firing 50 simultaneous requests is
 * how you get rate-limited into a half-applied batch — and count the failures
 * rather than assuming success. A rejected promise counts as a failure, never as
 * a crash: one bad row must not abandon the other forty-nine.
 */
export async function runBulk<T>(
  inputs: readonly T[],
  task: (input: T) => Promise<boolean>,
  concurrency = 4,
): Promise<BulkRunResult> {
  let ok = 0;
  let failed = 0;
  let cursor = 0;

  const lanes = Math.max(1, Math.min(concurrency, inputs.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= inputs.length) return;
        let success = false;
        try {
          success = await task(inputs[index]);
        } catch {
          success = false;
        }
        if (success) ok += 1;
        else failed += 1;
      }
    }),
  );

  return { ok, failed };
}

/**
 * Honest one-liner for the result of a batch — never "done" when some failed.
 * `verb` is past tense ("Dismissed", "Marked read"), because that is what the
 * message is reporting: what happened, not what was attempted.
 */
export function bulkResultMessage(verb: string, result: BulkRunResult): string {
  const total = result.ok + result.failed;
  if (result.failed === 0) return `${verb} ${result.ok} of ${total}.`;
  if (result.ok === 0) return `None of the ${total} could be ${verb.toLowerCase()}.`;
  return `${verb} ${result.ok} of ${total} — ${result.failed} failed.`;
}
