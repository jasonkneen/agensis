import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { tableRealtimeManager } from '../lib/realtimeManager';
import { harvestFromRow, pendingProposalCount, reviewableHarvests, type ThreadHarvest, type ThreadHarvestRow } from '../lib/threadHarvest';
import type { DbChangePayload } from '../types/realtime';

/**
 * Proposals mined from threads this workspace discarded.
 *
 * Loaded through the dedicated route rather than the generic table API, because
 * `thread_harvests` is deliberately read-only to clients (shared/backend-core.cjs)
 * and the route is also what joins the thread's title and deleted_at back on —
 * without those a proposal has no provenance and cannot be judged.
 *
 * Kept live over the same realtime db_changes subscription every other table
 * uses. A realtime row is the RAW database shape and carries NO joined thread
 * title, so an update is merged onto the row already in state rather than
 * replacing it: otherwise accepting one proposal would blank out the "which
 * thread did this come from" line on the card you are still looking at.
 */
export function useThreadHarvests(workspaceId: string | null) {
  const [harvests, setHarvests] = useState<ThreadHarvest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');

  const load = useCallback(async () => {
    if (!workspaceId) {
      setHarvests([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/thread-harvests`),
        { headers: apiAuthHeaders() },
      );
      const payload = await response.json();
      const rows = response.ok && !payload.error ? (payload.data as ThreadHarvestRow[]) : [];
      setHarvests(Array.isArray(rows) ? rows.map(harvestFromRow) : []);
    } catch {
      setHarvests([]);
    }
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!workspaceId) return;
    return tableRealtimeManager.subscribe(
      {
        table: 'thread_harvests',
        filter: `workspace_id=eq.${workspaceId}`,
        channelName: `thread-harvests:${workspaceId}`,
      },
      (payload: DbChangePayload<ThreadHarvestRow>) => {
        const row = (payload.new ?? payload.old) as ThreadHarvestRow | undefined;
        if (!row?.id) return;
        setHarvests(prev => {
          const existing = prev.find(harvest => harvest.id === row.id);
          // A harvest the list has never seen arriving over realtime is one that
          // just finished analysing. Reload rather than render it: the row alone
          // has no thread title, and a card that cannot say where a proposal came
          // from is exactly the thing this surface exists to prevent.
          if (!existing) {
            void load();
            return prev;
          }
          const next = harvestFromRow({
            ...row,
            session_title: row.session_title ?? existing.threadTitle,
            session_deleted_at: row.session_deleted_at ?? existing.discardedAt,
          });
          return prev.map(harvest => (harvest.id === next.id ? next : harvest));
        });
      },
    );
  }, [workspaceId, load]);

  const visible = useMemo(() => reviewableHarvests(harvests), [harvests]);
  const pendingCount = useMemo(() => pendingProposalCount(visible), [visible]);

  /**
   * Answer ONE proposal.
   *
   * Goes through the dedicated route, never a table write. The request names
   * WHICH proposal and accept-or-dismiss; the body that reaches memory_facts or
   * documents is read back out of the harvest row on the server. A client that
   * could name what gets written could put words no model produced into the two
   * stores a human trusts most.
   *
   * One proposal per call by design — there is no bulk accept, because accepting
   * something nobody has read is the failure mode this whole feature is built to
   * avoid.
   */
  const decide = useCallback(async (
    harvestId: string,
    index: number,
    decision: 'accept' | 'dismiss',
  ): Promise<{ error: string }> => {
    if (!workspaceId) return { error: 'No workspace' };
    setBusyKey(`${harvestId}:${index}`);
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/thread-harvests/${harvestId}/findings/${index}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({ decision }),
        },
      );
      const payload = await response.json();
      if (!response.ok || payload.error) {
        return { error: String(payload.error || 'Could not record that decision') };
      }
      const row = payload.data as ThreadHarvestRow;
      setHarvests(prev => prev.map(harvest => (harvest.id === row.id
        ? harvestFromRow({
          ...row,
          session_title: row.session_title ?? harvest.threadTitle,
          session_deleted_at: row.session_deleted_at ?? harvest.discardedAt,
        })
        : harvest)));
      return { error: '' };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not record that decision' };
    } finally {
      setBusyKey('');
    }
  }, [workspaceId]);

  return { harvests: visible, pendingCount, loading, busyKey, decide, reload: load };
}
