import type { AgentJobRow } from '../types';

/**
 * "Which sessions/threads have an agent working in them right now, and since
 * when" — the store behind the sidebar elapsed badge and the thread indicator's
 * working state.
 *
 * Two properties matter, and they are the whole reason this is a store and not
 * a piece of component state:
 *
 *  1. It publishes ONLY when the working SET changes (a job starts, finishes, or
 *     its anchor moves). It NEVER publishes on a clock edge — each entry carries
 *     a FIXED `anchorAt` (the job's started_at) and the counting up is done by
 *     one `useNow(1000)` inside the badge leaf. So a workspace with three agents
 *     working re-renders three <span>s a second, not three subscribers' subtrees.
 *  2. Snapshots are reference-stable: an unchanged entry keeps its object
 *     identity across recomputes, so a `useSyncExternalStore` reader for session
 *     A does not re-render when session B's job starts (React bails out on an
 *     `Object.is`-equal snapshot).
 *
 * Deliberately NOT wired to the shared minute clock (src/lib/sharedClock.ts):
 * that ticks every subscriber on one edge, which is the coupling that caused
 * this app's re-render-storm perf round.
 */

/** One key's live work. `anchorAt` is fixed for the life of the job. */
export interface AgentWork {
 /** Epoch ms the (oldest still-running) job started — the badge's clock anchor. */
 anchorAt: number;
 /** How many jobs are running against this key. */
 jobs: number;
 /**
  * The running job ids, sorted, so a Stop control can name exactly what it is
  * halting rather than asking the server to guess from a session id.
  *
  * SORTED, and rebuilt into the same array only when the membership is
  * unchanged — see `stabilize`. Realtime rows arrive in whatever order the
  * sockets deliver them, and an array that reordered itself would defeat the
  * reference stability this whole store exists for.
  */
 jobIds: readonly string[];
 /** The agent ids behind those jobs, same order, for labelling the control. */
 agentIds: readonly string[];
}

/**
 * The server's own hard ceiling on a running job is 30 minutes from started_at
 * (31 for farm jobs) — see reapStuckAgentJobs in server/index.cjs. Past that a
 * job cannot legitimately still be running, and the reaper's terminal write
 * (finalizeStuckJob) does NOT notify agent_jobs realtime subscribers, so no
 * finishing row is coming for it either. The badge therefore stops believing a
 * job older than this instead of counting up forever.
 */
export const MAX_WORKING_MS = 31 * 60_000;

/** How long a terminal job is remembered, so a slow initial fetch can't resurrect it. */
const TOMBSTONE_TTL_MS = 60_000;

interface JobRecord {
 /** false = tombstone: this job is known to be finished (see TOMBSTONE_TTL_MS). */
 working: boolean;
 sessionId: string;
 threadParentId: string | null;
 /** Whose job it is, so a Stop control can say which agent it will halt. */
 agentId: string;
 anchorAt: number;
 /** Epoch ms this record was written, used only by the fetch/realtime race guard. */
 appliedAt: number;
}

const EMPTY: ReadonlyMap<string, AgentWork> = new Map();

const jobs = new Map<string, JobRecord>();
let sessionWork: ReadonlyMap<string, AgentWork> = EMPTY;
let threadWork: ReadonlyMap<string, AgentWork> = EMPTY;
const listeners = new Set<() => void>();

function text(value: unknown): string {
 return typeof value === 'string' ? value.trim() : '';
}

function epochMs(value: unknown): number | null {
 if (typeof value === 'number' && Number.isFinite(value)) return value;
 const iso = text(value);
 if (!iso) return null;
 const ms = new Date(iso).getTime();
 return Number.isFinite(ms) ? ms : null;
}

function jobIdOf(row: Partial<AgentJobRow> | null | undefined): string {
 return row ? text(row.id) : '';
}

/**
 * Turn an agent_jobs row into a store record.
 *
 * A row is only "working" when the server says status='running' AND it carries a
 * parseable start timestamp: 'queued' means nobody has picked the turn up yet,
 * and an unparseable/missing anchor would mean inventing an elapsed time, which
 * is worse than showing nothing. Every code path that inserts a running job sets
 * started_at (or the claim sets it), so the fallback to created_at is belt-and-
 * braces rather than the normal case.
 */
