import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { StoredAgentTemplate } from '../lib/agentTemplates';

// Authored agent templates ("persona packs").
//
// THE FETCH MUST FALL BACK, NOT ERROR. If the server does not have these routes
// yet — the frontend deploys on push while the backend needs an explicit Fly
// deploy, so the frontend routinely runs ahead — the gallery has to show the
// bundled templates exactly as it does today, not an error state. That is also
// the entire rollback story for this feature: revert the server and the UI is
// byte-identical to before. So a failure here sets `templates` to [] and
// records `unavailable`, and the caller merges [] with the bundled array.
//
// No realtime subscription in v1. A template gallery is opened, read and closed;
// it is not a live surface, and workspace_agent_templates is in the allowlists
// so a subscription can be added later without a server change.

interface TemplatesResponse {
  data?: StoredAgentTemplate[] | null;
  error?: { message?: string } | string | null;
}

export function useAgentTemplates(workspaceId: string | null) {
  const [templates, setTemplates] = useState<StoredAgentTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  /** True when the route could not be reached at all — the gallery still works. */
  const [unavailable, setUnavailable] = useState(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setTemplates([]);
      setUnavailable(false);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${workspaceId}/agent-templates`), {
        headers: apiAuthHeaders(),
      });
      if (requestRef.current !== requestId) return;
      if (!response.ok) {
        // 404 means the backend has not shipped these routes yet. Anything else
        // is a real failure, but the user-visible answer is the same: show the
        // bundled templates rather than an error.
        setTemplates([]);
        setUnavailable(true);
        return;
      }
      const body: TemplatesResponse | null = await response.json().catch(() => null);
      if (requestRef.current !== requestId) return;
      setTemplates(Array.isArray(body?.data) ? body.data : []);
      setUnavailable(false);
    } catch {
      if (requestRef.current !== requestId) return;
      setTemplates([]);
      setUnavailable(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Save an existing agent as a template. Returns the stored row, or null. */
  const saveAgentAsTemplate = useCallback(async (agentId: string): Promise<StoredAgentTemplate | null> => {
    if (!workspaceId || !agentId) return null;
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/agent-templates/from-agent/${agentId}`),
        { method: 'POST', headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' } },
      );
      if (!response.ok) return null;
      const body: { data?: StoredAgentTemplate } | null = await response.json().catch(() => null);
      const saved = body?.data ?? null;
      if (saved) {
        setTemplates(prev => {
          const rest = prev.filter(entry => entry.slug !== saved.slug);
          return [saved, ...rest];
        });
      }
      return saved;
    } catch {
      return null;
    }
  }, [workspaceId]);

  /**
   * Import a template file. Returns an error MESSAGE (or '' on success) rather
   * than a boolean, because the server's refusals are the useful part: it names
   * the offending key when a hand-edited file carries `permissionMode`, and
   * "import failed" would throw that away.
   *
   * Manage-gated server-side, unlike authoring — importing crosses a workspace
   * boundary. A 403 is reported as what it is.
   */
  const importTemplate = useCallback(async (payload: unknown): Promise<string> => {
    if (!workspaceId) return 'No workspace selected';
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/agent-templates/import`),
        {
          method: 'POST',
          headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ export: payload }),
        },
      );
      const body: { data?: StoredAgentTemplate; error?: { message?: string } | string } | null =
        await response.json().catch(() => null);
      if (response.status === 403) {
        return 'Importing a template needs the manage role on this workspace.';
      }
      if (response.status === 404) {
        return 'This server does not support importing templates yet.';
      }
      if (!response.ok) {
        const error = body?.error;
        if (typeof error === 'string' && error.trim()) return error;
        if (error && typeof error === 'object' && error.message) return error.message;
        return 'Could not import that template';
      }
      const saved = body?.data ?? null;
      if (saved) {
        setTemplates(prev => [saved, ...prev.filter(entry => entry.slug !== saved.slug)]);
      }
      return '';
    } catch {
      return 'Could not reach the server';
    }
  }, [workspaceId]);

  const deleteTemplate = useCallback(async (templateId: string): Promise<boolean> => {
    if (!workspaceId || !templateId) return false;
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/agent-templates/${templateId}`),
        { method: 'DELETE', headers: apiAuthHeaders() },
      );
      if (!response.ok) return false;
      setTemplates(prev => prev.filter(entry => entry.id !== templateId));
      return true;
    } catch {
      return false;
    }
  }, [workspaceId]);

  return { templates, loading, unavailable, refresh, saveAgentAsTemplate, importTemplate, deleteTemplate };
}
