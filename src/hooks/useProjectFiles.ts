import { useCallback, useEffect, useMemo } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState } from './useWorkspaceState';
import type { UploadedFile } from '../types';

// The files attached to one project. A file is a normal uploaded_files row; attaching just
// sets its project_id, and removing clears it, so the file itself is never deleted from here.
// Live over realtime, like the other workspace tables.

export function useProjectFiles(workspaceId: string | null, projectId: string) {
  const [files, setFiles, beginRequest] = useWorkspaceListState<UploadedFile>(workspaceId, []);

  const fetchFiles = useCallback(async () => {
    const isCurrent = beginRequest();
    if (!workspaceId) {
      setFiles([]);
      return;
    }
    const data = await cachedFetch<UploadedFile[]>(`project_files_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('uploaded_files')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });
      return data;
    });
    if (isCurrent() && data) setFiles(data);
  }, [beginRequest, setFiles, workspaceId]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<UploadedFile>(
    {
      enabled: !!workspaceId,
      channelName: `project-files:${workspaceId}`,
      table: 'uploaded_files',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    payload => {
      if (!deduper.shouldProcess(payload)) return;
      if ((payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') && payload.new) {
        const row = payload.new;
        setFiles(prev => (prev.some(f => f.id === row.id) ? prev.map(f => (f.id === row.id ? row : f)) : [row, ...prev]));
      } else if (payload.eventType === 'DELETE' && payload.old?.id) {
        const id = payload.old.id;
        setFiles(prev => prev.filter(f => f.id !== id));
      }
    },
  );

  const projectFiles = useMemo(() => files.filter(file => file.project_id === projectId), [files, projectId]);

  const setProject = useCallback(
    async (ids: string[], target: string | null) => {
      if (!ids.length) return;
      setFiles(prev => prev.map(f => (ids.includes(f.id) ? { ...f, project_id: target } : f)));
      for (const id of ids) {
        await backendClient.from('uploaded_files').update({ project_id: target }).eq('id', id);
      }
    },
    [setFiles],
  );

  /** Attaches already-uploaded files to this project. */
  const attach = useCallback((uploaded: UploadedFile[]) => setProject(uploaded.map(f => f.id), projectId), [projectId, setProject]);
  /** Detaches a file from this project. The file itself stays in the workspace. */
  const detach = useCallback((id: string) => setProject([id], null), [setProject]);

  return { files: projectFiles, attach, detach, refetch: fetchFiles };
}
