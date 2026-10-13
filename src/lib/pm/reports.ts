import type { Task } from '../../types';

// Numbers behind the dashboard and the project Reports tab. Everything is derived
// from each task's created_at / completed_at, so no extra history is stored.
// All functions take `now` so tests and callers agree on "today".

const DAY = 24 * 60 * 60 * 1000;

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const closed = (task: Pick<Task, 'status'>) => task.status === 'done' || task.status === 'cancelled';

export interface BurndownPoint {
  /** Start of the day, in ms. */
  day: number;
  remaining: number;
  ideal: number;
}

/**
 * Open tasks at the end of each day from `from` to `to`, with a straight ideal
 * line from the starting scope to zero. Tasks created mid-range raise the line
 * (scope added); tasks completed or cancelled lower it. The series stops at `now`
 * for the actual line, so it never plots the future.
 */
export function burndown(tasks: Task[], from: number, to: number, now: number): BurndownPoint[] {
  const start = startOfDay(from);
  const end = Math.max(startOfDay(to), start);
  const today = startOfDay(now);
  const live = tasks.filter(task => task.status !== 'cancelled' || task.completed_at);
  const days = Math.round((end - start) / DAY);
  const openAt = (dayEnd: number) =>
    live.filter(task => {
      const created = new Date(task.created_at).getTime();
      if (created > dayEnd) return false;
      if (task.status === 'done' || task.status === 'cancelled') {
        const finished = new Date(task.completed_at ?? task.updated_at).getTime();
        return finished > dayEnd;
      }
      return true;
    }).length;
  const startScope = openAt(start + DAY - 1);
  const points: BurndownPoint[] = [];
  for (let i = 0; i <= days; i += 1) {
    const day = start + i * DAY;
    if (day > today) break;
    points.push({
      day,
      remaining: openAt(day + DAY - 1),
      ideal: days === 0 ? 0 : Math.round((startScope * (days - i)) / days * 10) / 10,
    });
  }
  return points;
}

export interface VelocityWeek {
  /** Start of the week (Monday), in ms. */
  weekStart: number;
  done: number;
  /** True for the week that contains `now`. */
  current: boolean;
}

function mondayOf(ms: number): number {
  const d = new Date(startOfDay(ms));
  const offset = (d.getDay() + 6) % 7;
  return d.getTime() - offset * DAY;
}

/** Tasks completed per week for the last `weeks` weeks, oldest first. */
export function velocity(tasks: Pick<Task, 'status' | 'completed_at'>[], weeks: number, now: number): VelocityWeek[] {
  const thisWeek = mondayOf(now);
  const result: VelocityWeek[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const weekStart = thisWeek - i * 7 * DAY;
    const weekEnd = weekStart + 7 * DAY;
    const done = tasks.filter(task => {
      if (task.status !== 'done' || !task.completed_at) return false;
      const at = new Date(task.completed_at).getTime();
      return at >= weekStart && at < weekEnd;
    }).length;
    result.push({ weekStart, done, current: i === 0 });
  }
  return result;
}

/** Mean tasks per finished week, ignoring the week still in progress. */
export function averageVelocity(weeksData: VelocityWeek[]): number {
  const full = weeksData.filter(week => !week.current);
  if (full.length === 0) return 0;
  return Math.round((full.reduce((sum, week) => sum + week.done, 0) / full.length) * 10) / 10;
}

export interface FlowPoint {
  day: number;
  created: number;
  completed: number;
}

/** Cumulative tasks created and completed by the end of each day up to `now`. */
export function createdVsCompleted(tasks: Task[], from: number, to: number, now: number): FlowPoint[] {
  const start = startOfDay(from);
  const end = Math.min(startOfDay(to), startOfDay(now));
  const points: FlowPoint[] = [];
  for (let day = start; day <= end; day += DAY) {
    const dayEnd = day + DAY - 1;
    points.push({
      day,
      created: tasks.filter(task => new Date(task.created_at).getTime() <= dayEnd).length,
      completed: tasks.filter(task => task.status === 'done' && task.completed_at && new Date(task.completed_at).getTime() <= dayEnd).length,
    });
  }
  return points;
}

export interface StatusSlice {
  status: Task['status'];
  count: number;
}

export function statusBreakdown(tasks: Pick<Task, 'status'>[]): StatusSlice[] {
  const counts: Record<Task['status'], number> = { todo: 0, in_progress: 0, done: 0, cancelled: 0 };
  for (const task of tasks) if (task.status in counts) counts[task.status] += 1;
  return (Object.keys(counts) as Task['status'][]).map(status => ({ status, count: counts[status] }));
}

export interface WorkloadRow {
  /** User id for a person, agent id for an agent. */
  id: string;
  isAgent: boolean;
  inProgress: number;
  todo: number;
  total: number;
}

/**
 * Open tasks per assignee, people and agents together, busiest first. Unassigned
 * tasks are not a row. `agentIds` says which assignee ids are agents.
 */
export function workload(tasks: Pick<Task, 'status' | 'assignee_id'>[], agentIds: Set<string>): WorkloadRow[] {
  const rows = new Map<string, WorkloadRow>();
  for (const task of tasks) {
    if (!task.assignee_id || closed(task)) continue;
    const row = rows.get(task.assignee_id) ?? { id: task.assignee_id, isAgent: agentIds.has(task.assignee_id), inProgress: 0, todo: 0, total: 0 };
    if (task.status === 'in_progress') row.inProgress += 1;
    else row.todo += 1;
    row.total += 1;
    rows.set(task.assignee_id, row);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

export interface WorkspaceTotals {
  openTasks: number;
  agentTasks: number;
  doneThisWeek: number;
  overdue: number;
}

export function workspaceTotals(tasks: Task[], agentIds: Set<string>, now: number): WorkspaceTotals {
  const today = startOfDay(now);
  const weekStart = mondayOf(now);
  let openTasks = 0;
  let agentTasks = 0;
  let doneThisWeek = 0;
  let overdue = 0;
  for (const task of tasks) {
    if (closed(task)) {
      if (task.status === 'done' && task.completed_at && new Date(task.completed_at).getTime() >= weekStart) doneThisWeek += 1;
      continue;
    }
    openTasks += 1;
    if (task.assignee_id && agentIds.has(task.assignee_id)) agentTasks += 1;
    if (task.due_date && startOfDay(new Date(task.due_date).getTime()) < today) overdue += 1;
  }
  return { openTasks, agentTasks, doneThisWeek, overdue };
}
