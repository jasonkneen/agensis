/**
 * Per-user VIEW preferences for the workspace switcher rail: which workspaces
 * the user has hidden from their own sidebar, and the order they want the tiles
 * in. No React, no DOM, no network — pure functions over an id list, so the
 * decisions are unit-tested here and the component/App are thin.
 *
 * Why client-side (localStorage) and not the server: hiding and ordering are
 * personal view state, not workspace data. "Remove from sidebar" must be
 * reversible with nothing destroyed — the workspace, its channels, agents and
 * members are all untouched; only *this browser* stops showing the tile, and
 * the user re-adds it from the rail's Hidden list. Ordering is the same kind of
 * preference the rail width already keeps here. A soft *delete* (destroying the
 * workspace, recoverably) is a different, server-side operation and is
 * deliberately NOT in this file.
 *
 * The System workspace is never hideable and never reordered: it is a triage
 * destination the rail already partitions below a divider, and letting a user
 * hide the place feedback lands would strand reports with no visible inbox.
 */

/** localStorage key: JSON array of workspace ids the user has hidden. */
export const WORKSPACE_RAIL_HIDDEN_KEY = 'agensis.workspaceRail.hidden';
/** localStorage key: JSON array of workspace ids in the user's chosen order. */
export const WORKSPACE_RAIL_ORDER_KEY = 'agensis.workspaceRail.order';

/** The one shape these helpers need: an identifiable workspace-like row. */
export interface RailOrderable {
  id: string;
  is_system?: boolean;
}

/**
 * Parse a stored value into a clean id list. A junk value (null, not-an-array,
 * non-string entries, duplicates) degrades to "no preference" rather than
 * throwing — a corrupt key must never blank the rail. Order and dedupe are
 * preserved: first occurrence wins.
 */
export function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/** A minimal storage surface, so tests can pass a fake and SSR can pass null. */
export interface RailPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** window.localStorage, or null where it is unavailable (SSR, locked-down). */
function defaultStorage(): RailPrefsStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readHiddenWorkspaceIds(storage: RailPrefsStorage | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    return parseIdList(storage.getItem(WORKSPACE_RAIL_HIDDEN_KEY));
  } catch {
    return [];
  }
}

export function readWorkspaceOrder(storage: RailPrefsStorage | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    return parseIdList(storage.getItem(WORKSPACE_RAIL_ORDER_KEY));
  } catch {
    return [];
  }
}

export function writeHiddenWorkspaceIds(ids: string[], storage: RailPrefsStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_RAIL_HIDDEN_KEY, JSON.stringify(ids));
  } catch {
    /* best effort — a full/blocked store just loses the preference */
  }
}

export function writeWorkspaceOrder(ids: string[], storage: RailPrefsStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_RAIL_ORDER_KEY, JSON.stringify(ids));
  } catch {
    /* best effort */
  }
}

/**
 * Apply a saved order to a list of workspaces.
 *
 * Items whose id appears in `order` are placed in that sequence. Items NOT in
 * `order` — a workspace created since the order was saved — keep their incoming
 * relative order and sit at the TOP, because the incoming list is `updated_at
 * desc` (newest first) and a freshly-made workspace surfacing at the top is
 * what the user expects, not buried under a stale saved order. The sort is
 * stable and never drops or duplicates a row.
 */
export function orderWorkspaces<T extends RailOrderable>(items: readonly T[], order: readonly string[]): T[] {
  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  const known: T[] = [];
  const unknown: T[] = [];
  for (const item of items) {
    (rank.has(item.id) ? known : unknown).push(item);
  }
  known.sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number));
  return [...unknown, ...known];
}

/**
 * Split workspaces into what the rail shows and what the user has hidden.
 *
 * The System workspace is force-visible: it is never in the hidden set even if
 * a stale id says so. Visible ordinary workspaces come back ordered by the
 * saved order; system workspaces are appended untouched (the rail re-partitions
 * them below its divider, so their position in this array does not matter).
 * `hidden` preserves incoming order so the restore list is stable.
 */
export function partitionWorkspaceRail<T extends RailOrderable>(
  workspaces: readonly T[],
  hiddenIds: readonly string[],
  order: readonly string[],
): { rail: T[]; hidden: T[] } {
  const hiddenSet = new Set(hiddenIds);
  const system: T[] = [];
  const visibleOrdinary: T[] = [];
  const hidden: T[] = [];
  for (const ws of workspaces) {
    if (ws.is_system === true) {
      system.push(ws);
      continue;
    }
    if (hiddenSet.has(ws.id)) {
      hidden.push(ws);
    } else {
      visibleOrdinary.push(ws);
    }
  }
  return { rail: [...orderWorkspaces(visibleOrdinary, order), ...system], hidden };
}

/**
 * Move one id up or down within a full ordered id list, returning a new list.
 *
 * `'up'` moves it toward index 0. A move off either end, or an id not in the
 * list, is a no-op returning the same sequence — the caller can persist the
 * result unconditionally.
 */
export function moveInOrder(orderedIds: readonly string[], id: string, direction: 'up' | 'down'): string[] {
  const ids = [...orderedIds];
  const index = ids.indexOf(id);
  if (index < 0) return ids;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= ids.length) return ids;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return ids;
}

/**
 * Move one id so it sits immediately before or after another id, returning a
 * new list. This is the drag-and-drop counterpart to `moveInOrder` (which is the
 * one-step keyboard/menu move): a drag can jump a tile across the whole rail in
 * a single gesture, so the drop is expressed relative to the tile it landed on
 * rather than as a series of swaps.
 *
 * `draggedId === targetId`, an unknown dragged id, or an unknown target is a
 * no-op returning a copy — the caller can persist the result unconditionally.
 * The dragged id is removed BEFORE the target's index is read, so "after the
 * last tile" and "before the first tile" both land correctly regardless of where
 * the dragged tile started.
 */
export function moveRelativeTo(
  orderedIds: readonly string[],
  draggedId: string,
  targetId: string,
  place: 'before' | 'after',
): string[] {
  if (draggedId === targetId || orderedIds.indexOf(draggedId) < 0) return [...orderedIds];
  const without = orderedIds.filter(id => id !== draggedId);
  const targetIndex = without.indexOf(targetId);
  if (targetIndex < 0) return [...orderedIds];
  const insertAt = place === 'before' ? targetIndex : targetIndex + 1;
  without.splice(insertAt, 0, draggedId);
  return without;
}

/** Add an id to the hidden set (idempotent), returning a new list. */
export function addHidden(hiddenIds: readonly string[], id: string): string[] {
  return hiddenIds.includes(id) ? [...hiddenIds] : [...hiddenIds, id];
}

/** Remove an id from the hidden set (idempotent), returning a new list. */
export function removeHidden(hiddenIds: readonly string[], id: string): string[] {
  return hiddenIds.filter(existing => existing !== id);
}
