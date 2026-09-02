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
// Above the columns sit the things that are supposed to cover them, and the
// portal band sits above ALL of them. Radix portals to the body, so a Select,
// popover or tooltip opened from inside a dialog (12000), the huddle panel
// (11600) or the dock (11500) is competing with those numbers, not with the
// three columns — at Tailwind's default z-50 it lost, and opened behind the
// surface that raised it. `overlay` is therefore the top of the ladder bar the
// feedback picker, and the gap between `workspaceRail` and it is now enormous
// rather than merely deliberate.
//
//   agentFeed       the sidebar's agent status feed, portalled to the body
//   presencePanel   the presence roster, likewise portalled out of the sidebar
//   cursors         live collaborator cursors
//   appDock         mobile window switcher + the feedback launcher
//   modalScrim      dialog + alert-dialog backdrops
//   drawerScrim     the phone nav drawer's backdrop
//   modal           dialog / alert-dialog content, and the phone nav drawer
//   contextMenu     right-click menus, which must beat an open modal
//   menu            dropdown menus, which must beat a context menu
//   nestedModal     a dialog opened FROM a menu that is already at `menu`
//   overlay         Radix portals: tooltip / popover / select / hover card
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
  agentFeed: 9500,
  /**
   * The presence roster popover.
   *
   * The popover base now lands ABOVE the dock, and the inline
   * `zIndex: CHROME_DEPTH.presencePanel` at PresenceRoster.tsx:332 is what
   * holds the roster DOWN to 9600 — an inline style beats the class, which is
   * why the roster is unaffected by this change and still sits under
   * `appDock`. It carried a bare `z-[9600]` for exactly that reason; this is
   * the same number, named.
   *
   * Note what it does NOT clear: `appDock` (11500) is the feedback launcher,
   * so a launcher parked over the roster still paints on top of it. That is
   * deliberate — the launcher is the one control a stuck user must always be
   * able to reach — and it dodges only obstructions under 120px tall
   * (MAX_OBSTRUCTION_HEIGHT in FeedbackButton.tsx), so it will never slide
   * clear of a panel. Keeping the roster short is what keeps them apart.
   */
  presencePanel: 9600,
  cursors: 9999,
  appDock: 11500,
  /**
   * The floating huddle panel. ABOVE the window layer and the dock, because a
   * live call must not be buried by whatever you navigate to next — that was
   * the whole point of lifting it out of the channel. BELOW modalScrim, so a
   * dialog raised from inside the huddle still paints over it rather than
   * behind it.
   */
  huddlePanel: 11600,
  modalScrim: 11990,
  drawerScrim: 11999,
  modal: 12000,
  drawer: 12000,
  contextMenu: 12010,
  menu: 12050,
  nestedModal: 12060,
  overlay: 12070,
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
  'agentFeed',
  'presencePanel',
  'cursors',
  'appDock',
  'huddlePanel',
  'modalScrim',
  'drawerScrim',
  'modal',
  'drawer',
  'contextMenu',
  'menu',
  'nestedModal',
  'overlay',
  'picker',
  'pickerHud',
];
