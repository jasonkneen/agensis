import { useCallback, useMemo } from 'react';
import type { Document, WorkspaceAgent } from '../types';
import { buildDocumentLibrary, type LibraryEntry, type LibrarySource } from '../lib/documentLibrary';
import { useAgentDocuments } from './useAgentDocuments';
import { useAgentMemory } from './useAgentMemory';

// ---------------------------------------------------------------------------
// The library, assembled once for the whole app.
//
// ONE hook, called ONCE, deliberately. The sidebar's Documents section and the
// Library window show the same collation, and each of the two mirrors it reads
// (agent_documents, agent_memory_files) opens a realtime subscription. Calling
// the underlying hooks in both places would open two subscriptions per table
// and let the two surfaces disagree for as long as one of them was mid-fetch —
// which, in a sidebar and a window sitting side by side, is visible.
//
// So AppContent calls this and hands the result down. That also means the body
// loader lives here, next to the caches it reads from, rather than being
// rebuilt by every consumer that wants to open a document.
// ---------------------------------------------------------------------------

export interface DocumentLibraryInput {
  workspaceId: string | null;
  /** Workspace-authored documents (the metadata list). */
  documents: readonly Document[];
  agents: readonly WorkspaceAgent[];
  /** Agent ids with a live daemon right now. */
  connectedAgentIds: readonly string[];
  /** useDocuments().fetchDocumentContent — the workspace half of the loader. */
  fetchWorkspaceDocumentContent: (id: string) => Promise<string>;
}

export interface DocumentLibrary {
  entries: LibraryEntry[];
  loading: boolean;
  /** One source's body, whichever of the mirrors it lives in. */
  loadSource: (source: LibrarySource) => Promise<string>;
  /** Ask one agent's daemon to re-enumerate its documents. */
  refreshAgent: (agentId: string) => Promise<boolean>;
}

export function useDocumentLibrary({
  workspaceId,
  documents,
  agents,
  connectedAgentIds,
  fetchWorkspaceDocumentContent,
}: DocumentLibraryInput): DocumentLibrary {
  const agentDocs = useAgentDocuments(workspaceId);
  const memory = useAgentMemory(workspaceId);

  const entries = useMemo(() => buildDocumentLibrary({
    documents,
    agentDocuments: agentDocs.documents,
    memoryFiles: memory.files,
    agents,
    connectedAgentIds,
  }), [documents, agentDocs.documents, memory.files, agents, connectedAgentIds]);

  /**
   * One body, whichever table it lives in.
   *
   * `agent-skill` returns '' on purpose rather than reaching for a loader: skill
   * bodies are read through /backend/system/skill-content, a different route
   * with its own authorization, and the Skills window is where they are read.
   * The library still LISTS a skill document — knowing an agent carries one is
   * useful — it just does not pretend it can open it here.
   */
  const loadSource = useCallback(async (source: LibrarySource): Promise<string> => {
    if (source.kind === 'workspace') return fetchWorkspaceDocumentContent(source.rowId);
    if (source.kind === 'agent-document') {
      const row = agentDocs.documents.find(doc => doc.id === source.rowId);
      return row ? agentDocs.fetchDocumentContent(row) : '';
    }
    if (source.kind === 'agent-memory') {
      const row = memory.files.find(file => file.id === source.rowId);
      return row ? memory.fetchFileContent(row) : '';
    }
    return '';
  }, [agentDocs, memory, fetchWorkspaceDocumentContent]);

  return {
    entries,
    loading: agentDocs.loading || memory.loading,
    loadSource,
    refreshAgent: agentDocs.refresh,
  };
}
