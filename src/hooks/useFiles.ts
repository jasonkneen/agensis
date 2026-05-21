import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineDelete } from '../lib/offlineBackend';
import type { UploadedFile } from '../types';

export function useFiles(workspaceId: string | null) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFiles = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    const data = await cachedFetch<UploadedFile[]>(`files_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('uploaded_files')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });
      return data;
    });
    if (data) setFiles(data);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const uploadFiles = useCallback(async (uploadedFiles: File[]) => {
    if (!workspaceId) return;
    const inserts = uploadedFiles.map(f => ({
      workspace_id: workspaceId,
      name: f.name,
      size: f.size,
      type: f.type,
      storage_path: '',
    }));
    const { data } = await backendClient
      .from('uploaded_files')
      .insert(inserts)
      .select();
    if (data) setFiles(prev => [...data, ...prev]);
  }, [workspaceId]);

  const deleteFile = useCallback(async (id: string) => {
    await offlineDelete('uploaded_files', id);
    setFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  return { files, loading, uploadFiles, deleteFile };
}
