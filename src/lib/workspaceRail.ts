import { agentAccentPaletteColor, hashString } from './agentAccent';
/**
 * The workspace switcher rail's decisions, with no React and no DOM.
 *
 * Everything here is about what a tile *says* and where it *sits* — the glyph,
 * the fallback initials, which tile reads as active, and which workspaces get
 * pushed below the divider. The component is then a thin painter over this.
 *
 * The subtle one is the glyph. `workspaces.icon` is a free-text column the user
 * types into (the create dialog's Icon field is a plain `<input maxLength=4>`),
 * so it can be an emoji, a letter, whitespace, or nothing at all. A rail that
 * trusts it renders blank tiles for every workspace created before the field
 * existed — hence the initials fallback, and hence the grapheme cap so a pasted
 * string can't blow the tile out.
 */

export interface WorkspaceRailSource {
  id: string;
  name: string;
  icon?: string | null;
  /** The System workspace (feedback triage). An ordinary workspace, grouped apart. */
  is_system?: boolean;
}

export interface WorkspaceRailTile {
  id: string;
  /** Full name — the tooltip and the accessible label. */
  name: string;
  /** The 1–2 characters the tile paints. */
  glyph: string;
  /** True when the glyph came from the `icon` column rather than the name. */
  fromIcon: boolean;
  isSystem: boolean;
  /** Solid tile fill, stable per workspace. */
  color: string;
  active: boolean;
}

export interface WorkspaceRailModel {
  /** Ordinary workspaces, in the order the caller supplied them. */
  tiles: WorkspaceRailTile[];
  /** `is_system` workspaces, rendered below a divider. Usually 0 or 1. */
  systemTiles: WorkspaceRailTile[];
  /** The id that reads as active — null when there is nothing to activate. */
  activeId: string | null;
}

/** Longest run of characters a tile will paint, icon or initials. */

/** Splits a workspace name into words. Hyphens and underscores count as spaces. */
const WORD_SEPARATORS = /[\s\-_/\\.·|,:;]+/;

/** Leading decoration (emoji, punctuation, digits-as-bullets) before the real name. */
const LEADING_NON_LETTERS = /^[^\p{L}\p{N}]+/u;

/**
 * Characters, not code units — `Array.from` splits surrogate pairs correctly, so
 * a single astral-plane emoji counts as one. It does NOT keep ZWJ sequences
 * (👨‍👩‍👧 is 5 code points) together, which is why the cap is applied to the
 * *icon* only after we've already decided the icon is what we're painting: a
 * clipped family emoji is cosmetic, a clipped name is a wrong label.
 */
function graphemes(value: string): string[] {
  return Array.from(value);
}

function firstGrapheme(value: string): string {
  return graphemes(value)[0] || '';
}

/**
 * Initials for a workspace with no usable icon.
 *
 * - Two or more words → the first letter of the first two ("My Cool Space" → "MC").
 * - One word → its first two letters ("Personal" → "Pe"), which reads better in a
 *   40px tile than a single lonely capital.
 * - Emoji-prefixed ("🌱 Garden") → the emoji is stripped and "Ga" wins; the icon
 *   column is the place for a picture, not the name.
 * - Nothing lettered at all ("🌱", "···") → the first character verbatim, so an
 *   emoji-only name still paints something rather than a blank tile.
 */
export function workspaceInitials(name: string | null | undefined): string {
  const raw = String(name ?? '').trim();
  if (!raw) return '?';

  const words = raw
    .split(WORD_SEPARATORS)
    .map(word => word.replace(LEADING_NON_LETTERS, ''))
    .filter(word => word.length > 0);

  if (words.length === 0) return firstGrapheme(raw);
  if (words.length === 1) {
    return graphemes(words[0]).slice(0, 2).join('').toUpperCase();
  }
  return (firstGrapheme(words[0]) + firstGrapheme(words[1])).toUpperCase();
}

/**
 * What this workspace's tile paints, and whether it came from the icon column.
 * The caller wants both: an icon is centred as-is, initials get the tracking and
 * weight of a text tile.
 */
/**
 * A tile's letters. ALWAYS initials — never the workspace's emoji.
 *
 * The rail is chrome, and emoji in chrome renders as a different typeface at a
 * different weight on every platform, so a row of tiles stops looking like one
 * control. Slack's solid-colour-plus-letters is the pattern this follows, and
 * it is also legible at 20px in a way a colour emoji is not.
 *
 * `icon` is deliberately ignored rather than removed from the type: it is still
 * the workspace's own emoji elsewhere, and a picker for a real image is coming.
 */
