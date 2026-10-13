import { useMemo, useState } from 'react';
import { Button } from '@agensis/ui/components/button';
import { Input } from '@agensis/ui/components/input';
import { cn } from '@/lib/utils';
import { backendClient } from '../../lib/backendClient';
import { useProjects, type Project, type ProjectStatus } from '../../hooks/useProjects';
import { useTasks } from '../../hooks/useTasks';
import { isClosedTask, startOfDay } from './taskSchedule';

// Projects window: every project in the workspace with its task counts, and an
// overview of the selected one. Creating a project and changing its status are
// the only edits here; tasks are assigned to projects from the Tasks window.

const STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'Planning',
  active: 'Active',
  at_risk: 'At risk',
  on_hold: 'On hold',
  completed: 'Completed',
};

export function ProjectsWindowContent({
  workspaceId,
  userId,
}: {
  workspaceId: string | null;
  userId?: string;
}) {
  const { projects, createProject } = useProjects(workspaceId, userId);
  const { tasks } = useTasks(workspaceId, userId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({ name: '', key: '' });
  const todayStart = useMemo(() => startOfDay(Date.now()), []);

  // Per-project counts over top-level and sub tasks alike. Archived projects are hidden.
  const stats = useMemo(() => {
    const byProject = new Map<string, { total: number; done: number; open: number; overdue: number }>();
    for (const task of tasks) {
      if (!task.project_id) continue;
      const entry = byProject.get(task.project_id) ?? { total: 0, done: 0, open: 0, overdue: 0 };
      entry.total += 1;
      if (task.status === 'done') entry.done += 1;
      if (!isClosedTask(task)) {
        entry.open += 1;
        if (task.due_date && startOfDay(new Date(task.due_date).getTime()) < todayStart) entry.overdue += 1;
      }
      byProject.set(task.project_id, entry);
    }
    return byProject;
  }, [tasks, todayStart]);

  const visible = useMemo(() => projects.filter(project => !project.archived), [projects]);
  const selected: Project | null = visible.find(project => project.id === selectedId) ?? null;
  const selectedTasks = useMemo(
    () => (selected ? tasks.filter(task => task.project_id === selected.id && task.parent_id == null) : []),
    [selected, tasks],
  );

  // The status select saves straight to the projects table; the realtime update
  // then refreshes the list.
  const setStatus = async (id: string, status: ProjectStatus) => {
    await backendClient.from('projects').update({ status }).eq('id', id);
  };

  const submit = async () => {
    const name = draft.name.trim();
    if (!name) return;
    const created = await createProject({ name, project_key: draft.key.trim().toUpperCase() });
    if (created) {
      setDraft({ name: '', key: '' });
      setShowForm(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">Projects</span>
        <span className="text-xs text-muted-foreground">{visible.length}</span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setShowForm(open => !open)} aria-expanded={showForm}>
          New project
        </Button>
      </div>

      {showForm && (
        <form
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs"
          onSubmit={e => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            autoFocus
            aria-label="Project name"
            placeholder="Project name"
            className="h-7 min-w-40 flex-1"
            value={draft.name}
            onChange={e => setDraft(current => ({ ...current, name: e.target.value }))}
          />
          <Input
            aria-label="Project key"
            placeholder="Key (e.g. WEB)"
            className="h-7 w-28"
            value={draft.key}
            onChange={e => setDraft(current => ({ ...current, key: e.target.value }))}
          />
          <Button type="submit" size="sm" disabled={!draft.name.trim()}>
            Add project
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
            Cancel
          </Button>
        </form>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 w-72 shrink-0 overflow-y-auto border-r border-border">
          {visible.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No projects yet. Create one to group tasks.</p>
          )}
          {visible.map(project => {
            const counts = stats.get(project.id) ?? { total: 0, done: 0, open: 0, overdue: 0 };
            const progress = counts.total ? Math.round((100 * counts.done) / counts.total) : 0;
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => setSelectedId(project.id)}
                aria-pressed={selectedId === project.id}
                className={cn(
                  'flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left text-sm hover:bg-muted/60',
                  selectedId === project.id && 'bg-muted',
                )}
              >
                <span className="flex items-center gap-2">
                  {project.project_key && <span className="font-mono text-[0.6875rem] text-muted-foreground">{project.project_key}</span>}
                  <span className="truncate font-medium">{project.name}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{STATUS_LABELS[project.status]}</span>
                  <span>·</span>
                  <span>{counts.total} tasks</span>
                  {counts.overdue > 0 && <span className="text-destructive">{counts.overdue} overdue</span>}
                </span>
                <span className="h-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full bg-primary" style={{ width: `${progress}%` }} />
                </span>
              </button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!selected && <p className="text-sm text-muted-foreground">Select a project to see its overview.</p>}
          {selected && (
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex items-center gap-2">
                  {selected.project_key && <span className="font-mono text-xs text-muted-foreground">{selected.project_key}</span>}
                  <h2 className="text-lg font-semibold">{selected.name}</h2>
                </div>
                {selected.description && <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>}
              </div>

              <div className="grid grid-cols-3 gap-3 text-sm">
                {(() => {
                  const counts = stats.get(selected.id) ?? { total: 0, done: 0, open: 0, overdue: 0 };
                  return (
                    <>
                      <div className="rounded-md border border-border p-3">
                        <div className="text-xs text-muted-foreground">Tasks</div>
                        <div className="text-xl font-semibold">{counts.total}</div>
                      </div>
                      <div className="rounded-md border border-border p-3">
                        <div className="text-xs text-muted-foreground">Done</div>
                        <div className="text-xl font-semibold">{counts.done}</div>
                      </div>
                      <div className="rounded-md border border-border p-3">
                        <div className="text-xs text-muted-foreground">Overdue</div>
                        <div className={cn('text-xl font-semibold', counts.overdue > 0 && 'text-destructive')}>{counts.overdue}</div>
                      </div>
                    </>
                  );
                })()}
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Status</span>
                <select
                  aria-label="Project status"
                  className="h-7 rounded-md border border-border bg-card px-2"
                  value={selected.status}
                  onChange={e => {
                    const status = e.target.value as ProjectStatus;
                    void setStatus(selected.id, status);
                  }}
                >
                  {(Object.keys(STATUS_LABELS) as ProjectStatus[]).map(status => (
                    <option key={status} value={status}>{STATUS_LABELS[status]}</option>
                  ))}
                </select>
              </div>

              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tasks</h3>
                {selectedTasks.length === 0 && <p className="text-sm text-muted-foreground">No tasks in this project yet.</p>}
                <ul className="flex flex-col gap-1 text-sm">
                  {selectedTasks.map(task => (
                    <li key={task.id} className={cn('flex items-center justify-between gap-2 rounded px-2 py-1', task.status === 'done' && 'text-muted-foreground line-through')}>
                      <span className="truncate">{task.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{task.status === 'in_progress' ? 'In progress' : task.status === 'done' ? 'Done' : task.status === 'cancelled' ? 'Cancelled' : 'To do'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
