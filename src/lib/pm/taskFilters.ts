import type { Task, TaskPriority } from '../../types';

// Extra task filters and grouping from the approved Section 10 mock. Pure, so the
// List and the saved views agree on what a filter or a group means.

export type TaskGroupBy = 'status' | 'assignee' | 'priority' | 'project' | 'due';
export const GROUP_BYS: TaskGroupBy[] = ['status', 'assignee', 'priority', 'project', 'due'];
export const GROUP_BY_LABELS: Record<TaskGroupBy, string> = {
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  project: 'Project',
  due: 'Due week',
};
export const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];

export interface ExtraFilters {
  priorities: TaskPriority[];
  labels: string[];
}

/** True when the task passes: any selected priority, and any selected label. Empty selections match everything. */
export function matchesExtraFilters(task: Pick<Task, 'priority' | 'labels'>, filters: ExtraFilters): boolean {
  if (filters.priorities.length && !filters.priorities.includes(task.priority)) return false;
  if (filters.labels.length && !filters.labels.some(label => task.labels?.includes(label))) return false;
  return true;
}

/** How many separate extra filters are switched on (priority counts as one, labels as one). */
export function activeExtraFilterCount(filters: ExtraFilters, groupBy: TaskGroupBy): number {
  return (filters.priorities.length ? 1 : 0) + (filters.labels.length ? 1 : 0) + (groupBy !== 'status' ? 1 : 0);
}

/** Every label used by the tasks, sorted. */
export function allLabels(tasks: Pick<Task, 'labels'>[]): string[] {
  return [...new Set(tasks.flatMap(task => task.labels ?? []))].sort();
}

export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}

export interface GroupContext {
  /** Label for an assignee id; falsy ids are Unassigned. */
  assigneeLabel: (id: string | null) => string;
  /** Name for a project id. */
  projectName: (id: string | null | undefined) => string;
  now: number;
}

const DAY = 24 * 60 * 60 * 1000;

function mondayOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - ((d.getDay() + 6) % 7) * DAY;
}

function dueBucket(task: Task, now: number): { key: string; label: string; order: number } {
  if (!task.due_date) return { key: 'none', label: 'No due date', order: 9e15 };
  const due = new Date(task.due_date).getTime();
  const week = mondayOf(due);
  const thisWeek = mondayOf(now);
  if (week < thisWeek) return { key: 'overdue', label: 'Earlier', order: -1 };
  if (week === thisWeek) return { key: 'this', label: 'This week', order: 0 };
  if (week === thisWeek + 7 * DAY) return { key: 'next', label: 'Next week', order: 1 };
  return { key: `w${week}`, label: `Week of ${new Date(week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, order: (week - thisWeek) / DAY };
}

/**
 * Splits tasks into labelled groups. Within a group the incoming order is kept.
 * Status is handled by the List itself (its own order and labels), so it is not built here.
 */
export function groupTasks(tasks: Task[], by: Exclude<TaskGroupBy, 'status'>, ctx: GroupContext): TaskGroup[] {
  const buckets = new Map<string, { label: string; order: number; tasks: Task[] }>();
  const put = (key: string, label: string, order: number, task: Task) => {
    const bucket = buckets.get(key) ?? { label, order, tasks: [] };
    bucket.tasks.push(task);
    buckets.set(key, bucket);
  };

  for (const task of tasks) {
    if (by === 'assignee') {
      put(task.assignee_id ?? 'none', ctx.assigneeLabel(task.assignee_id), task.assignee_id ? 0 : 1, task);
    } else if (by === 'priority') {
      put(task.priority, task.priority.charAt(0).toUpperCase() + task.priority.slice(1), PRIORITIES.indexOf(task.priority), task);
    } else if (by === 'project') {
      put(task.project_id ?? 'none', task.project_id ? ctx.projectName(task.project_id) : 'No project', task.project_id ? 0 : 1, task);
    } else {
      const bucket = dueBucket(task, ctx.now);
      put(bucket.key, bucket.label, bucket.order, task);
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[1].order - b[1].order || a[1].label.localeCompare(b[1].label))
    .map(([key, bucket]) => ({ key, label: bucket.label, tasks: bucket.tasks }));
}
