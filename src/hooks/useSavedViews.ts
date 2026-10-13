import { useCallback, useEffect } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineDelete, offlineInsert } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState } from './useWorkspaceState';
import { normalizeViewConfig, type SavedViewConfig } from '../lib/pm/savedViews';

// Saved task views for one workspace: a name and the toolbar settings it restores.
// Loaded, kept live over realtime, and created or deleted through the same offline-aware
// path the other tables use. Settings are validated on the way out, so a stored view with
// odd values still loads.

export interface SavedView {
  id: string;
  workspace_id: string;
  created_by: string | null;
  name: string;
  config: SavedViewConfig;
  version: number;
  created_at: string;
  updated_at: string;
}

type RawSavedView = Omit<SavedView, 'config'> & { config: unknown };

const clean = (row: RawSavedView): SavedView => ({ ...row, config: normalizeViewConfig(row.config) });

export function useSavedViews(workspaceId: string | null, userId?: string) {
  const [views, setViews, beginRequest] = useWorkspaceListState<SavedView>(workspaceId, []);

  const fetchViews = useCallback(async () => {
    const isCurrent = beginRequest();
    if (!workspaceId) {
      setViews([]);
      return;
    }
    const data = await cachedFetch<RawSavedView[]>(`saved_views_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('saved_views')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true });
      return data;
    });
    if (isCurrent() && data) setViews(data.map(clean));
  }, [beginRequest, setViews, workspaceId]);

  useEffect(() => {
    fetchViews();
  }, [fetchViews]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<RawSavedView>(
    {
      enabled: !!workspaceId,
      channelName: `saved_views:${workspaceId}`,
      table: 'saved_views',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    payload => {
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT' && payload.new) {
        const row = clean(payload.new);
        setViews(prev => (prev.some(v => v.id === row.id) ? prev : [...prev, row]));
      } else if (payload.eventType === 'UPDATE' && payload.new) {
        const row = clean(payload.new);
        setViews(prev => prev.map(v => (v.id === row.id ? row : v)));
      } else if (payload.eventType === 'DELETE' && payload.old?.id) {
        const id = payload.old.id;
        setViews(prev => prev.filter(v => v.id !== id));
      }
    },
  );

  const createView = useCallback(
    async (name: string, config: SavedViewConfig) => {
      if (!workspaceId) return null;
      const data = await offlineInsert(
        'saved_views',
        { workspace_id: workspaceId, created_by: userId ?? null, name: name.trim(), config },
        `saved_views_${workspaceId}`,
      );
      if (data) {
        const view = clean(data as unknown as RawSavedView);
        setViews(prev => (prev.some(v => v.id === view.id) ? prev : [...prev, view]));
        return view;
      }
      return null;
    },
    [setViews, userId, workspaceId],
  );

  const deleteView = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      try {
        const deleted = await offlineDelete('saved_views', id, `saved_views_${workspaceId}`);
        if (deleted) setViews(prev => prev.filter(v => v.id !== id));
      } catch {
        // Keep the view in the list if the delete could not be saved.
      }
    },
    [setViews, workspaceId],
  );

  return { views, createView, deleteView, refetch: fetchViews };
}
