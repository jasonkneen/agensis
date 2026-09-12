import { useCallback, useMemo, useState } from 'react';
import {
  addHidden,
  moveInOrder,
  moveRelativeTo,
  partitionWorkspaceRail,
  readHiddenWorkspaceIds,
  readWorkspaceOrder,
  removeHidden,
  writeHiddenWorkspaceIds,
  writeWorkspaceOrder,
  type RailOrderable,
} from '../lib/workspaceRailPrefs';

/**
 * The rail's per-user view preferences (hidden tiles + tile order), wired to
 * localStorage. The decisions live in `src/lib/workspaceRailPrefs.ts`; this hook
 * only holds the state and hands the rail a filtered/ordered list plus the
 * actions its context menu fires. Nothing here touches the server — hiding and
 * reordering are personal view state, not workspace data.
 */
export function useWorkspaceRailPrefs<T extends RailOrderable>(workspaces: readonly T[]) {
  const [hiddenIds, setHiddenIds] = useState<string[]>(() => readHiddenWorkspaceIds());
  const [order, setOrder] = useState<string[]>(() => readWorkspaceOrder());

  const { rail, hidden } = useMemo(
    () => partitionWorkspaceRail(workspaces, hiddenIds, order),
    [workspaces, hiddenIds, order],
  );

  const hideWorkspace = useCallback((id: string) => {
    setHiddenIds(prev => {
      const next = addHidden(prev, id);
      writeHiddenWorkspaceIds(next);
      return next;
    });
  }, []);

  const restoreWorkspace = useCallback((id: string) => {
    setHiddenIds(prev => {
      const next = removeHidden(prev, id);
      writeHiddenWorkspaceIds(next);
      return next;
    });
  }, []);

  const moveWorkspace = useCallback((id: string, direction: 'up' | 'down') => {
    // Base the swap on what the rail is CURRENTLY showing (ordinary, in display
    // order), not the raw saved order — this folds any workspace created since
    // the last reorder into an explicit, complete order the moment the user
    // touches it, so the sequence stops depending on `updated_at` from then on.
    const currentOrdinaryIds = rail.filter(w => w.is_system !== true).map(w => w.id);
    const next = moveInOrder(currentOrdinaryIds, id, direction);
    setOrder(next);
    writeWorkspaceOrder(next);
  }, [rail]);

  // Drag-and-drop reorder: drop the dragged tile immediately before/after the
  // tile it landed on. Like `moveWorkspace`, it bases the sequence on what the
  // rail is CURRENTLY showing so any workspace created since the last reorder is
  // folded into an explicit, complete order the moment the user drags.
  const reorderWorkspace = useCallback(
    (draggedId: string, targetId: string, place: 'before' | 'after') => {
      const currentOrdinaryIds = rail.filter(w => w.is_system !== true).map(w => w.id);
      const next = moveRelativeTo(currentOrdinaryIds, draggedId, targetId, place);
      setOrder(next);
      writeWorkspaceOrder(next);
    },
    [rail],
  );

  return { railWorkspaces: rail, hiddenWorkspaces: hidden, hideWorkspace, restoreWorkspace, moveWorkspace, reorderWorkspace };
}
