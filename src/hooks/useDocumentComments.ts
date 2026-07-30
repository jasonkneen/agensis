import type { DocumentComment } from '../types';
import { useRealtimeComments } from './useRealtimeComments';

export interface CreateCommentInput {
  content: string;
  anchor_text?: string;
  parent_id?: string | null;
}

const docCommentsConfig = {
  table: 'document_comments',
  filterField: 'document_id',
  channelPrefix: 'doc-comments',
  buildInsertPayload: (
    input: { content: string; parent_id?: string | null; anchor_text?: string },
    extra: Record<string, unknown>,
  ) => ({
    ...extra,
    parent_id: input.parent_id ?? null,
    content: input.content,
    anchor_text: input.anchor_text ?? '',
  }),
  castRow: (data: Record<string, unknown>) => data as unknown as DocumentComment,
};

export function useDocumentComments(
  documentId: string | null,
  workspaceId: string | null,
  userId?: string,
) {
  return useRealtimeComments<DocumentComment, CreateCommentInput>(
    docCommentsConfig,
    documentId,
    workspaceId,
    userId,
  );
}
