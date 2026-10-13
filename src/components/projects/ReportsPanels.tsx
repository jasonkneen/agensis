import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from '@agensis/ui/components/spinner';
import { agentHandle } from '../../lib/agentAccent';
import {
  averageVelocity,
  burndown,
  createdVsCompleted,
  cumulativeFlow,
  statusBreakdown,
  velocity,
  workload,
  workspaceTotals,
  type StatusEvent,
  type WorkloadRow,
} from '../../lib/pm/reports';
import type { Task, WorkspaceAgent } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';
import type { Project } from '../../hooks/useProjects';
import { STATUS_COLORS } from './reportColors';
import { STATUS_LABELS } from '../windows/taskPresentation';

// Dashboard and Reports screens from the approved Section 7 mock. Charts load on
// demand; the numbers and bars drawn in plain markup render immediately.

const Charts = {
  Burndown: lazy(() => import('./ReportCharts').then(m => ({ default: m.BurndownChart }))),
  Velocity: lazy(() => import('./ReportCharts').then(m => ({ default: m.VelocityChart }))),
  Flow: lazy(() => import('./ReportCharts').then(m => ({ default: m.FlowChart }))),
  StatusFlow: lazy(() => import('./ReportCharts').then(m => ({ default: m.StatusFlowChart }))),
  Ring: lazy(() => import('./ReportCharts').then(m => ({ default: m.StatusRing }))),
};

const DAY = 24 * 60 * 60 * 1000;

function Panel({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-xl border border-border bg-card/60 p-4', className)}>
      <div className="mb-3 flex items-center">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{aside}</span>
      </div>
      {children}
    </section>
  );
}

const ChartFallback = () => (
  <div className="flex h-32 items-center justify-center">
    <Spinner />
  </div>
);

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-muted-foreground">{children}</p>;
}

function Stat({ label, value, sub, tone }: { label: string; value: number | string; sub?: string; tone?: 'bad' }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 px-3.5 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-2xl font-semibold tracking-tight', tone === 'bad' && 'text-destructive')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Open tasks per person or agent as one stacked bar each. */
export function WorkloadBars({ rows, members, agents }: { rows: WorkloadRow[]; members: WorkspaceMember[]; agents: WorkspaceAgent[] }) {
  if (rows.length === 0) return <Empty>No open tasks are assigned yet.</Empty>;
  const max = Math.max(...rows.map(row => row.total));
  return (
    <ul className="space-y-2" aria-label="Workload">
      {rows.map(row => {
        const agent = row.isAgent ? agents.find(item => item.id === row.id) : undefined;
        const member = row.isAgent ? undefined : members.find(item => item.user_id === row.id);
        const name = agent ? `@${agentHandle(agent)}` : member?.email?.split('@')[0] || 'Member';
        return (
          <li key={row.id} className="grid grid-cols-[5.5rem_1fr_1.5rem] items-center gap-2 text-xs">
            <span className={cn('truncate', agent && 'text-violet-500')} title={name}>
              {name}
            </span>
            <span className="flex h-2 overflow-hidden rounded-full bg-muted" style={{ width: `${(row.total / max) * 100}%`, minWidth: '0.5rem' }}>
              <span style={{ width: `${(row.inProgress / row.total) * 100}%`, backgroundColor: STATUS_COLORS.in_progress }} />
              <span style={{ width: `${(row.todo / row.total) * 100}%`, backgroundColor: STATUS_COLORS.todo }} />
            </span>
            <span className="text-right text-muted-foreground">{row.total}</span>
          </li>
        );
      })}
    </ul>
  );
}

function StatusLegend({ counts }: { counts: ReturnType<typeof statusBreakdown> }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
      {counts.map(slice => (
        <span key={slice.status} className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm" style={{ backgroundColor: STATUS_COLORS[slice.status] }} />
          {STATUS_LABELS[slice.status]} {slice.count}
        </span>
      ))}
    </div>
  );
}

type Range = 7 | 30 | 'all';

