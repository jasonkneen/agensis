// The Kanban and Gantt views, lifted out of TasksWindowContent whole. They are
// the two alternate renderings of the same task list: the window picks one by
// view mode and hands it the same props, so neither shares state with the list
// or with each other. 641 lines of a 2,595-line file, moved without a single
// change to either body.

import { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  CornerDownRight,
  Flag,
  Link2,
  User,
  } from 'lucide-react';
import type { Task, TaskStatus } from '../../types';
import { TaskActivityChip } from './TaskActivityChip';
import { STATUS_LABELS, taskChatSessionId } from './taskPresentation';
import {
  DAY_MS,
  applyHideDone,
  buildGanttRows,
  buildTaskSpans,
  dueDateFromExclusiveEnd,
  labelFitsInsideBar,
  startOfDay,
  taskDependsOn,
  type GanttRow,
  type TaskSpan,
} from './taskSchedule';
import { Badge } from '@agensis/ui/components/badge';
import { ScrollArea } from '@agensis/ui/components/scroll-area';
import { cn } from '@/lib/utils';

const KANBAN_COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];

export function TaskKanban({
  columns,
  memberLabel,
  selectedTaskId,
  onSelectTask,
  onChangeStatus,
  onReparent,
}: {
  columns: Record<TaskStatus, Task[]>;
  memberLabel: (assigneeId: string | null) => string | null;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onChangeStatus: (id: string, status: TaskStatus) => void;
  onReparent: (draggedId: string, targetId: string) => void;
}) {
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  // A card the dragged task is hovering over — dropping here nests as a subtask
  // instead of changing status.
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);

  const resetDrag = () => {
    setDragTaskId(null);
    setDragOver(null);
    setDragOverCardId(null);
  };

  const dropOnColumn = (status: TaskStatus) => {
    const id = dragTaskId;
    resetDrag();
    if (!id) return;
    const from = KANBAN_COLUMNS.find(col => columns[col].some(task => task.id === id));
    if (from === status) return;
    onChangeStatus(id, status);
  };

  const dropOnCard = (targetId: string) => {
    const id = dragTaskId;
    resetDrag();
    if (!id) return;
    onReparent(id, targetId);
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex gap-3 p-3">
        {KANBAN_COLUMNS.map(status => {
          const items = columns[status];
          return (
            <div
              key={status}
              className={cn(
                'flex w-64 shrink-0 flex-col gap-2 rounded-lg border border-border bg-card/40 p-2 transition-colors',
                dragOver === status && 'border-primary/60 bg-primary/5',
              )}
              onDragOver={e => {
                if (!dragTaskId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // Card handlers stopPropagation, so reaching here means the pointer
                // is over the column background — a status drop, not a nest.
                setDragOverCardId(null);
                setDragOver(status);
              }}
              onDragLeave={e => {
                // Only clear when the pointer actually leaves the column, not on
                // moves between its children.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOver(prev => (prev === status ? null : prev));
                }
              }}
              onDrop={e => {
                e.preventDefault();
                dropOnColumn(status);
              }}
            >
              <div className="flex items-center justify-between px-1 pt-0.5">
                <span className="text-xs font-semibold tracking-tight">{STATUS_LABELS[status]}</span>
                <span className="rounded-full bg-muted px-1.5 text-3xs font-medium leading-4 text-muted-foreground">
                  {items.length}
                </span>
              </div>
              {dragOver === status && dragTaskId && (
                <div className="h-8 rounded-md border border-dashed border-primary/50 bg-primary/5" aria-hidden />
              )}
              {items.map(task => {
                const assignee = memberLabel(task.assignee_id);
                const deps = taskDependsOn(task);
                return (
                  <div
                    key={task.id}
                    draggable
                    onClick={() => onSelectTask(task.id)}
                    onDragStart={e => {
                      setDragTaskId(task.id);
                      // Some browsers refuse to start an HTML5 drag with no payload.
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', task.id);
                    }}
                    onDragEnd={resetDrag}
                    onDragOver={e => {
                      // Hovering a different card = nest-as-subtask intent. Stop the
                      // event reaching the column so its status-drop highlight clears.
                      if (!dragTaskId || dragTaskId === task.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'move';
                      setDragOver(null);
                      setDragOverCardId(task.id);
                    }}
                    onDragLeave={e => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDragOverCardId(prev => (prev === task.id ? null : prev));
                      }
                    }}
                    onDrop={e => {
                      if (!dragTaskId || dragTaskId === task.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      dropOnCard(task.id);
                    }}
                    className={cn(
                      'flex cursor-grab flex-col gap-1.5 rounded-md border border-border bg-card p-2 shadow-sm active:cursor-grabbing',
                      dragTaskId === task.id && 'opacity-50',
                      dragOverCardId === task.id && 'border-primary bg-primary/10 ring-1 ring-primary/50',
                      selectedTaskId === task.id && 'border-primary/70 ring-1 ring-primary/40',
                    )}
                  >
                    <span className={cn('text-sm', task.status === 'done' && 'text-muted-foreground line-through')}>
                      {task.title}
                    </span>
                    <div className="flex flex-wrap items-center gap-1">
                      <TaskActivityChip task={task} sessionId={taskChatSessionId(task)} compact />
                      {task.priority !== 'normal' && (
                        <Badge variant={task.priority === 'urgent' ? 'destructive' : 'secondary'}>
                          <Flag />
                          {task.priority}
                        </Badge>
                      )}
                      {task.due_date && (
                        <Badge variant="outline">
                          <Clock />
                          {new Date(task.due_date).toLocaleDateString()}
                        </Badge>
                      )}
                      {assignee && (
                        <Badge variant="outline">
                          <User />
                          {assignee}
                        </Badge>
                      )}
                      {deps.length > 0 && (
                        <Badge variant="outline" title="Depends on other tasks">
                          <Link2 />
                          {deps.length}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// Gantt timeline — rows are tasks (parents with their children inlined and
// indented underneath), the X axis is days.
//
// What a row draws comes from buildTaskSpans in ./taskSchedule:
//   'span'   — the task has start_date and/or due_date: a real range.
//   'rollup' — a parent: the union of its own dates and every scheduled
//              descendant, drawn as a slim summary bar (not draggable — moving
//              a summary would not move the children it summarises).
//   'point'  — NO dates anywhere in its subtree: a single-day diamond marker on
//              its created_at, deliberately unlike a bar so an unscheduled task
//              is never mistaken for a real one-day span.
//
// Bars drag horizontally (day-snapped) to reschedule; the right edge resizes
// due_date only. Dependency arrows are non-interactive SVG; a task that starts
// before a dependency ends gets a violation tint. Labels sit inside the bar when
// it is wide enough and outside it when it is not, so a one-day bar still reads
// as its title instead of "T…".
// ---------------------------------------------------------------------------

const GANTT_DAY_WIDTH = 32;
// One line of text (text-sm, matching the List view) plus room to breathe. The
// old 36px held two jammed lines because the name lived in a side column; the
// name now rides the bar, so a row is a single line again — just a taller one.
const GANTT_ROW_HEIGHT = 40;
const GANTT_HEADER_HEIGHT = 36;
// Bars sit inside the row with breathing room above and below.
const GANTT_BAR_HEIGHT = 24;
// Depth indent applied to a row's label (never to its bar — a bar's position
// means a date and must not be nudged to show hierarchy).
const GANTT_DEPTH_INDENT = 14;
// Closest two axis labels may sit before one is dropped.
const GANTT_TICK_MIN_GAP = 56;
// A label that rides beside its bar truncates at this width, with the full
// title on hover. ~66 characters — longer than any title in practice, and 2.5x
// what the old fixed name column could show before it cut a title off.
const GANTT_ALONGSIDE_LABEL_MAX = 520;
// Room to the right of the grid so the last row's alongside label is fully
// reachable by scrolling instead of being clipped by the content width.
const GANTT_LABEL_GUTTER = GANTT_ALONGSIDE_LABEL_MAX + 48;

interface GanttDrag {
  taskId: string;
  mode: 'move' | 'resize';
  originX: number;
  startMs: number;
  endMs: number;
}

export function TaskGantt({
  tasks,
  allTasks,
  hideDone,
  memberLabel,
  selectedTaskId,
  onSelectTask,
  onReschedule,
}: {
  /** Rows to chart (already assignment-filtered, top-level only). */
  tasks: Task[];
  /** EVERY task in the workspace — needed to resolve children and rollups. */
  allTasks: Task[];
  /** Toolbar toggle: closed subtasks drop out of the rows, not the rollups. */
  hideDone?: boolean;
  memberLabel: (assigneeId: string | null) => string | null;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onReschedule: (id: string, updates: Partial<Task>) => void;
}) {
  const [drag, setDrag] = useState<GanttDrag | null>(null);
  // Preview offset (in snapped days) applied to the dragging bar before commit.
  const [previewDays, setPreviewDays] = useState(0);

  // Only the ROWS honour "hide done" — spans below still resolve over every
  // task, so a parent's rollup keeps spanning the children it is hiding.
  const rowSource = useMemo(() => applyHideDone(allTasks, Boolean(hideDone)), [allTasks, hideDone]);
  const rows = useMemo<GanttRow[]>(() => buildGanttRows(tasks, rowSource), [tasks, rowSource]);
  // Spans are resolved over ALL tasks so a parent still rolls up over a child
  // the assignment filter hides.
  const spans = useMemo(() => buildTaskSpans(allTasks), [allTasks]);
  const spanOf = (task: Task): TaskSpan => {
    const span = spans.get(task.id);
    if (span) return span;
    const day = startOfDay(new Date(task.created_at).getTime());
    return { startMs: day, endMs: day + DAY_MS, kind: 'point' };
  };

  const { windowStart, dayCount } = useMemo(() => {
    const today = startOfDay(Date.now());
    let min = today - 7 * DAY_MS;
    let max = today + 30 * DAY_MS;
    for (const row of rows) {
      const span = spans.get(row.task.id);
      if (!span) continue;
      min = Math.min(min, span.startMs);
      max = Math.max(max, span.endMs);
    }
    const days = Math.max(1, Math.round((max - min) / DAY_MS) + 1);
    return { windowStart: min, dayCount: days };
  }, [rows, spans]);

  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => map.set(row.task.id, i));
    return map;
  }, [rows]);

  const dayToX = (ms: number) => ((startOfDay(ms) - windowStart) / DAY_MS) * GANTT_DAY_WIDTH;
  const gridWidth = dayCount * GANTT_DAY_WIDTH;
  const contentWidth = gridWidth + GANTT_LABEL_GUTTER;
  const gridHeight = rows.length * GANTT_ROW_HEIGHT;

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const deltaDays = Math.round((e.clientX - drag.originX) / GANTT_DAY_WIDTH);
      setPreviewDays(deltaDays);
    };
    const onUp = (e: PointerEvent) => {
      const deltaDays = Math.round((e.clientX - drag.originX) / GANTT_DAY_WIDTH);
      if (deltaDays === 0) {
        // No movement — treat a plain (non-resize) press as a click that opens
        // the editor. The resize handle should never open the panel.
        if (drag.mode === 'move') onSelectTask(drag.taskId);
      } else if (drag.mode === 'move') {
        // Materialize both dates so the update shape is always {start_date, due_date}
        // — dragging an undated marker is how you schedule it in the first place.
        // drag.endMs is EXCLUSIVE, so due_date is the day before it.
        const nextStart = drag.startMs + deltaDays * DAY_MS;
        const nextEnd = drag.endMs + deltaDays * DAY_MS;
        onReschedule(drag.taskId, {
          start_date: new Date(nextStart).toISOString(),
          due_date: dueDateFromExclusiveEnd(nextEnd),
        });
      } else {
        // Resize the right edge: due_date only, floored to at least one day wide.
        const nextEnd = Math.max(drag.startMs + DAY_MS, drag.endMs + deltaDays * DAY_MS);
        onReschedule(drag.taskId, { due_date: dueDateFromExclusiveEnd(nextEnd) });
      }
      setDrag(null);
      setPreviewDays(0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, onReschedule, onSelectTask]);

  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        No tasks to chart. Add one above.
      </div>
    );
  }

  // Dependency arrows: dep bar end -> task bar start, only when both are visible.
  const arrows: Array<{ key: string; x1: number; y1: number; x2: number; y2: number; violation: boolean }> = [];
  for (const row of rows) {
    const toRow = rowIndex.get(row.task.id);
    if (toRow === undefined) continue;
    const taskStart = spanOf(row.task).startMs;
    for (const depId of taskDependsOn(row.task)) {
      const fromRow = rowIndex.get(depId);
      if (fromRow === undefined) continue;
      const depEnd = spanOf(rows[fromRow].task).endMs;
      arrows.push({
        key: `${depId}->${row.task.id}`,
        x1: dayToX(depEnd),
        y1: fromRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2,
        x2: dayToX(taskStart),
        y2: toRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2,
        violation: taskStart < depEnd,
      });
    }
  }

  // Day header ticks — label the 1st of each month plus every 7th day so the
  // axis stays readable at 32px/day. The two rules collide near a month
  // boundary ("1 Aug" landing right beside "2 Aug"), so a tick that would sit
  // on top of the previous label is dropped.
  const ticks: Array<{ x: number; label: string }> = [];
  for (let i = 0; i < dayCount; i++) {
    const ms = windowStart + i * DAY_MS;
    const d = new Date(ms);
    if (d.getDate() !== 1 && i !== 0 && i % 7 !== 0) continue;
    const x = i * GANTT_DAY_WIDTH;
    const previous = ticks[ticks.length - 1];
    if (previous && x - previous.x < GANTT_TICK_MIN_GAP) continue;
    ticks.push({ x, label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) });
  }
  const todayX = dayToX(Date.now());
  const todayVisible = todayX >= 0 && todayX <= gridWidth;
  // Every row is an undated marker, so the chart is a column of identical
  // diamonds conveying nothing. Say so once, above the rows, rather than
  // leaving the user to work out that the timeline has no timeline in it.
  const nothingScheduled = rows.every(row => spanOf(row.task).kind === 'point');

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {nothingScheduled && (
        <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
          Nothing is scheduled yet. Give a task a start or due date — or drag its marker
          along the timeline — and it draws as a bar.
        </p>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex" style={{ width: contentWidth }}>
          {/* Timeline grid. There is no separate name column: every task's name
              rides its own bar or marker (see the label block below). */}
          <div className="relative" style={{ width: contentWidth }}>
            {/* Day header */}
            <div className="relative border-b border-border" style={{ width: contentWidth, height: GANTT_HEADER_HEIGHT }}>
              {ticks.map(tick => (
                <div
                  key={tick.x}
                  className="absolute top-0 flex h-full items-center border-l border-border/40 pl-1.5 text-xs text-muted-foreground"
                  style={{ left: tick.x }}
                >
                  {tick.label}
                </div>
              ))}
            </div>

            <div className="relative" style={{ width: contentWidth, height: gridHeight }}>
              {/* Row backgrounds. Also the row's click target: with the name
                  column gone, clicking anywhere on the band selects the task,
                  so selection no longer depends on hitting a 12px diamond. */}
              {rows.map((row, i) => (
                <div
                  key={row.task.id}
                  className={cn(
                    'absolute left-0 cursor-pointer border-b border-border/40',
                    selectedTaskId === row.task.id && 'bg-muted',
                  )}
                  style={{ top: i * GANTT_ROW_HEIGHT, height: GANTT_ROW_HEIGHT, width: contentWidth }}
                  onClick={() => onSelectTask(row.task.id)}
                />
              ))}

              {/* Today marker */}
              {todayVisible && (
                <div className="absolute top-0 z-0 w-px bg-primary/40" style={{ left: todayX, height: gridHeight }} aria-hidden />
              )}

              {/* Dependency arrows */}
              <svg className="pointer-events-none absolute inset-0 overflow-visible" width={gridWidth} height={gridHeight} aria-hidden>
                <defs>
                  <marker id="gantt-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" className="fill-muted-foreground/60" />
                  </marker>
                </defs>
                {arrows.map(arrow => (
                  <path
                    key={arrow.key}
                    d={`M${arrow.x1},${arrow.y1} L${(arrow.x1 + arrow.x2) / 2},${arrow.y1} L${(arrow.x1 + arrow.x2) / 2},${arrow.y2} L${arrow.x2},${arrow.y2}`}
                    fill="none"
                    className={cn('stroke-[1.5]', arrow.violation ? 'stroke-destructive/70' : 'stroke-muted-foreground/40')}
                    markerEnd="url(#gantt-arrow)"
                  />
                ))}
              </svg>

              {/* Bars */}
              {rows.map((row, i) => {
                const task = row.task;
                const span = spanOf(task);
                const isDragging = drag?.taskId === task.id;
                const shiftDays = isDragging ? previewDays : 0;
                const moveShift = isDragging && drag?.mode === 'move' ? shiftDays : 0;
                const resizeShift = isDragging && drag?.mode === 'resize' ? shiftDays : 0;
                const left = dayToX(span.startMs + moveShift * DAY_MS);
                const days = Math.max(1, (span.endMs - span.startMs) / DAY_MS + resizeShift);
                const width = days * GANTT_DAY_WIDTH;
                const assigneeLabel = memberLabel(task.assignee_id);
                const deps = taskDependsOn(task);
                const violation = deps.some(depId => {
                  const depRow = rowIndex.get(depId);
                  if (depRow === undefined) return false;
                  return span.startMs < spanOf(rows[depRow].task).endMs;
                });
                // Where this row's name goes. There is exactly one copy of it,
                // and it belongs to the shape: inside the bar when the bar is
                // wide enough to hold the WHOLE title, immediately alongside
                // when it is not (which includes every undated marker — a
                // diamond can hold no text at all). One rule for every row, no
                // per-row guesswork, and no title is ever truncated by a bar
                // whose width is really just its date range.
                const labelInside = span.kind === 'span' && labelFitsInsideBar(task.title, width, row.depth);
                const labelPlacement = labelInside ? 'inside' : 'outside';
                // Width of the shape the alongside label has to clear.
                const shapeWidth = span.kind === 'point' ? GANTT_DAY_WIDTH : width;
                const statusTint = task.status === 'done'
                  ? 'border-emerald-500/40 bg-emerald-500/25'
                  : task.status === 'cancelled'
                    ? 'border-border bg-muted'
                    : 'border-primary/40 bg-primary/25';
                const tooltip = [
                  task.title,
                  span.kind === 'point'
                    ? 'no dates set — drag to schedule'
                    : span.kind === 'rollup'
                      ? 'rolled up from subtasks'
                      : `${new Date(span.startMs).toLocaleDateString()} → ${new Date(span.endMs - DAY_MS).toLocaleDateString()}`,
                  violation ? 'starts before a dependency ends' : null,
                ].filter(Boolean).join(' — ');

                const startDrag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  if (mode === 'resize') e.stopPropagation();
                  setDrag({ taskId: task.id, mode, originX: e.clientX, startMs: span.startMs, endMs: span.endMs });
                  setPreviewDays(0);
                };

                return (
                  <div
                    key={task.id}
                    // Spans the full row rather than starting at the bar, so the
                    // alongside label below can be `sticky` — see its comment.
                    className="pointer-events-none absolute left-0 flex items-center"
                    style={{ top: i * GANTT_ROW_HEIGHT, height: GANTT_ROW_HEIGHT, width: contentWidth }}
                    // Which of the three shapes this row drew, and where its title
                    // ended up. Asserted by tests/unit/tasksWindowRender.test.ts —
                    // "every bar is a narrow block with a one-character label" is
                    // otherwise only visible to a human looking at the screen.
                    data-gantt-kind={span.kind}
                    data-gantt-label={labelPlacement}
                    data-gantt-days={Math.round(days)}
                    data-gantt-id={task.id}
                  >
                    <span className="absolute flex items-center" style={{ left, height: GANTT_ROW_HEIGHT }}>
                    {span.kind === 'point' ? (
                      // Single-day marker: a diamond, NOT a bar. An undated task
                      // must not look like a real one-day span.
                      <span
                        className="pointer-events-auto grid cursor-pointer place-items-center"
                        style={{ width: GANTT_DAY_WIDTH, height: GANTT_ROW_HEIGHT }}
                        title={tooltip}
                        onPointerDown={e => startDrag(e, 'move')}
                      >
                        <span
                          className={cn(
                            // Neutral whatever the status. A marker means "no
                            // dates set", and a screen of green diamonds spent
                            // the loudest colour available on the one thing in
                            // this view carrying no schedule at all. Done still
                            // reads: the title beside it is struck through,
                            // exactly as it is in the List view.
                            'size-3 rotate-45 border border-dashed border-muted-foreground/70 bg-muted-foreground/15',
                            selectedTaskId === task.id && 'border-primary bg-primary/40',
                            isDragging && 'opacity-70',
                          )}
                          aria-hidden
                        />
                      </span>
                    ) : span.kind === 'rollup' ? (
                      // Summary bar: slim, with end caps, spanning its children. It
                      // is derived from them, so it CLICKS to select rather than
                      // dragging — moving a summary would move nothing real.
                      <span
                        className="pointer-events-auto relative flex cursor-pointer items-center"
                        style={{ width, height: GANTT_ROW_HEIGHT }}
                        title={tooltip}
                        onClick={() => onSelectTask(task.id)}
                      >
                        <span
                          className={cn(
                            'absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-sm bg-foreground/45',
                            selectedTaskId === task.id && 'bg-primary',
                            violation && 'bg-destructive/70',
                          )}
                          aria-hidden
                        />
                        <span className="absolute top-1/2 left-0 size-2 -translate-y-1/2 rotate-45 bg-foreground/60" aria-hidden />
                        <span className="absolute top-1/2 right-0 size-2 -translate-y-1/2 rotate-45 bg-foreground/60" aria-hidden />
                      </span>
                    ) : (
                      <span
                        className={cn(
                          'pointer-events-auto flex cursor-pointer items-center overflow-hidden rounded-md border text-xs shadow-sm',
                          statusTint,
                          violation && 'ring-1 ring-destructive/60',
                          selectedTaskId === task.id && 'ring-2 ring-primary',
                          isDragging && 'opacity-80',
                        )}
                        style={{ width, height: GANTT_BAR_HEIGHT }}
                        title={tooltip}
                        onPointerDown={e => startDrag(e, 'move')}
                      >
                        {labelInside && (
                          <span className="pointer-events-none flex min-w-0 flex-1 items-center gap-1 truncate px-2">
                            {row.depth > 0 && <CornerDownRight className="size-3.5 shrink-0 opacity-70" aria-hidden />}
                            <span className={cn('truncate', task.status === 'done' && 'line-through')}>{task.title}</span>
                          </span>
                        )}
                        {/* Right-edge resize handle (due_date only) */}
                        <span
                          className="ml-auto h-full w-2 shrink-0 cursor-ew-resize bg-foreground/10 hover:bg-foreground/25"
                          onPointerDown={e => startDrag(e, 'resize')}
                          aria-label="Resize due date"
                        />
                      </span>
                    )}
                    {/* Activity chip, just past the right edge of the shape.
                        Outside the bar rather than in it: a bar's width is its
                        DATE RANGE, so anything put inside a short one is
                        immediately truncated. Only for rows whose title already
                        sits in the bar — when the title is alongside, the chip
                        rides that label instead (below) so the two can't
                        overlap. pointer-events-auto because the row wrapper
                        turns them off and the chip carries the tooltip that
                        says what its number means. */}
                    {labelInside && (
                      <span className="pointer-events-auto ml-1.5 flex items-center">
                        <TaskActivityChip task={task} sessionId={taskChatSessionId(task)} compact />
                      </span>
                    )}
                    </span>
                    {/* The name, when the shape is too small to hold it — which
                        is every undated marker. It is `sticky`, so it travels
                        with its bar until the bar scrolls off the left edge and
                        then pins there: with no name column left, that is the
                        only thing keeping rows identifiable once you scroll into
                        next month. The chip background is what makes it legible
                        when it is pinned over the grid. */}
                    {labelPlacement === 'outside' && (
                      <span
                        data-gantt-sticky-label=""
                        // inline-flex with the TITLE in its own truncating span,
                        // rather than truncating the whole label: the activity
                        // chip lives at the end, and inside a single truncating
                        // box a long title ate it outright — the rows most worth
                        // knowing are being worked were the ones whose chip was
                        // clipped away. The title gives up the room instead.
                        className={cn(
                          'pointer-events-auto sticky z-10 inline-flex cursor-pointer items-center gap-1 overflow-hidden whitespace-nowrap rounded-sm bg-card/80 px-1 text-sm',
                          row.hasChildren && 'font-medium',
                          task.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground',
                        )}
                        style={{
                          marginLeft: left + shapeWidth + 6 + row.depth * GANTT_DEPTH_INDENT,
                          left: 8 + row.depth * GANTT_DEPTH_INDENT,
                          maxWidth: GANTT_ALONGSIDE_LABEL_MAX,
                        }}
                        title={tooltip}
                        onClick={() => onSelectTask(task.id)}
                      >
                        {row.depth > 0 && (
                          <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="truncate">
                          {task.title}
                          {assigneeLabel && <span className="text-muted-foreground"> · {assigneeLabel}</span>}
                        </span>
                        <TaskActivityChip task={task} sessionId={taskChatSessionId(task)} compact />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
