import type { Task } from '../../types';

// ---------------------------------------------------------------------------
// Task scheduling model shared by the task editor and the Gantt timeline.
//
// Four things live here because they must agree, and because they are the only
// parts of the task window worth unit-testing without a DOM:
//   1. date <-> <input type="date"> conversion (local-midnight round-trip),
//   2. the dependency graph (candidate filtering + cycle rejection),
//   3. the span each row draws (a real range, a parent rollup, or the
//      single-day marker an undated task falls back to),
//   4. what a focus request ("scroll me to task X") is allowed to do to the
//      filters the user set by hand.
// ---------------------------------------------------------------------------

export const DAY_MS = 86400000;

// Timeline days are LOCAL days: the axis, the bars and the date inputs all
// snap to local midnight so a bar never lands a day off for a user east/west
// of UTC.
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayFromIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return startOfDay(ms);
}

/** ISO timestamp -> `yyyy-mm-dd` for `<input type="date">`, in LOCAL time. */
export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `yyyy-mm-dd` from a date input -> an ISO timestamp at LOCAL midnight, so
 * toDateInputValue(fromDateInputValue(v)) === v. Building the Date from
 * `new Date(value)` instead would parse as UTC and shift the day for anyone
 * behind UTC. Returns null for an empty/garbage value (i.e. "clear the date").
 */
export function fromDateInputValue(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (!Number.isFinite(d.getTime())) return null;
  // Reject a rolled-over date (2026-02-31 -> Mar 3) rather than silently
  // storing a day the user did not pick.
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d.toISOString();
}

// Reads happen against a mix of shapes: the backend returns a JS string[]
// (postgres.js parses uuid[]), but an offline/cached row or a raw PG array
// literal could surface as a string. Normalize every read so counts, Set math,
// and .includes() never operate on characters of a string.
export function taskDependsOn(task: Pick<Task, 'depends_on'>): string[] {
  const raw = task.depends_on as unknown;
  if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (typeof raw === 'string') {
    return raw.replace(/^\{|\}$/g, '').split(',').map(id => id.replace(/^"|"$/g, '').trim()).filter(Boolean);
  }
  return [];
}

type GraphTask = Pick<Task, 'id' | 'depends_on'>;

/**
 * Every task that transitively depends on `taskId`. Adding any of them as a
 * dependency OF `taskId` would close a loop, which would hang a topological
 * layout — so this set is exactly what the picker must exclude.
 *
 * Fixed-point iteration rather than DFS: it terminates even if the stored graph
 * ALREADY contains a cycle (written by an older path), because the frontier
 * only ever grows.
 */
export function collectDependents(taskId: string, tasks: GraphTask[]): Set<string> {
  const dependents = new Set<string>();
  const depsOf = new Map<string, string[]>();
  for (const task of tasks) depsOf.set(task.id, taskDependsOn(task));
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      if (dependents.has(task.id)) continue;
      const deps = depsOf.get(task.id) || [];
      if (deps.some(id => id === taskId || dependents.has(id))) {
        dependents.add(task.id);
        grew = true;
      }
    }
  }
  return dependents;
}

/** Would `taskId` depending on `candidateId` create a cycle (self included)? */
export function dependencyWouldCycle(taskId: string, candidateId: string, tasks: GraphTask[]): boolean {
  if (taskId === candidateId) return true;
  return collectDependents(taskId, tasks).has(candidateId);
}

/** Tasks that may legally be added to `task.depends_on`. */
export function dependencyCandidates<T extends GraphTask>(task: GraphTask, tasks: T[]): T[] {
  const blocked = collectDependents(task.id, tasks);
  return tasks.filter(candidate => candidate.id !== task.id && !blocked.has(candidate.id));
}

// --- Timeline spans ---------------------------------------------------------

export type TaskSpanKind =
  /** The task carries at least one real date — a genuine range. */
  | 'span'
  /** A parent whose bar is rolled up from its children (summary bar). */
  | 'rollup'
  /** No dates anywhere in its subtree — a single-day marker at created_at. */
  | 'point';

export interface TaskSpan {
  /** Inclusive local-midnight start of the first day the bar covers. */
  startMs: number;
  /** EXCLUSIVE end boundary: bar width in days is (endMs - startMs) / DAY_MS. */
  endMs: number;
  kind: TaskSpanKind;
}

/**
 * The days a task's own dates cover, or null when it has none.
 *
 * `endMs` is exclusive so a task that starts and is due the SAME day still
 * draws one day wide (the old code returned a zero-width range and leaned on a
 * min-width clamp, which is why every bar looked identical). A task with only
 * one of the two dates is a one-day span on that date.
 */
function ownDates(task: Task): { startMs: number; endMs: number } | null {
  const startDay = dayFromIso(task.start_date);
  const dueDay = dayFromIso(task.due_date);
  if (startDay === null && dueDay === null) return null;
  const startMs = startDay ?? (dueDay as number);
  const endMs = Math.max(startMs, dueDay ?? startMs) + DAY_MS;
  return { startMs, endMs };
}

