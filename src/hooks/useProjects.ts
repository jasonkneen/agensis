import { useCallback, useEffect } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert } from '../lib/offlineBackend';
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
  due_date: string | null;
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
      const data = await offlineInsert(
        'projects',
        {
          workspace_id: workspaceId,
          created_by: userId ?? null,
          name: input.name,
          project_key: input.project_key ?? '',
          description: input.description ?? '',
          status: input.status ?? 'active',
        },
        `projects_${workspaceId}`,
      );
      if (data) {
        const project = data as unknown as Project;
        setProjects(prev => (prev.some(p => p.id === project.id) ? prev : [...prev, project]));
      }
      return data;
    },
    [setProjects, userId, workspaceId],
  );

  return { projects, createProject, refetch: fetchProjects };
}
