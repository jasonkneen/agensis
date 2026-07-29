import type { ComponentType } from 'react';
import { AtSign, Hand, MessageCircle, MessagesSquare, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { InboxCategory } from '../../types';

// ---------------------------------------------------------------------------
// Shared presentation constants for the inbox surface.
//
// The design rests on one idea, borrowed wholesale: a row is three lines of
// text and a face. One 32px avatar column at a 10px gutter puts every line of
// every row on the SAME left edge (12 + 32 + 10 = 54px), and nothing else
// structural is drawn — no rules between rows, no gaps, no cards, no radii, no
// shadows. Separation is done with whitespace and a ~3% background wash.
//
// Colour is spent in exactly three places: the unread dot, the amber
// "needs your decision" label, and the red "run failed" label. Everything else
// is foreground/muted, so a full list stays calm and the two rows that are
// actually costing a human time are the only things that shout.
//
// TYPE SCALE — see TEXT_BODY / TEXT_META / TEXT_MICRO below. The one rule is
// that NOTHING here is sized in px.
// ---------------------------------------------------------------------------

// --- Type scale -----------------------------------------------------------
//
// The app sets `html { font-size: var(--agensis-ui-font-size, 15px) }` and
// exposes that as a user setting (Settings → Appearance, 12–18px). Every other
// surface is therefore sized in rem and grows with it: the sidebar's nav rows
// are `text-sm`, so is a chat message body (components/ui/message.tsx), so is
// the Activity detail.
//
// The inbox was the one surface written in absolute px (`text-[13px]` /
// `text-[11px]`). At the default 15px base that is a coincidental match —
// `text-sm` computes to 13.13px — so it looked right and nobody noticed. Turn
// the base up and it stops being a match: measured at an 17px base, the sidebar
// label renders 14.88px while the inbox row stayed frozen at 13.00px, which is
// what makes the inbox read as a shrunken secondary panel next to it.
//
// So these three are the whole scale, and they are the app's, not a new one:
//
//   TEXT_BODY   0.875rem  sender name, preview, detail body — the app's body size
//   TEXT_META   0.75rem   category line, timestamps, entity ids
//   TEXT_MICRO  0.65rem   uppercase section labels only
//
// body:meta is 7:6, the same step the sidebar uses between an agent's name and
// its handle — deliberate, not accidental, and it holds at every base size
// because all three are rem.

/** The app's body size. Matches `text-sm` everywhere else in the app. */
export const TEXT_BODY = 'text-sm';

/** One step down: metadata that must not compete with the body line. */
export const TEXT_META = 'text-xs';

/** Uppercase micro-labels only. Below this, type stops being readable. */
export const TEXT_MICRO = 'text-[0.65rem]';

export const CATEGORY_ICON: Record<InboxCategory, ComponentType<{ className?: string }>> = {
  // The same shield the transcript's approval card uses, so the two surfaces
  // are recognisably about one object.
  approval: ShieldAlert,
  blocker: Hand,
  error: TriangleAlert,
  mention: AtSign,
  thread: MessagesSquare,
  comment: MessageCircle,
};

/**
 * Hue is an urgency signal, not a taxonomy. Only the two categories that mean
 * "something is stopped and a human has to move it" get a colour; the rest read
 * as muted glyphs so a full list stays calm.
 */
export function categoryAccent(category: InboxCategory): string {
  if (category === 'approval' || category === 'blocker') return 'text-amber-500';
  if (category === 'error') return 'text-destructive';
  return '';
}

/**
 * The row wash, derived from --foreground rather than --muted.
 *
 * This app ships six UI themes and in several of them --muted sits within 3% of
 * --card, which would make hover and selection literally invisible. Mixing a few
 * percent of --foreground into --card instead is self-correcting: it darkens in
 * a light theme and lightens in a dark one, by the same perceptual amount, in
 * every theme. Selected and hover are deliberately close — selection is also
 * carried by the detail pane and by aria-current, so the list does not need to
 * shout about it.
 */
export const ROW_WASH_HOVER = 'color-mix(in oklab, var(--card) 96%, var(--foreground))';
export const ROW_WASH_SELECTED = 'color-mix(in oklab, var(--card) 91%, var(--foreground))';

/**
 * Row metrics: three text lines against a 2rem face. Tailwind spacing is rem,
 * and the row has no fixed height, so a larger base font size grows the type
 * AND the padding and the row simply gets taller — ~96px at the 15px default,
 * ~108px at 17px. Nothing here clamps a line back down to fit.
 */
export const ROW_PADDING = 'px-3 py-3';

/**
 * Caps and centres the row column, same move as the chat window's
 * CHAT_COLUMN_CLASS (src/components/windows/ChatWindowContent.tsx). Without
 * it, the single-column view (no item selected) stretches rows edge-to-edge
 * across the whole floating window — three short lines of text on a 32px face
 * reading as a thin ribbon across 900+px looks like a bug, not restraint. Has
 * no visible effect in two-pane mode, where the list pane itself is already
 * narrower than this (MAX_LIST_WIDTH in InboxWindowContent.tsx).
 *
 * In rem, not px: the comfortable measure for a column of text is a count of
 * CHARACTERS, so the cap has to grow when the type does. 42rem is 630px at the
 * 15px default (the 640px this used to be) and 714px at 17px.
 */
export const LIST_COLUMN_CLASS = 'mx-auto w-full max-w-[42rem]';

/**
 * Radix's ScrollArea.Viewport wraps whatever you put inside it in an injected
 * `<div style="min-width:100%; display:table">`, and that div is what actually
 * lays the content out.
 *
 * A `display: table` box with `width: auto` is sized shrink-to-fit, with a FLOOR
 * of its content's min-content width — so a single unbreakable token in one row
 * (a file path, a uuid, a stack frame, a URL) makes the whole column wider than
 * the pane it lives in. The viewport's own inline `overflow: hidden scroll` then
 * has no horizontal scrollbar to offer, so the excess is simply CLIPPED. Every
 * row in the list loses its right-hand side, mid-word, at once.
 *
 * Measured in the inbox list pane at a 700px window: viewport clientWidth 339px,
 * injected div width 575.34px — 236px of every row cut off.
 *
 * Forcing that div back to `display: block` makes it fill the viewport instead
 * of shrink-wrapping the content, and the text wraps. The `!` is needed because
 * the `display: table` is an inline style. Same fix as the sidebar's list
 * (src/components/layout/Sidebar.tsx).
 */
export const SCROLL_VIEWPORT_BLOCK = '[&_[data-radix-scroll-area-viewport]>div]:!block';

/** Drawn inside the row so an adjacent row never clips it. */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2';

/** Section headers and micro-labels — chrome, deliberately below row type size. */
export const MICRO_LABEL =
  `${TEXT_MICRO} font-semibold uppercase tracking-[0.08em] text-muted-foreground`;

/**
 * The two panes' headers are the same band so they line up pixel-for-pixel
 * across the divider — the single most noticeable thing about a two-pane inbox
 * that has been built carelessly.
 */
export const PANE_HEADER =
  'flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5';

/** Hover-pill buttons: 24px circles, quiet until the row is under the pointer. */
export const PILL_BUTTON =
  'flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5';

/**
 * The avatar, which doubles as the selection checkbox.
 *
 * It is exactly the same 32px circle in all three states — initials, hover hint,
 * checked — so entering selection mode shifts NOTHING. That is the whole reason
 * the checkbox lives on the avatar rather than in a column of its own: a
 * checkbox column would push every line of every row 26px right and turn the
 * list into the dense table this design spent its time avoiding.
 */
export const ROW_AVATAR =
  `pointer-events-auto relative flex size-8 shrink-0 items-center justify-center rounded-full ${TEXT_META} font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1`;
