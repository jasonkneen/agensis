// Picked-element references, rendered as cards in the transcript.
//
// The composer folds an inspector pick into the outgoing message as a plain
// "[Picked elements]" text block (see lib/componentPicker.ts:buildPickContext)
// so the agent reading the thread gets a precise, machine-legible reference.
// That same text used to render RAW in the bubble — a wall of "selector:
// div:nth-of-type(3) > …". This draws it instead: one numbered card per pick,
// the human's note first (it is the point), the label/component as context, and
// the selector demoted to a truncated mono chip.
//
// Everything here is TEXT that React escapes — a crafted label, note or
// selector can inject no markup and, because every field truncates inside a
// bounded box, cannot widen the bubble either.

import { useState } from 'react';
import { ChevronRight, Crosshair } from 'lucide-react';
import type { ParsedPick } from '../../lib/componentPicker';
import { cn } from '@/lib/utils';

export function PickedElementsCard({ picks, className }: { picks: ParsedPick[]; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (picks.length === 0) return null;
  return (
    <div
      className={cn('mb-2 rounded-lg border border-border bg-muted/30 p-2', expanded && 'space-y-1.5', className)}
      data-testid="picked-elements"
    >
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      >
        <Crosshair className="size-3 shrink-0" aria-hidden />
        <span>{picks.length === 1 ? 'Referenced element' : `Referenced elements · ${picks.length}`}</span>
        <ChevronRight
          className={cn('ml-auto size-3 shrink-0 transition-transform', expanded && 'rotate-90')}
          aria-hidden
        />
      </button>
      {expanded && picks.map(pick => (
        <div
          key={pick.index}
          className="flex items-start gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
        >
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-3xs font-bold leading-none text-primary-foreground">
            {pick.index}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
              <span className="truncate text-xs font-medium text-foreground">{pick.label}</span>
              {pick.component && pick.component !== pick.label && (
                <span className="truncate text-2xs text-muted-foreground">{pick.component}</span>
              )}
            </div>
            {pick.text && (
              <div className="truncate text-2xs italic text-muted-foreground">“{pick.text}”</div>
            )}
            {pick.note && (
              <div className="text-xs leading-snug text-foreground">{pick.note}</div>
            )}
            {pick.selector && (
              <code
                className="block truncate rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
                title={pick.selector}
              >
                {pick.selector}
              </code>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
