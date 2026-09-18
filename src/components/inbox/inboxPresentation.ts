import type { ComponentType } from 'react';
import { AtSign, Hand, MessageCircle, MessagesSquare, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { InboxCategory } from '../../types';
import { TEXT_META } from '@/components/common/presentation';

// ---------------------------------------------------------------------------
// Shared presentation constants for the inbox surface.
//
// The design rests on one idea: a row is three lines of text and a face, and
// nothing else. One 32px avatar column at a 10px gutter puts every line of
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
// The app sets `html { font-size: var(--agensis-ui-font-size, 16px) }` and
// exposes that as a user setting (Settings → Appearance, 12–18px). Every other
// surface is therefore sized in rem and grows with it: the sidebar's nav rows
// are `text-sm`, so is a chat message body (components/ui/message.tsx), so is
// the Activity detail.
//
// The inbox was the one surface written in absolute px (`text-[13px]` /
// `text-2xs`). At the default 16px base that is a coincidental match —
// `text-sm` computes to 14px — so it looked right and nobody noticed. Turn
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
