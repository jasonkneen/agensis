import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { WorkspaceSkill, WorkspaceSkillDraft } from '../lib/workspaceSkills';

// Workspace-authored skills — the app-side skill store.
//
// THE FETCH MUST FALL BACK, NOT ERROR, and that is not defensive habit: this
// repo's frontend deploys on push while the backend needs an explicit Fly
// deploy, so the frontend routinely runs against a server that has never heard
// of these routes. A 404 here has to mean "no stored skills yet", leaving the
// Skills window exactly as it was — daemon-advertised names and libraries —
// rather than an error state over a feature the user cannot see is missing.
// That is also this feature's whole rollback story: revert the server and the
// UI is byte-identical to before.
//
// `unavailable` distinguishes the two anyway, because the AUTHORING affordance
// must not be offered against a backend that would reject the POST. An empty
// store shows "Write one"; an unreachable route shows nothing at all.

interface SkillsResponse {
  data?: WorkspaceSkill[] | null;
  error?: { message?: string } | string | null;
}

/** The message from a failed write, so a form can show why rather than just failing. */
function errorMessage(body: unknown, fallback: string): string {
  const error = (body as SkillsResponse | null)?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export interface WorkspaceSkillsApi {
  skills: WorkspaceSkill[];
  loading: boolean;
  /** The routes could not be reached at all — hide authoring, keep the page. */
  unavailable: boolean;
  refresh: () => Promise<void>;
  createSkill: (draft: WorkspaceSkillDraft) => Promise<{ skill: WorkspaceSkill | null; error: string }>;
  updateSkill: (skillId: string, draft: WorkspaceSkillDraft) => Promise<{ skill: WorkspaceSkill | null; error: string }>;
  deleteSkill: (skillId: string) => Promise<boolean>;
}

export function useWorkspaceSkills(workspaceId: string | null): WorkspaceSkillsApi {
  const [skills, setSkills] = useState<WorkspaceSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setSkills([]);
      setUnavailable(false);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${workspaceId}/skills`), {
        headers: apiAuthHeaders(),
      });
      if (requestRef.current !== requestId) return;
      if (!response.ok) {
        setSkills([]);
        setUnavailable(true);
        return;
      }
      const body: SkillsResponse | null = await response.json().catch(() => null);
      if (requestRef.current !== requestId) return;
      setSkills(Array.isArray(body?.data) ? body.data : []);
      setUnavailable(false);
    } catch {
      if (requestRef.current !== requestId) return;
      setSkills([]);
      setUnavailable(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const createSkill = useCallback(async (draft: WorkspaceSkillDraft) => {
    if (!workspaceId) return { skill: null, error: 'No workspace is open.' };
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${workspaceId}/skills`), {
        method: 'POST',
        headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: draft }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // The server's message names the actual problem — a duplicate name, a
        // never-carried field, an empty body. Relayed verbatim rather than
        // replaced with "could not save", because the validator's message is the
        // only place the caller learns WHICH rule they hit.
        return { skill: null, error: errorMessage(body, 'That skill could not be saved.') };
      }
      const saved = (body as { data?: WorkspaceSkill } | null)?.data ?? null;
      if (saved) setSkills(prev => [...prev.filter(s => s.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      return { skill: saved, error: '' };
    } catch {
      return { skill: null, error: 'The skill store could not be reached.' };
    }
  }, [workspaceId]);

  const updateSkill = useCallback(async (skillId: string, draft: WorkspaceSkillDraft) => {
    if (!workspaceId || !skillId) return { skill: null, error: 'No workspace is open.' };
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${workspaceId}/skills/${skillId}`), {
        method: 'PATCH',
        headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: draft }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return { skill: null, error: errorMessage(body, 'That skill could not be saved.') };
      const saved = (body as { data?: WorkspaceSkill } | null)?.data ?? null;
      if (saved) setSkills(prev => prev.map(s => (s.id === saved.id ? saved : s)));
      return { skill: saved, error: '' };
    } catch {
      return { skill: null, error: 'The skill store could not be reached.' };
    }
  }, [workspaceId]);

  const deleteSkill = useCallback(async (skillId: string): Promise<boolean> => {
    if (!workspaceId || !skillId) return false;
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${workspaceId}/skills/${skillId}`), {
        method: 'DELETE',
        headers: apiAuthHeaders(),
      });
      if (!response.ok) return false;
      setSkills(prev => prev.filter(s => s.id !== skillId));
      return true;
    } catch {
      return false;
    }
  }, [workspaceId]);

  return { skills, loading, unavailable, refresh, createSkill, updateSkill, deleteSkill };
}
