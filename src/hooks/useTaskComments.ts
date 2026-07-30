import type { TaskComment } from '../types';
import { useRealtimeComments } from './useRealtimeComments';

export interface CreateTaskCommentInput {
  content: string;
  parent_id?: string | null;
}

const taskCommentsConfig = {
  table: 'task_comments',
  filterField: 'task_id',
  channelPrefix: 'task-comments',
  buildInsertPayload: (
    input: { content: string; parent_id?: string | null },
    extra: Record<string, unknown>,
  ) => ({
    ...extra,
    parent_id: input.parent_id ?? null,
    content: input.content,
  }),
  castRow: (data: Record<string, unknown>) => data as unknown as TaskComment,
};

export function useTaskComments(
  taskId: string | null,
  workspaceId: string | null,
  userId?: string,
) {
  return useRealtimeComments<TaskComment, CreateTaskCommentInput>(
    taskCommentsConfig,
    taskId,
    workspaceId,
    userId,
  );
}
