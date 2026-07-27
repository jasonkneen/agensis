/**
 * "Show desktop" — put the open panels away so the wallpaper and the home
 * composer are all that is left, and bring them back on a second press.
 *
 * ## Why this is not called "Desktop"
 *
 * A **desktop** already means something here: one `canvas_layers` row, a
 * configuration inside a workspace that you switch between (see
 * `desktopOverlay.ts`). This module does not switch, create or clear one — it
 * acts *on the one you are already on*. So the control is a verb phrase,
 * "Show desktop", the same gesture macOS and Windows spell that way; it borrows
 * the existing noun rather than minting a second meaning for it.
 *
 * ## Minimise, not close
 *
 * Every window this puts away is **minimised**: it stays mounted, keeps its
 * scroll position and its half-typed message, and is still one click away in
 * the dock. Closing would be the destructive reading of the same gesture — a
 * sidebar row that silently ended a conversation someone was mid-way through.
 * There is deliberately no third "hidden" flag: the dock, the desktop overlay's
 * window counts and the full-expand guard all already read `minimized`, and a
 * parallel state would have to be taught to every one of them.
 *
 * ## The rule, in one sentence
 *
 * **Show desktop puts away everything on this desktop; pressing it again brings
 * back exactly what it put away.**
 *
 * That makes the second press safe in the case that actually bites: you show the
 * desktop, then open something new. The new window is visible, so the next press
 * puts *it* away too and adds it to the same stash — it is never clobbered, and
 * the press after that restores the whole set. Windows you minimised yourself
 * are not in the stash and are left exactly where you put them.
 *
 * The stash is keyed by desktop, because windows are not: switching desktops
 * leaves the other one's windows open, and a single shared list would restore
 * them onto the wrong wallpaper.
 */

/** The parts of a `FloatingWindow` this decision needs. */
export interface ShowDesktopWindow {
  id: string;
  canvasId?: string | null;
  minimized?: boolean;
}

/** Window ids the button put away, keyed by the desktop they belong to. */
export type ShowDesktopStash = Readonly<Record<string, readonly string[]>>;

export interface ShowDesktopDecision {
  /**
   * - `hide`    — minimise `windowIds`.
   * - `restore` — un-minimise `windowIds`.
   * - `none`    — an empty desktop with nothing stashed. The press does nothing.
   */
  action: 'hide' | 'restore' | 'none';
  /** Always only windows on this desktop, and always in need of the action. */
  windowIds: string[];
  /** The stash to keep. Dead ids are pruned on every press, including `none`. */
  stash: ShowDesktopStash;
}

/** Windows carry `canvasId` undefined for a workspace's Main desktop. */
const BASE_DESKTOP_KEY = 'base';

function desktopKey(canvasId: string | null | undefined): string {
  return canvasId || BASE_DESKTOP_KEY;
}

function writeStash(
  stash: ShowDesktopStash,
  key: string,
  ids: readonly string[],
): ShowDesktopStash {
  const next: Record<string, readonly string[]> = { ...stash };
  if (ids.length === 0) delete next[key];
  else next[key] = ids;
  return next;
}

interface DesktopView {
  key: string;
  /** Every window on this desktop, minimised or not. */
  present: ShowDesktopWindow[];
  /** The ones a person can currently see. */
  visible: ShowDesktopWindow[];
  /** Stashed ids whose window still exists — the restore candidates. */
  stashed: string[];
}

function readDesktop(
  windows: readonly ShowDesktopWindow[],
  canvasId: string | null | undefined,
  stash: ShowDesktopStash,
): DesktopView {
  const key = desktopKey(canvasId);
  const present = windows.filter(win => desktopKey(win.canvasId) === key);
  const byId = new Map(present.map(win => [win.id, win]));
  return {
    key,
    present,
    visible: present.filter(win => !win.minimized),
    // A closed window must not linger in the stash: it would keep the button
    // reading "pressed" on a bare desktop with nothing left to bring back.
    stashed: (stash[key] || []).filter(id => byId.has(id)),
  };
}

