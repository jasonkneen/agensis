import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { tableRealtimeManager } from '../lib/realtimeManager';
import {
  pendingSuggestionCount,
  reviewableSuggestionSets,
  suggestionSetFromRow,
  type SuggestionSet,
  type SuggestionSetRow,
} from '../lib/suggestions';
import type { DbChangePayload } from '../types/realtime';

/**
 * What this workspace's conversations suggested keeping.
 *
 * Loaded through the dedicated route rather than the generic table API, because
 * `thread_harvests` is deliberately read-only to clients (shared/backend-core.cjs)
 * and the route is also what joins the conversation's title and deleted_at back
 * on — without those a suggestion has no provenance and cannot be judged. The
 * route is where private conversations are excluded, too, which is the second
 * reason this cannot go through the generic table read.
 *
 * Kept live over the same realtime db_changes subscription every other table
 * uses. A realtime row is the RAW database shape and carries NO joined title, so
 * an update is merged onto the row already in state rather than replacing it:
 * otherwise accepting one suggestion would blank out the "which conversation did
 * this come from" line on the card you are still looking at.
 */
export function useSuggestions(workspaceId: string | null) {
  const [sets, setSets] = useState<SuggestionSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');

  const load = useCallback(async () => {
    if (!workspaceId) {
      setSets([]);
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
      const rows = response.ok && !payload.error ? (payload.data as SuggestionSetRow[]) : [];
      setSets(Array.isArray(rows) ? rows.map(suggestionSetFromRow) : []);
    } catch {
      setSets([]);
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
      (payload: DbChangePayload<SuggestionSetRow>) => {
        const row = (payload.new ?? payload.old) as SuggestionSetRow | undefined;
        if (!row?.id) return;
        setSets(prev => {
          const existing = prev.find(set => set.id === row.id);
          // A row the list has never seen arriving over realtime is a
          // conversation that just finished being read. Reload rather than
          // render it: the row alone has no title, and a card that cannot say
          // where a suggestion came from is exactly what this surface exists to
          // prevent. The reload also re-applies the route's privacy filter,
          // which the raw row has not been through.
          if (!existing) {
            void load();
            return prev;
          }
          const next = suggestionSetFromRow({
            ...row,
            session_title: row.session_title ?? existing.threadTitle,
            session_deleted_at: row.session_deleted_at ?? existing.discardedAt,
          });
          return prev.map(set => (set.id === next.id ? next : set));
        });
      },
    );
  }, [workspaceId, load]);

  const visible = useMemo(() => reviewableSuggestionSets(sets), [sets]);
  const pendingCount = useMemo(() => pendingSuggestionCount(visible), [visible]);

  /**
   * Answer ONE suggestion.
   *
   * Goes through the dedicated route, never a table write. The request names
   * WHICH suggestion and accept-or-dismiss; the body that reaches memory_facts
   * or documents is read back out of the stored row on the server. A client that
   * could name what gets written could put words no model produced into the two
   * stores a human trusts most.
   *
   * One suggestion per call by design — there is no bulk accept, because
   * accepting something nobody has read is the failure mode this whole feature
   * is built to avoid.
   */
  const decide = useCallback(async (
    setId: string,
    index: number,
    decision: 'accept' | 'dismiss',
  ): Promise<{ error: string }> => {
    if (!workspaceId) return { error: 'No workspace' };
    setBusyKey(`${setId}:${index}`);
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/thread-harvests/${setId}/findings/${index}`),
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
      const row = payload.data as SuggestionSetRow;
      setSets(prev => prev.map(set => (set.id === row.id
        ? suggestionSetFromRow({
          ...row,
          session_title: row.session_title ?? set.threadTitle,
          session_deleted_at: row.session_deleted_at ?? set.discardedAt,
        })
        : set)));
      return { error: '' };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not record that decision' };
    } finally {
      setBusyKey('');
    }
  }, [workspaceId]);

  return { suggestionSets: visible, pendingCount, loading, busyKey, decide, reload: load };
}