/** The Reports tab on a project page: burndown, velocity, created vs completed, status, workload. */
export function ProjectReports({ project, projectTasks, members, agents, statusEvents }: { project: Project; projectTasks: Task[]; members: WorkspaceMember[]; agents: WorkspaceAgent[]; statusEvents: StatusEvent[] }) {
  const [range, setRange] = useState<Range>(30);
  const now = Date.now();
  const agentIds = useMemo(() => new Set(agents.map(agent => agent.id)), [agents]);

  const earliest = projectTasks.reduce((min, task) => Math.min(min, new Date(task.created_at).getTime()), now);
  const from = range === 'all' ? Math.min(earliest, project.start_date ? new Date(project.start_date).getTime() : earliest) : now - (range - 1) * DAY;
  const to = project.due_date && new Date(project.due_date).getTime() > now ? new Date(project.due_date).getTime() : now;

  const burn = useMemo(() => burndown(projectTasks, from, range === 'all' ? to : Math.max(to, now), now), [projectTasks, from, to, range, now]);
  const weeks = useMemo(() => velocity(projectTasks, 4, now), [projectTasks, now]);
  const flow = useMemo(() => createdVsCompleted(projectTasks, from, now, now), [projectTasks, from, now]);
  const counts = useMemo(() => statusBreakdown(projectTasks), [projectTasks]);
  const statusFlow = useMemo(() => {
    const ids = new Set(projectTasks.map(task => task.id));
    return cumulativeFlow(projectTasks, statusEvents.filter(event => ids.has(event.task_id)), from, now);
  }, [projectTasks, statusEvents, from, now]);
  const rows = useMemo(() => workload(projectTasks, agentIds), [projectTasks, agentIds]);

  const total = projectTasks.length;
  const done = counts.find(slice => slice.status === 'done')?.count ?? 0;
  const remaining = burn.length ? burn[burn.length - 1].remaining : 0;

  if (total === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Empty>Reports appear once this project has tasks.</Empty>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="project-reports">
      <div className="flex gap-1.5 text-xs" role="group" aria-label="Report range">
        {([[30, 'Last 30 days'], [7, 'Last 7 days'], ['all', 'Whole project']] as Array<[Range, string]>).map(([value, label]) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={range === value}
            onClick={() => setRange(value)}
            className={cn('rounded-full border border-border px-2.5 py-1', range === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Burndown" aside={`${total} tasks · ${remaining} remaining`}>
          <Suspense fallback={<ChartFallback />}>
            <Charts.Burndown points={burn} />
          </Suspense>
          <p className="mt-2 text-xs text-muted-foreground">Open tasks at the end of each day, from created and completed dates. Scope added mid-project shows as a step up.</p>
        </Panel>
        <Panel title="Velocity" aside="Tasks done per week">
          <Suspense fallback={<ChartFallback />}>
            <Charts.Velocity weeks={weeks} />
          </Suspense>
          <p className="mt-2 text-xs text-muted-foreground">Average {averageVelocity(weeks)} a week. This week is still in progress, so its bar is lighter.</p>
        </Panel>
      </div>

      <Panel title="Cumulative flow" aside="Tasks in each status">
        <Suspense fallback={<ChartFallback />}>
          <Charts.StatusFlow points={statusFlow} />
        </Suspense>
        <StatusLegend counts={counts} />
        <p className="mt-2 text-xs text-muted-foreground">Built from recorded status changes. Tasks from before changes were recorded are placed from their created and updated dates.</p>
      </Panel>

      <div className="grid gap-4 md:grid-cols-3">
        <Panel title="Created vs completed">
          <Suspense fallback={<ChartFallback />}>
            <Charts.Flow points={flow} />
          </Suspense>
        </Panel>
        <Panel title="By status">
          <Suspense fallback={<ChartFallback />}>
            <Charts.Ring slices={counts} label={`${Math.round((100 * done) / total)}%`} />
          </Suspense>
          <StatusLegend counts={counts} />
        </Panel>
        <Panel title="Workload" aside="Open tasks">
          <WorkloadBars rows={rows} members={members} agents={agents} />
        </Panel>
      </div>
    </div>
  );
}

/** The workspace Dashboard: totals, portfolio, status, workload, deadlines, agents at work. */
export function WorkspaceDashboard({
  projects,
  tasks,
  members,
  agents,
  loading = false,
  onOpenProject,
}: {
  projects: Project[];
  tasks: Task[];
  members: WorkspaceMember[];
  agents: WorkspaceAgent[];
  /** True until the projects have loaded, so the empty message is not shown too early. */
  loading?: boolean;
  onOpenProject: (id: string) => void;
}) {
  const now = Date.now();
  const agentIds = useMemo(() => new Set(agents.map(agent => agent.id)), [agents]);
  const live = useMemo(() => projects.filter(project => !project.archived), [projects]);
  const liveIds = useMemo(() => new Set(live.map(project => project.id)), [live]);
  const scoped = useMemo(() => tasks.filter(task => task.project_id && liveIds.has(task.project_id)), [tasks, liveIds]);

  const totals = useMemo(() => workspaceTotals(scoped, agentIds, now), [scoped, agentIds, now]);
  const counts = useMemo(() => statusBreakdown(scoped), [scoped]);
  const rows = useMemo(() => workload(scoped, agentIds), [scoped, agentIds]);
  const atRisk = live.filter(project => project.status === 'at_risk').length;
  const working = scoped.filter(task => task.status === 'in_progress' && task.assignee_id && agentIds.has(task.assignee_id));

  const deadlines = useMemo(
    () =>
      scoped
        .filter(task => task.status !== 'done' && task.status !== 'cancelled' && task.due_date)
        .map(task => ({ task, due: new Date(task.due_date as string).getTime() }))
        .filter(item => item.due < now + 14 * DAY)
        .sort((a, b) => a.due - b.due)
        .slice(0, 5),
    [scoped, now],
  );
  const projectName = (id: string | null | undefined) => live.find(project => project.id === id)?.name ?? '';

  if (live.length === 0) {
    return (
      <div className="flex-1 p-4">
        <Empty>{loading ? 'Loading…' : 'The dashboard fills in once you have a project.'}</Empty>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="workspace-dashboard">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Active projects" value={live.filter(project => project.status !== 'completed').length} sub={atRisk ? `${atRisk} at risk` : 'none at risk'} />
        <Stat label="Open tasks" value={totals.openTasks} sub={`${totals.agentTasks} held by agents`} />
        <Stat label="Completed" value={totals.doneThisWeek} sub="this week" />
        <Stat label="Overdue" value={totals.overdue} sub="need attention" tone={totals.overdue ? 'bad' : undefined} />
        <Stat label="Agents working" value={working.length} sub="tasks in progress" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Projects" aside="Portfolio">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-2 font-medium">Project</th>
                <th className="py-1.5 pr-2 font-medium">Progress</th>
                <th className="py-1.5 pr-2 font-medium">Overdue</th>
                <th className="py-1.5 font-medium">Due</th>
              </tr>
            </thead>
            <tbody>
              {live.map(project => {
                const projectTasks = tasks.filter(task => task.project_id === project.id);
                const done = projectTasks.filter(task => task.status === 'done').length;
                const progress = projectTasks.length ? Math.round((100 * done) / projectTasks.length) : 0;
                const overdue = workspaceTotals(projectTasks, agentIds, now).overdue;
                return (
                  <tr key={project.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-2">
                      <button type="button" className="font-medium hover:underline" onClick={() => onOpenProject(project.id)}>
                        {project.name}
                      </button>
                      {project.status === 'at_risk' && <span className="ml-2 text-xs text-destructive">At risk</span>}
                    </td>
                    <td className="py-2 pr-2 text-xs text-muted-foreground">
                      <span className="mr-2 inline-block h-1.5 w-20 overflow-hidden rounded-full bg-muted align-middle">
                        <span className="block h-full bg-foreground/70" style={{ width: `${progress}%` }} />
                      </span>
                      {progress}%
                    </td>
                    <td className={cn('py-2 pr-2', overdue > 0 && 'text-destructive')}>{overdue}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {project.due_date ? new Date(project.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
        <Panel title="Tasks by status" aside="All projects">
          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
            {counts.map(slice => (
              <span key={slice.status} style={{ width: `${(100 * slice.count) / Math.max(scoped.length, 1)}%`, backgroundColor: STATUS_COLORS[slice.status] }} />
            ))}
          </div>
          <StatusLegend counts={counts} />
          <div className="my-3 border-t border-border" />
          <div className="mb-2 flex items-center text-sm font-semibold">
            Workload <span className="ml-auto text-xs font-normal text-muted-foreground">Open tasks</span>
          </div>
          <WorkloadBars rows={rows} members={members} agents={agents} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Upcoming deadlines" aside="Next 14 days">
          {deadlines.length === 0 ? (
            <Empty>Nothing due soon.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {deadlines.map(({ task, due }) => (
                <li key={task.id} className="flex items-center gap-2 py-2 text-sm">
                  <span className={cn('size-2 shrink-0 rounded-full', due < now ? 'bg-destructive' : 'bg-amber-500')} />
                  <span className="truncate">{task.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {projectName(task.project_id)} · {due < now ? `${Math.max(1, Math.round((now - due) / DAY))}d overdue` : new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Agents at work" aside="Live">
          {working.length === 0 ? (
            <Empty>No agent is working on a task right now.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {working.slice(0, 5).map(task => {
                const agent = agents.find(item => item.id === task.assignee_id);
                return (
                  <li key={task.id} className="flex items-center gap-2 py-2 text-sm">
                    <span className="shrink-0 rounded-full border border-violet-500/50 px-2 text-[0.6875rem] text-violet-500">{agent ? agentHandle(agent) : 'agent'}</span>
                    <span className="truncate">{task.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{projectName(task.project_id)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
