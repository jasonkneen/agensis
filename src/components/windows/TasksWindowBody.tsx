// Split out of WindowBodies so the Tasks surface (and everything it pulls in)
// can load on demand instead of riding in the entry bundle. Same memo contract
// as WindowBodies: see the comment at the top of that file.
import { useCallback, type ComponentProps } from 'react';
import { TasksWindowContent } from './TasksWindowContent';
import type { FloatingWindow } from '../../types';

export type TasksWindowBodyProps = Omit<
  ComponentProps<typeof TasksWindowContent>,
  'onFocusTaskConsumed'
> & {
  windowId: string;
  onUpdateWindow: (id: string, updates: Partial<FloatingWindow>) => void;
};

export function TasksWindowBody({
  windowId,
  onUpdateWindow,
  ...contentProps
}: TasksWindowBodyProps) {
  const handleFocusTaskConsumed = useCallback(
    () => onUpdateWindow(windowId, { focusTaskId: undefined }),
    [onUpdateWindow, windowId],
  );

  return <TasksWindowContent {...contentProps} onFocusTaskConsumed={handleFocusTaskConsumed} />;
}
