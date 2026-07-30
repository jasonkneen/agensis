import type { ActivityEventComment } from '../types';
import { useRealtimeComments } from './useRealtimeComments';

export interface CreateActivityEventCommentInput {
  content: string;
  parent_id?: string | null;
}

const activityEventCommentsConfig = {
  table: 'activity_event_comments',
  filterField: 'event_id',
  channelPrefix: 'activity-event-comments',
  buildInsertPayload: (
    input: { content: string; parent_id?: string | null },
    extra: Record<string, unknown>,
  ) => ({
    ...extra,
    parent_id: input.parent_id ?? null,
    content: input.content,
  }),
  castRow: (data: Record<string, unknown>) => data as unknown as ActivityEventComment,
};

export function useActivityEventComments(
  eventId: string | null,
  workspaceId: string | null,
  userId?: string,
) {
  return useRealtimeComments<ActivityEventComment, CreateActivityEventCommentInput>(
    activityEventCommentsConfig,
    eventId,
    workspaceId,
    userId,
  );
}