function createdDay(task: Task): number {
  return dayFromIso(task.created_at) ?? startOfDay(Date.now());
}

function childrenByParent(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parent_id) continue;
    const list = map.get(task.parent_id);
    if (list) list.push(task);
    else map.set(task.parent_id, [task]);
  }
  return map;
}

/** The single-day fallback marker — deliberately NOT a range. */
function pointSpan(task: Task): TaskSpan {
  const day = createdDay(task);
  return { startMs: day, endMs: day + DAY_MS, kind: 'point' };
}

/**
 * Resolve the drawn span of every task, rolling parents up over their
 * descendants. Pass ALL tasks (not just the visible rows) so a child whose
 * parent is filtered out still contributes.
 *
 * A parent that has scheduled descendants is a 'rollup' even when it carries
 * its own dates: the bar is the union, so it always spans its children.
 */
export function buildTaskSpans(tasks: Task[]): Map<string, TaskSpan> {
  const childrenOf = childrenByParent(tasks);
  const spans = new Map<string, TaskSpan>();
  // parent_id cycles are rejected on write, but a corrupt row must not recurse
  // forever — a task already on the stack resolves from its own dates only.
  const resolving = new Set<string>();

  const resolve = (task: Task): TaskSpan => {
    const cached = spans.get(task.id);
    if (cached) return cached;
    if (resolving.has(task.id)) {
      const own = ownDates(task);
      return own ? { ...own, kind: 'span' } : pointSpan(task);
    }
    resolving.add(task.id);

    const own = ownDates(task);
    let startMs = own?.startMs ?? null;
    let endMs = own?.endMs ?? null;
    let rolled = false;
    for (const child of childrenOf.get(task.id) || []) {
      const childSpan = resolve(child);
      // An undated child has no real span; it must not drag the parent's bar
      // back to its created_at marker.
      if (childSpan.kind === 'point') continue;
      rolled = true;
      startMs = startMs === null ? childSpan.startMs : Math.min(startMs, childSpan.startMs);
      endMs = endMs === null ? childSpan.endMs : Math.max(endMs, childSpan.endMs);
    }
    resolving.delete(task.id);

    const span: TaskSpan = startMs === null || endMs === null
      ? pointSpan(task)
      : { startMs, endMs, kind: rolled ? 'rollup' : 'span' };
    spans.set(task.id, span);
    return span;
  };

  for (const task of tasks) resolve(task);
  return spans;
}

export interface GanttRow {
  task: Task;
  /** Indent level; 0 for a top-level task. */
  depth: number;
  hasChildren: boolean;
}

/**
 * Flatten `topLevel` (already status/assignment-filtered) into timeline rows
 * with their descendants inlined underneath, so a parent's rollup bar sits
 * directly above the children it spans.
 */
export function buildGanttRows(topLevel: Task[], allTasks: Task[], maxDepth = 8): GanttRow[] {
  const childrenOf = childrenByParent(allTasks);
  const rows: GanttRow[] = [];
  const seen = new Set<string>();

  const walk = (task: Task, depth: number) => {
    if (seen.has(task.id) || depth > maxDepth) return;
    seen.add(task.id);
    const children = childrenOf.get(task.id) || [];
    rows.push({ task, depth, hasChildren: children.length > 0 });
    for (const child of children) walk(child, depth + 1);
  };

  for (const task of topLevel) walk(task, 0);
  return rows;
}

/**
 * A drag commits a due_date, which is INCLUSIVE — the last day the bar covers.
 * Spans carry an exclusive end, so always convert through here.
 */
export function dueDateFromExclusiveEnd(endMs: number): string {
  return new Date(endMs - DAY_MS).toISOString();
}

// --- Timeline labels --------------------------------------------------------

/**
 * Rough advance width of one character of a timeline label, in px.
 *
 * Deliberately an OVER-estimate of Inter at the label's size: guessing too wide
 * moves a label that would have just fitted to the outside of its bar, which
 * costs nothing, while guessing too narrow puts it inside and truncates it —
 * and a truncated title is the thing this view was reported for.
 */
export const GANTT_LABEL_CHAR_WIDTH = 7.4;
/** Horizontal padding inside a bar, plus the width of the resize handle. */
const GANTT_INSIDE_LABEL_CHROME = 26;
/** The `↳` glyph shown on a nested row. */
const GANTT_DEPTH_GLYPH_WIDTH = 18;
/**
 * Floor on the bar width that may hold a label at all. Without it an empty or
 * one-character title would "fit" a two-day bar on arithmetic alone and render
 * as a sliver of text wedged against the resize handle.
 */
const GANTT_INSIDE_LABEL_MIN = 68;

/**
 * Can a bar this wide hold the whole title, or does the title have to sit
 * beside it?
 *
 * A bar's width is its DATES — it cannot be grown to fit text. So the only two
 * honest options are "the bar contains the title" and "the title sits next to
 * the bar", and this is the single rule that picks between them for every row.
 * Estimating from character count rather than measuring keeps the decision
 * pure, testable and identical on every render.
 */
