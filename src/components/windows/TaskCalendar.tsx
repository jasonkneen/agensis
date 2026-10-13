import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@agensis/ui/components/button';
import { cn } from '@/lib/utils';
import type { Task } from '../../types';
import { isClosedTask, startOfDay } from './taskSchedule';

// Calendar view from the approved table-and-calendar mock: a Monday-first month
// grid with each top-level task shown on its due day. Overdue open tasks are
// red, done tasks are muted. Read-only apart from selecting a task, which opens
// the existing editor. Calendar events are not in the schema yet, so only tasks
// appear here.

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_CHIPS_PER_DAY = 3;

/** Local calendar-day key, e.g. "2026-10-13". */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function TaskCalendar({
  tasks,
  selectedTaskId,
  onSelectTask,
  onReschedule,
}: {
  /** Top-level rows to place, already filtered by the toolbar. */
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  /** Moves a task's due date (and its start, if it has one) by whole days. */
  onReschedule: (id: string, updates: Partial<Task>) => void;
}) {
  // Drop target: the day under the pointer. Set on dragover so the cell can highlight.
  const [dropKey, setDropKey] = useState<string | null>(null);

  // Move the task so its due day lands on `targetKey`, keeping the time of day
  // and the length of the start-to-due gap.
  const moveTaskTo = (taskId: string, targetKey: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task || !task.due_date) return;
    const due = new Date(task.due_date);
    const [y, m, d] = targetKey.split('-').map(Number);
    const target = new Date(y, m - 1, d, due.getHours(), due.getMinutes(), due.getSeconds());
    if (dayKey(target.getTime()) === dayKey(due.getTime())) return;
    const deltaMs = target.getTime() - due.getTime();
    const updates: Partial<Task> = { due_date: new Date(due.getTime() + deltaMs).toISOString() };
    if (task.start_date) updates.start_date = new Date(new Date(task.start_date).getTime() + deltaMs).toISOString();
    onReschedule(taskId, updates);
  };
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const todayMs = useMemo(() => startOfDay(Date.now()), []);
  const todayKey = dayKey(todayMs);

  // Tasks grouped by the local day they are due.
  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.due_date) continue;
      const key = dayKey(new Date(t.due_date).getTime());
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    }
    return map;
  }, [tasks]);

  // Six Monday-first weeks, so every month fits the same grid height.
  const cells = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7;
    first.setDate(first.getDate() - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(first);
      d.setDate(first.getDate() + i);
      return { date: d, key: dayKey(d.getTime()), inMonth: d.getMonth() === month.getMonth() };
    });
  }, [month]);

  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">{monthLabel}</span>
        <div className="flex-1" />
        <Button variant="outline" size="icon-sm" aria-label="Previous month" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="sm" onClick={() => {
          const d = new Date();
          setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
        }}>
          Today
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>
          <ChevronRight />
        </Button>
      </div>

      <div className="grid shrink-0 grid-cols-7 border-b border-border bg-card text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
        {WEEKDAYS.map(day => (
          <div key={day} className="border-r border-border px-2 py-1.5 last:border-r-0">{day}</div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 overflow-auto">
        {cells.map(cell => {
          const list = byDay.get(cell.key) ?? [];
          const shown = list.slice(0, MAX_CHIPS_PER_DAY);
          const isToday = cell.key === todayKey;
          return (
            <div
              key={cell.key}
              onDragOver={e => {
                e.preventDefault();
                if (dropKey !== cell.key) setDropKey(cell.key);
              }}
              onDragLeave={() => setDropKey(current => (current === cell.key ? null : current))}
              onDrop={e => {
                e.preventDefault();
                const taskId = e.dataTransfer.getData('text/plain');
                setDropKey(null);
                if (taskId) moveTaskTo(taskId, cell.key);
              }}
              className={cn(
                'min-h-24 border-r border-b border-border p-1.5 last:border-r-0',
                !cell.inMonth && 'bg-muted/40 text-muted-foreground',
                dropKey === cell.key && 'bg-primary/10 ring-1 ring-inset ring-primary',
              )}
            >
              <div className="mb-1 flex items-center">
                <span
                  className={cn(
                    'grid size-5 place-items-center rounded-full text-[0.6875rem]',
                    isToday && 'bg-destructive font-semibold text-white',
                  )}
                >
                  {cell.date.getDate()}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                {shown.map(task => {
                  const overdue = !isClosedTask(task) && startOfDay(new Date(task.due_date as string).getTime()) < todayMs;
                  const done = task.status === 'done';
                  return (
                    <button
                      key={task.id}
                      type="button"
                      draggable
                      onDragStart={e => {
                        e.dataTransfer.setData('text/plain', task.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onClick={() => onSelectTask(task.id)}
                      className={cn(
                        'truncate rounded border-l-2 px-1.5 py-0.5 text-left text-[0.6875rem]',
                        overdue ? 'border-destructive bg-destructive/10 text-destructive' : 'border-primary bg-primary/10',
                        done && 'border-muted-foreground bg-muted text-muted-foreground line-through',
                        selectedTaskId === task.id && 'ring-1 ring-primary',
                      )}
                      title={task.title}
                    >
                      {task.title}
                    </button>
                  );
                })}
                {list.length > MAX_CHIPS_PER_DAY && (
                  <span className="px-1 text-[0.6875rem] text-muted-foreground">+{list.length - MAX_CHIPS_PER_DAY} more</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
