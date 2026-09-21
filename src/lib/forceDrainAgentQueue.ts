import { apiAuthHeaders, apiUrl } from './backendClient';

// Force-draining one agent's queues.
//
// EVERY DECISION LIVES HERE and not in the button, because the frontend runner
// only sees tests/unit/**/*.test.ts — logic left in a `.tsx` component is
// untestable in this repo.
//
// WHY THIS TAKES A WORKSPACE ID AND AGENT ID, NOT A JOB ID. The server route
// drains a (workspace, agent) pair: every task assigned to the agent AND every
// parked chat turn for that agent. A job-scoped drain would only solve half
// the problem — a wedged task queue with no active job, or a parked chat turn
// that no daemon has picked up — and the user's actual symptom ("agents
// finish a job and don't move to the next") is exactly the case where neither
// a job-id nor an active row exists.
//
// WHY THIS RETURNS A RESULT OBJECT, NOT A BOOLEAN. The route distinguishes
// "dispatched a task" from "found parked chat turns" — an operator who hit
// the button wants to see both numbers, because the answer to "did anything
// happen?" depends on which was non-zero. A boolean would lose that.
//
// WHY THE BUTTON TEXT SAYS "Force drain", NOT "Resume". A drain is not a
// resume; it is an operator override that bypasses the in-process debounce and
// the 30s reaper tick. Calling it "Resume" would suggest the system was
// pausing for a reason the user should know about, which is the opposite of
// what an override means.

export type ForceDrainKind = 'all' | 'tasks' | 'chat';

export interface ForceDrainResult {
  /** Which queue was forced: 'all' (default), 'tasks', or 'chat'. */
  kind: ForceDrainKind;
  /** True when the drain actually dispatched a new task. */
  dispatchedTask: boolean;
  /** The dispatched task's id, if any. */
  dispatchedTaskId: string | null;
  /** Number of parked chat turns the drain found BEFORE the call. */
  foundParkedChat: number;
  /** The drain's own verdict — 'dispatched', 'empty', 'busy', etc. */
  drainReason: string | null;
}

export interface QueueStatusResult {
  workspaceId: string;
  agentId: string;
  tasks: { total: number; todo: number; inProgress: number };
  chat: { parked: number; oldestParkedAt: string | null };
  activeJob: {
   id: string;
   status: string;
   startedAt: string | null;
   finishedAt: string | null;
  } | null;
  lastDrain: {
   at: string;
   actorUserId: string | null;
   kind: ForceDrainKind | null;
   dispatchedTask: boolean;
   dispatchedTaskId: string | null;
   foundParkedChat: number;
   drainReason: string | null;
  } | null;
}

interface DrainResponse {
  data?: ForceDrainResult | null;
  error?: { message?: string } | null;
}

interface StatusResponse {
  data?: QueueStatusResult | null;
  error?: { message?: string } | null;
}

export interface DrainOutcome {
  /** Whether the call reached the server and the route answered. */
  ok: boolean;
  /** The decoded result, if the call succeeded. */
  result?: ForceDrainResult;
  /** The error message, if the call failed (network, 4xx, 5xx). */
  error?: string;
}

/**
 * Force-drain an agent's queues now.
 *
 * Returns a structured outcome so the UI can say "dispatched X" / "found Y
 * parked" / "queue empty" — three distinct user-visible results, three
 * distinct buttons the operator can press next. Never rejects: an HTTP 4xx
 * becomes a structured error so the button stays interactive.
 */
export async function forceDrainAgentQueue(
  workspaceId: string,
  agentId: string,
  kind: ForceDrainKind = 'all',
): Promise<DrainOutcome> {
  try {
    const response = await fetch(
      apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/queue/drain`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ kind }),
      },
    );
    const body = await response.json().catch(() => null) as DrainResponse | null;
    if (!response.ok) {
      return { ok: false, error: body?.error?.message || `Force drain failed (HTTP ${response.status})` };
    }
    return { ok: true, result: body?.data ?? undefined };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface StatusOutcome {
  ok: boolean;
  result?: QueueStatusResult;
  error?: string;
}

export async function getAgentQueueStatus(
  workspaceId: string,
  agentId: string,
): Promise<StatusOutcome> {
  try {
    const response = await fetch(
      apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/queue/status`),
      { method: 'GET', headers: apiAuthHeaders() },
    );
    const body = await response.json().catch(() => null) as StatusResponse | null;
    if (!response.ok) {
      return { ok: false, error: body?.error?.message || `Queue status failed (HTTP ${response.status})` };
    }
    return { ok: true, result: body?.data ?? undefined };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What to tell the operator after a force-drain attempt. Empty string means
 * "say nothing" — a successful drain does not need confirmation UI on top of
 * the queue count refresh that follows.
 *
 * Distinct cases the operator cares about:
 *   - dispatched a task: "drained · dispatched task t-2"
 *   - found N parked chat turns: "drained · N parked chat turn(s)"
 *   - both: "drained · dispatched task t-2, N parked chat turn(s)"
 *   - queue empty: "queue empty, nothing to drain"
 *   - server said "busy": "agent is mid-turn, drain held off"
 */
export function forceDrainMessage(result: ForceDrainResult): string {
  const parts: string[] = [];
  if (result.dispatchedTask) parts.push(`dispatched task ${result.dispatchedTaskId}`);
  if (result.foundParkedChat > 0) parts.push(`${result.foundParkedChat} parked chat turn${result.foundParkedChat === 1 ? '' : 's'}`);
  if (parts.length > 0) return `Drained · ${parts.join(', ')}`;
  if (result.drainReason === 'busy') return 'Agent is mid-turn, drain held off';
  if (result.drainReason === 'empty') return 'Queue empty, nothing to drain';
  return 'Drain ran · no work to dispatch';
}