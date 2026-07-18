import { useState, useEffect, useCallback, useRef } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { AgentMemoryFile } from '../types';

// The list is metadata-only; content_cache (the full file body) is fetched on
// demand when a file is opened. A workspace can mirror many/large agent files,
// so pulling every body for a path list is wasteful (and realtime UPSERTs would
// otherwise stream each body to every client).
const MEMORY_FILE_LIST_COLUMNS = 'id, workspace_id, agent_id, path, kind, summary, byte_size, editable, last_synced, version, created_at, updated_at';

// Strip the body so it never enters the metadata-only list state (a realtime
// UPSERT emits the full row; keep the list light).
function stripFileContent(file: AgentMemoryFile): AgentMemoryFile {
 if (file.content_cache === undefined) return file;
 const copy = { ...file } as Record<string, unknown>;
 delete copy.content_cache;
 return copy as unknown as AgentMemoryFile;
}

/**
 * Read-only mirror of every agent's file-backed memory in the workspace. The daemon
 * pushes file rows up; we just read the table and subscribe for changes. `refresh`
 * fires a fire-and-forget nudge — the answer arrives as a realtime change, not a
 * synchronous response, so the UI never blocks on the daemon being online.
 */
export function useAgentMemory(workspaceId: string | null) {
 const [files, setFiles] = useState<AgentMemoryFile[]>([]);
 const [loading, setLoading] = useState(true);
 // On-demand body cache keyed by `${id}:${version ?? updated_at}` so an edited
 // file (new version/timestamp) refetches instead of serving a stale body.
 const contentCache = useRef<Map<string, string>>(new Map());

 const fetchFiles = useCallback(async () => {
  if (!workspaceId) {
   setFiles([]);
   setLoading(false);
   return;
  }
  setLoading(true);
  const data = await cachedFetch<AgentMemoryFile[]>(`agent_memory_meta_${workspaceId}`, async () => {
   const { data } = await backendClient
    .from('agent_memory_files')
    .select(MEMORY_FILE_LIST_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('path', { ascending: true });
   return (data as unknown as AgentMemoryFile[])?.map(stripFileContent) ?? [];
  });
  if (data) setFiles(data);
  setLoading(false);
 }, [workspaceId]);

 useEffect(() => {
  fetchFiles();
 }, [fetchFiles]);

 const deduper = useRealtimeDeduper();
 useTableSubscription<AgentMemoryFile>(
  {
   enabled: !!workspaceId,
   channelName: `agent-memory:${workspaceId}`,
   table: 'agent_memory_files',
   event: '*',
   schema: 'public',
   filter: `workspace_id=eq.${workspaceId}`,
  },
  (payload) => {
   if (!deduper.shouldProcess(payload)) return;
   // The daemon re-syncs UPSERT in place (same row id) but the server emits it as
   // INSERT. Strip content_cache so the list stays metadata-only; the on-demand
   // fetch re-reads the body when a file is opened (its version/updated_at bump
   // invalidates the content cache).
   if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
    const row = payload.new;
    if (!row) return;
    const meta = stripFileContent(row);
    setFiles(prev => prev.some(f => f.id === meta.id)
     ? prev.map(f => f.id === meta.id ? meta : f)
     : [...prev, meta]);
   } else if (payload.eventType === 'DELETE') {
    const row = payload.old;
    if (!row?.id) return;
    setFiles(prev => prev.filter(f => f.id !== row.id));
   }
  },
 );

 const refresh = useCallback(async (agentId: string) => {
  if (!agentId) return false;
  try {
   const res = await fetch(apiUrl(`/backend/agents/${encodeURIComponent(agentId)}/memory-refresh`), {
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

 // Fetch one file's body on demand, cached by identity+version so repeated opens
 // don't refetch but an edit (new version) does.
 const fetchFileContent = useCallback(async (file: AgentMemoryFile): Promise<string> => {
  if (!workspaceId) return '';
  const key = `${file.id}:${file.version ?? file.updated_at}`;
  const cached = contentCache.current.get(key);
  if (cached !== undefined) return cached;
  const { data } = await backendClient
   .from('agent_memory_files')
   .select('id, content_cache')
   .eq('workspace_id', workspaceId)
   .eq('id', file.id);
  const body = (Array.isArray(data) ? data[0]?.content_cache : (data as { content_cache?: string } | null)?.content_cache) || '';
  contentCache.current.set(key, body);
  return body;
 }, [workspaceId]);

 return { files, loading, refresh, refetch: fetchFiles, fetchFileContent };
}
