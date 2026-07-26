// Thread widget rail — the "is it open, and where does it sit?" decisions,
// deliberately free of React and the DOM so they can be tested directly.
//
// Two rules drive everything here.
//
// 1. **The rail shows itself, but a hand beats it.** A session's widgets appear
//    on their own the moment they have something to show (an agent posts a
//    to-do, a plan, a blocker) — an empty rail is just lost width. But once the
//    user has opened or closed it BY HAND for that session, their choice wins
//    forever after: a to-do arriving must not reopen a rail somebody closed and
//    yank the layout around mid-read.
//
// 2. **Opening the rail must not narrow the conversation.** The message column
//    is centred at `CHAT_COLUMN_MAX_WIDTH`; the rail is a fixed-width overlay
//    pinned to the right of the message surface. While the surface can hold
//    both side by side, the chat body reserves the rail's width and the column
//    keeps its full rendered width — it slides left, it does not shrink. Below
//    that the rail FLOATS OVER the messages rather than squeezing them into a
//    ribbon, and below `RAIL_MIN_SURFACE_WIDTH` it is not shown at all.
//
// The previous layout did the opposite: every message row carried a 300px right
// padding while the rail was open, which cost the 800px column 220px of text
// width — code blocks gained a horizontal scrollbar and prose wrapped at half
// the window — even when there was empty gutter either side going spare.

/** What the user has said by hand about this session's rail. */
export type RailPreference = 'auto' | 'open' | 'closed';

/**
 * Where the rail sits relative to the conversation.
 *
 * - `gutter`  — beside it. The chat body reserves `RAIL_RESERVE_WIDTH` on the
 *               right; the message column keeps its width and shifts left.
 * - `overlay` — on top of it. Nothing is reserved, so the column keeps its
 *               width here too; the rail floats above the right-hand edge of
 *               the messages until it is closed.
 * - `hidden`  — not shown at all; too narrow to be anything but in the way.
 */
export type RailLayout = 'gutter' | 'overlay' | 'hidden';

/** Card width of the rail (matches the `w-[272px]` on the overlay). */
export const RAIL_WIDTH = 272;
/** Gap between the rail and the right edge of the message surface (`right-2`). */
export const RAIL_EDGE_GAP = 8;
/** Horizontal space the chat body gives up to sit the rail beside it. */
export const RAIL_RESERVE_WIDTH = RAIL_WIDTH + RAIL_EDGE_GAP;
/** Mirrors `CHAT_COLUMN_CLASS`'s `max-w-[800px]` in ChatWindowContent. */
export const CHAT_COLUMN_MAX_WIDTH = 800;
/**
 * The composer shell's own `p-2`, on both sides. The composer column shares the
 * message column's 800px cap but starts 8px in, so it runs out of room 16px
 * sooner — it has to be counted or the composer narrows at the exact width
 * where the message column still fits.
 */
export const COMPOSER_SHELL_PADDING = 8;
/**
 * Narrowest message surface that still fits a full-width chat column (messages
 * AND composer) beside the rail. At or above this the rail costs the
 * conversation nothing.
 */
export const RAIL_GUTTER_MIN_SURFACE_WIDTH =
  CHAT_COLUMN_MAX_WIDTH + RAIL_RESERVE_WIDTH + COMPOSER_SHELL_PADDING * 2;
/** Below this the rail would cover most of the message surface — don't show it. */
export const RAIL_MIN_SURFACE_WIDTH = 520;
/** Slide/fade duration, in ms. Kept here so the CSS and the JS timer agree. */
export const RAIL_ANIMATION_MS = 200;

export interface RailState {
  /** Should the rail's cards be on screen right now? */
  open: boolean;
  /** How it relates to the conversation — see {@link RailLayout}. */
  layout: RailLayout;
  /**
   * Horizontal space the chat body must give up so the rail can sit beside the
   * conversation. Non-zero only in `gutter` layout while open; every other case
   * leaves the message column exactly as wide as it was with the rail closed.
   */
  reserve: number;
}

export interface RailStateInput {
  /** Does this session's rail have any items at all (of any kind or status)? */
  hasContent: boolean;
  /** The user's per-session choice; `auto` means they haven't made one. */
  preference: RailPreference;
  /**
   * Width of the message surface in px. `null` means "not measured yet" — we
   * assume there is room rather than flashing the rail closed on first paint,
   * because the ResizeObserver reports a real width within the first frame.
   */
  surfaceWidth: number | null;
}

/** Where the rail can sit at this surface width, independent of whether it's open. */
export function railLayout(surfaceWidth: number | null | undefined): RailLayout {
  if (surfaceWidth == null || !Number.isFinite(surfaceWidth) || surfaceWidth <= 0) return 'gutter';
  if (surfaceWidth < RAIL_MIN_SURFACE_WIDTH) return 'hidden';
  return surfaceWidth >= RAIL_GUTTER_MIN_SURFACE_WIDTH ? 'gutter' : 'overlay';
}

/**
 * The single answer to "should the rail be open, and what does that cost the
 * message column?" — auto-show from content, overridden by an explicit choice,
 * and forced shut when the window is genuinely too narrow.
 */
export function resolveRailState(input: RailStateInput): RailState {
  const layout = railLayout(input.surfaceWidth);
  if (layout === 'hidden') return { open: false, layout, reserve: 0 };

  const open = input.preference === 'auto' ? input.hasContent : input.preference === 'open';
  return {
    open,
    layout,
    reserve: open && layout === 'gutter' ? RAIL_RESERVE_WIDTH : 0,
  };
}

/**
 * What the user's choice becomes when they hit the toggle. Toggling always
 * records an explicit preference — that is the point of touching it — so the
 * rail can never drift back to the automatic behaviour behind their back.
 */
export function toggledRailPreference(currentlyOpen: boolean): RailPreference {
  return currentlyOpen ? 'closed' : 'open';
}

/** localStorage key holding the user's choice for one session. */
export function railPreferenceKey(sessionId: string): string {
  return `thread-widgets-pref:${sessionId}`;
}

/** Reads a stored preference back, treating anything unrecognised as "no choice made". */
export function parseRailPreference(raw: string | null | undefined): RailPreference {
  return raw === 'open' || raw === 'closed' ? raw : 'auto';
}
