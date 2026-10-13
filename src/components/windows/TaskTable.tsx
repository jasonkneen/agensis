import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
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
// columns. Columns can be resized by dragging their right edge. Title and
// estimate are edited in place on double-click. Clicking elsewhere on a row
// selects it, which opens the task editor.

type ColumnKey = 'select' | 'title' | 'status' | 'assignee' | 'priority' | 'start' | 'due' | 'labels' | 'estimate' | 'progress';

const DEFAULT_WIDTHS: Record<ColumnKey, number> = {
  select: 36,
  title: 300,
  status: 120,
  assignee: 140,
  priority: 96,
  start: 90,
  due: 130,
  labels: 160,
  estimate: 90,
  progress: 130,
};
const MIN_WIDTH = 56;

type EditingCell = { id: string; field: 'title' | 'estimate'; draft: string } | null;

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
  onUpdateTask,
}: {
  /** Top-level rows to show, already filtered by the toolbar. */
  tasks: Task[];
  /** Every task in the workspace, used to count subtask progress. */
  allTasks: Task[];
  memberLabel: (assigneeId: string | null) => string | null;
  priorityLabel: (priority: TaskPriority) => string;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onUpdateTask: (id: string, updates: Partial<Task>) => void;
}) {
  const todayStart = useMemo(() => startOfDay(Date.now()), []);
  // Rows ticked for a bulk action. Kept apart from selectedTaskId, which opens the editor.
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [widths, setWidths] = useState<Record<ColumnKey, number>>(DEFAULT_WIDTHS);
  const [editing, setEditing] = useState<EditingCell>(null);
  const resizing = useRef<{ key: ColumnKey; startX: number; startWidth: number } | null>(null);

  const toggleChecked = (id: string) =>
    setChecked(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const applyToChecked = (updates: Partial<Task>) => {
    checked.forEach(id => onUpdateTask(id, updates));
    setChecked(new Set());
  };

  // Column resize: pointer capture on the handle, width follows the pointer.
  const startResize = (key: ColumnKey) => (e: PointerEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    e.preventDefault();
    resizing.current = { key, startX: e.clientX, startWidth: widths[key] };
    // Capture keeps the drag alive outside the handle. It can throw if the pointer is
    // already gone, in which case the drag still works as long as the pointer stays over the page.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer not capturable: ignore */
    }
  };
  const moveResize = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = resizing.current;
    if (!drag) return;
    const width = Math.max(MIN_WIDTH, drag.startWidth + (e.clientX - drag.startX));
    setWidths(current => ({ ...current, [drag.key]: width }));
  };
  const endResize = () => {
    resizing.current = null;
  };

  // Inline edit: commit on Enter or blur, cancel on Escape. Empty titles are refused.
  const beginEdit = (task: Task, field: 'title' | 'estimate') => {
    setEditing({ id: task.id, field, draft: field === 'title' ? task.title : task.estimate ?? '' });
  };
  const commitEdit = () => {
    if (!editing) return;
    const task = allTasks.find(t => t.id === editing.id);
    const next = editing.draft.trim();
    if (task) {
      if (editing.field === 'title' && next && next !== task.title) onUpdateTask(task.id, { title: next });
      if (editing.field === 'estimate' && next !== (task.estimate ?? '')) onUpdateTask(task.id, { estimate: next || null });
    }
    setEditing(null);
  };
  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditing(null);
  };

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

  const headCell = (key: ColumnKey, label: string) => (
    <TableHead key={key} className="relative" style={{ width: widths[key], minWidth: widths[key] }}>
      {label}
      <span
        role="separator"
        aria-label={`Resize ${label} column`}
        className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none hover:bg-primary/30"
        onPointerDown={startResize(key)}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
    </TableHead>
  );

  const tableWidth = Object.values(widths).reduce((sum, w) => sum + w, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {checked.size > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/10 px-3 py-1.5 text-xs">
          <span className="font-medium">{checked.size} selected</span>
          <button type="button" className="rounded-md border border-border bg-card px-2 py-0.5" onClick={() => applyToChecked({ status: 'done' })}>
            Mark done
          </button>
          <button type="button" className="rounded-md border border-border bg-card px-2 py-0.5" onClick={() => applyToChecked({ status: 'todo' })}>
            Mark to do
          </button>
          <div className="flex-1" />
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setChecked(new Set())}>
            Clear
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="table-fixed text-[0.8125rem]" style={{ width: tableWidth, minWidth: '100%' }}>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="relative" style={{ width: widths.select }}>
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  className="size-3.5 accent-primary"
                  checked={tasks.length > 0 && checked.size === tasks.length}
                  onChange={e => setChecked(e.target.checked ? new Set(tasks.map(t => t.id)) : new Set())}
                />
              </TableHead>
              {headCell('title', 'Task')}
              {headCell('status', 'Status')}
              {headCell('assignee', 'Assignee')}
              {headCell('priority', 'Priority')}
              {headCell('start', 'Start')}
              {headCell('due', 'Due')}
              {headCell('labels', 'Labels')}
              {headCell('estimate', 'Estimate')}
              {headCell('progress', 'Progress')}
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map(task => {
              const progress = progressOf(task);
              const overdue = isOverdue(task);
              const done = task.status === 'done';
              const isEditing = (field: 'title' | 'estimate') => editing?.id === task.id && editing.field === field;
              return (
                <TableRow
                  key={task.id}
                  data-state={selectedTaskId === task.id ? 'selected' : undefined}
                  className="cursor-pointer"
                  onClick={() => onSelectTask(task.id)}
                >
                  <TableCell onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${task.title}`}
                      className="size-3.5 accent-primary"
                      checked={checked.has(task.id)}
                      onChange={() => toggleChecked(task.id)}
                    />
                  </TableCell>
                  <TableCell
                    className={cn('truncate', done && 'text-muted-foreground line-through')}
                    onDoubleClick={e => {
                      e.stopPropagation();
                      beginEdit(task, 'title');
                    }}
                    onClick={e => isEditing('title') && e.stopPropagation()}
                  >
                    {isEditing('title') ? (
                      <input
                        autoFocus
                        aria-label="Task title"
                        className="w-full rounded border border-primary bg-card px-1 py-0.5 text-[0.8125rem] outline-none"
                        value={editing?.draft ?? ''}
                        onChange={e => setEditing(current => (current ? { ...current, draft: e.target.value } : current))}
                        onKeyDown={onEditKey}
                        onBlur={commitEdit}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      task.title
                    )}
                  </TableCell>
                  <TableCell className="truncate">{STATUS_LABELS[task.status]}</TableCell>
                  <TableCell className="truncate text-muted-foreground">{memberLabel(task.assignee_id) ?? 'Unassigned'}</TableCell>
                  <TableCell className="truncate">{priorityLabel(task.priority)}</TableCell>
                  <TableCell className="truncate text-muted-foreground">{formatDay(task.start_date)}</TableCell>
                  <TableCell className={cn('truncate', overdue ? 'text-destructive' : 'text-muted-foreground')}>
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
                  <TableCell
                    className="truncate text-muted-foreground"
                    onDoubleClick={e => {
                      e.stopPropagation();
                      beginEdit(task, 'estimate');
                    }}
                    onClick={e => isEditing('estimate') && e.stopPropagation()}
                  >
                    {isEditing('estimate') ? (
                      <input
                        autoFocus
                        aria-label="Estimate"
                        placeholder="e.g. 2d"
                        className="w-full rounded border border-primary bg-card px-1 py-0.5 text-[0.8125rem] outline-none"
                        value={editing?.draft ?? ''}
                        onChange={e => setEditing(current => (current ? { ...current, draft: e.target.value } : current))}
                        onKeyDown={onEditKey}
                        onBlur={commitEdit}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      task.estimate || '—'
                    )}
                  </TableCell>
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
    </div>
  );
}
