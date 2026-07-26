import { useState } from 'react';
import { useNow } from '../../hooks/useNow';
import { useSessionWork, useThreadWork } from '../../hooks/useAgentWork';
import { MAX_WORKING_MS, formatElapsed } from '../../lib/agentWork';
import { cn } from '@/lib/utils';

/**
 * Live "an agent is working here" indicators.
 *
 * The split into two components per surface is the point, not ceremony:
 *
 *   <XWorkBadge>  subscribes to the agent-work store. No timer. Re-renders only
 *                 when ITS key starts/stops working, and renders `null` when
 *                 idle — so an idle workspace creates ZERO intervals.
 *   <XElapsed>    the leaf that paints the digits. Owns the only 1s interval, so
 *                 a tick re-renders one <span> per working channel and nothing
 *                 above it.
 */
const ELAPSED_TICK_MS = 1000;

/**
 * Elapsed label, or null once the job is past the server's hard ceiling.
 *
 * The reaper's terminal write never reaches realtime subscribers, so "running"
 * can be a lie for a job whose daemon died. Rather than count up forever, the
 * label expires — and expiring also kills the interval (useNow(0)).
 */
function useElapsedLabel(anchorAt: number): string | null {
  const [expired, setExpired] = useState(() => Date.now() - anchorAt > MAX_WORKING_MS);
  const now = useNow(expired ? 0 : ELAPSED_TICK_MS);
  const elapsed = Math.max(0, now - anchorAt);
  if (elapsed > MAX_WORKING_MS) {
    if (!expired) setExpired(true);
    return null;
  }
  return formatElapsed(elapsed);
}

function workingTitle(jobs: number, elapsed: string): string {
  return jobs > 1
    ? `${jobs} agents working here — oldest started ${elapsed} ago`
    : `An agent is working here — started ${elapsed} ago`;
}

function SidebarElapsed({ anchorAt, jobs }: { anchorAt: number; jobs: number }) {
  const elapsed = useElapsedLabel(anchorAt);
  if (!elapsed) return null;
  return (
    // A chip, not a whisper. At 10px with a 6px dot this read as decoration and
    // was missed entirely; "is this agent actually working" is the single most
    // asked question of the sidebar, so it gets a filled pill and legible
    // digits. tabular-nums keeps the row from twitching as the seconds tick.
    <span
      className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/12 px-2 py-0.5 text-primary"
      title={workingTitle(jobs, elapsed)}
    >
      <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />
      <span className="text-[12px] font-semibold tabular-nums leading-none">{elapsed}</span>
    </span>
  );
}

/** Elapsed badge for a sidebar channel/DM row. Renders nothing when idle. */
export function SessionWorkBadge({ sessionId }: { sessionId: string }) {
  const work = useSessionWork(sessionId);
  if (!work) return null;
  return <SidebarElapsed anchorAt={work.anchorAt} jobs={work.jobs} />;
}

function ThreadElapsed({ anchorAt, jobs, className }: { anchorAt: number; jobs: number; className?: string }) {
  const elapsed = useElapsedLabel(anchorAt);
  if (!elapsed) return null;
  return (
    <>
      <span aria-hidden className="shrink-0 text-muted-foreground/50">·</span>
      <span
        className={cn('flex shrink-0 items-center gap-1 text-primary', className)}
        title={workingTitle(jobs, elapsed)}
      >
        <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
        <span className="font-medium tabular-nums">working {elapsed}</span>
      </span>
    </>
  );
}

/**
 * Working state for the thread indicator, keyed by the thread's parent message
 * id — `agent_jobs.metadata.threadParentId`, the same value the server threads
 * the reply under. Renders nothing when no agent is working in that thread.
 */
export function ThreadWorkBadge({ parentMessageId, className }: { parentMessageId: string; className?: string }) {
  const work = useThreadWork(parentMessageId);
  if (!work) return null;
  return <ThreadElapsed anchorAt={work.anchorAt} jobs={work.jobs} className={className} />;
}
