import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import type { DbChangePayload } from '../types/realtime';

interface CommentRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  parent_id: string | null;
  content: string;
  resolved: boolean;
  version?: number;
  created_at: string;
  updated_at: string;
}

export interface UseRealtimeCommentsConfig<T extends CommentRow> {
  table: string;
  filterField: string;
  channelPrefix: string;
  buildInsertPayload: (input: { content: string; parent_id?: string | null }, extra: Record<string, unknown>) => Record<string, unknown>;
  castRow: (data: Record<string, unknown>) => T;
}

export function useRealtimeComments<T extends CommentRow>(
  config: UseRealtimeCommentsConfig<T>,
  filterValue: string | null,
  workspaceId: string | null,
  userId?: string,
) {
  const [comments, setComments] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchComments = useCallback(async () => {
    if (!filterValue) {
      setComments([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<T[]>(`${config.table}_${filterValue}`, async () => {
      const { data } = await backendClient
        .from(config.table)
        .select('*')
        .eq(config.filterField, filterValue)
        .order('created_at', { ascending: true });
      return data as unknown as T[];
    });
    if (data) setComments(data);
    setLoading(false);
  }, [filterValue, config.table, config.filterField]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  useEffect(() => {
    if (!filterValue) return;
    const channel = backendClient
      .channel(`${config.channelPrefix}:${filterValue}`)
      .on(
        'db_changes',
        { event: '*', schema: 'public', table: config.table, filter: `${config.filterField}=eq.${filterValue}` },
        (payload: DbChangePayload<T>) => {
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
  }, [filterValue, config.table, config.filterField, config.channelPrefix]);

  const createComment = useCallback(async (input: { content: string; parent_id?: string | null }) => {
    if (!filterValue || !workspaceId) return null;
    const payload = config.buildInsertPayload(input, {
      [config.filterField]: filterValue,
      workspace_id: workspaceId,
      user_id: userId ?? null,
      resolved: false,
    });
    const data = await offlineInsert(config.table, payload);
    if (data) {
      const comment = config.castRow(data);
      setComments(prev => prev.some(c => c.id === comment.id) ? prev : [...prev, comment]);
      return comment;
    }
    return null;
  }, [filterValue, workspaceId, userId, config]);

  const updateComment = useCallback(async (id: string, updates: Partial<T>) => {
    const result = await offlineUpdate(config.table, id, updates as Record<string, unknown>);
    if (result) {
      setComments(prev => prev.map(c => c.id === id ? { ...c, ...result } as T : c));
    }
    return result;
  }, [config.table]);

  const resolveComment = useCallback(async (id: string, resolved: boolean) => {
    return updateComment(id, { resolved } as Partial<T>);
  }, [updateComment]);

  const deleteComment = useCallback(async (id: string) => {
    await offlineDelete(config.table, id);
    setComments(prev => prev.filter(c => c.id !== id && c.parent_id !== id));
    return true;
  }, [config.table]);

  const topLevel = comments.filter(c => !c.parent_id);
  const replyMap = comments.reduce<Record<string, T[]>>((acc, c) => {
    if (c.parent_id) {
      (acc[c.parent_id] = acc[c.parent_id] || []).push(c);
    }
    return acc;
  }, {});

  return {
    comments,
    topLevel,
    replyMap,
    loading,
    createComment,
    updateComment,
    resolveComment,
    deleteComment,
    refetch: fetchComments,
  };
}
