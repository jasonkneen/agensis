import { Check, ListOrdered } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import { SEEN_GLYPH, describeSeenBy, seenPillLabel } from '../../lib/seenPill';
import { queuedLabel, type QueuedState } from '../../lib/queuedPill';

// The read receipt, shaped like a reaction pill and sitting in the reaction row.
//
// EVERY DECISION IS IN src/lib/seenPill.ts — why this is derived rather than a
// stored reaction, why 👀 is allowed here when ReadReceipt.tsx argued for an
// SVG, and why there is still never a timestamp. Read that first. This
// component renders and nothing else, because the frontend runner only sees
// tests/unit/**/*.test.ts and `.test.tsx` is outside the glob.
//
// IT IS A `span`, NOT A `button`. A reaction pill is a toggle; this is an
// assertion. Making it clickable would offer an action that cannot exist (you
// cannot un-see a message on someone else's behalf), and `aria-pressed` on it
// would tell a screen reader it is a control. The visual difference from a real
// pill is deliberate too: no hover tint, no border emphasis, muted text.

export interface SeenPillProps {
  /** Ids of everyone who has read this message, excluding its author. */
  readerIds: readonly string[];
  resolveName: (readerId: string) => string | null;
  className?: string;
}

export function SeenPill({ readerIds, resolveName, className }: SeenPillProps) {
  // Nobody has read it yet: render nothing rather than a zero. An empty pill on
  // every message you send is furniture, and "0 people have seen this" is a
  // sentence no product should say out loud.
  if (readerIds.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-seen-pill=""
          aria-label={seenPillLabel(readerIds, resolveName)}
          className={cn(
            'chat-reaction-chip inline-flex h-6 cursor-default select-none items-center gap-1',
            'rounded-md border border-dashed border-border/70 bg-transparent px-2 text-sm',
            'text-muted-foreground',
            className,
          )}
        >
          <span aria-hidden="true">{SEEN_GLYPH}</span>
          {/* Always shown, including at 1: "+1" and a hidden count both make you
              hover to learn something the row could just say. */}
          <span className="text-[11px] font-medium tabular-nums">{readerIds.length}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{describeSeenBy(readerIds, resolveName)}</TooltipContent>
    </Tooltip>
  );
}

/**
 * "Sent, not read yet" — the state a pill cannot express by being absent.
 *
 * DMs only, one message only. `unseenAnchorId` in src/lib/seenPill.ts owns that
 * rule and the reasons for it. A lucide Check and NOT a greyed 👀: an emoji
 * cannot be dimmed (it is full-colour by definition), so a "faint" version of
 * the seen glyph is not something the platform can render — it would just look
 * like the same chip in a slightly different box.
 */
export function UnseenPill({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-unseen-pill=""
          aria-label="Sent, not seen yet"
          className={cn(
            'chat-reaction-chip inline-flex h-6 cursor-default select-none items-center gap-1',
            'rounded-md border border-dashed border-border/50 bg-transparent px-2',
            'text-[11px] font-medium text-muted-foreground/60',
            className,
          )}
        >
          <Check className="size-3" aria-hidden="true" />
          Sent
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Sent — not seen yet</TooltipContent>
    </Tooltip>
  );
}

/**
 * "You sent this while the agent was already working; it is next."
 *
 * EVERY DECISION IS IN src/lib/queuedPill.ts — how "queued" is derived from the
 * running job's start time, why it is not read off a 'queued' job status, and
 * what it deliberately refuses to claim (no position, no ETA).
 *
 * A lucide icon rather than an emoji: the seen pill earns 👀 because that glyph
 * was the request and because it sits among user-chosen reactions. Nobody asked
 * for a specific queue emoji, so this follows the house rule and stays an SVG
 * that inherits currentColor and dims with the rest of the chrome.
 */
export function QueuedPill({ state, className }: { state: QueuedState; className?: string }) {
  if (!state.queued) return null;
  const { label, title } = queuedLabel(state);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-queued-pill=""
          aria-label={title}
          className={cn(
            'chat-reaction-chip inline-flex h-6 cursor-default select-none items-center gap-1',
            'rounded-md border border-dashed border-primary/30 bg-primary/5 px-2',
            'text-[11px] font-medium text-primary/80',
            className,
          )}
        >
          <ListOrdered className="size-3" aria-hidden="true" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{title}</TooltipContent>
    </Tooltip>
  );
}
