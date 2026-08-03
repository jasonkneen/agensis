import { useState } from 'react';
import { Square } from 'lucide-react';
import { useSessionWork, useThreadWork } from '../../hooks/useAgentWork';
import { stopAgentWork, stopLabel, stopOutcomeMessage } from '../../lib/stopAgentWork';
import { cn } from '@/lib/utils';

// "Stop" next to the agent activity indicator.
//
// EVERY DECISION IS IN src/lib/stopAgentWork.ts — why it takes job ids rather
// than a session id, why the idempotent already-finished answer is a success,
// and where the labels come from. This component renders and nothing else,
// because the frontend runner's glob is tests/unit/**/*.test.ts.
//
// IT IS DRIVEN BY agent_jobs, NOT BY THE ACTIVITY LINE IT SITS BESIDE. The
// "X is thinking…" text is derived from placeholder MESSAGES, which carry no
// job id, so there would be nothing there to cancel. The work store is fed from
// `agent_jobs` and holds the ids — see src/lib/agentWork.ts. The consequence is
// worth stating plainly: this button appears when a JOB is running, which is
// the thing that can actually be stopped, and not merely when a placeholder is
// on screen.
//
// A SQUARE, NOT AN OCTAGON OR A ✋. The stop-square is the transport control
// every player and every terminal uses for "end this now"; a red octagon reads
// as a warning sign and an emoji would break the no-decorative-emoji rule the
// rest of this chrome follows.

const BUSY_LABEL = 'Stopping…';

function StopControl({
  jobIds,
  agentNames,
  className,
}: {
  jobIds: readonly string[];
  agentNames: readonly (string | null)[];
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const { label, title } = stopLabel(agentNames);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    const result = await stopAgentWork(jobIds);
    // Deliberately not clearing `busy` on success: the job row goes terminal,
    // the store drops it and this whole component unmounts. Clearing it would
    // flash the idle label for one frame on the way out.
    const outcome = stopOutcomeMessage(result);
    if (outcome) {
      setMessage(outcome);
      setBusy(false);
    }
  };

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        aria-label={title}
        title={title}
        className={cn(
          'control-outer-ring inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border',
          'bg-muted/60 px-1.5 text-[11px] font-medium text-muted-foreground',
          'hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive',
          'disabled:cursor-default disabled:opacity-60 disabled:hover:bg-muted/60 disabled:hover:text-muted-foreground',
          className,
        )}
      >
        <Square className="size-2.5 fill-current" aria-hidden="true" />
        {busy ? BUSY_LABEL : label}
      </button>
      {/* Only ever rendered when something went WRONG. A success message here
          would compete with the activity line vanishing, which is already the
          clearest confirmation available. role=status so it is announced
          without stealing focus. */}
      {message ? (
        <span role="status" className="truncate text-[11px] text-destructive">{message}</span>
      ) : null}
    </span>
  );
}

/**
 * Stop the agents working in this conversation. Renders nothing when idle, so
 * an idle channel costs no chrome and no subscription work beyond the store
 * read every badge already does.
 */
export function SessionStopButton({
  sessionId,
  resolveAgentName,
  className,
}: {
  sessionId: string;
  resolveAgentName?: (agentId: string) => string | null;
  className?: string;
}) {
  const work = useSessionWork(sessionId);
  if (!work) return null;
  return (
    <StopControl
      jobIds={work.jobIds}
      agentNames={work.agentIds.map(id => resolveAgentName?.(id) ?? null)}
      className={className}
    />
  );
}

/**
 * Stop the agents working in this thread, keyed by the thread's parent message
 * id — `agent_jobs.metadata.threadParentId`, the same value the server threads
 * the reply under, so this stops the thread's turn and NOT the channel's.
 */
export function ThreadStopButton({
  parentMessageId,
  resolveAgentName,
  className,
}: {
  parentMessageId: string;
  resolveAgentName?: (agentId: string) => string | null;
  className?: string;
}) {
  const work = useThreadWork(parentMessageId);
  if (!work) return null;
  return (
    <StopControl
      jobIds={work.jobIds}
      agentNames={work.agentIds.map(id => resolveAgentName?.(id) ?? null)}
      className={className}
    />
  );
}
