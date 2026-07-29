import type { Task } from '../types';
import type { AgentWork } from './agentWork';

/**
 * "Is this task being worked on right now, and since when" — the whole logic
 * behind the activity chip the List, Board and Timeline views all render.
 *
 * The honest definition matters more than the chip does. Three signals exist and
 * only one of them means work is happening NOW:
 *
 *   tasks.status = 'in_progress'   a STATE. An agent reply flips a todo into it
 *                                  (mirrorAgentReplyToTaskComment) and nothing
 *                                  ever flips it back, so a task abandoned three
 *                                  hours ago still reads 'in_progress'.
 *   agent_connections.status       the daemon's socket, not its work. `busy`
 *                                  means that agent is mid-turn SOMEWHERE — the
 *                                  existing "· working" badge on the assignee
 *                                  says this and is why it can be wrong.
 *   agent_jobs.status = 'running'  a real turn, with a real started_at. This is
 *                                  the only present-tense fact available.
 *
 * So "working" here means: a job is running in the chat session this task is
 * being worked in, AND that job plausibly belongs to THIS task. Everything else
 * that is merely open gets a deliberately different, non-live chip — because a
 * ticking timer on something that stopped hours ago is the exact bug this repo
 * has already shipped once ("Thinking 2m 11s" long after the agent died).
 */

/**
 * Both dispatch paths (dispatchTaskAssignment and the @mention path in
 * server/index.cjs) write `update tasks set … updated_at = now()` immediately
 * BEFORE the agent job is created, so a dispatched task's updated_at lands a
 * beat EARLIER than its job's started_at. Both stamps are the server's own
 * clock, so comparing them to each other carries no browser skew — only the gap
 * between the two writes, which is one round trip.
 *
 * This is the whole reason the chip can be honest. All of an agent's task work
 * lands in ONE DM session, so session-level "an agent is working" would light up
 * every task that agent has ever been given, plus every plain DM turn a human
 * starts with it. Requiring the task's own updated_at to be at least as new as
 * the job means a job that was never about this task cannot claim it.
 */
export const TASK_DISPATCH_SKEW_MS = 15_000;

/** How long "in progress" has to sit untouched before the chip stops rounding to minutes. */
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type TaskActivityKind =
  /** An agent job is running now, and it is this task's. */
  | 'working'
  /** Open and in progress, but nothing is running against it. */
  | 'idle'
  /** Not in progress (todo, done, cancelled) — no chip at all. */
  | 'none';

export interface TaskActivityState {
  kind: TaskActivityKind;
  /** Epoch ms the live clock counts from — the job's started_at. NaN when not working. */
  workingSince: number;
  /** Epoch ms of the last thing that happened to this task — tasks.updated_at. */
  idleSince: number;
  /** How many jobs are running in this task's session (tooltip only). */
  jobs: number;
}

const NOTHING: TaskActivityState = { kind: 'none', workingSince: Number.NaN, idleSince: Number.NaN, jobs: 0 };

function epochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * What the chip should say for one task.
 *
 * Deliberately takes no `now`: nothing here is time-relative, so the value is
 * stable between the store's own updates and the leaf that paints the digits
 * owns the only clock. (The server's 31-minute ceiling on a running job is
 * applied by that leaf, for the same reason — see MAX_WORKING_MS in agentWork.)
 *
 * `work` is the agent-work store's entry for `task.source_id`, i.e. the DM the
 * task is being worked in. Pass null when the task has no chat session, which is
 * every task no agent has ever picked up.
 */
export function taskActivityState(
  task: Pick<Task, 'status' | 'updated_at'>,
  work: AgentWork | null | undefined,
): TaskActivityState {
  if (task.status !== 'in_progress') return NOTHING;
  const idleSince = epochMs(task.updated_at);
  if (work && Number.isFinite(work.anchorAt)) {
    // The correlation that stops one agent's DM lighting up all of its tasks:
    // this task must have been touched at (or after) the moment the job began.
    const dispatched = !Number.isFinite(idleSince) || idleSince >= work.anchorAt - TASK_DISPATCH_SKEW_MS;
    if (dispatched) {
      return { kind: 'working', workingSince: work.anchorAt, idleSince, jobs: Math.max(1, work.jobs) };
    }
  }
  return { kind: 'idle', workingSince: Number.NaN, idleSince, jobs: 0 };
}

/**
 * Coarse elapsed for the NON-live chip: "4m", "3h", "2d". No seconds, ever —
 * seconds are what makes a label look like it is counting, and this one is not.
 * Sub-minute reads "just now" rather than "0m", which would look broken.
 */
export function formatIdleElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return 'just now';
  if (clamped < HOUR_MS) return `${Math.floor(clamped / 60_000)}m`;
  if (clamped < DAY_MS) return `${Math.floor(clamped / HOUR_MS)}h`;
  return `${Math.floor(clamped / DAY_MS)}d`;
}

/** Tooltip for the live chip. */
export function workingTaskTitle(elapsed: string, jobs: number): string {
  return jobs > 1
    ? `An agent is working on this task — ${jobs} jobs running in its chat, oldest started ${elapsed} ago`
    : `An agent is working on this task — started ${elapsed} ago`;
}

/** Tooltip for the non-live chip. Says what the number IS, so it can't be misread as a timer. */
export function idleTaskTitle(elapsed: string): string {
  return elapsed === 'just now'
    ? 'In progress — no agent is running right now; last updated just now'
    : `In progress — no agent is running right now; last updated ${elapsed} ago`;
}