function jobRecordOf(row: Partial<AgentJobRow> | null | undefined, appliedAt: number): JobRecord | null {
 if (!row) return null;
 const sessionId = text(row.session_id);
 const anchorAt = epochMs(row.started_at) ?? epochMs(row.created_at);
 const working = text(row.status) === 'running' && !!sessionId && anchorAt != null;
 const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {};
 return {
  working,
  sessionId,
  threadParentId: text(metadata.threadParentId) || null,
  agentId: text(row.agent_id),
  anchorAt: anchorAt ?? 0,
  appliedAt,
 };
}

function accumulate(
 map: Map<string, AgentWork>,
 key: string,
 anchorAt: number,
 jobId: string,
 agentId: string,
) {
 const existing = map.get(key);
 if (!existing) {
  map.set(key, { anchorAt, jobs: 1, jobIds: [jobId], agentIds: [agentId] });
  return;
 }
 // Oldest start wins: the badge answers "how long has work been going on here".
 map.set(key, {
  anchorAt: Math.min(existing.anchorAt, anchorAt),
  jobs: existing.jobs + 1,
  jobIds: [...existing.jobIds, jobId],
  agentIds: [...existing.agentIds, agentId],
 });
}

/** Same ids in the same order. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
 if (left.length !== right.length) return false;
 for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
 return true;
}

/** Order every entry's ids by job id, keeping each agent id paired with its job. */
function sortIds(map: Map<string, AgentWork>) {
 for (const [key, value] of map) {
  if (value.jobs < 2) continue;
  const pairs = value.jobIds
   .map((jobId, index) => ({ jobId, agentId: value.agentIds[index] ?? '' }))
   .sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
  map.set(key, {
   ...value,
   jobIds: pairs.map(pair => pair.jobId),
   agentIds: pairs.map(pair => pair.agentId),
  });
 }
}

/**
 * Keep the previous map (and the previous entry objects) wherever the derived
 * value is unchanged, so `Object.is` lets React skip both the whole-store
 * readers and the per-key readers whose own entry did not move.
 */
function stabilize(
 previous: ReadonlyMap<string, AgentWork>,
 next: Map<string, AgentWork>,
): ReadonlyMap<string, AgentWork> {
 let reused = 0;
 for (const [key, value] of next) {
  const before = previous.get(key);
  if (
   before
   && before.anchorAt === value.anchorAt
   && before.jobs === value.jobs
   // Membership too, not just the count: one job finishing as another starts
   // keeps `jobs` at 1 while the id a Stop control would send changes.
   && sameIds(before.jobIds, value.jobIds)
  ) {
   next.set(key, before);
   reused += 1;
  }
 }
 if (reused === next.size && next.size === previous.size) return previous;
 return next;
}

function publish(now: number) {
 const cutoff = now - TOMBSTONE_TTL_MS;
 const nextSession = new Map<string, AgentWork>();
 const nextThread = new Map<string, AgentWork>();
 for (const [id, record] of jobs) {
  if (!record.working) {
   if (record.appliedAt < cutoff) jobs.delete(id);
   continue;
  }
  accumulate(nextSession, record.sessionId, record.anchorAt, id, record.agentId);
  if (record.threadParentId) {
   accumulate(nextThread, record.threadParentId, record.anchorAt, id, record.agentId);
  }
 }
 // Sort AFTER accumulating, so the arrays do not depend on Map iteration order
 // (which follows whatever order realtime rows happened to arrive in). Without
 // this, two clients watching the same session hold differently-ordered arrays
 // and `stabilize` sees a change on every recompute.
 sortIds(nextSession);
 sortIds(nextThread);
 const stableSession = stabilize(sessionWork, nextSession);
 const stableThread = stabilize(threadWork, nextThread);
 const changed = stableSession !== sessionWork || stableThread !== threadWork;
 sessionWork = stableSession;
 threadWork = stableThread;
 if (!changed) return;
 for (const listener of Array.from(listeners)) listener();
}

