import { useCallback, useEffect } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineDelete, offlineInsert, offlineUpdate } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState } from './useWorkspaceState';

// Teams for one workspace: a named group of people and agents. member_ids holds user
// ids and agent ids side by side. A team groups members for workload only; it is never
// attached to a project.

export interface Team {
  id: string;
  workspace_id: string;
  created_by: string | null;
  name: string;
  description: string;
  color: string;
  member_ids: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

const clean = (row: Team): Team => ({ ...row, member_ids: Array.isArray(row.member_ids) ? row.member_ids : [] });

export function useTeams(workspaceId: string | null, userId?: string) {
  const [teams, setTeams, beginRequest] = useWorkspaceListState<Team>(workspaceId, []);

  const fetchTeams = useCallback(async () => {
    const isCurrent = beginRequest();
    if (!workspaceId) {
      setTeams([]);
      return;
    }
    const data = await cachedFetch<Team[]>(`teams_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('teams')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true });
      return data;
    });
    if (isCurrent() && data) setTeams(data.map(clean));
  }, [beginRequest, setTeams, workspaceId]);

  useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<Team>(
    {
      enabled: !!workspaceId,
      channelName: `teams:${workspaceId}`,
      table: 'teams',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    payload => {
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT' && payload.new) {
        const row = clean(payload.new);
        setTeams(prev => (prev.some(t => t.id === row.id) ? prev : [...prev, row]));
      } else if (payload.eventType === 'UPDATE' && payload.new) {
        const row = clean(payload.new);
        setTeams(prev => prev.map(t => (t.id === row.id ? row : t)));
      } else if (payload.eventType === 'DELETE' && payload.old?.id) {
        const id = payload.old.id;
        setTeams(prev => prev.filter(t => t.id !== id));
      }
    },
  );

  const createTeam = useCallback(
    async (input: { name: string; description?: string; color?: string; member_ids?: string[] }) => {
      if (!workspaceId || !input.name.trim()) return null;
      const data = await offlineInsert(
        'teams',
        {
          workspace_id: workspaceId,
          created_by: userId ?? null,
          name: input.name.trim(),
          description: input.description ?? '',
          color: input.color ?? 'indigo',
          member_ids: input.member_ids ?? [],
        },
        `teams_${workspaceId}`,
      );
      if (data) {
        const team = clean(data as unknown as Team);
        setTeams(prev => (prev.some(t => t.id === team.id) ? prev : [...prev, team]));
        return team;
      }
      return null;
    },
    [setTeams, userId, workspaceId],
  );

  const updateTeam = useCallback(
    async (id: string, updates: Partial<Pick<Team, 'name' | 'description' | 'color' | 'member_ids'>>) => {
      if (!workspaceId) return null;
      setTeams(prev => prev.map(t => (t.id === id ? { ...t, ...updates } : t)));
      return offlineUpdate('teams', id, updates as Record<string, unknown>, `teams_${workspaceId}`);
    },
    [setTeams, workspaceId],
  );

  const deleteTeam = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      try {
        const deleted = await offlineDelete('teams', id, `teams_${workspaceId}`);
        if (deleted) setTeams(prev => prev.filter(t => t.id !== id));
      } catch {
        // Keep the team in the list if the delete could not be saved.
      }
    },
    [setTeams, workspaceId],
  );

  return { teams, createTeam, updateTeam, deleteTeam, refetch: fetchTeams };
}
