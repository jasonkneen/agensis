import { useEffect, useCallback } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch } from '../lib/offlineBackend';
import { normalizeUploadedFile, normalizeUploadedFiles } from '../lib/uploadedFiles';
import { useWorkspaceListState, useWorkspaceState } from './useWorkspaceState';
import type { UploadedFile } from '../types';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Every row entering this hook goes through normalizeUploadedFile, on all three
// ways in (bootstrap seed, list fetch, upload response). `size` is a bigint that
// neither driver parses, so without this the whole app holds a string in a field
// typed `number` — see the header of lib/uploadedFiles.ts.
export function useFiles(workspaceId: string | null, seed?: UploadedFile[] | null) {
  const [files, setFiles, beginFilesRequest] = useWorkspaceListState<UploadedFile>(
    workspaceId,
    normalizeUploadedFiles(seed).filter(file => file.workspace_id === workspaceId),
  );
  const [loading, setLoading] = useWorkspaceState(
    workspaceId,
    !seed?.length,
    Boolean(workspaceId),
  );

  useEffect(() => {
    if (seed) setFiles(normalizeUploadedFiles(seed).filter(file => file.workspace_id === workspaceId));
  }, [seed, setFiles, workspaceId]);

  const fetchFiles = useCallback(async () => {
    const isCurrent = beginFilesRequest();
    if (!workspaceId) {
      setFiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await cachedFetch<UploadedFile[]>(`files_${workspaceId}`, async () => {
        const { data } = await backendClient
          .from('uploaded_files')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false });
        return data;
      });
      if (isCurrent() && data) setFiles(normalizeUploadedFiles(data));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginFilesRequest, setFiles, setLoading, workspaceId]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const uploadFiles = useCallback(async (uploadedFiles: File[]): Promise<UploadedFile[]> => {
    if (!workspaceId) return [];
    const uploaded: UploadedFile[] = [];
    for (const file of uploadedFiles) {
      const contentBase64 = await fileToBase64(file);
      const response = await fetch(apiUrl('/backend/files/upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({
          workspace_id: workspaceId,
          name: file.name,
          size: file.size,
          type: file.type,
          contentBase64,
        }),
      });
      const payload = await response.json();
      if (response.ok && payload.data) uploaded.push(normalizeUploadedFile(payload.data as UploadedFile));
    }
    if (uploaded.length > 0) setFiles(prev => [...uploaded, ...prev]);
    return uploaded;
  }, [setFiles, workspaceId]);

  // M4: deleting through the generic /backend/db/delete dropped the uploaded_files
  // row but left the blob on disk forever. The bespoke route removes both.
  const deleteFile = useCallback(async (id: string) => {
    const response = await fetch(apiUrl(`/backend/files/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: apiAuthHeaders(),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `Delete file HTTP ${response.status}`);
    setFiles(prev => prev.filter(f => f.id !== id));
  }, [setFiles]);

  return { files, loading, uploadFiles, deleteFile };
}
