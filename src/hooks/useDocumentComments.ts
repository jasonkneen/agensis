import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import type { DocumentComment } from '../types';

export interface CreateCommentInput {
  content: string;
  anchor_text?: string;
  parent_id?: string | null;
}

export function useDocumentComments(
  documentId: string | null,
  workspaceId: string | null,
  userId?: string,
) {
  const [comments, setComments] = useState<DocumentComment[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchComments = useCallback(async () => {
    if (!documentId) {
      setComments([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<DocumentComment[]>(`comments_${documentId}`, async () => {
      const { data } = await backendClient
        .from('document_comments')
        .select('*')
        .eq('document_id', documentId)
        .order('created_at', { ascending: true });
      return data;
    });
    if (data) setComments(data);
    setLoading(false);
  }, [documentId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  useEffect(() => {
    if (!documentId) return;
    const channel = backendClient
      .channel(`doc-comments:${documentId}`)
      .on(
        'db_changes',
        { event: '*', schema: 'public', table: 'document_comments', filter: `document_id=eq.${documentId}` },
        (payload: any) => {
          if (payload.eventType === 'INSERT') {
            const row = payload.new as DocumentComment;
            setComments(prev => prev.some(c => c.id === row.id) ? prev : [...prev, row]);
          } else if (payload.eventType === 'UPDATE') {
            const row = payload.new as DocumentComment;
            setComments(prev => prev.map(c => c.id === row.id ? row : c));
          } else if (payload.eventType === 'DELETE') {
            const row = payload.old as DocumentComment;
            setComments(prev => prev.filter(c => c.id !== row.id));
          }
        },
      )
      .subscribe();
    return () => {
      backendClient.removeChannel(channel);
    };
  }, [documentId]);

  const createComment = useCallback(async (input: CreateCommentInput) => {
    if (!documentId || !workspaceId) return null;
    const data = await offlineInsert('document_comments', {
      document_id: documentId,
      workspace_id: workspaceId,
      user_id: userId ?? null,
      parent_id: input.parent_id ?? null,
      content: input.content,
      anchor_text: input.anchor_text ?? '',
      resolved: false,
    });
    if (data) {
      const comment = data as unknown as DocumentComment;
      setComments(prev => prev.some(c => c.id === comment.id) ? prev : [...prev, comment]);
      return comment;
    }
    return null;
  }, [documentId, workspaceId, userId]);

  const updateComment = useCallback(async (id: string, updates: Partial<DocumentComment>) => {
    const result = await offlineUpdate('document_comments', id, updates as Record<string, unknown>);
    if (result) {
      setComments(prev => prev.map(c => c.id === id ? { ...c, ...result } as DocumentComment : c));
    }
    return result;
  }, []);

  const resolveComment = useCallback(async (id: string, resolved: boolean) => {
    return updateComment(id, { resolved });
  }, [updateComment]);

  const deleteComment = useCallback(async (id: string) => {
    await offlineDelete('document_comments', id);
    setComments(prev => prev.filter(c => c.id !== id && c.parent_id !== id));
    return true;
  }, []);

  const topLevel = comments.filter(c => !c.parent_id);
  const replyMap = comments.reduce<Record<string, DocumentComment[]>>((acc, c) => {
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
