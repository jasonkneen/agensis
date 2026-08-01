import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createWorkspaceResource,
  deleteWorkspaceResource,
  getWorkspaceResourceOperation,
  listWorkspaceResourceOperations,
  listWorkspaceResources,
  requestWorkspaceResourceOperation,
  restoreWorkspaceResource,
  subscribeWorkspaceResourceOperation,
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
import type { WorkspaceResourceOperationProgressEvent } from './api';

const ACTIVE_OPERATION_POLL_MS = 4_000;

export function useWorkspaceResources(
  workspaceId: string | null,
  options: { includeDeleted?: boolean } = {},
) {
  const includeDeleted = options.includeDeleted === true;
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
        listWorkspaceResources(workspaceId, { includeDeleted }),
        listWorkspaceResourceOperations(workspaceId, { includeDeleted }),
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
  }, [includeDeleted, workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const hasLiveOperations = useMemo(
    () => operations.some(isLiveResourceOperation),
    [operations],
  );

  useEffect(() => {
    if (!workspaceId || !hasLiveOperations) return undefined;
    const interval = window.setInterval(() => { void refresh({ quiet: true }); }, ACTIVE_OPERATION_POLL_MS);
    return () => window.clearInterval(interval);
  }, [hasLiveOperations, includeDeleted, refresh, workspaceId]);

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

  const deleteResource = useCallback(async (resourceId: string): Promise<string | null> => {
    if (!workspaceId) return 'No workspace selected.';
    try {
      const deleted = await deleteWorkspaceResource(workspaceId, resourceId);
      if (includeDeleted) {
        setResources(previous => previous.map(entry => (entry.id === deleted.id ? deleted : entry)));
      } else {
        setResources(previous => previous.filter(entry => entry.id !== deleted.id));
      }
      setError(null);
      await refresh({ quiet: true });
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'Could not delete the resource.';
    }
  }, [includeDeleted, refresh, workspaceId]);

  const restoreResource = useCallback(async (resourceId: string): Promise<string | null> => {
    if (!workspaceId) return 'No workspace selected.';
    try {
      const restored = await restoreWorkspaceResource(workspaceId, resourceId);
      setResources(previous => previous.map(entry => (entry.id === restored.id ? restored : entry)));
      setError(null);
      await refresh({ quiet: true });
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'Could not restore the resource.';
    }
  }, [refresh, workspaceId]);

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
      const operation = await getWorkspaceResourceOperation(workspaceId, operationId, { includeDeleted });
      setOperationDetails(previous => ({ ...previous, [operation.id]: operation }));
      setOperations(previous => previous.map(entry => (entry.id === operation.id ? operation : entry)));
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'Could not load the operation.';
    }
  }, [includeDeleted, workspaceId]);

  const subscribeOperationProgress = useCallback((operationId: string): (() => void) => {
    if (!workspaceId) return () => {};
    return subscribeWorkspaceResourceOperation(workspaceId, operationId, (event: WorkspaceResourceOperationProgressEvent) => {
      setOperations(previous => previous.map(operation => {
        if (operation.id !== event.operationId) return operation;
        const currentSeq = Number(operation.progress_seq) || 0;
        const nextSeq = Number(event.progressSeq) || 0;
        return nextSeq >= currentSeq
          ? {
            ...operation,
            status: event.status,
            progress: event.progress,
            progress_seq: nextSeq,
            progress_updated_at: event.updatedAt,
            updated_at: event.updatedAt || operation.updated_at,
          }
          : operation;
      }));
      setOperationDetails(previous => {
        const existing = previous[event.operationId];
        if (!existing) return previous;
        const currentSeq = Number(existing.progress_seq) || 0;
        const nextSeq = Number(event.progressSeq) || 0;
        if (nextSeq < currentSeq) return previous;
        return {
          ...previous,
          [event.operationId]: {
            ...existing,
            status: event.status,
            progress: event.progress,
            progress_seq: nextSeq,
            progress_updated_at: event.updatedAt,
            updated_at: event.updatedAt || existing.updated_at,
          },
        };
      });
    });
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
    deleteResource,
    restoreResource,
    requestOperation,
    loadOperation,
    subscribeOperationProgress,
  };
}
