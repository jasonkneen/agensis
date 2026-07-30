// Renaming a workspace or a desktop.
//
// Small enough to be tempting to inline, and exactly the kind of thing that
// goes subtly wrong in ways nobody notices until a tile is blank or an
// abandoned edit got saved. Kept pure so the rules are tested rather than
// re-argued at every call site.

/** Long enough for a real name, short enough that a pasted paragraph cannot break a tile. */
export const RENAME_MAX_CHARS = 60;

export type RenameOutcome =
  /** Commit this value. */
  | { action: 'commit'; name: string }
  /** Nothing changed — close the editor without touching the network. */
  | { action: 'noop' }
  /** Not a usable name; restore what was there. */
  | { action: 'reject'; reason: string };

/**
 * What should happen when a rename is submitted.
 *
 * Deliberately NOT "is this valid" — the interesting answers are the two that
 * are neither valid nor invalid: an unchanged name (must not write) and a
 * whitespace-only one (must not blank the tile).
 */
export function resolveRename(nextRaw: string, current: string): RenameOutcome {
  const next = nextRaw.replace(/\s+/g, ' ').trim().slice(0, RENAME_MAX_CHARS);
  if (!next) {
    // A blank name leaves a tile the user can no longer identify, and the rail
    // is icons-only when collapsed — there would be nothing at all to click.
    return { action: 'reject', reason: 'A name is required' };
  }
  // Compared AFTER normalising, so committing "  Work  " over "Work" is
  // correctly a no-op rather than a pointless round trip that bumps updated_at
  // — and updated_at ordering decides which workspace you land in.
  if (next === current.replace(/\s+/g, ' ').trim()) return { action: 'noop' };
  return { action: 'commit', name: next };
}

/**
 * Whether a blur should commit.
 *
 * Escape sets `cancelled` first, and blur fires afterwards because closing the
 * editor moves focus. If blur committed unconditionally, Escape would SAVE the
 * edit it was supposed to discard — the same cancel-before-read ordering bug
 * this codebase already hit in the visual editor. Cancel always wins.
 */
export function shouldCommitOnBlur(cancelled: boolean): boolean {
  return !cancelled;
}
