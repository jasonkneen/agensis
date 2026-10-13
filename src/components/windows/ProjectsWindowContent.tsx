import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { ArrowLeft, File as FileIcon, Paperclip, Pencil } from 'lucide-react';
import { Button } from '@agensis/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@agensis/ui/components/native-select';
import { Textarea } from '@agensis/ui/components/textarea';
import { cn } from '@/lib/utils';
import { useActivity } from '../../hooks/useActivity';
import { useProjectFiles } from '../../hooks/useProjectFiles';
import { projectActivity } from '../../lib/pm/projectActivity';
import { useProjects, type Project, type ProjectStatus } from '../../hooks/useProjects';
import type { Task, WorkspaceAgent } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';
import { NewProjectDialog } from '../projects/NewProjectDialog';
import { ProjectIconTile } from '../projects/projectIcons';
import { ProjectReports, WorkspaceDashboard } from '../projects/ReportsPanels';
import { projectColor } from '../projects/projectIconMap';
import { TasksWindowContent, type TaskView } from './TasksWindowContent';
import { STATUS_LABELS } from './taskPresentation';
import { DAY_MS, isClosedTask, startOfDay } from './taskSchedule';

// The Projects window, from the approved project mocks: a list of project cards,
// and a project page with an Overview and the task views (Board, List, Table,
// Calendar, Timeline) locked to that project. A project has tasks and agents do
// tasks, so agents appear here only through the tasks they are assigned.

type TasksContentProps = Omit<ComponentProps<typeof TasksWindowContent>, 'onFocusTaskConsumed' | 'projectId' | 'forcedView'>;

const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'Planning',
  active: 'Active',
  at_risk: 'At risk',
  on_hold: 'On hold',
  completed: 'Completed',
};

const STATUS_FILTERS: Array<[ProjectStatus | 'all' | 'archived', string]> = [
  ['all', 'All'],
  ['active', 'Active'],
  ['at_risk', 'At risk'],
  ['completed', 'Completed'],
  ['archived', 'Archived'],
];

type LandingTab = 'overview' | 'files' | 'activity' | 'reports' | TaskView;
const LANDING_TABS: Array<[LandingTab, string]> = [
  ['overview', 'Overview'],
  ['kanban', 'Board'],
  ['list', 'List'],
  ['table', 'Table'],
  ['calendar', 'Calendar'],
  ['gantt', 'Timeline'],
  ['files', 'Files'],
  ['activity', 'Activity'],
  ['reports', 'Reports'],
];

function initials(email: string | null | undefined): string {
  const local = (email ?? '').split('@')[0] || 'M';
  return local.slice(0, 2).toUpperCase();
}

