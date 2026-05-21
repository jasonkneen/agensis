import { useState, useEffect, useCallback, useRef } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import type { Document } from '../types';

export function useDocuments(workspaceId: string | null) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const createDocument = useCallback(async (title = 'Untitled') => {
    if (!workspaceId) return null;
    const data = await offlineInsert('documents', {
      workspace_id: workspaceId,
      title,
      content: '',
      is_favorite: false,
    });
    if (data) {
      const doc = data as unknown as Document;
      setDocuments(prev => [doc, ...prev]);
      return doc;
    }
    return null;
  }, [workspaceId]);

  const saveDocument = useCallback(async (id: string, updates: { title?: string; content?: string }) => {
    const result = await offlineUpdate('documents', id, {
      ...updates,
      updated_at: new Date().toISOString(),
    });
    if (result) {
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, ...result } as Document : d));
    }
    return result;
  }, []);

  const autoSave = useCallback((id: string, updates: { title?: string; content?: string }) => {
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
    await offlineDelete('documents', id);
    setDocuments(prev => prev.filter(d => d.id !== id));
    return true;
  }, []);

  const toggleFavorite = useCallback(async (id: string, currentValue: boolean) => {
    const result = await offlineUpdate('documents', id, {
      is_favorite: !currentValue,
      updated_at: new Date().toISOString(),
    });
    if (result) {
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, ...result } as Document : d));
    }
  }, []);

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
