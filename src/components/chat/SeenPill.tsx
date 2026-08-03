import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import { SEEN_GLYPH, describeSeenBy, seenPillLabel } from '../../lib/seenPill';

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
