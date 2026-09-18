import type { Task, TaskStatus } from '../../types';

// The two things the task list and its board views both need to agree on.
// They used to live in TasksWindowContent, which was fine while the Kanban and
// Gantt views lived there too. They do not any more, and neither file may
// import the other without a cycle, so the shared pair moved down here.

/** Column headings on the board, and the status line in the list. */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

/**
 * The chat session a task came from, or null. Only a task whose source IS a
 * chat has one — `source_id` alone is not enough, because other source types
 * put their own ids there.
 */
export function taskChatSessionId(task: Task): string | null {
  return task.source_type === 'chat' && task.source_id ? task.source_id : null;
}