export function workspaceGlyph(
  workspace: Pick<WorkspaceRailSource, 'name' | 'icon'>,
): { glyph: string; fromIcon: boolean } {
  return { glyph: workspaceInitials(workspace.name), fromIcon: false };
}

/**
 * The tile's solid fill, derived from the workspace id so it is stable across
 * reloads and devices, and distinct between neighbours. Same palette and hash
 * the agent avatars use, so the two never disagree about what colour a thing is.
 */
export function workspaceTileColor(
  workspace: Pick<WorkspaceRailSource, 'id' | 'name'>,
): string {
  return agentAccentPaletteColor(hashString(`${workspace.id || ''}:${workspace.name || ''}`));
}

/**
 * Which workspace the rail should mark active.
 *
 * `activeWorkspaceId` in App starts as '' and can outlive the workspace it names
 * (deleted in another tab, or a stored id from an account you've since left), so
 * "the id doesn't match anything" is a normal state, not an error — it resolves
 * to the first workspace, matching the fallback App already runs. Returns null
 * only when there are no workspaces at all.
 */
export function resolveActiveWorkspaceId(
  workspaces: readonly WorkspaceRailSource[],
  activeId: string | null | undefined,
): string | null {
  if (workspaces.length === 0) return null;
  const wanted = String(activeId ?? '');
  if (wanted && workspaces.some(w => w.id === wanted)) return wanted;
  // Falling back to workspaces[0] would land you in the SYSTEM workspace
  // whenever it sorts first, which it does the moment a feedback report touches
  // it — the list is ordered by updated_at. The feedback inbox is a destination
  // you go to on purpose, never somewhere you are put. Landing a user in an
  // empty workspace reads as their data having vanished; that happened.
  const ordinary = workspaces.find(w => w.is_system !== true);
  return (ordinary || workspaces[0]).id;
}

/**
 * The id to open on a cold load: the one the user was last in, if they still
 * have it, else the first. Kept here (rather than inline in App) so the
 * "stored id points at a workspace you no longer have" case is covered by a
 * test instead of by hope.
 */
export function pickInitialWorkspaceId(
  storedId: string | null | undefined,
  workspaces: readonly WorkspaceRailSource[],
): string | null {
  return resolveActiveWorkspaceId(workspaces, storedId);
}

/**
 * The full rail model.
 *
 * Order is the caller's order, untouched — the workspaces route already sorts by
 * `updated_at desc`, and re-sorting here would make tiles hop around under the
 * pointer every time an unrelated write touched a workspace row. The only
 * reordering is the System partition, which is a stable filter (relative order
 * within each group is preserved).
 */
export function buildWorkspaceRail(
  workspaces: readonly WorkspaceRailSource[],
  activeId: string | null | undefined,
): WorkspaceRailModel {
  const resolvedActive = resolveActiveWorkspaceId(workspaces, activeId);
  const tiles: WorkspaceRailTile[] = [];
  const systemTiles: WorkspaceRailTile[] = [];

  for (const workspace of workspaces) {
    const { glyph, fromIcon } = workspaceGlyph(workspace);
    const tile: WorkspaceRailTile = {
      color: workspaceTileColor(workspace),
      id: workspace.id,
      name: String(workspace.name ?? '').trim() || 'Untitled workspace',
      glyph,
      fromIcon,
      isSystem: workspace.is_system === true,
      active: workspace.id === resolvedActive,
    };
    (tile.isSystem ? systemTiles : tiles).push(tile);
  }

  return { tiles, systemTiles, activeId: resolvedActive };
}

/**
 * Flattened focus order for the rail's roving tabindex: ordinary tiles, then the
 * System group. Arrow keys walk this; the divider is not a stop.
 */
export function workspaceRailFocusOrder(model: WorkspaceRailModel): WorkspaceRailTile[] {
  return [...model.tiles, ...model.systemTiles];
}

/**
 * Where an Arrow/Home/End keystroke lands, as an index into
 * `workspaceRailFocusOrder`. Wraps at both ends — a 3-tile rail is short enough
 * that stopping dead at the bottom just feels broken. Returns null for keys the
 * rail does not own, so the caller knows not to preventDefault.
 */
export function workspaceRailKeyTarget(
  key: string,
  currentIndex: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  const from = currentIndex >= 0 && currentIndex < count ? currentIndex : 0;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return (from + 1) % count;
    case 'ArrowUp':
    case 'ArrowLeft':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
