import { agentAccentPaletteColor, hashString } from './agentAccent';
import { WORKSPACE_RAIL_WIDTH } from './workspaceLayout';
/**
 * The workspace switcher rail's decisions, with no React and no DOM.
 *
 * Everything here is about what a tile *says* and where it *sits* — the glyph,
 * the fallback initials, which tile reads as active, which workspaces get
 * pushed below the divider, and how wide the rail is allowed to be. The
 * component is then a thin painter over this.
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

/* --------------------------------------------------------------------------
 * Width
 *
 * The rail drags between two useful shapes: an icon strip, and a column wide
 * enough to carry a workspace name plus its canvases. The band in between is
 * the problem — 90px is wide enough to look deliberate and too narrow to read,
 * so a drag that lands there is snapped to one end rather than left as a
 * sliver. Everything downstream (the canvas viewport's left inset, the
 * traffic-light clearance) is arithmetic off this number, so it is clamped in
 * one place instead of at each call site.
 * ----------------------------------------------------------------------- */

/** Icon-only. Same 52px the rail has always been; see WORKSPACE_RAIL_WIDTH. */
export const WORKSPACE_RAIL_COLLAPSED_WIDTH = WORKSPACE_RAIL_WIDTH;

/**
 * Narrowest the rail may be while showing names. Below this a name is all
 * ellipsis, so there is no width between the collapsed strip and this that is
 * worth offering.
 */
export const WORKSPACE_RAIL_MIN_EXPANDED_WIDTH = 168;

/** Widest. Past this the rail is competing with the sidebar for the same job. */
export const WORKSPACE_RAIL_MAX_WIDTH = 320;

/** Where an unconfigured rail opens to when expanded by double-click. */
export const WORKSPACE_RAIL_DEFAULT_EXPANDED_WIDTH = 208;

/**
 * Drag below this and the rail snaps shut. It sits between the collapsed width
 * and the minimum expanded width so both directions are reachable without the
 * pointer having to travel the whole gap.
 */
export const WORKSPACE_RAIL_SNAP_WIDTH = 110;

/**
 * A raw drag width made legal: either exactly collapsed, or somewhere in the
 * expanded band. Nothing in between is representable, which is what stops a
 * half-dragged rail existing at all.
 */
export function clampWorkspaceRailWidth(width: number): number {
  if (!Number.isFinite(width) || width < WORKSPACE_RAIL_SNAP_WIDTH) {
    return WORKSPACE_RAIL_COLLAPSED_WIDTH;
  }
  return Math.round(
    Math.min(WORKSPACE_RAIL_MAX_WIDTH, Math.max(WORKSPACE_RAIL_MIN_EXPANDED_WIDTH, width)),
  );
}

/** True when the rail is wide enough to carry workspace names beside the tiles. */
export function isWorkspaceRailExpanded(width: number): boolean {
  return clampWorkspaceRailWidth(width) > WORKSPACE_RAIL_COLLAPSED_WIDTH;
}

/**
 * The persisted width, read back. A missing or junk value is the collapsed
 * rail — the shape the app has always had, so an upgrade changes nothing until
 * the user drags.
 */
export function readWorkspaceRailWidth(stored: string | null | undefined): number {
  return clampWorkspaceRailWidth(Number.parseFloat(String(stored ?? '')));
}

/** Double-clicking the resize handle toggles between the two shapes. */
export function toggleWorkspaceRailWidth(width: number): number {
  return isWorkspaceRailExpanded(width)
    ? WORKSPACE_RAIL_COLLAPSED_WIDTH
    : WORKSPACE_RAIL_DEFAULT_EXPANDED_WIDTH;
}

/**
 * One arrow-key step on the resize handle.
 *
 * A pointer crosses the dead band in one gesture; a keyboard cannot, because
 * every step starts from the last CLAMPED width. Nudging right from a collapsed
 * rail by 24px lands on 76, which clamps straight back to 52 — the rail would be
 * keyboard-unresizable, which is how this was first written and how it was
 * caught. So a step that would land inside the band steps over it instead.
 */
export function nudgeWorkspaceRailWidth(width: number, delta: number): number {
  const current = clampWorkspaceRailWidth(width);
  if (delta > 0 && current === WORKSPACE_RAIL_COLLAPSED_WIDTH) return WORKSPACE_RAIL_MIN_EXPANDED_WIDTH;
  if (delta < 0 && current <= WORKSPACE_RAIL_MIN_EXPANDED_WIDTH) return WORKSPACE_RAIL_COLLAPSED_WIDTH;
  return clampWorkspaceRailWidth(current + delta);
}

/* --------------------------------------------------------------------------
 * Desktops are NOT in this file, on purpose.
 *
 * An earlier version of the rail disclosed each workspace's desktops beneath
 * its tile. It was removed once the model was settled: a workspace is a
 * PROJECT (its own agents, channels, documents); a desktop is a saved view *of*
 * the workspace you are already in — window positions, wallpaper, applets — and
 * every piece of content is identical whichever desktop you are on.
 *
 * Nesting desktops under workspaces in one tree asserts that they are the same
 * kind of thing one level apart, and users would reason from that and be wrong
 * ("are my channels per-desktop?"). The rail is a flat list of projects.
 *
 * A desktop switcher belongs in the workspace's own chrome, beside the desktop
 * name the sidebar header already renders. Whoever builds it will want the one
 * idea worth keeping from the removed code: desktops load per-workspace
 * (`useCanvasLayers(activeWorkspaceId)`), so a list must travel STAMPED with
 * the workspace id it was loaded for, and be refused by any other workspace —
 * otherwise one workspace's desktops end up labelled with another's name.
 * ----------------------------------------------------------------------- */
