import { useState, useEffect, useCallback, useRef } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { AgentDocument } from '../types';

// Read-only mirror of the markdown every connected agent contributes.
//
// Deliberately the same shape as useAgentMemory: a metadata-only list plus an
// on-demand body fetch. The daemon pushes rows up, we read the table and
// subscribe for changes; nothing here writes.
//
// The metadata/body split is not an optimisation detail here, it is what makes
// the library viable at all. A workspace with five agents each mirroring a
// repo's docs tree is hundreds of rows and megabytes of markdown, and a daemon
// re-syncs on reconnect — pulling every body for a list nobody has opened would
// cost that on every cold load, and the realtime UPSERT would stream it again
// to every client. The server strips `content` from the fanout for the same
// reason (REALTIME_HEAVY_FIELDS in server/realtime.cjs).
const DOCUMENT_LIST_COLUMNS = 'id, workspace_id, agent_id, path, title, domain, summary, byte_size, truncated, content_hash, source_modified_at, last_synced, version, created_at, updated_at';

/** Strip the body so it never enters the metadata-only list state. */
function stripDocumentContent(doc: AgentDocument): AgentDocument {
 if (doc.content === undefined) return doc;
 const copy = { ...doc } as Record<string, unknown>;
 delete copy.content;
 return copy as unknown as AgentDocument;
}

export function useAgentDocuments(workspaceId: string | null) {
 const [documents, setDocuments] = useState<AgentDocument[]>([]);
 const [loading, setLoading] = useState(true);
 // Keyed by `${id}:${version ?? updated_at}` so a re-synced document (new
 // version) refetches instead of serving the body it had before the edit.
 const contentCache = useRef<Map<string, string>>(new Map());

 const fetchDocuments = useCallback(async () => {
  if (!workspaceId) {
   setDocuments([]);
   setLoading(false);
   return;
  }
  setLoading(true);
  const data = await cachedFetch<AgentDocument[]>(`agent_documents_meta_${workspaceId}`, async () => {
   const { data } = await backendClient
    .from('agent_documents')
    .select(DOCUMENT_LIST_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('path', { ascending: true });
   return (data as unknown as AgentDocument[])?.map(stripDocumentContent) ?? [];
  });
  if (data) setDocuments(data);
  setLoading(false);
 }, [workspaceId]);

 useEffect(() => {
  fetchDocuments();
 }, [fetchDocuments]);

 const deduper = useRealtimeDeduper();
 useTableSubscription<AgentDocument>(
  {
   enabled: !!workspaceId,
   channelName: `agent-documents:${workspaceId}`,
   table: 'agent_documents',
   event: '*',
   schema: 'public',
   filter: `workspace_id=eq.${workspaceId}`,
  },
  (payload) => {
   if (!deduper.shouldProcess(payload)) return;
   // A re-sync UPSERTs in place (same row id) but the server emits INSERT, so
   // both events take the same upsert-into-state branch. Same as useAgentMemory.
   if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
    const row = payload.new;
    if (!row) return;
    const meta = stripDocumentContent(row);
    setDocuments(prev => prev.some(doc => doc.id === meta.id)
     ? prev.map(doc => doc.id === meta.id ? meta : doc)
     : [...prev, meta]);
   } else if (payload.eventType === 'DELETE') {
    const row = payload.old;
    if (!row?.id) return;
    setDocuments(prev => prev.filter(doc => doc.id !== row.id));
   }
  },
 );

 /**
  * Ask one agent's daemon to re-enumerate its documents.
  *
  * Fire-and-forget, like the memory refresh: the answer arrives as a realtime
  * change on agent_documents, not in this response, so the UI never blocks on
  * somebody else's laptop being awake. Resolves false when nothing was live to
  * ask — which the caller should SAY rather than swallow, since a refresh that
  * silently did nothing is indistinguishable from one that found no changes.
  */
 const refresh = useCallback(async (agentId: string) => {
  if (!agentId) return false;
  try {
   const res = await fetch(apiUrl(`/backend/agents/${encodeURIComponent(agentId)}/documents-refresh`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({}),
   });
   const body = await res.json().catch(() => null);
   return Boolean(body?.data?.nudged);
  } catch {
   return false;
  }
 }, []);

 /** One document's body, on demand, cached by identity+version. */
 const fetchDocumentContent = useCallback(async (doc: AgentDocument): Promise<string> => {
  if (!workspaceId) return '';
  const key = `${doc.id}:${doc.version ?? doc.updated_at}`;
  const cached = contentCache.current.get(key);
  if (cached !== undefined) return cached;
  const { data } = await backendClient
   .from('agent_documents')
   .select('id, content')
   .eq('workspace_id', workspaceId)
   .eq('id', doc.id);
  const body = (Array.isArray(data) ? data[0]?.content : (data as { content?: string } | null)?.content) || '';
  contentCache.current.set(key, body);
  return body;
 }, [workspaceId]);

 return { documents, loading, refresh, refetch: fetchDocuments, fetchDocumentContent };
}
