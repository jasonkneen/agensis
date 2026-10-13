import { useCallback, useEffect } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsertResult, offlineUpdate } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState } from './useWorkspaceState';

// Projects for one workspace. Tasks link to a project through tasks.project_id.
// Loaded, kept live over realtime, and created through the same offline-aware
// path the other tables use.

export type ProjectStatus = 'planning' | 'active' | 'at_risk' | 'on_hold' | 'completed';

export interface Project {
  id: string;
  workspace_id: string;
  created_by: string | null;
  name: string;
  project_key: string;
  description: string;
  status: ProjectStatus;
  color: string;
  /** Lucide icon name from PROJECT_ICONS. */
  icon: string;
  lead_id: string | null;
  start_date: string | null;
  due_date: string | null;
  /** The project's channel (a chat session) and brief (a document), when created. */
  channel_id: string | null;
  brief_document_id: string | null;
  archived: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  name: string;
  project_key?: string;
  description?: string;
  status?: ProjectStatus;
  icon?: string;
  color?: string;
  lead_id?: string | null;
  start_date?: string | null;
  due_date?: string | null;
}

export function useProjects(workspaceId: string | null, userId?: string) {
  const [projects, setProjects, beginRequest] = useWorkspaceListState<Project>(workspaceId, []);

  const fetchProjects = useCallback(async () => {
    const isCurrent = beginRequest();
    if (!workspaceId) {
      setProjects([]);
      return;
    }
    const data = await cachedFetch<Project[]>(`projects_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('projects')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true });
      return data;
    });
    if (isCurrent() && data) setProjects(data);
  }, [beginRequest, setProjects, workspaceId]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<Project>(
    {
      enabled: !!workspaceId,
      channelName: `projects:${workspaceId}`,
      table: 'projects',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    payload => {
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT' && payload.new) {
        const row = payload.new;
        setProjects(prev => (prev.some(p => p.id === row.id) ? prev : [...prev, row]));
      } else if (payload.eventType === 'UPDATE' && payload.new) {
        const row = payload.new;
        setProjects(prev => prev.map(p => (p.id === row.id ? row : p)));
      } else if (payload.eventType === 'DELETE' && payload.old?.id) {
        const id = payload.old.id;
        setProjects(prev => prev.filter(p => p.id !== id));
      }
    },
  );

  const createProject = useCallback(
    async (input: CreateProjectInput) => {
      if (!workspaceId) return null;
      const { data, error } = await offlineInsertResult(
        'projects',
        {
          workspace_id: workspaceId,
          created_by: userId ?? null,
          name: input.name,
          project_key: input.project_key ?? '',
          description: input.description ?? '',
          status: input.status ?? 'planning',
          icon: input.icon ?? 'folder',
          color: input.color ?? 'indigo',
          lead_id: input.lead_id ?? null,
          start_date: input.start_date ?? null,
          due_date: input.due_date ?? null,
        },
        `projects_${workspaceId}`,
      );
      // Surface the server's own reason (for example a missing table on a database that has
      // not been migrated yet) so the dialog can show it, instead of a bare "could not be saved".
      if (error) throw new Error(error.message || 'The project could not be saved.');
      if (data) {
        const project = data as unknown as Project;
        setProjects(prev => (prev.some(p => p.id === project.id) ? prev : [...prev, project]));
      }
      return data;
    },
    [setProjects, userId, workspaceId],
  );

  const updateProject = useCallback(
    async (id: string, updates: Partial<Omit<Project, 'id' | 'workspace_id' | 'created_at' | 'updated_at'>>) => {
      if (!workspaceId) return null;
      // Apply locally first so the UI does not wait on the round trip; realtime then confirms it.
      setProjects(prev => prev.map(p => (p.id === id ? { ...p, ...updates } : p)));
      return offlineUpdate('projects', id, updates as Record<string, unknown>, `projects_${workspaceId}`);
    },
    [setProjects, workspaceId],
  );

  return { projects, createProject, updateProject, refetch: fetchProjects };
}
