import type { Task } from '../../types';

// Notifications derived from tasks, for the bell next to the Inbox's own items.
// Nothing is stored: each entry is a fact about a task right now (it is overdue,
// it was just given to you, an agent just finished it), so it clears itself when
// the task changes. That is also why these carry no unread dot.

const DAY = 24 * 60 * 60 * 1000;
const RECENT_MS = 3 * DAY;

export type TaskNotificationKind = 'overdue' | 'assigned' | 'agent_done';

export interface TaskNotification {
  id: string;
  kind: TaskNotificationKind;
  taskId: string;
  title: string;
  /** Who did it, for agent_done and assigned. Null when unknown. */
  actorId: string | null;
  /** ISO time the bell sorts and groups by. */
  at: string;
}

interface Options {
  userId: string | null | undefined;
  agentIds: Set<string>;
  now: number;
}

const isClosed = (task: Pick<Task, 'status'>) => task.status === 'done' || task.status === 'cancelled';

export function taskNotifications(tasks: Task[], { userId, agentIds, now }: Options): TaskNotification[] {
  const out: TaskNotification[] = [];
  for (const task of tasks) {
    const mine = Boolean(userId) && task.assignee_id === userId;

    if (mine && !isClosed(task) && task.due_date && new Date(task.due_date).getTime() < now) {
      out.push({ id: `overdue:${task.id}`, kind: 'overdue', taskId: task.id, title: task.title, actorId: null, at: task.due_date });
    }

    if (mine && !isClosed(task) && task.created_by && task.created_by !== userId && now - new Date(task.created_at).getTime() <= RECENT_MS) {
      out.push({ id: `assigned:${task.id}`, kind: 'assigned', taskId: task.id, title: task.title, actorId: task.created_by, at: task.created_at });
    }

    if (
      task.status === 'done' &&
      task.assignee_id &&
      agentIds.has(task.assignee_id) &&
      task.completed_at &&
      now - new Date(task.completed_at).getTime() <= RECENT_MS
    ) {
      out.push({ id: `agent_done:${task.id}`, kind: 'agent_done', taskId: task.id, title: task.title, actorId: task.assignee_id, at: task.completed_at });
    }
  }
  return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** True when the ISO time falls on the same calendar day as `now`. */
export function isToday(iso: string, now: number): boolean {
  const a = new Date(iso);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
