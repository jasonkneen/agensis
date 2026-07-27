import { workspaceInitials, workspaceTileColor } from './workspaceRail';

/**
 * The two-tier "workspaces above, desktops below" overlay's decisions, with no
 * React and no DOM.
 *
 * The model this paints:
 *
 * - A **workspace** is a project. It owns the agents, channels, DMs, documents,
 *   tasks and memory. The far-left rail switches between them.
 * - A **desktop** is a configuration *inside* one workspace: window positions,
 *   wallpaper, applets. It owns no content — the same channels and agents are
 *   there whichever desktop you are on. You are on exactly one at a time.
 *
 * They are stored in `canvas_layers` and the code calls them canvases/layers;
 * that stays, because renaming the schema buys the user nothing. But "layer" was
 * the wrong word to show anyone: layers composite, stacking and showing through
 * each other, and these are mutually exclusive. The word promised a model the
 * thing does not have, and the old overlay then labelled the grid of them "All
 * workspaces" — so an account with three real workspaces opened it and saw one
 * tile called "Workspace 1".
 *
 * The load-bearing rule here is the pairing invariant: **desktops are only ever
 * listed under the workspace they belong to.** App loads them for the ACTIVE
 * workspace only (`useCanvasLayers(activeWorkspaceId)`), and that array does not
 * change in the same render as the workspace id — so for at least one painted
 * frame after a switch, the list is the PREVIOUS workspace's. Rather than trust
 * the caller to notice, this module takes the workspace id the list was actually
 * loaded for and refuses to pair them when it disagrees: the tier reports
 * `pending` and an empty list. A spinner for one frame; never a lie.
 */

/** An account-level `workspaces` row — a project. */
export interface OverlayWorkspace {
  id: string;
  name: string;
  /** The System workspace (feedback triage). Grouped apart, same as the rail. */
  is_system?: boolean;
}

/** A `canvas_layers` row — one desktop inside a workspace. */
export interface OverlayDesktop {
  id: string;
  name: string;
}

/** Anything placed on a desktop: a `canvas_objects` row. */
export interface OverlayObject {
  layer_id?: string | null;
}

/** An open floating window, which remembers the desktop it belongs to. */
export interface OverlayWindow {
  canvasId?: string | null;
  minimized?: boolean;
}

export interface OverlayWorkspaceTile {
  id: string;
  /** Full name — the tile's label and its accessible name. */
  name: string;
  /** The 1–2 characters the tile paints. Never an emoji; see `workspaceGlyph`. */
  initials: string;
  /** Solid tile fill, the same colour the rail gives this workspace. */
  color: string;
  isSystem: boolean;
  /** True for the workspace whose desktops the bottom tier is showing. */
  active: boolean;
}

export interface OverlayDesktopTile {
  id: string;
  name: string;
  /** `canvas_objects` sitting on this desktop. */
  itemCount: number;
  /** Open, non-minimized windows on this desktop. */
  windowCount: number;
  active: boolean;
  /** Main is the workspace's floor — it cannot be removed. */
  canDelete: boolean;
}

/**
 * - `ready`  — the desktops below genuinely belong to the workspace named above.
 * - `pending`— they do not (yet); the list is empty and the UI should say so.
 * - `empty`  — they do belong, and there are none.
 */
export type DesktopTierState = 'ready' | 'pending' | 'empty';

export interface DesktopOverlayModel {
  /** Ordinary workspaces, in the order the caller supplied them. */
  workspaces: OverlayWorkspaceTile[];
  /** `is_system` workspaces, rendered below a divider. Usually 0 or 1. */
  systemWorkspaces: OverlayWorkspaceTile[];
  /** The workspace the bottom tier belongs to. Null only when there are none. */
  selectedWorkspaceId: string | null;
  /** What to write above the desktop grid. Never blank. */
  selectedWorkspaceName: string;
  desktops: OverlayDesktopTile[];
  desktopTier: DesktopTierState;
}

/** Shown when a workspace has no desktops at all, and while one is loading. */
export const DESKTOP_TIER_EMPTY_MESSAGE = 'No desktops in this workspace yet';
export const DESKTOP_TIER_PENDING_MESSAGE = 'Loading desktops…';

/** Every workspace's first desktop. Not "Desktop 1" — there is no Desktop 1. */
export const FIRST_DESKTOP_NAME = 'Main';

/**
 * Name for a desktop the user just created.
 *
 * The first one is **Main**; numbering starts at the second, so a workspace
 * reads "Main, Desktop 2, Desktop 3". Every workspace's first layer used to be
 * called "Workspace 1", which is most of why the two concepts were impossible
 * to tell apart.
 *
 * The number is the first one free rather than `list.length + 1`, which
 * collides after a delete: Main + Desktop 2, remove Desktop 2, create twice and
 * you get "Desktop 2" twice. Two tiles with the same label in a grid you
 * navigate by label is a real ambiguity.
 */
export function defaultDesktopName(existing: readonly { name?: string | null }[]): string {
  if (existing.length === 0) return FIRST_DESKTOP_NAME;
  const taken = new Set(existing.map(item => String(item.name ?? '').trim()));
  let index = 2;
  while (taken.has(`Desktop ${index}`)) index += 1;
  return `Desktop ${index}`;
}

