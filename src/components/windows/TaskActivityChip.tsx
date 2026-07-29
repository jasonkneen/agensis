import { useState } from 'react';
import { Hourglass } from 'lucide-react';
import type { Task } from '../../types';
import { useNow } from '../../hooks/useNow';
import { useSharedNow } from '../../hooks/useSharedNow';
import { useSessionWork } from '../../hooks/useAgentWork';
import { MAX_WORKING_MS, formatElapsed } from '../../lib/agentWork';
import {
  formatIdleElapsed,
  idleTaskTitle,
  taskActivityState,
  workingTaskTitle,
} from '../../lib/taskActivity';
import { cn } from '@/lib/utils';

/**
 * "This task is active, and for how long" — one small chip, shown in the List,
 * Board and Timeline views.
 *
 * Two chips, deliberately unlike each other. What each one MEANS is in
 * src/lib/taskActivity.ts; what matters here is that only the live one moves:
 *
 *   working  a job is running in this task's chat right now. Pulsing dot,
 *            primary fill, seconds ticking. Owns a 1s interval.
 *   idle     in progress, nothing running. Static hourglass, muted, whole
 *            minutes/hours off the SHARED minute clock — no per-card interval,
 *            and no seconds, so it can never be read as a live timer.
 *
 * Structure copies AgentWorkBadge on purpose: the subscribing component renders
 * `null` when there is nothing to say, so a board of todo cards creates zero
 * timers, and the tick only ever re-renders the leaf <span> that paints digits.
 */
const ELAPSED_TICK_MS = 1000;

function IdleChip({ since, compact }: { since: number; compact?: boolean }) {
  // Once a minute, off the one shared clock — this label's finest step is a
  // minute, so a faster tick would re-render for a value that cannot change.
  const now = useSharedNow();
  const elapsed = formatIdleElapsed(now - since);
  if (!elapsed) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground',
        compact ? 'text-[10px] leading-none' : 'text-[11px] leading-none',
      )}
      title={idleTaskTitle(elapsed)}
    >
      <Hourglass aria-hidden className="size-2.5 shrink-0 opacity-70" />
      <span className="font-medium tabular-nums">{elapsed}</span>
    </span>
  );
}

function WorkingChip({
  since,
  idleSince,
  jobs,
  compact,
}: {
  since: number;
  idleSince: number;
  jobs: number;
  compact?: boolean;
}) {
  // The reaper's terminal write never reaches realtime subscribers, so a job
  // whose daemon died can stay 'running' forever. Rather than count up past the
  // server's own 31-minute ceiling, fall back to the honest static chip — and
  // stop the interval while doing it (useNow(0)).
  const [expired, setExpired] = useState(() => Date.now() - since > MAX_WORKING_MS);
  const now = useNow(expired ? 0 : ELAPSED_TICK_MS);
  const raw = Math.max(0, now - since);
  if (raw > MAX_WORKING_MS) {
    if (!expired) setExpired(true);
    return <IdleChip since={Number.isFinite(idleSince) ? idleSince : since} compact={compact} />;
  }
  const elapsed = formatElapsed(raw);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-primary',
        compact ? 'text-[10px] leading-none' : 'text-[11px] leading-none',
      )}
      title={workingTaskTitle(elapsed, jobs)}
    >
      <span aria-hidden className="relative flex size-1.5 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
      </span>
      <span className="font-semibold tabular-nums">{elapsed}</span>
    </span>
  );
}

/**
 * A task's activity chip, or nothing at all.
 *
 * `sessionId` is the chat the task is being worked in (tasks.source_id, stamped
 * by the dispatch) — the key the agent-work store is indexed by. Tasks that were
 * never dispatched have none, and only ever get the static chip.
 */
export function TaskActivityChip({
  task,
  sessionId,
  compact,
}: {
  task: Pick<Task, 'status' | 'updated_at'>;
  sessionId: string | null;
  compact?: boolean;
}) {
  const work = useSessionWork(sessionId);
  const state = taskActivityState(task, work);
  if (state.kind === 'none') return null;
  if (state.kind === 'working') {
    return (
      <WorkingChip
        since={state.workingSince}
        idleSince={state.idleSince}
        jobs={state.jobs}
        compact={compact}
      />
    );
  }
  if (!Number.isFinite(state.idleSince)) return null;
  return <IdleChip since={state.idleSince} compact={compact} />;
}
