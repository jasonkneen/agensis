import type { ActivityEvent, Task } from '../../types';

/**
 * The activity for one project: task events (created, completed, updated) for the
 * tasks that belong to it, newest first. Events for other entities, or for tasks in
 * other projects, are left out. A deleted task's events are kept only if the task
 * is still in `projectTasks`, so they drop off with it.
 */
export function projectActivity(events: ActivityEvent[], projectTasks: Pick<Task, 'id'>[], limit = 50): ActivityEvent[] {
  const ids = new Set(projectTasks.map(task => task.id));
  return events
    .filter(event => event.entity_type === 'task' && event.entity_id !== null && ids.has(event.entity_id))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);
}