export function labelFitsInsideBar(title: string, barWidth: number, depth = 0): boolean {
  const text = String(title || '').trim();
  if (!text || barWidth < GANTT_INSIDE_LABEL_MIN) return false;
  const needed = text.length * GANTT_LABEL_CHAR_WIDTH
    + GANTT_INSIDE_LABEL_CHROME
    + (depth > 0 ? GANTT_DEPTH_GLYPH_WIDTH : 0);
  return barWidth >= needed;
}

// --- Filters ----------------------------------------------------------------

/**
 * "Done" in the toolbar means CLOSED — done OR cancelled.
 *
 * The open-count badge has always treated the two together, so hiding one and
 * not the other leaves a lone "Cancelled" section on screen after the click and
 * reads as a toggle that half-worked.
 */
export function isClosedTask(task: Pick<Task, 'status'>): boolean {
  return task.status === 'done' || task.status === 'cancelled';
}

/** Drop closed tasks when the toolbar toggle is on. Identity when it is off. */
export function applyHideDone<T extends Pick<Task, 'status'>>(tasks: T[], hideDone: boolean): T[] {
  return hideDone ? tasks.filter(task => !isClosedTask(task)) : tasks;
}

/**
 * THE definition of "N open tasks", for every surface that shows that number.
 *
 * Top-level ONLY. A subtask is not a row in the Tasks window — it lives inside
 * its parent's expanded detail — so counting subtasks produced a sidebar badge
 * that promised more work than the list could show. Reported as "why is tasks
 * showing 3? click and nothing to see": in production one workspace had 5 open
 * tasks but 3 top-level, another 4 open but 1 top-level. A badge you cannot
 * reconcile with the screen is worse than no badge.
 *
 * "Open" is the complement of `isClosedTask` — not-done AND not-cancelled — so
 * the toolbar's "Hide done" toggle provably cannot change this number: it only
 * removes closed tasks, and none are counted here. That is why the sidebar
 * badge does not need to read that preference to agree with the window.
 *
 * What it deliberately does NOT apply is the window's assignment filter
 * (all / mine / others). See the call site in App.tsx.
 */
export function countOpenTasks<T extends Pick<Task, 'status' | 'parent_id'>>(tasks: T[]): number {
  return tasks.filter(task => !task.parent_id && !isClosedTask(task)).length;
}

// --- Focus requests ---------------------------------------------------------

export type TaskAssignmentFilter = 'all' | 'mine' | 'others';

export interface TaskFocusFilters {
  filter: TaskAssignmentFilter;
  hideDone: boolean;
}

/** Nothing is hidden at these settings, so widening past them is impossible. */
export const WIDEST_TASK_FILTERS: TaskFocusFilters = { filter: 'all', hideDone: false };

export type TaskFocusAction =
  /** No request pending — forget whatever was last handled. */
  | { kind: 'reset' }
  /** Already handled this request: leave the filters, and the DOM, alone. */
  | { kind: 'idle' }
  /** The row is hidden by a filter — relax them, then re-decide. */
  | { kind: 'widen'; next: TaskFocusFilters }
  /** The row is on screen: scroll to it (best effort) and consume. */
  | { kind: 'reveal' }
  /** The row cannot be shown at all. Consume anyway — see below. */
  | { kind: 'consume' };

/**
 * Decide what a pending "focus task X" request may do.
 *
 * Two rules, both learned from a bug where "Hide done" looked dead:
 *
 *  1. **Widen at most once per request.** The caller re-runs this on every
 *     filter change, so an unbounded rule would fight the user: click
 *     "Hide done" while a done task is focused, the row leaves the list, and
 *     the effect turns the toggle straight back off. `handledFocusId` marks a
 *     request as spent, and a spent request never touches the filters again —
 *     from then on the user's own choices win.
 *
 *  2. **Always reach a terminal action.** Both `reveal` and `consume` tell the
 *     caller to clear the request. Bailing out without consuming is what let a
 *     stale focus id hold the filters hostage indefinitely — and in the Board /
 *     Timeline views there is no `task-row-<id>` element to scroll to at all,
 *     so that path was guaranteed there. A missed smooth-scroll is a far
 *     smaller failure than a toolbar button that does nothing.
 */
export function resolveTaskFocus(input: {
  /** The row that should come into view, if any. */
  focusRowId?: string | null;
  /** The last request this caller took a terminal action on. */
  handledFocusId?: string | null;
  /** Is `focusRowId` in the currently-rendered, filtered list? */
  isVisible: boolean;
  filters: TaskFocusFilters;
}): TaskFocusAction {
  const { focusRowId, handledFocusId, isVisible, filters } = input;
  if (!focusRowId) return { kind: 'reset' };
  if (focusRowId === handledFocusId) return { kind: 'idle' };
  if (isVisible) return { kind: 'reveal' };
  const alreadyWidest = filters.filter === WIDEST_TASK_FILTERS.filter
    && filters.hideDone === WIDEST_TASK_FILTERS.hideDone;
  return alreadyWidest ? { kind: 'consume' } : { kind: 'widen', next: WIDEST_TASK_FILTERS };
}
