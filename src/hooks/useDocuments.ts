import { useEffect, useCallback, useRef } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState, useWorkspaceState } from './useWorkspaceState';
import type { Document } from '../types';

// NET-06: the documents LIST is metadata-only — pulling every doc's full HTML
// body for a title list (Sidebar, pickers) is wasteful, especially with many
// large docs. These are the columns the list needs; `content` is fetched on
// demand via fetchDocumentContent and kept in a separate per-doc cache.
const DOCUMENT_LIST_COLUMNS = 'id, workspace_id, title, is_favorite, folder, version, created_at, updated_at';

// A metadata-only document (body removed). Used everywhere the LIST is written.
function stripContent(doc: Record<string, unknown>): Document {
  if (doc.content === undefined) return doc as unknown as Document;
  const copy = { ...doc };
  delete copy.content;
  return copy as unknown as Document;
}

// Strip a document's body so it never enters the metadata-only list state (a
// realtime UPDATE or a save result would otherwise leak the full body back in).
function toListDocument(doc: Document): Document {
  return stripContent(doc as unknown as Record<string, unknown>);
}

/**
 * Keep the per-doc body cache coherent with a realtime fanout row.
 * When content is present, refresh; when stripped (heavy-field fanout), delete
 * so the next editor open re-fetches instead of serving a stale body.
 */
export function applyDocumentRealtimeToContentCache(
  cache: Map<string, string>,
  eventType: string,
  nextDoc: { id?: string; content?: string } | null | undefined,
  oldDoc?: { id?: string } | null,
): void {
  if (eventType === 'DELETE') {
    if (oldDoc?.id) cache.delete(oldDoc.id);
    return;
  }
  if (!nextDoc?.id) return;
  const nextId = nextDoc.id;
  if (typeof nextDoc.content === 'string') {
    cache.set(nextId, nextDoc.content);
  } else if (eventType === 'UPDATE' || eventType === 'INSERT') {
    cache.delete(nextId);
  }
}

export function useDocuments(workspaceId: string | null, seed?: Document[] | null) {
  const [documents, setDocuments, beginDocumentsRequest] = useWorkspaceListState<Document>(
    workspaceId,
    (seed || []).filter(doc => doc.workspace_id === workspaceId).map(toListDocument),
  );
  const [loading, setLoading] = useWorkspaceState(
    workspaceId,
    !seed?.length,
    Boolean(workspaceId),
  );
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-doc content cache (id -> body). Populated by fetchDocumentContent and
  // invalidated when a doc's realtime UPDATE arrives (its body may have changed).
  const contentCache = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (seed) setDocuments(seed.filter(doc => doc.workspace_id === workspaceId).map(toListDocument));
  }, [seed, setDocuments, workspaceId]);

  const fetchDocuments = useCallback(async () => {
    const isCurrent = beginDocumentsRequest();
    if (!workspaceId) {
      setDocuments([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await cachedFetch<Document[]>(`documents_meta_${workspaceId}`, async () => {
        const { data } = await backendClient
          .from('documents')
          .select(DOCUMENT_LIST_COLUMNS)
          .eq('workspace_id', workspaceId)
          .order('updated_at', { ascending: false });
        return data;
      });
      if (isCurrent() && data) setDocuments(data.map(toListDocument));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginDocumentsRequest, setDocuments, setLoading, workspaceId]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // NET-06: fetch a single document's body on demand (editor open, search index,
  // applet render). Cached per doc; pass force to bypass the cache after an edit.
  const fetchDocumentContent = useCallback(async (id: string, force = false): Promise<string> => {
    if (!id) return '';
    if (!force) {
      const cached = contentCache.current.get(id);
      if (cached !== undefined) return cached;
    }
    const { data } = await backendClient
      .from('documents')
      .select('id, content')
      .eq('id', id);
    const body = (Array.isArray(data) ? data[0]?.content : (data as { content?: string } | null)?.content) || '';
    contentCache.current.set(id, body);
    return body;
  }, []);

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
      const eventType = String(payload.eventType || '');
      if (eventType === 'DELETE') {
        const oldDoc = payload.old;
        applyDocumentRealtimeToContentCache(contentCache.current, eventType, null, oldDoc);
        if (oldDoc?.id) {
          setDocuments(prev => prev.filter(doc => doc.id !== oldDoc.id));
        }
        return;
      }

      const nextDoc = payload.new;
      if (!nextDoc?.id) return;
      applyDocumentRealtimeToContentCache(contentCache.current, eventType, nextDoc);
      const listDoc = toListDocument(nextDoc as Document);
      setDocuments(prev => {
        const existingIndex = prev.findIndex(doc => doc.id === listDoc.id);
        if (existingIndex === -1) {
          return [listDoc, ...prev].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
        }
        const next = [...prev];
        next[existingIndex] = { ...next[existingIndex], ...listDoc };
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
    }, `documents_meta_${workspaceId}`);
    if (data) {
      const doc = data as unknown as Document;
      // A new doc's body is empty; prime the cache and keep the list metadata-only.
      contentCache.current.set(doc.id, doc.content ?? '');
      setDocuments(prev => [toListDocument(doc), ...prev]);
      return doc;
    }
    return null;
  }, [setDocuments, workspaceId]);

  const saveDocument = useCallback(async (id: string, updates: { title?: string; content?: string; folder?: string | null }) => {
    const result = await offlineUpdate('documents', id, {
      ...updates,
      updated_at: new Date().toISOString(),
    }, `documents_meta_${workspaceId}`);
    if (result) {
      // Keep the content cache authoritative for a body edit, but never let the
      // body into the metadata-only list state.
      if (typeof updates.content === 'string') contentCache.current.set(id, updates.content);
      setDocuments(prev => prev.map(d => d.id === id ? stripContent({ ...d, ...(result as Record<string, unknown>) }) : d));
    }
    return result;
  }, [setDocuments, workspaceId]);

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
    await offlineDelete('documents', id, `documents_meta_${workspaceId}`);
    contentCache.current.delete(id);
    setDocuments(prev => prev.filter(d => d.id !== id));
    return true;
  }, [setDocuments, workspaceId]);

  const toggleFavorite = useCallback(async (id: string, currentValue: boolean) => {
    const result = await offlineUpdate('documents', id, {
      is_favorite: !currentValue,
      updated_at: new Date().toISOString(),
    }, `documents_meta_${workspaceId}`);
    if (result) {
      setDocuments(prev => prev.map(d => d.id === id ? stripContent({ ...d, ...(result as Record<string, unknown>) }) : d));
    }
  }, [setDocuments, workspaceId]);

  // Applet storage docs (folder === APPLETS_FOLDER) are real documents that also
  // back the Canvas Apps picker (see CanvasTemplatePicker) — they're shown in
  // Documents like any other doc (DocumentRow gives them a distinct icon and
  // "Add to canvas" action), just routed to a code editor instead of the
  // rich-text one (see WindowBodies.tsx / AppletDocWindowContent).
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
    fetchDocumentContent,
  };
}