/**
 * Apply one agent_jobs realtime row (or a row from the initial fetch).
 * Idempotent: re-applying an identical row does not notify.
 */
export function applyAgentJobRow(
 row: Partial<AgentJobRow> | null | undefined,
 eventType: string = 'UPDATE',
 now = Date.now(),
): void {
 const id = jobIdOf(row);
 if (!id) return;
 if (eventType === 'DELETE') {
  if (jobs.delete(id)) publish(now);
  return;
 }
 const record = jobRecordOf(row, now);
 if (!record) return;
 const previous = jobs.get(id);
 jobs.set(id, record);
 if (
  previous
  && previous.working === record.working
  && previous.sessionId === record.sessionId
  && previous.threadParentId === record.threadParentId
  && previous.anchorAt === record.anchorAt
 ) return; // nothing derived changed — don't wake subscribers
 publish(now);
}

/**
 * Replace the whole set from an initial fetch of running jobs.
 *
 * `keepAppliedSince` is the fetch's start time: any row that arrived over
 * realtime WHILE the fetch was in flight is newer than the fetch's view of the
 * world and survives it. Without that, a job that finished mid-fetch would be
 * resurrected by the older snapshot and its badge would never go away.
 */
export function resetAgentWork(
 rows: Array<Partial<AgentJobRow>> | null | undefined,
 keepAppliedSince?: number,
 now = Date.now(),
): void {
 const kept = new Map<string, JobRecord>();
 if (typeof keepAppliedSince === 'number') {
  for (const [id, record] of jobs) {
   if (record.appliedAt >= keepAppliedSince) kept.set(id, record);
  }
 }
 jobs.clear();
 for (const [id, record] of kept) jobs.set(id, record);
 for (const row of rows || []) {
  const id = jobIdOf(row);
  if (!id || jobs.has(id)) continue;
  const record = jobRecordOf(row, now);
  if (record) jobs.set(id, record);
 }
 publish(now);
}

/** Drop everything (workspace switch / feed unmount). */
export function clearAgentWork(): void {
 if (jobs.size === 0 && sessionWork === EMPTY && threadWork === EMPTY) return;
 jobs.clear();
 sessionWork = EMPTY;
 threadWork = EMPTY;
 for (const listener of Array.from(listeners)) listener();
}

export function subscribeToAgentWork(listener: () => void): () => void {
 listeners.add(listener);
 return () => {
  listeners.delete(listener);
 };
}

/** Reference-stable while unchanged — safe as a useSyncExternalStore snapshot. */
export function getSessionWork(sessionId: string | null | undefined): AgentWork | null {
 if (!sessionId) return null;
 return sessionWork.get(sessionId) || null;
}

/** Same, keyed by the thread's parent message id (agent_jobs.metadata.threadParentId). */
export function getThreadWork(parentMessageId: string | null | undefined): AgentWork | null {
 if (!parentMessageId) return null;
 return threadWork.get(parentMessageId) || null;
}

/** Whole-store snapshot (tests, and any future "N agents working" summary). */
export function agentWorkSnapshot(): {
 bySession: ReadonlyMap<string, AgentWork>;
 byThread: ReadonlyMap<string, AgentWork>;
} {
 return { bySession: sessionWork, byThread: threadWork };
}

/**
 * Elapsed as "5m 55s" — the sidebar badge's whole vocabulary. Seconds are shown
 * up to the hour mark (the point of the badge is that it visibly moves), then
 * dropped because an hour-old job's seconds are noise.
 */
export function formatElapsed(ms: number): string {
 const totalSeconds = Math.max(0, Math.floor(ms / 1000));
 const seconds = totalSeconds % 60;
 const minutes = Math.floor(totalSeconds / 60) % 60;
 const hours = Math.floor(totalSeconds / 3600);
 if (hours > 0) return `${hours}h ${minutes}m`;
 if (minutes > 0) return `${minutes}m ${seconds}s`;
 return `${seconds}s`;
}
