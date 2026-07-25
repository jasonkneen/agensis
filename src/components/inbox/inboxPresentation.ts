import type { ComponentType } from 'react';
import { AtSign, Hand, MessageCircle, TriangleAlert } from 'lucide-react';
import type { InboxCategory } from '../../types';

// ---------------------------------------------------------------------------
// Shared presentation constants for the inbox surface.
//
// The whole design rests on ONE idea: every row is a single line whose columns
// land on the same vertical rules all the way down the list, so the eye can run
// straight down "who / what / when" without re-reading a layout each time.
// The column widths therefore live here — declared once — instead of being
// re-typed per call site where they would inevitably drift apart.
//
// Colour is deliberately scarce: category is carried by a MUTED glyph, and hue
// is spent only where something is actually costing a human time (a blocker an
// agent is stuck on, a run that failed). Everything else is foreground/muted.
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

/** Fixed-width row columns. Changing a width here moves the whole list together. */
export const COL = {
  /** Unread marker gutter — always rendered so the icons never shift. */
  dot: 'flex w-1.5 shrink-0 items-center justify-center',
  icon: 'size-3.5 shrink-0',
  /**
   * Who it came from. Widens with the pane (container query, not viewport) so
   * the same component works at 40% width beside the reading pane and at full
   * width on a phone — and drops out entirely once the pane is too narrow to
   * hold a column, rather than pushing the title off the row.
   */
  actor: 'flex w-16 shrink-0 items-baseline gap-1 @max-xs/inbox:hidden @sm/inbox:w-24 @lg/inbox:w-32',
  /** Right-aligned so every timestamp ends on one rule. */
  time: 'w-[4.25rem] shrink-0 text-right tabular-nums',
  /** Reserved even when empty — the hover affordance must not move the row. */
  chevron: 'size-3.5 shrink-0',
} as const;

/** Row metrics. ~34px + hairline: roughly twice the density of a stacked card. */
export const ROW_BASE =
  'group/row relative flex h-[34px] w-full items-center gap-x-2 border-b border-border/60 px-2 text-left text-[13px] outline-none transition-colors last:border-b-0';

/** Drawn inside the row so an adjacent row never clips it. */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2';

/** Section headers and micro-labels — chrome, deliberately below row type size. */
export const MICRO_LABEL =
  'text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
