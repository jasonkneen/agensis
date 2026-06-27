import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import type { TaskComment } from '../types';

type DbChangePayload<T> = {
  eventType?: string;
  new?: T;
  old?: Partial<T>;
};

export interface CreateTaskCommentInput {
  content: string;
  parent_id?: string | null;
}

export function useTaskComments(
  taskId: string | null,
  workspaceId: string | null,
  userId?: string,
) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchComments = useCallback(async () => {
    if (!taskId) {
      setComments([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<TaskComment[]>(`task_comments_${taskId}`, async () => {
      const { data } = await backendClient
        .from('task_comments')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true });
      return data;
    });
    if (data) setComments(data);
    setLoading(false);
  }, [taskId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  useEffect(() => {
    if (!taskId) return;
    const channel = backendClient
      .channel(`task-comments:${taskId}`)
      .on(
        'db_changes',
        { event: '*', schema: 'public', table: 'task_comments', filter: `task_id=eq.${taskId}` },
        (payload: DbChangePayload<TaskComment>) => {
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
      )
      .subscribe();
    return () => {
      backendClient.removeChannel(channel);
    };
  }, [taskId]);

  const createComment = useCallback(async (input: CreateTaskCommentInput) => {
    if (!taskId || !workspaceId) return null;
    const data = await offlineInsert('task_comments', {
      task_id: taskId,
      workspace_id: workspaceId,
      user_id: userId ?? null,
      parent_id: input.parent_id ?? null,
      content: input.content,
      resolved: false,
    });
    if (data) {
      const comment = data as unknown as TaskComment;
      setComments(prev => prev.some(c => c.id === comment.id) ? prev : [...prev, comment]);
      return comment;
    }
    return null;
  }, [taskId, workspaceId, userId]);

  const deleteComment = useCallback(async (id: string) => {
    await offlineDelete('task_comments', id);
    setComments(prev => prev.filter(c => c.id !== id && c.parent_id !== id));
    return true;
  }, []);

  const resolveComment = useCallback(async (id: string, resolved: boolean) => {
    const result = await offlineUpdate('task_comments', id, { resolved });
    if (result) {
      setComments(prev => prev.map(c => c.id === id ? { ...c, resolved } as TaskComment : c));
    }
    return result;
  }, []);

  return {
    comments,
    loading,
    createComment,
    deleteComment,
    resolveComment,
    refetch: fetchComments,
  };
}
