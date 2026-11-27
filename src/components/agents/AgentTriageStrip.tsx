import type { Task, WorkspaceAgent } from '@/types';
import { cn } from '@/lib/utils';

// The four questions you ask of a team of agents, answered at a glance before
// any card: what needs me, who is working, what is waiting, what got done.
// (After the triage counters in the agent-lead UI Jason pointed at.)
//
// Every number is real state already in the window — tasks assigned to an
// agent, and live presence — so the strip never shows a figure it made up.

export interface AgentTriageCounts {
  /** Agent tasks waiting in review: a human has to look. */
  needsYou: number;
  /** Agents busy right now (live presence). */
  working: number;
  /** Agent tasks not yet started (todo + backlog). */
  queued: number;
  /** Agent tasks completed since local midnight. */
  doneToday: number;
}

export function agentTriageCounts(
  agents: Pick<WorkspaceAgent, 'id'>[],
  tasks: Pick<Task, 'assignee_id' | 'status' | 'completed_at' | 'parent_id'>[],
  busyAgents: number,
  now: Date = new Date(),
): AgentTriageCounts {
  const agentIds = new Set(agents.map(agent => agent.id));
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const counts: AgentTriageCounts = { needsYou: 0, working: busyAgents, queued: 0, doneToday: 0 };
  for (const task of tasks) {
    if (!task.assignee_id || !agentIds.has(task.assignee_id)) continue;
    if (task.status === 'in_review') counts.needsYou += 1;
    else if (task.status === 'todo' || task.status === 'backlog') counts.queued += 1;
    else if (task.status === 'done' && task.completed_at && new Date(task.completed_at) >= midnight) counts.doneToday += 1;
  }
  return counts;
}

export function AgentTriageStrip({
  counts,
  workingActive,
  onShowWorking,
}: {
  counts: AgentTriageCounts;
  /** The grid is already filtered to busy agents. */
  workingActive?: boolean;
  onShowWorking?: () => void;
}) {
  const tiles: Array<{ key: keyof AgentTriageCounts; label: string; tone?: 'attention'; onClick?: () => void; pressed?: boolean }> = [
    { key: 'needsYou', label: 'Needs you', tone: counts.needsYou > 0 ? 'attention' : undefined },
    { key: 'working', label: 'Working', onClick: onShowWorking, pressed: workingActive },
    { key: 'queued', label: 'Queued' },
    { key: 'doneToday', label: 'Done today' },
  ];
  return (
    <div className="agents-triage-strip relative mb-3 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-border bg-border" role="group" aria-label="Agent triage">
      {tiles.map(tile => {
        const body = (
          <>
            <span className={cn('text-lg font-semibold leading-tight tabular-nums', tile.tone === 'attention' && 'text-warning')}>
              {counts[tile.key]}
            </span>
            <span className="truncate text-xs text-muted-foreground">{tile.label}</span>
          </>
        );
        const base = 'flex min-w-0 flex-col items-start gap-0.5 bg-card px-3 py-2 text-left';
        return tile.onClick ? (
          <button
            key={tile.key}
            type="button"
            aria-pressed={tile.pressed}
            onClick={tile.onClick}
            title="Show only agents that are working"
            className={cn(base, 'transition-colors hover:bg-muted/60', tile.pressed && 'bg-muted')}
          >
            {body}
          </button>
        ) : (
          <div key={tile.key} className={base}>{body}</div>
        );
      })}
    </div>
  );
}