/**
 * Is this desktop currently showing? True only when nothing is visible on it AND
 * the button is holding something to put back — an empty desktop you never
 * pressed the button on is not "showing the desktop", it is just empty.
 *
 * This is the button's `aria-pressed`.
 */
export function isShowingDesktop(
  windows: readonly ShowDesktopWindow[],
  canvasId: string | null | undefined,
  stash: ShowDesktopStash,
): boolean {
  const desktop = readDesktop(windows, canvasId, stash);
  return desktop.visible.length === 0 && desktop.stashed.length > 0;
}

/** What one press of Show desktop does. Pure; the caller applies it. */
export function resolveShowDesktop(
  windows: readonly ShowDesktopWindow[],
  canvasId: string | null | undefined,
  stash: ShowDesktopStash,
): ShowDesktopDecision {
  const desktop = readDesktop(windows, canvasId, stash);

  if (desktop.visible.length > 0) {
    const hiding = desktop.visible.map(win => win.id);
    const hidingSet = new Set(hiding);
    // Append rather than replace: anything already stashed is still put away,
    // and the restoring press should bring back the whole set, not just the
    // windows opened since. Order is oldest-stashed first so the restore reads
    // in the order the button collected them.
    const kept = desktop.stashed.filter(id => !hidingSet.has(id));
    return {
      action: 'hide',
      windowIds: hiding,
      stash: writeStash(stash, desktop.key, [...kept, ...hiding]),
    };
  }

  // Nothing visible. Restore whatever the button is holding — filtered to the
  // ones still minimised, so a window already brought back from the dock is not
  // toggled straight back down.
  const byId = new Map(desktop.present.map(win => [win.id, win]));
  const restoring = desktop.stashed.filter(id => byId.get(id)?.minimized);
  if (restoring.length === 0) {
    return { action: 'none', windowIds: [], stash: writeStash(stash, desktop.key, desktop.stashed) };
  }
  return { action: 'restore', windowIds: restoring, stash: writeStash(stash, desktop.key, []) };
}

/**
 * Drop a desktop's stash. Used when its windows go away underneath it — a
 * workspace switch closes every window, so ids stashed against the outgoing
 * workspace's 'base' desktop would otherwise match the incoming one's.
 */
export function clearShowDesktopStash(): ShowDesktopStash {
  return {};
}

// ---------------------------------------------------------------------------
// The desktop as a SURFACE — a different question from the button above.
//
// `isShowingDesktop` asks "did the button put things away", which is about the
// button's own state. This asks "is the wallpaper what the user is looking at",
// which is about the screen. They differ on the ordinary case: a desktop you
// simply never opened anything on is not "showing" (nothing was put away) but
// IS the surface.
// ---------------------------------------------------------------------------

/**
 * Nothing on this desktop is covering it — wallpaper, canvas objects and the
 * home composer are what is on screen. Minimised windows do not count: they are
 * in the dock, not over the surface.
 */
export function isDesktopSurfaceVisible(
  windows: readonly ShowDesktopWindow[],
  canvasId: string | null | undefined,
): boolean {
  return readDesktop(windows, canvasId, {}).visible.length === 0;
}

/**
 * Should the Draw control be offered?
 *
 * Draw acts on the DESKTOP — it paints onto the canvas behind the windows — so
 * offering it while a channel or a document has the surface is offering a tool
 * that works somewhere the user is not looking. It belongs to the desktop view
 * and appears there only.
 *
 * The one exception is drawing already being ON: a control that vanishes the
 * moment its own mode opens a window would strand someone in a mode they cannot
 * see how to leave.
 */
export function isDrawToolAvailable(
  windows: readonly ShowDesktopWindow[],
  canvasId: string | null | undefined,
  drawingActive: boolean,
): boolean {
  return drawingActive || isDesktopSurfaceVisible(windows, canvasId);
}
