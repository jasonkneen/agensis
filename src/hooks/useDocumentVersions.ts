import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { cachedFetch, offlineInsert } from '../lib/offlineSupabase';
import type { DocumentVersion } from '../types';

export function useDocumentVersions(
  documentId: string | null,
  workspaceId: string | null,
  userId?: string,
) {
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchVersions = useCallback(async () => {
    if (!documentId) {
      setVersions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<DocumentVersion[]>(`versions_${documentId}`, async () => {
      const { data } = await supabase
        .from('document_versions')
        .select('*')
        .eq('document_id', documentId)
        .order('version_number', { ascending: false });
      return data;
    });
    if (data) setVersions(data);
    setLoading(false);
  }, [documentId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const createSnapshot = useCallback(async (title: string, content: string) => {
    if (!documentId || !workspaceId) return null;
    const nextVersion = versions.length + 1;
    const data = await offlineInsert('document_versions', {
      document_id: documentId,
      workspace_id: workspaceId,
      user_id: userId ?? null,
      title,
      content,
      version_number: nextVersion,
    });
    if (data) {
      const version = data as unknown as DocumentVersion;
      setVersions((prev: DocumentVersion[]) => [version, ...prev]);
      return version;
    }
    return null;
  }, [documentId, workspaceId, userId, versions.length]);

  return {
    versions,
    loading,
    createSnapshot,
    refetch: fetchVersions,
  };
}
