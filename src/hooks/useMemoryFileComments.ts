import { useMemo } from 'react';
import { useRealtimeComments, type UseRealtimeCommentsConfig } from './useRealtimeComments';
import type { MemoryFileComment } from '../types';

export interface CreateMemoryCommentInput {
 content: string;
 anchor_text?: string;
 parent_id?: string | null;
}

/**
 * Comments on an agent's memory files. These key on the stable `(agent_id, path)`
 * identity (not a FK to the file row), so they survive re-syncs and file deletion.
 * A table can only be filtered server-side by one field, so this subscribes by
 * `agent_id` (the realtime filter) and narrows to the selected `path` client-side
 * via `useRealtimeComments`' `clientFilter`. Thin wrapper over the shared hook —
 * same shape as useDocumentComments / useTaskComments.
 */
export function useMemoryFileComments(
 workspaceId: string | null,
 agentId: string | null,
 path: string | null,
 userId?: string,
) {
 // Config carries `path` (clientFilter + create payload), so it is memoized on
 // `path` rather than module-level. Stable across renders that don't change path
 // — the shared hook keeps `config` in its callback deps.
 const config = useMemo<UseRealtimeCommentsConfig<MemoryFileComment, CreateMemoryCommentInput>>(() => ({
  table: 'memory_file_comments',
  filterField: 'agent_id',
  channelPrefix: 'memory-file-comments',
  clientFilter: (c) => !!path && c.path === path,
  buildInsertPayload: (input, extra) => ({
   ...extra,
   path,
   parent_id: input.parent_id ?? null,
   content: input.content,
   anchor_text: input.anchor_text ?? '',
  }),
  castRow: (data) => data as unknown as MemoryFileComment,
 }), [path]);

 const result = useRealtimeComments<MemoryFileComment, CreateMemoryCommentInput>(
  config,
  agentId,
  workspaceId,
  userId,
 );

 // createComment must no-op without a selected path (the original guarded on it).
 const createComment = useMemo(() => {
  const base = result.createComment;
  return async (input: CreateMemoryCommentInput) => (path ? base(input) : null);
 }, [result.createComment, path]);

 return { ...result, createComment };
}
