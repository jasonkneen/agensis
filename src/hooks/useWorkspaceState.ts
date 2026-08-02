import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

type WorkspaceIdentity = {
  workspaceId: string | null;
  generation: number;
};

type WorkspaceState<T> = {
  identity: WorkspaceIdentity;
  value: T;
};

/**
 * Own state on behalf of one workspace identity.
 *
 * The returned value becomes `emptyValue` during the render that switches
 * workspaces, before effects have a chance to clear the previous value. Setters
 * created by the old render are fenced too, so late mutations and realtime
 * callbacks cannot replace the new workspace's state.
 */
export function useWorkspaceState<T>(
  workspaceId: string | null,
  initialValue: T,
  emptyValue: T,
): [T, Dispatch<SetStateAction<T>>, () => () => boolean] {
  const identityRef = useRef<WorkspaceIdentity>({ workspaceId, generation: 0 });
  if (identityRef.current.workspaceId !== workspaceId) {
    identityRef.current = {
      workspaceId,
      generation: identityRef.current.generation + 1,
    };
  }
  const identity = identityRef.current;
  const requestSequenceRef = useRef(0);
  const [state, setState] = useState<WorkspaceState<T>>(() => ({ identity, value: initialValue }));

  const setValue = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    setState(current => {
      if (identityRef.current !== identity) return current;
      const previous = current.identity === identity ? current.value : emptyValue;
      const value = typeof action === 'function'
        ? (action as (previousValue: T) => T)(previous)
        : action;
      return { identity, value };
    });
  }, [emptyValue, identity]);

  const beginRequest = useCallback(() => {
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    return () => identityRef.current === identity && requestSequenceRef.current === sequence;
  }, [identity]);

  return [state.identity === identity ? state.value : emptyValue, setValue, beginRequest];
}

export function useWorkspaceListState<T>(
  workspaceId: string | null,
  initialValue: T[],
): [T[], Dispatch<SetStateAction<T[]>>, () => () => boolean] {
  const emptyValue = useRef<T[]>([]);
  return useWorkspaceState(workspaceId, initialValue, emptyValue.current);
}
