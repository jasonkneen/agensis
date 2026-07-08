import { useState, useEffect, useCallback, useRef } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { Document } from '../types';

export function useDocuments(workspaceId: string | null, seed?: Document[] | null) {
  const [documents, setDocuments] = useState<Document[]>(() => seed || []);
  const [loading, setLoading] = useState(!seed?.length);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (seed) setDocuments(seed);
  }, [seed]);

  const fetchDocuments = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    const data = await cachedFetch<Document[]>(`documents_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('documents')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('updated_at', { ascending: false });
      return data;
    });
    if (data) setDocuments(data);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<Document>(
    {
      enabled: !!workspaceId,
      channelName: `documents:${workspaceId}`,
      table: 'documents',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      const eventType = payload.eventType;
      if (eventType === 'DELETE') {
        const oldDoc = payload.old;
        if (oldDoc?.id) setDocuments(prev => prev.filter(doc => doc.id !== oldDoc.id));
        return;
      }

      const nextDoc = payload.new;
      if (!nextDoc?.id) return;
      setDocuments(prev => {
        const existingIndex = prev.findIndex(doc => doc.id === nextDoc.id);
        if (existingIndex === -1) {
          return [nextDoc, ...prev].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
        }
        const next = [...prev];
        next[existingIndex] = { ...next[existingIndex], ...nextDoc };
        return next.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      });
    },
  );

  const createDocument = useCallback(async (title = 'Untitled') => {
    if (!workspaceId) return null;
    const data = await offlineInsert('documents', {
      workspace_id: workspaceId,
      title,
      content: '',
      is_favorite: false,
    }, `documents_${workspaceId}`);
    if (data) {
      const doc = data as unknown as Document;
      setDocuments(prev => [doc, ...prev]);
      return doc;
    }
    return null;
  }, [workspaceId]);

  const saveDocument = useCallback(async (id: string, updates: { title?: string; content?: string; folder?: string | null }) => {
    const result = await offlineUpdate('documents', id, {
      ...updates,
      updated_at: new Date().toISOString(),
    }, `documents_${workspaceId}`);
    if (result) {
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, ...result } as Document : d));
    }
    return result;
    }, [workspaceId]);

  const autoSave = useCallback((id: string, updates: { title?: string; content?: string; folder?: string | null }) => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      saveDocument(id, updates);
    }, 800);
  }, [saveDocument]);

  const deleteDocument = useCallback(async (id: string) => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    await offlineDelete('documents', id, `documents_${workspaceId}`);
    setDocuments(prev => prev.filter(d => d.id !== id));
    return true;
    }, [workspaceId]);

  const toggleFavorite = useCallback(async (id: string, currentValue: boolean) => {
    const result = await offlineUpdate('documents', id, {
      is_favorite: !currentValue,
      updated_at: new Date().toISOString(),
    }, `documents_${workspaceId}`);
    if (result) {
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, ...result } as Document : d));
    }
    }, [workspaceId]);

  const favorites = documents.filter(d => d.is_favorite);
  const recents = documents.slice(0, 5);

  return {
    documents,
    favorites,
    recents,
    loading,
    createDocument,
    saveDocument,
    autoSave,
    deleteDocument,
    toggleFavorite,
    refetch: fetchDocuments,
  };
}