function dayDiff(iso: string): number {
  return Math.round((startOfDay(new Date(iso).getTime()) - startOfDay(Date.now())) / DAY_MS);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Not set';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateFromInput(value: string): string | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

interface ProjectStats {
  total: number;
  done: number;
  overdue: number;
  byStatus: Record<Task['status'], number>;
}

function statsFor(projectTasks: Task[]): ProjectStats {
  const today = startOfDay(Date.now());
  const byStatus: Record<Task['status'], number> = { todo: 0, in_progress: 0, done: 0, cancelled: 0 };
  let overdue = 0;
  for (const task of projectTasks) {
    if (task.status in byStatus) byStatus[task.status] += 1;
    if (!isClosedTask(task) && task.due_date && startOfDay(new Date(task.due_date).getTime()) < today) overdue += 1;
  }
  return { total: projectTasks.length, done: byStatus.done, overdue, byStatus };
}

/** Who is doing a task: a person's initials, or the agent's name in violet. */
function AssigneeChip({ task, members, agents }: { task: Task; members: WorkspaceMember[]; agents: WorkspaceAgent[] }) {
  if (!task.assignee_id) return null;
  const agent = agents.find(item => item.id === task.assignee_id);
  if (agent) {
    return (
      <span className="rounded-full border border-violet-500/40 px-1.5 text-[0.6875rem] text-violet-400">{agent.name || 'Agent'}</span>
    );
  }
  const member = members.find(item => item.user_id === task.assignee_id);
  return (
    <span className="grid size-5 place-items-center rounded-full bg-primary/20 text-[0.5625rem] font-semibold" title={member?.email}>
      {initials(member?.email)}
    </span>
  );
}

interface ProjectExtras {
  /** Creates a channel for a new project and returns its id. */
  onCreateChannel?: (name: string, description: string) => Promise<string | null>;
  /** Creates a brief document for a new project and returns its id. */
  onCreateBrief?: (title: string, content: string) => Promise<string | null>;
  /** Opens a document by id, for the project's brief. */
  onOpenDocument?: (documentId: string) => void;
}

export function ProjectsWindowContent({ tasksProps, onCreateChannel, onCreateBrief, onOpenDocument }: { tasksProps: TasksContentProps } & ProjectExtras) {
  const { tasks, members, agents, workspaceId, currentUserId, onCreateTask } = tasksProps;
  const { projects, createProject, updateProject } = useProjects(workspaceId, currentUserId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProjectStatus | 'all' | 'archived'>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [page, setPage] = useState<'dashboard' | 'projects'>('projects');

  const tasksByProject = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.project_id) continue;
      const list = map.get(task.project_id) ?? [];
      list.push(task);
      map.set(task.project_id, list);
    }
    return map;
  }, [tasks]);

  const selected = projects.find(project => project.id === selectedId) ?? null;

  const visible = projects.filter(project => {
    if (filter === 'archived') return project.archived;
    if (project.archived) return false;
    return filter === 'all' || project.status === filter;
  });

  const dialog = (
    <NewProjectDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      members={members}
      agents={agents}
      currentUserId={currentUserId}
      createProject={createProject}
      createTask={onCreateTask}
      updateProject={updateProject}
      onCreateChannel={onCreateChannel}
      onCreateBrief={onCreateBrief}
      onCreated={project => setSelectedId(project.id)}
    />
  );

  if (selected) {
    return (
      <>
        <ProjectLanding
          project={selected}
          projectTasks={tasksByProject.get(selected.id) ?? []}
          tasksProps={tasksProps}
          updateProject={updateProject}
          onOpenDocument={onOpenDocument}
          onBack={() => setSelectedId(null)}
        />
        {dialog}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <h1 className="text-base font-semibold">Projects</h1>
        <span className="text-sm text-muted-foreground">{projects.filter(project => !project.archived).length}</span>
        <div className="flex-1" />
        <div className="flex gap-1 text-xs" role="group" aria-label="Projects page">
          {([['dashboard', 'Dashboard'], ['projects', 'All projects']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={page === value}
              onClick={() => setPage(value)}
              className={cn('rounded-full border border-border px-2.5 py-1', page === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          New project
        </Button>
      </div>
      {page === 'dashboard' ? (
        <WorkspaceDashboard projects={projects} tasks={tasks} members={members} agents={agents} onOpenProject={id => setSelectedId(id)} />
      ) : (
      <>
      <div className="flex shrink-0 gap-1 border-b border-border px-4 py-2 text-xs">
        {STATUS_FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={cn('rounded-md px-2.5 py-1', filter === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <p className="text-sm font-medium">{projects.length === 0 ? 'No projects yet' : 'No projects match this filter'}</p>
            {projects.length === 0 && (
              <>
                <p className="max-w-xs text-sm text-muted-foreground">A project groups tasks for one body of work, and agents take part by being assigned its tasks.</p>
                <Button size="sm" onClick={() => setDialogOpen(true)}>
                  New project
                </Button>
              </>
            )}
          </div>
        )}
        {visible.map(project => {
          const stats = statsFor(tasksByProject.get(project.id) ?? []);
          const progress = stats.total ? Math.round((100 * stats.done) / stats.total) : 0;
          const hex = projectColor(project.color);
          const people = Array.from(new Set((tasksByProject.get(project.id) ?? []).map(task => task.assignee_id).filter((id): id is string => Boolean(id))))
            .map(id => members.find(member => member.user_id === id))
            .filter((member): member is WorkspaceMember => Boolean(member))
            .slice(0, 4);
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => setSelectedId(project.id)}
              className="flex w-full flex-col gap-2 border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/50"
            >
              <span className="flex items-center gap-2.5">
                <ProjectIconTile icon={project.icon} color={project.color} size="sm" />
                <span className="truncate font-semibold">{project.name}</span>
                {project.project_key && <span className="font-mono text-[0.6875rem] text-muted-foreground">{project.project_key}</span>}
                <span
                  className={cn(
                    'ml-auto shrink-0 rounded-full border px-2 text-[0.6875rem]',
                    project.status === 'at_risk' ? 'border-destructive/50 text-destructive' : project.status === 'active' ? 'border-emerald-500/50 text-emerald-500' : 'border-border text-muted-foreground',
                  )}
                >
                  {PROJECT_STATUS_LABELS[project.status]}
                </span>
              </span>
              <span className="flex items-center gap-2.5 text-xs text-muted-foreground">
                {people.length > 0 && (
                  <span className="flex -space-x-1.5">
                    {people.map(member => (
                      <span key={member.user_id} className="grid size-5 place-items-center rounded-full border-2 border-card bg-primary/20 text-[0.5625rem] font-semibold text-foreground">
                        {initials(member.email)}
                      </span>
                    ))}
                  </span>
                )}
                <span>{stats.total} {stats.total === 1 ? 'task' : 'tasks'}</span>
                {stats.overdue > 0 && <span className="text-destructive">{stats.overdue} overdue</span>}
                {project.due_date && <span className="ml-auto">Due {formatDate(project.due_date)}</span>}
              </span>
              <span className="h-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full" style={{ width: `${progress}%`, backgroundColor: hex }} />
              </span>
            </button>
          );
        })}
      </div>
      </>
      )}
      {dialog}
    </div>
  );
}

function ProjectLanding({
  project,
  projectTasks,
  tasksProps,
  updateProject,
  onOpenDocument,
  onBack,
}: {
  project: Project;
  projectTasks: Task[];
  tasksProps: TasksContentProps;
  updateProject: ReturnType<typeof useProjects>['updateProject'];
  onOpenDocument?: (documentId: string) => void;
  onBack: () => void;
}) {
  const { members } = tasksProps;
  const [tab, setTab] = useState<LandingTab>('overview');
  const stats = useMemo(() => statsFor(projectTasks), [projectTasks]);
  const progress = stats.total ? Math.round((100 * stats.done) / stats.total) : 0;
  const lead = members.find(member => member.user_id === project.lead_id);
  const people = useMemo(
    () =>
      Array.from(new Set([project.lead_id, ...projectTasks.map(task => task.assignee_id)].filter((id): id is string => Boolean(id))))
        .map(id => members.find(member => member.user_id === id))
        .filter((member): member is WorkspaceMember => Boolean(member)),
    [members, project.lead_id, projectTasks],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-sm text-muted-foreground">
        <button type="button" onClick={onBack} className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Projects
        </button>
        <span>/</span>
        <span className="truncate font-medium text-foreground">{project.name}</span>
      </div>

      <div className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-3">
        <ProjectIconTile icon={project.icon} color={project.color} size="lg" />
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{project.name}</h1>
        <NativeSelect
          size="sm"
          className="w-32"
          value={project.status}
          onChange={e => void updateProject(project.id, { status: e.target.value as ProjectStatus })}
          aria-label="Project status"
        >
          {(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map(status => (
            <NativeSelectOption key={status} value={status}>{PROJECT_STATUS_LABELS[status]}</NativeSelectOption>
          ))}
        </NativeSelect>
        <div className="flex-1" />
        <span className="flex -space-x-1.5">
          {people.slice(0, 5).map(member => (
            <span key={member.user_id} className="grid size-7 place-items-center rounded-full border-2 border-background bg-primary/20 text-[0.625rem] font-semibold" title={member.email}>
              {initials(member.email)}
            </span>
          ))}
        </span>
      </div>

      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4" role="tablist">
        {LANDING_TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap',
              tab === value ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <OverviewTab
          project={project}
          projectTasks={projectTasks}
          stats={stats}
          progress={progress}
          lead={lead}
          tasksProps={tasksProps}
          updateProject={updateProject}
          onOpenDocument={onOpenDocument}
          onViewList={() => setTab('list')}
        />
      ) : tab === 'files' ? (
        <ProjectFilesTab project={project} tasksProps={tasksProps} />
      ) : tab === 'activity' ? (
        <ProjectActivityTab projectTasks={projectTasks} tasksProps={tasksProps} />
      ) : tab === 'reports' ? (
        <ProjectReports project={project} projectTasks={projectTasks} members={tasksProps.members} agents={tasksProps.agents} />
      ) : (
        <TasksWindowContent {...tasksProps} projectId={project.id} forcedView={tab} />
      )}
    </div>
  );
}

function fileSize(bytes: number | string | null | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Files attached to the project. Attaching uploads through the app's normal upload and links the file; removing only unlinks it. */
function ProjectFilesTab({ project, tasksProps }: { project: Project; tasksProps: TasksContentProps }) {
  const { workspaceId, onUploadFiles } = tasksProps;
  const { files, attach, detach } = useProjectFiles(workspaceId, project.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onPick = async (picked: FileList | null) => {
    const list = picked ? Array.from(picked) : [];
    if (!list.length || !onUploadFiles) return;
    setBusy(true);
    setError('');
    try {
      const uploaded = await onUploadFiles(list);
      if (!uploaded.length) throw new Error('The upload did not go through.');
      await attach(uploaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not attach the file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-sm font-medium">Files</span>
        <span className="text-xs text-muted-foreground">{files.length}</span>
        <div className="flex-1" />
        {onUploadFiles && (
          <label className={cn('flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted', busy && 'pointer-events-none opacity-60')}>
            <Paperclip className="size-3.5" />
            {busy ? 'Attaching…' : 'Attach files'}
            <input
              type="file"
              multiple
              className="sr-only"
              aria-label="Attach files"
              onChange={e => {
                void onPick(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
      {error && <p role="alert" className="shrink-0 px-4 pt-2 text-xs text-destructive">{error}</p>}
      {files.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <p className="text-sm font-medium">No files yet</p>
          <p className="text-xs text-muted-foreground">Attach the briefs, designs and documents this project works from.</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-4 py-1">
          {files.map(file => (
            <li key={file.id} className="flex items-center gap-2.5 border-b border-border py-2.5 text-sm last:border-b-0">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{fileSize(file.size)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatDate(file.created_at)}</span>
              <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-destructive" onClick={() => void detach(file.id)} aria-label={`Remove ${file.name} from this project`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The project's task activity, newest first: who did what to which task, and when. */
function ProjectActivityTab({ projectTasks, tasksProps }: { projectTasks: Task[]; tasksProps: TasksContentProps }) {
  const { workspaceId, currentUserId, members } = tasksProps;
  const { events, loading } = useActivity(workspaceId, currentUserId);
  const items = useMemo(() => projectActivity(events, projectTasks), [events, projectTasks]);

  if (items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm font-medium">{loading ? 'Loading activity' : 'No activity yet'}</p>
        {!loading && <p className="text-xs text-muted-foreground">Creating, updating and completing this project's tasks shows up here.</p>}
      </div>
    );
  }

  return (
    <ul className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
      {items.map(item => {
        const member = members.find(candidate => candidate.user_id === item.user_id);
        return (
          <li key={item.id} className="flex items-center gap-2.5 border-b border-border py-2.5 text-sm last:border-b-0">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/20 text-[0.5625rem] font-semibold" title={member?.email ?? 'An agent or the system'}>
              {member ? initials(member.email) : 'AI'}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.created_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card/60 p-4">
      <div className="mb-3 flex items-center">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="ml-auto text-xs text-muted-foreground">{action}</div>
      </div>
      {children}
    </section>
  );
}

function OverviewTab({
  project,
  projectTasks,
  stats,
  progress,
  lead,
  tasksProps,
  updateProject,
  onOpenDocument,
  onViewList,
}: {
  project: Project;
  projectTasks: Task[];
  stats: ProjectStats;
  progress: number;
  lead: WorkspaceMember | undefined;
  tasksProps: TasksContentProps;
  updateProject: ReturnType<typeof useProjects>['updateProject'];
  onOpenDocument?: (documentId: string) => void;
  onViewList: () => void;
}) {
  const { members, agents } = tasksProps;
  const [editingAbout, setEditingAbout] = useState(false);
  const [aboutDraft, setAboutDraft] = useState(project.description);

  const comingUp = useMemo(
    () =>
      projectTasks
        .filter(task => !isClosedTask(task) && task.due_date && !task.labels?.includes('milestone'))
        .sort((a, b) => new Date(a.due_date as string).getTime() - new Date(b.due_date as string).getTime())
        .slice(0, 5),
    [projectTasks],
  );
  const milestones = useMemo(
    () =>
      projectTasks
        .filter(task => task.labels?.includes('milestone') && task.due_date)
        .sort((a, b) => new Date(a.due_date as string).getTime() - new Date(b.due_date as string).getTime()),
    [projectTasks],
  );
  const recent = useMemo(
    () => [...projectTasks].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 5),
    [projectTasks],
  );

  const daysLine = project.due_date
    ? dayDiff(project.due_date) >= 0
      ? `${dayDiff(project.due_date)} days until ${new Date(project.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : `${Math.abs(dayDiff(project.due_date))} days overdue`
    : 'No target date';

  const statusKeys: Array<[Task['status'], string, string]> = [
    ['todo', STATUS_LABELS.todo, '#8a867e'],
    ['in_progress', STATUS_LABELS.in_progress, '#d98a24'],
    ['done', STATUS_LABELS.done, '#2f9e6a'],
    ['cancelled', STATUS_LABELS.cancelled, '#6b7280'],
  ];

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card
          title="About"
          action={
            !editingAbout && (
              <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => { setAboutDraft(project.description); setEditingAbout(true); }}>
                <Pencil className="size-3" />
                Edit
              </button>
            )
          }
        >
          {editingAbout ? (
            <div className="flex flex-col gap-2">
              <Textarea value={aboutDraft} onChange={e => setAboutDraft(e.target.value)} rows={3} aria-label="About" autoFocus />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => { void updateProject(project.id, { description: aboutDraft.trim() }); setEditingAbout(false); }}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingAbout(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{project.description || 'No description yet.'}</p>
          )}
        </Card>

        <Card title="Progress" action={`${stats.done} of ${stats.total} tasks done`}>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-semibold tracking-tight">{progress}%</span>
            <span className="text-sm text-muted-foreground">{daysLine}</span>
          </div>
          <div className="my-3 flex h-2 overflow-hidden rounded-full bg-muted">
            {statusKeys.map(([key, , hex]) =>
              stats.byStatus[key] > 0 && stats.total > 0 ? (
                <span key={key} style={{ width: `${(100 * stats.byStatus[key]) / stats.total}%`, backgroundColor: hex }} />
              ) : null,
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {statusKeys.map(([key, label, hex]) => (
              <span key={key} className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ backgroundColor: hex }} />
                {label}
                <b className="font-medium text-foreground">{stats.byStatus[key]}</b>
              </span>
            ))}
            {stats.overdue > 0 && <span className="text-destructive">{stats.overdue} overdue</span>}
          </div>
        </Card>

        <Card title="Coming up" action={<button type="button" className="hover:text-foreground" onClick={onViewList}>View list</button>}>
          {comingUp.length === 0 ? (
            <div className="flex flex-col items-center gap-1 py-6 text-center">
              <p className="text-sm font-medium">Nothing scheduled</p>
              <p className="text-xs text-muted-foreground">Tasks with due dates will show up here.</p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {comingUp.map(task => {
                const overdue = dayDiff(task.due_date as string) < 0;
                return (
                  <li key={task.id} className="flex items-center gap-2.5 border-t border-border py-2 text-sm first:border-t-0">
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                    <AssigneeChip task={task} members={members} agents={agents} />
                    <span className={cn('shrink-0 text-xs', overdue ? 'text-destructive' : 'text-muted-foreground')}>
                      {overdue ? `${Math.abs(dayDiff(task.due_date as string))} days overdue` : formatDate(task.due_date)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <Card title="Details">
          <dl className="grid grid-cols-[6rem_1fr] items-center gap-x-2 gap-y-2.5 text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{PROJECT_STATUS_LABELS[project.status]}</dd>
            <dt className="text-muted-foreground">Lead</dt>
            <dd>
              <NativeSelect size="sm" value={project.lead_id ?? ''} onChange={e => void updateProject(project.id, { lead_id: e.target.value || null })} aria-label="Lead">
                <NativeSelectOption value="">No lead</NativeSelectOption>
                {members.map(member => (
                  <NativeSelectOption key={member.user_id} value={member.user_id}>{member.email?.split('@')[0] || 'Member'}</NativeSelectOption>
                ))}
              </NativeSelect>
              {lead && <span className="sr-only">{lead.email}</span>}
            </dd>
            <dt className="text-muted-foreground">Start</dt>
            <dd>
              <input type="date" aria-label="Start date" className="rounded-md border border-border bg-transparent px-2 py-1 text-sm" value={dateInputValue(project.start_date)} onChange={e => void updateProject(project.id, { start_date: dateFromInput(e.target.value) })} />
            </dd>
            <dt className="text-muted-foreground">Due</dt>
            <dd>
              <input type="date" aria-label="Due date" className="rounded-md border border-border bg-transparent px-2 py-1 text-sm" value={dateInputValue(project.due_date)} onChange={e => void updateProject(project.id, { due_date: dateFromInput(e.target.value) })} />
            </dd>
            {project.channel_id && tasksProps.onOpenSession && (
              <>
                <dt className="text-muted-foreground">Channel</dt>
                <dd>
                  <button type="button" className="text-primary hover:underline" onClick={() => tasksProps.onOpenSession?.(project.channel_id as string)}>
                    Open channel
                  </button>
                </dd>
              </>
            )}
            {project.brief_document_id && onOpenDocument && (
              <>
                <dt className="text-muted-foreground">Brief</dt>
                <dd>
                  <button type="button" className="text-primary hover:underline" onClick={() => onOpenDocument(project.brief_document_id as string)}>
                    Open brief
                  </button>
                </dd>
              </>
            )}
          </dl>
        </Card>

        <Card title="Milestones">
          {milestones.length === 0 ? (
            <p className="text-sm text-muted-foreground">No milestones yet. Label a task "milestone" to add one.</p>
          ) : (
            <ul className="flex flex-col">
              {milestones.map(task => (
                <li key={task.id} className="flex items-center gap-2.5 border-t border-border py-2 text-sm first:border-t-0">
                  <span className="size-2 shrink-0 rotate-45 bg-primary/70" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(task.due_date)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recently updated">
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet. Add a task to this project to get started.</p>
          ) : (
            <ul className="flex flex-col">
              {recent.map(task => (
                <li key={task.id} className="flex items-center gap-2.5 border-t border-border py-2 text-sm first:border-t-0">
                  <AssigneeChip task={task} members={members} agents={agents} />
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABELS[task.status]} · {timeAgo(task.updated_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
