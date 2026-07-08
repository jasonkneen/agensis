import { useState, useEffect, useCallback } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';
import { cachedFetch, offlineDelete } from '../lib/offlineBackend';
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

export function useFiles(workspaceId: string | null, seed?: UploadedFile[] | null) {
  const [files, setFiles] = useState<UploadedFile[]>(() => seed || []);
  const [loading, setLoading] = useState(!seed?.length);

  useEffect(() => {
    if (seed) setFiles(seed);
  }, [seed]);

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
      if (response.ok && payload.data) uploaded.push(payload.data as UploadedFile);
    }
    if (uploaded.length > 0) setFiles(prev => [...uploaded, ...prev]);
    return uploaded;
  }, [workspaceId]);

  const deleteFile = useCallback(async (id: string) => {
    await offlineDelete('uploaded_files', id, `files_${workspaceId}`);
    setFiles(prev => prev.filter(f => f.id !== id));
  }, [workspaceId]);

  return { files, loading, uploadFiles, deleteFile };
}
