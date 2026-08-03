import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import { SEEN_GLYPH, describeSeenBy, seenPillLabel } from '../../lib/seenPill';
import { queuedLabel, type QueuedState } from '../../lib/queuedPill';
import { FaceStack } from './FaceStack';
import { describeFaces, faceStack, type ReaderFace } from '../../lib/readerFaces';

// The derived chips that ride in the reaction row: "looked at" and "queued".
//
// EVERY DECISION IS IN src/lib/seenPill.ts AND src/lib/queuedPill.ts — why
// "seen" is derived rather than stored, why 👀 is allowed here, why "queued" is
// not read off a job status, and what neither of them will ever claim. Read
// those first. These components render and nothing else, because the frontend
// runner only sees tests/unit/**/*.test.ts and `.test.tsx` is outside the glob.
//
// THEY ARE `span`s, NOT `button`s. A reaction pill is a toggle; these are
// assertions. Making them clickable would offer an action that cannot exist
// (you cannot un-see a message on somebody else's behalf), and `aria-pressed`
// would tell a screen reader they are controls. The visual difference from a
// real pill is deliberate too: dashed border, no hover tint, muted text.
//
// EACH ONE SHOWS WHOSE FACE. A count answers "how many" when the question is
// "who" — in a channel with three agents in it, "2" does not tell you whether
// the one you asked has read it. The faces come from src/lib/readerFaces.ts and
// an agent's carries its accent colour, the same colour its name is drawn in.

export interface SeenPillProps {
  /** Ids of everyone who has read this message, excluding its author. */
  readerIds: readonly string[];
  resolveName: (readerId: string) => string | null;
  /** Optional face lookup. Without it the chip falls back to a count. */
  resolveFace?: (readerId: string) => ReaderFace;
  className?: string;
}

export function SeenPill({ readerIds, resolveName, resolveFace, className }: SeenPillProps) {
  // Nobody has read it yet: render nothing rather than a zero. An empty pill on
  // every message you send is furniture, and "0 people have seen this" is a
  // sentence no product should say out loud.
  if (readerIds.length === 0) return null;

  const stack = resolveFace ? faceStack(readerIds, resolveFace) : null;
  // The tooltip prefers the face model when there is one, because that is what
  // is actually on screen — a tooltip naming four readers over a chip showing
  // three is the kind of small lie that makes people distrust the whole row.
  const tooltip = stack
    ? `Seen by ${describeFaces(stack.shown, stack.overflow)}`
    : describeSeenBy(readerIds, resolveName);

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
          {resolveFace ? (
            <FaceStack readerIds={readerIds} resolveFace={resolveFace} />
          ) : (
            /* Always shown, including at 1: "+1" and a hidden count both make
               you hover to learn something the row could just say. */
            <span className="text-[11px] font-medium tabular-nums">{readerIds.length}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
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
 * The faces are the agents whose turns are IN FRONT of this message, not a
 * guess at who will answer it. Same reason the seen chip carries faces: in a
 * channel with more than one agent, "Queued" without a who is half a sentence.
 */
export function QueuedPill({
  state, resolveFace, className,
}: {
  state: QueuedState;
  resolveFace?: (readerId: string) => ReaderFace;
  className?: string;
}) {
  if (!state.queued) return null;
  const { label, title } = queuedLabel(state);
  const agentIds = state.agentIds || [];
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
          {/* The faces ARE the icon. A lucide glyph beside them would be a
              second thing to parse saying less than the first. Without a face
              lookup the chip is the word alone, exactly as it was. */}
          {resolveFace && agentIds.length > 0 && (
            <FaceStack readerIds={agentIds} resolveFace={resolveFace} max={2} />
          )}
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{title}</TooltipContent>
    </Tooltip>
  );
}
