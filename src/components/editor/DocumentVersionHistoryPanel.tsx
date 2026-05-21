import { DocumentVersionHistory } from './DocumentVersionHistory';
import { useDocumentVersions } from '../../hooks/useDocumentVersions';
import type { DocumentVersion } from '../../types';

interface DocumentVersionHistoryPanelProps {
  documentId: string;
  workspaceId: string;
  userId?: string;
  onRestore: (version: DocumentVersion) => void;
  onClose: () => void;
}

export function DocumentVersionHistoryPanel({
  documentId,
  workspaceId,
  userId,
  onRestore,
  onClose,
}: DocumentVersionHistoryPanelProps) {
  const {
    versions,
    loading,
  } = useDocumentVersions(documentId, workspaceId, userId);

  return (
    <DocumentVersionHistory
      versions={versions}
      loading={loading}
      onRestore={onRestore}
      onClose={onClose}
    />
  );
}