/**
 * Which workspace the bottom tier describes.
 *
 * `activeWorkspaceId` can name a workspace that is no longer in the list — it is
 * restored from localStorage and can outlive the account's membership — so "the
 * id matches nothing" is a normal state. It resolves to the first ordinary
 * workspace, never the System one: landing a user in the feedback-triage
 * workspace reads as their data having vanished.
 */
export function resolveOverlayWorkspaceId(
  workspaces: readonly OverlayWorkspace[],
  selectedId: string | null | undefined,
): string | null {
  if (workspaces.length === 0) return null;
  const wanted = String(selectedId ?? '');
  if (wanted && workspaces.some(w => w.id === wanted)) return wanted;
  const ordinary = workspaces.find(w => w.is_system !== true);
  return (ordinary || workspaces[0]).id;
}

function workspaceTile(
  workspace: OverlayWorkspace,
  activeId: string | null,
): OverlayWorkspaceTile {
  return {
    id: workspace.id,
    name: String(workspace.name ?? '').trim() || 'Untitled workspace',
    initials: workspaceInitials(workspace.name),
    color: workspaceTileColor(workspace),
    isSystem: workspace.is_system === true,
    active: workspace.id === activeId,
  };
}

export interface DesktopOverlayInput {
  /** Every workspace on the account. */
  workspaces: readonly OverlayWorkspace[];
  /** The workspace whose desktops should be listed below. */
  selectedWorkspaceId: string | null | undefined;
  /** The desktops the app currently has loaded. */
  desktops: readonly OverlayDesktop[];
  /**
   * The workspace `desktops` was loaded for. When this is not the selected
   * workspace the two are NOT paired — see the pairing invariant above.
   */
  desktopsWorkspaceId: string | null | undefined;
  /** The desktop currently open in the app. */
  activeDesktopId?: string | null;
  /** The base desktop id — Main, the one a workspace cannot be without. */
  baseDesktopId?: string | null;
  objects?: readonly OverlayObject[];
  windows?: readonly OverlayWindow[];
}

/**
 * The whole overlay: workspaces on top, the selected workspace's desktops below.
 *
 * Workspace order is the caller's order untouched (the workspaces route sorts by
 * `updated_at desc`; re-sorting here would make tiles hop under the pointer).
 * The only regrouping is the System partition, which is a stable filter.
 */
export function buildDesktopOverlay(input: DesktopOverlayInput): DesktopOverlayModel {
  const {
    workspaces,
    selectedWorkspaceId,
    desktops,
    desktopsWorkspaceId,
    activeDesktopId = null,
    baseDesktopId = null,
    objects = [],
    windows = [],
  } = input;

  const resolvedId = resolveOverlayWorkspaceId(workspaces, selectedWorkspaceId);

  const workspaceTiles: OverlayWorkspaceTile[] = [];
  const systemTiles: OverlayWorkspaceTile[] = [];
  for (const workspace of workspaces) {
    const tile = workspaceTile(workspace, resolvedId);
    (tile.isSystem ? systemTiles : workspaceTiles).push(tile);
  }

  const selectedName =
    [...workspaceTiles, ...systemTiles].find(tile => tile.id === resolvedId)?.name || 'Workspace';

  // The pairing invariant. Normalised through String() because one side comes
  // from a hook (null before a workspace loads) and the other from App state
  // (the empty string before one is chosen) — untreated, '' !== null would keep
  // the tier pending forever on a fresh, workspace-less account.
  const paired = String(desktopsWorkspaceId ?? '') === String(resolvedId ?? '');
  if (!paired) {
    return {
      workspaces: workspaceTiles,
      systemWorkspaces: systemTiles,
      selectedWorkspaceId: resolvedId,
      selectedWorkspaceName: selectedName,
      desktops: [],
      desktopTier: 'pending',
    };
  }

  const itemCounts = new Map<string, number>();
  for (const object of objects) {
    const id = object.layer_id || baseDesktopId || 'base';
    itemCounts.set(id, (itemCounts.get(id) || 0) + 1);
  }
  // A minimized window is not on the desktop as far as the user is concerned —
  // the tile's preview shows what you would SEE if you went there.
  const windowCounts = new Map<string, number>();
  for (const win of windows) {
    if (win.minimized) continue;
    const id = win.canvasId || baseDesktopId || 'base';
    windowCounts.set(id, (windowCounts.get(id) || 0) + 1);
  }

  const desktopTiles: OverlayDesktopTile[] = desktops.map(desktop => ({
    id: desktop.id,
    name: String(desktop.name ?? '').trim() || 'Untitled desktop',
    itemCount: itemCounts.get(desktop.id) || 0,
    windowCount: windowCounts.get(desktop.id) || 0,
    active: desktop.id === activeDesktopId,
    canDelete: desktop.id !== baseDesktopId,
  }));

  return {
    workspaces: workspaceTiles,
    systemWorkspaces: systemTiles,
    selectedWorkspaceId: resolvedId,
    selectedWorkspaceName: selectedName,
    desktops: desktopTiles,
    desktopTier: desktopTiles.length === 0 ? 'empty' : 'ready',
  };
}

/** Flattened order for the top tier: ordinary workspaces, then System. */
export function overlayWorkspaceOrder(model: DesktopOverlayModel): OverlayWorkspaceTile[] {
  return [...model.workspaces, ...model.systemWorkspaces];
}
