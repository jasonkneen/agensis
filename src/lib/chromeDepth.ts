// The one z-index ladder for the app shell.
//
// Every stacking decision in the chrome is a rung on this list, and the list is
// mirrored 1:1 by the `--z-*` custom properties in `src/index.css`
// (`tests/unit/chromeDepth.test.ts` fails if the two ever disagree). Nothing in
// the chrome should carry a bare numeric z-index again: a magic number tells the
// next reader what it is, never what it is ABOVE, and this shell has three
// full-height columns whose relative depth is the whole point.
//
// ## The intended reading, bottom to top
//
// The three chrome columns are the reason this file exists. Left to right they
// are the workspace rail, the sidebar, and the canvas column — and their depth
// is deliberately NOT their left-to-right order:
//
//   backdrop        the workspace wallpaper and its tint; behind everything
//   sidebar         LOWEST of the three columns. It sits under both its
//                   neighbours and casts nothing outward — the recess the other
//                   two are raised out of.
//   content         the canvas column, above the sidebar. Every floating window
//                   lives inside it (they self-manage from z-index 100 up, see
//                   useWindows.ts) so the column's own rung caps the lot.
//   sidebarFlyout   the COLLAPSED sidebar only — see the note on that rung.
//   workspaceRail   HIGHEST of the three. The workspace switcher is the outermost
//                   frame of the app, so it reads as sitting on top of the
//                   sidebar and casting onto it (`--chrome-cast` in index.css).
//
// Above the columns sit the things that are supposed to cover them. The gap
// between `workspaceRail` and `overlay` is deliberate headroom: every Radix
// portal (tooltip, popover, dropdown, select, hover card) lands at the body at
// z-50, so no chrome rung may ever reach it or menus start opening behind
// panels.
//
//   overlay         Radix portals: tooltip / popover / select / hover card
//   agentFeed       the sidebar's agent status feed, portalled to the body
//   cursors         live collaborator cursors
//   appDock         mobile window switcher + the feedback launcher
//   modalScrim      dialog + alert-dialog backdrops
//   drawerScrim     the phone nav drawer's backdrop
//   modal           dialog / alert-dialog content, and the phone nav drawer
//   contextMenu     right-click menus, which must beat an open modal
//   menu            dropdown menus, which must beat a context menu
//   nestedModal     a dialog opened FROM a menu that is already at `menu`
//   picker          the feedback element picker, which targets the whole app
//
// `modal` and `drawer` intentionally share a value: on a phone the nav drawer
// and a dialog are never usefully stacked, and DOM order (the dialog portals
// later) settles the tie. Kept as one number rather than two so the ladder does
// not imply an ordering nobody has designed.
export const CHROME_DEPTH = {
  backdrop: 0,
  sidebar: 10,
  content: 20,
  /**
   * The collapsed sidebar, and only the collapsed sidebar.
   *
   * The expanded panel can afford the bottom rung because it clips its own
   * children (`contain: layout paint`) — nothing it draws ever needs to leave
   * its box. The collapsed 52px icon rail is the opposite: it sets
   * `overflow: visible` so each button's hover label can fly out to the right,
   * across the canvas column. On the `sidebar` rung those labels would be
   * painted behind whatever window happens to be under them, which is most of
   * the time. So the icon rail keeps a rung above `content` — still below the
   * workspace rail, which it never overlaps.
   */
  sidebarFlyout: 30,
  workspaceRail: 40,
  overlay: 50,
  agentFeed: 9500,
  cursors: 9999,
  appDock: 11500,
  modalScrim: 11990,
  drawerScrim: 11999,
  modal: 12000,
  drawer: 12000,
  contextMenu: 12010,
  menu: 12050,
  nestedModal: 12060,
  picker: 12080,
  pickerHud: 12090,
} as const;

export type ChromeDepthLevel = keyof typeof CHROME_DEPTH;

/**
 * The rungs in the order they are meant to paint, bottom first. The ladder's
 * only real invariant — that this order matches the numbers — is asserted in
 * `tests/unit/chromeDepth.test.ts`, so reordering a rung by editing its number
 * alone is a test failure rather than a bug somebody finds in the UI.
 */
export const CHROME_DEPTH_ORDER: readonly ChromeDepthLevel[] = [
  'backdrop',
  'sidebar',
  'content',
  'sidebarFlyout',
  'workspaceRail',
  'overlay',
  'agentFeed',
  'cursors',
  'appDock',
  'modalScrim',
  'drawerScrim',
  'modal',
  'drawer',
  'contextMenu',
  'menu',
  'nestedModal',
  'picker',
  'pickerHud',
];
