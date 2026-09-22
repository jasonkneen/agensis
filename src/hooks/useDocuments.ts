import { useEffect, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { apiAuthHeaders, backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState, useWorkspaceState } from './useWorkspaceState';
import { DocumentBodyCache } from '../lib/documentBodyCache';
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
  // Debounce independently per document. A single timer here means typing in
  // one editor cancels another editor's pending write (and deleting one doc
  // cancels every other pending write).
  const autoSaveTimers = useRef(new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    updates: { title?: string; content?: string; folder?: string | null };
    owner: string;
  }>());
  // Per-doc content cache (id -> body). Populated by fetchDocumentContent and
  // invalidated when a doc's realtime UPDATE arrives (its body may have changed).
  const renderAuthOwner = apiAuthHeaders().Authorization || '';
  const bodyScope = useMemo(() => ({
    workspaceId,
    owner: renderAuthOwner,
    cache: new DocumentBodyCache(),
    reads: new Map<string, AbortController>(),
    pending: new Map<string, Promise<string>>(),
  }), [workspaceId, renderAuthOwner]);
  const activeBodyScope = useRef(bodyScope);
  activeBodyScope.current = bodyScope;
  const contentCache = bodyScope.cache;
  useEffect(() => () => {
    for (const controller of bodyScope.reads.values()) controller.abort();
    bodyScope.reads.clear();
    bodyScope.pending.clear();
    bodyScope.cache.clear();
  }, [bodyScope]);
  const saveGenerations = useRef(new Map<string, number>());
  const documentWrites = useRef(new Map<string, Promise<Record<string, unknown> | null>>());
  const saveNotices = useRef(new Map<string, string>());
  const dismissSaveNotice = useCallback((id: string) => {
    const notice = saveNotices.current.get(id);
    if (!notice) return;
    saveNotices.current.delete(id);
    toast.dismiss(notice);
  }, []);

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
    const isCurrent = () => activeBodyScope.current === bodyScope
      && bodyScope.owner === (apiAuthHeaders().Authorization || '');
    if (!id || !bodyScope.workspaceId || !bodyScope.owner || !isCurrent()) return '';
    if (!force) {
      const cached = contentCache.get(id);
      if (cached !== undefined) return cached;
      const pending = bodyScope.pending.get(id);
      if (pending) return pending;
    }
    if (force) contentCache.delete(id);
    bodyScope.reads.get(id)?.abort();
    const controller = new AbortController();
    bodyScope.reads.set(id, controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const request = (async () => {
      try {
        const { data, error } = await backendClient
          .from('documents')
          .select('id, content')
          .eq('id', id)
          .eq('workspace_id', bodyScope.workspaceId)
          .abortSignal(controller.signal);
        if (!isCurrent()) return '';
        if (controller.signal.aborted) {
          const newer = bodyScope.reads.get(id);
          if (newer && newer !== controller) return bodyScope.pending.get(id) ?? '';
          const cached = contentCache.get(id);
          if (cached !== undefined) return cached;
          throw new Error('Document content could not be loaded.');
        }
        if (error) throw new Error('Document content could not be loaded.');
        const row = Array.isArray(data) ? data[0] : data;
        if (!row || typeof row.content !== 'string') throw new Error('Document content is unavailable.');
        contentCache.set(id, row.content);
        return row.content;
      } finally {
        clearTimeout(timeout);
        if (bodyScope.reads.get(id) === controller) {
          bodyScope.reads.delete(id);
          bodyScope.pending.delete(id);
        }
      }
    })();
    bodyScope.pending.set(id, request);
    return request;
  }, [bodyScope, contentCache]);

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
      if (activeBodyScope.current !== bodyScope || renderAuthOwner !== (apiAuthHeaders().Authorization || '')) return;
      const changedId = payload.new?.id || payload.old?.id;
      if (changedId) bodyScope.reads.get(changedId)?.abort();
      const eventType = String(payload.eventType || '');
      if (eventType === 'DELETE') {
        const oldDoc = payload.old;
        applyDocumentRealtimeToContentCache(contentCache, eventType, null, oldDoc);
        if (oldDoc?.id) {
          setDocuments(prev => prev.filter(doc => doc.id !== oldDoc.id));
        }
        return;
      }

      const nextDoc = payload.new;
      if (!nextDoc?.id) return;
      applyDocumentRealtimeToContentCache(contentCache, eventType, nextDoc);
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
      if (activeBodyScope.current === bodyScope) contentCache.set(doc.id, doc.content ?? '');
      setDocuments(prev => [toListDocument(doc), ...prev]);
      return doc;
    }
    return null;
  }, [bodyScope, contentCache, setDocuments, workspaceId]);

  const saveDocument = useCallback(async function persistDocument(id: string, updates: { title?: string; content?: string; folder?: string | null }): Promise<Record<string, unknown> | null> {
    const owner = apiAuthHeaders().Authorization || '';
    if (!owner) return null;
    const generation = (saveGenerations.current.get(id) ?? 0) + 1;
    saveGenerations.current.set(id, generation);
    const isCurrent = () => saveGenerations.current.get(id) === generation
      && apiAuthHeaders().Authorization === owner;
    let result: Record<string, unknown> | null = null;
    try {
      // One write per document at a time. Ignoring an old response protects
      // React state but cannot stop that request overwriting the database.
      const previous = documentWrites.current.get(id);
      const write = (async () => {
        if (previous) await previous.catch(() => null);
        if (apiAuthHeaders().Authorization !== owner) return null;
        return offlineUpdate('documents', id, {
          ...updates,
          updated_at: new Date().toISOString(),
        }, `documents_meta_${workspaceId}`);
      })();
      documentWrites.current.set(id, write);
      try {
        result = await write;
      } finally {
        if (documentWrites.current.get(id) === write) documentWrites.current.delete(id);
      }
    } catch {
      // IndexedDB persistence can fail too. Never leave a fire-and-forget
      // autosave rejection invisible or claim a draft was queued when it wasn't.
    }
    if (!isCurrent()) return result;
    if (result) {
      dismissSaveNotice(id);
      if (typeof updates.content === 'string' && activeBodyScope.current === bodyScope) {
        bodyScope.reads.get(id)?.abort();
        contentCache.set(id, updates.content);
      }
      setDocuments(prev => prev.map(d => d.id === id ? stripContent({ ...d, ...result }) : d));
    } else {
      dismissSaveNotice(id);
      const noticeId = `document-save-${id}-${generation}`;
      saveNotices.current.set(id, noticeId);
      toast.error('Document changes were not saved', {
        id: noticeId,
        duration: Infinity,
        description: 'Your changes need saving. Retry before reloading the page.',
        action: {
          label: 'Retry',
          onClick: () => {
            // A newer edit, successful deletion or account switch invalidates
            // this captured draft, even if a toast action was already queued.
            if (isCurrent()) void persistDocument(id, updates);
          },
        },
      });
    }
    return result;
  }, [bodyScope, contentCache, dismissSaveNotice, setDocuments, workspaceId]);

  // The backend client resolves its token at request time. Keep the exact
  // authorization value with each debounced write so an account switch cannot
  // flush an edit created by the previous account under the new account.
  const currentAuthOwner = useCallback(() => apiAuthHeaders().Authorization || '', []);
  // Capture ownership at render time as well as at timer execution time. A
  // stale callback retained by an editor can run after auth storage changes;
  // reading only the current token there would incorrectly re-own old work.

  useEffect(() => () => {
    for (const id of saveNotices.current.keys()) dismissSaveNotice(id);
  }, [dismissSaveNotice, renderAuthOwner]);


  // A hook instance can survive a workspace switch. Flush pending writes using
  // the save function captured for the workspace that owned them, instead of
  // dropping a user's last edit at the debounce boundary.
  useEffect(() => () => {
    const pendingSaves = [...autoSaveTimers.current.entries()];
    autoSaveTimers.current.clear();
    for (const [id, pending] of pendingSaves) {
      clearTimeout(pending.timer);
      if (pending.owner && pending.owner === currentAuthOwner()) {
        void saveDocument(id, pending.updates);
      }
    }
  }, [currentAuthOwner, saveDocument]);

  const autoSave = useCallback((id: string, updates: { title?: string; content?: string; folder?: string | null }) => {
    const owner = renderAuthOwner;
    if (!owner || owner !== currentAuthOwner()) return;
    saveGenerations.current.set(id, (saveGenerations.current.get(id) ?? 0) + 1);
    dismissSaveNotice(id);
    const pending = autoSaveTimers.current.get(id);
    const sameOwnerPending = pending?.owner === owner ? pending : undefined;
    if (pending) {
      clearTimeout(pending.timer);
      autoSaveTimers.current.delete(id);
    }
    const mergedUpdates = { ...(sameOwnerPending?.updates || {}), ...updates };
    const timer = setTimeout(() => {
      autoSaveTimers.current.delete(id);
      if (owner === currentAuthOwner()) void saveDocument(id, mergedUpdates);
    }, 800);
    autoSaveTimers.current.set(id, { timer, updates: mergedUpdates, owner });
  }, [currentAuthOwner, dismissSaveNotice, renderAuthOwner, saveDocument]);

  const deleteDocument = useCallback(async (id: string) => {
    const pending = autoSaveTimers.current.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      autoSaveTimers.current.delete(id);
    }
    const deleted = await offlineDelete('documents', id, `documents_meta_${workspaceId}`);
    if (!deleted) {
      // A rejected delete leaves the row usable. Restore its pending edit too,
      // otherwise the failed destructive action would also lose an unrelated
      // title/body change that happened just before it.
      const currentPending = autoSaveTimers.current.get(id);
      if (!currentPending && pending && pending.owner === currentAuthOwner()) {
        autoSave(id, pending.updates);
      }
      return false;
    }
    const newerPending = autoSaveTimers.current.get(id);
    if (newerPending) {
      clearTimeout(newerPending.timer);
      autoSaveTimers.current.delete(id);
    }
    saveGenerations.current.set(id, (saveGenerations.current.get(id) ?? 0) + 1);
    dismissSaveNotice(id);
    bodyScope.reads.get(id)?.abort();
    contentCache.delete(id);
    setDocuments(prev => prev.filter(d => d.id !== id));
    return true;
  }, [autoSave, bodyScope, contentCache, currentAuthOwner, dismissSaveNotice, setDocuments, workspaceId]);

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
