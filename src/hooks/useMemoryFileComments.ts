import { useState, useEffect, useCallback, useMemo } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { MemoryFileComment } from '../types';

export interface CreateMemoryCommentInput {
  content: string;
  anchor_text?: string;
  parent_id?: string | null;
}

/**
 * Comments on an agent's memory files. These key on the stable `(agent_id, path)`
 * identity (not a FK to the file row), so they survive re-syncs and file deletion.
 * The shared `useRealtimeComments` hook only supports a single filter field, so this
 * fetches/subscribes by `agent_id` and filters to the selected `path` client-side.
 */
export function useMemoryFileComments(
  workspaceId: string | null,
  agentId: string | null,
  path: string | null,
  userId?: string,
) {
  const [comments, setComments] = useState<MemoryFileComment[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchComments = useCallback(async () => {
    if (!agentId) {
      setComments([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<MemoryFileComment[]>(`memory_file_comments_${agentId}`, async () => {
      const { data } = await backendClient
        .from('memory_file_comments')
        .select('*')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: true });
      return data as unknown as MemoryFileComment[];
    });
    if (data) setComments(data);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<MemoryFileComment>(
    {
      enabled: !!agentId,
      channelName: `memory-file-comments:${agentId}`,
      table: 'memory_file_comments',
      event: '*',
      schema: 'public',
      filter: `agent_id=eq.${agentId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT') {
        const row = payload.new;
        if (!row) return;
        setComments(prev => prev.some(c => c.id === row.id) ? prev : [...prev, row]);
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new;
        if (!row) return;
        setComments(prev => prev.map(c => c.id === row.id ? row : c));
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.id) return;
        setComments(prev => prev.filter(c => c.id !== row.id));
      }
    },
  );

  // The panel only ever shows one file at a time, so scope everything to `path`.
  const pathComments = useMemo(
    () => (path ? comments.filter(c => c.path === path) : []),
    [comments, path],
  );
  const topLevel = useMemo(() => pathComments.filter(c => !c.parent_id), [pathComments]);
  const replyMap = useMemo(() => pathComments.reduce<Record<string, MemoryFileComment[]>>((acc, c) => {
    if (c.parent_id) {
      (acc[c.parent_id] = acc[c.parent_id] || []).push(c);
    }
    return acc;
  }, {}), [pathComments]);

  const createComment = useCallback(async (input: CreateMemoryCommentInput) => {
    if (!agentId || !path || !workspaceId) return null;
    const data = await offlineInsert('memory_file_comments', {
      workspace_id: workspaceId,
      agent_id: agentId,
      path,
      user_id: userId ?? null,
      parent_id: input.parent_id ?? null,
      content: input.content,
      anchor_text: input.anchor_text ?? '',
      resolved: false,
    }, `memory_file_comments_${agentId}`);
    if (data) {
      const comment = data as unknown as MemoryFileComment;
      setComments(prev => prev.some(c => c.id === comment.id) ? prev : [...prev, comment]);
      return comment;
    }
    return null;
  }, [agentId, path, workspaceId, userId]);

  const resolveComment = useCallback(async (id: string, resolved: boolean) => {
    const result = await offlineUpdate('memory_file_comments', id, { resolved }, `memory_file_comments_${agentId}`);
    if (result) {
      setComments(prev => prev.map(c => c.id === id ? { ...c, ...result } as MemoryFileComment : c));
    }
    return result;
    }, [agentId]);

  const deleteComment = useCallback(async (id: string) => {
    await offlineDelete('memory_file_comments', id, `memory_file_comments_${agentId}`);
    setComments(prev => prev.filter(c => c.id !== id && c.parent_id !== id));
    return true;
    }, [agentId]);

  return {
    comments: pathComments,
    topLevel,
    replyMap,
    loading,
    createComment,
    resolveComment,
    deleteComment,
    refetch: fetchComments,
  };
}
