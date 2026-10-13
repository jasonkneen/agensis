import { useMemo } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@agensis/ui/components/table';
import { cn } from '@/lib/utils';
import type { Task, TaskPriority } from '../../types';
import { isClosedTask, startOfDay } from './taskSchedule';
import { STATUS_LABELS } from './taskPresentation';

// Table view from the approved task mock: one row per top-level task, with the
// fields a list hides (start, due, labels, estimate, progress) in aligned
// columns. Read-only apart from selecting a row, which opens the task editor.

function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TaskTable({
  tasks,
  allTasks,
  memberLabel,
  priorityLabel,
  selectedTaskId,
  onSelectTask,
}: {
  /** Top-level rows to show, already filtered by the toolbar. */
  tasks: Task[];
  /** Every task in the workspace, used to count subtask progress. */
  allTasks: Task[];
  memberLabel: (assigneeId: string | null) => string | null;
  priorityLabel: (priority: TaskPriority) => string;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
}) {
  const todayStart = useMemo(() => startOfDay(Date.now()), []);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of allTasks) {
      if (!t.parent_id) continue;
      const list = map.get(t.parent_id) ?? [];
      list.push(t);
      map.set(t.parent_id, list);
    }
    return map;
  }, [allTasks]);

  const progressOf = (task: Task): number | null => {
    const kids = childrenByParent.get(task.id);
    if (!kids?.length) return null;
    return Math.round((100 * kids.filter(k => k.status === 'done').length) / kids.length);
  };

  const isOverdue = (task: Task) =>
    Boolean(task.due_date) &&
    !isClosedTask(task) &&
    startOfDay(new Date(task.due_date as string).getTime()) < todayStart;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Table className="min-w-[860px] text-[0.8125rem]">
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow>
            <TableHead className="w-[34%]">Task</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Assignee</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Start</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Labels</TableHead>
            <TableHead>Estimate</TableHead>
            <TableHead>Progress</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map(task => {
            const progress = progressOf(task);
            const overdue = isOverdue(task);
            const done = task.status === 'done';
            return (
              <TableRow
                key={task.id}
                data-state={selectedTaskId === task.id ? 'selected' : undefined}
                className="cursor-pointer"
                onClick={() => onSelectTask(task.id)}
              >
                <TableCell className={cn('max-w-0 truncate', done && 'text-muted-foreground line-through')}>
                  {task.title}
                </TableCell>
                <TableCell>{STATUS_LABELS[task.status]}</TableCell>
                <TableCell className="text-muted-foreground">{memberLabel(task.assignee_id) ?? 'Unassigned'}</TableCell>
                <TableCell>{priorityLabel(task.priority)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDay(task.start_date)}</TableCell>
                <TableCell className={cn(overdue ? 'text-destructive' : 'text-muted-foreground')}>
                  {formatDay(task.due_date)}
                  {overdue && ' · overdue'}
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {(task.labels ?? []).map(label => (
                      <span key={label} className="rounded bg-muted px-1.5 text-[0.6875rem] text-muted-foreground">
                        {label}
                      </span>
                    ))}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{task.estimate || '—'}</TableCell>
                <TableCell>
                  {progress === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full bg-primary" style={{ width: `${progress}%` }} />
                      </span>
                      <span className="text-muted-foreground">{progress}%</span>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
