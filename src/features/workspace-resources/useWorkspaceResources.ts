import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createWorkspaceResource,
  getWorkspaceResourceOperation,
  listWorkspaceResourceOperations,
  listWorkspaceResources,
  requestWorkspaceResourceOperation,
  updateWorkspaceResource,
} from './api';
import {
  isLiveResourceOperation,
  type CreateWorkspaceResourceInput,
  type RequestWorkspaceResourceOperationInput,
  type WorkspaceResource,
  type WorkspaceResourceOperation,
  mergeResourceOperationDetails,
} from './model';

const ACTIVE_OPERATION_POLL_MS = 4_000;

export function useWorkspaceResources(workspaceId: string | null) {
  const [resources, setResources] = useState<WorkspaceResource[]>([]);
  const [operations, setOperations] = useState<WorkspaceResourceOperation[]>([]);
  const [operationDetails, setOperationDetails] = useState<Record<string, WorkspaceResourceOperation>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!workspaceId) {
      setResources([]);
      setOperations([]);
      setOperationDetails({});
      setError(null);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (!quiet) setLoading(true);
    try {
      const [nextResources, nextOperations] = await Promise.all([
        listWorkspaceResources(workspaceId),
        listWorkspaceResourceOperations(workspaceId),
      ]);
      if (requestRef.current !== requestId) return;
      setResources(nextResources);
      setOperations(nextOperations);
      setOperationDetails(previous => mergeResourceOperationDetails(previous, nextOperations));
      setError(null);
    } catch (cause) {
      if (requestRef.current !== requestId) return;
      setError(cause instanceof Error ? cause.message : 'Could not load workspace resources.');
    } finally {
      if (requestRef.current === requestId && !quiet) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const hasLiveOperations = useMemo(
    () => operations.some(isLiveResourceOperation),
    [operations],
  );

  useEffect(() => {
    if (!workspaceId || !hasLiveOperations) return undefined;
    const interval = window.setInterval(() => { void refresh({ quiet: true }); }, ACTIVE_OPERATION_POLL_MS);
    return () => window.clearInterval(interval);
  }, [hasLiveOperations, refresh, workspaceId]);

  const createResource = useCallback(async (
    input: CreateWorkspaceResourceInput,
  ): Promise<{ resource: WorkspaceResource | null; error: string | null }> => {
    if (!workspaceId) return { resource: null, error: 'No workspace selected.' };
    try {
      const resource = await createWorkspaceResource(workspaceId, input);
      setResources(previous => [resource, ...previous.filter(entry => entry.id !== resource.id)]);
      setError(null);
      return { resource, error: null };
    } catch (cause) {
      return { resource: null, error: cause instanceof Error ? cause.message : 'Could not create the resource.' };
    }
  }, [workspaceId]);

  const updateResource = useCallback(async (
    resourceId: string,
    changes: Partial<Pick<WorkspaceResource, 'name' | 'description' | 'visibility' | 'status'>>,
  ): Promise<string | null> => {
    if (!workspaceId) return 'No workspace selected.';
    try {
      const updated = await updateWorkspaceResource(workspaceId, resourceId, changes);
      setResources(previous => previous.map(entry => (entry.id === updated.id ? updated : entry)));
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'Could not update the resource.';
    }
  }, [workspaceId]);

  const requestOperation = useCallback(async (
    resourceId: string,
    input: RequestWorkspaceResourceOperationInput,
  ): Promise<{ operation: WorkspaceResourceOperation | null; error: string | null }> => {
    if (!workspaceId) return { operation: null, error: 'No workspace selected.' };
    try {
      const operation = await requestWorkspaceResourceOperation(workspaceId, resourceId, input);
      setOperations(previous => [operation, ...previous.filter(entry => entry.id !== operation.id)]);
      setOperationDetails(previous => ({ ...previous, [operation.id]: operation }));
      return { operation, error: null };
    } catch (cause) {
      return { operation: null, error: cause instanceof Error ? cause.message : 'Could not request the operation.' };
    }
  }, [workspaceId]);

  const loadOperation = useCallback(async (operationId: string): Promise<string | null> => {
    if (!workspaceId) return 'No workspace selected.';
    try {
      const operation = await getWorkspaceResourceOperation(workspaceId, operationId);
      setOperationDetails(previous => ({ ...previous, [operation.id]: operation }));
      setOperations(previous => previous.map(entry => (entry.id === operation.id ? operation : entry)));
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'Could not load the operation.';
    }
  }, [workspaceId]);

  return {
    resources,
    operations,
    operationDetails,
    loading,
    error,
    refresh,
    createResource,
    updateResource,
    requestOperation,
    loadOperation,
  };
}
