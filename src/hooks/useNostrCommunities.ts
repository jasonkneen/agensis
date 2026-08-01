import { useCallback, useEffect, useRef, useState } from 'react';
import { listNostrCommunities, type NostrConnection } from '../lib/nostrCommunities';

/** Safe local metadata for community grouping and settings re-entry. */
export function useNostrCommunities(workspaceId: string | null) {
  const [state, setState] = useState<{
    workspaceId: string | null;
    connections: NostrConnection[];
    loading: boolean;
    error: string;
    resolved: boolean;
  }>({ workspaceId: null, connections: [], loading: false, error: '', resolved: false });
  const controllerRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    controllerRef.current?.abort();
    if (!workspaceId) {
      setState({ workspaceId: null, connections: [], loading: false, error: '', resolved: true });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState(current => current.workspaceId === workspaceId
      ? { ...current, loading: true, error: '' }
      : { workspaceId, connections: [], loading: true, error: '', resolved: false });
    try {
      const connections = await listNostrCommunities(workspaceId, controller.signal);
      if (!controller.signal.aborted) {
        setState({ workspaceId, connections, loading: false, error: '', resolved: true });
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      setState(current => current.workspaceId === workspaceId
        ? {
          ...current,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        }
        : current);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [workspaceId]);

  useEffect(() => {
    void refetch();
    return () => controllerRef.current?.abort();
  }, [refetch]);

  const current = state.workspaceId === workspaceId
    ? state
    : { workspaceId, connections: [], loading: !!workspaceId, error: '', resolved: !workspaceId };
  return { ...current, refetch };
}
