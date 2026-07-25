import type { ComponentType } from 'react';
import { AtSign, Hand, MessageCircle, TriangleAlert } from 'lucide-react';
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
// ---------------------------------------------------------------------------

export const CATEGORY_ICON: Record<InboxCategory, ComponentType<{ className?: string }>> = {
  blocker: Hand,
  error: TriangleAlert,
  mention: AtSign,
  comment: MessageCircle,
};

/**
 * Hue is an urgency signal, not a taxonomy. Only the two categories that mean
 * "something is stopped and a human has to move it" get a colour; the rest read
 * as muted glyphs so a full list stays calm.
 */
export function categoryAccent(category: InboxCategory): string {
  if (category === 'blocker') return 'text-amber-500';
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

/** Row metrics. ~90px: three text lines against a 32px face. */
export const ROW_PADDING = 'px-3 py-3';

/**
 * Caps and centres the row column, same move as the chat window's
 * CHAT_COLUMN_CLASS (src/components/windows/ChatWindowContent.tsx). Without
 * it, the single-column view (no item selected) stretches rows edge-to-edge
 * across the whole floating window — three short lines of text on a 32px face
 * reading as a thin ribbon across 900+px looks like a bug, not restraint. Has
 * no visible effect in two-pane mode, where the list pane itself is already
 * narrower than this (MAX_LIST_WIDTH in InboxWindowContent.tsx).
 */
export const LIST_COLUMN_CLASS = 'mx-auto w-full max-w-[640px]';

/** Drawn inside the row so an adjacent row never clips it. */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2';

/** Section headers and micro-labels — chrome, deliberately below row type size. */
export const MICRO_LABEL =
  'text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

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
