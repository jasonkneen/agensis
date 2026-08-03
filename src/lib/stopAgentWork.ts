import { apiAuthHeaders, apiUrl } from './backendClient';

// Stopping the agents working in one place.
//
// EVERY DECISION LIVES HERE and not in the button, because the frontend runner
// only sees tests/unit/**/*.test.ts — logic left in a `.tsx` component is
// untestable in this repo.
//
// WHY THIS TAKES JOB IDS AND NOT A SESSION ID. The server cancels ONE job,
// keyed by `agent_jobs.id`, because that is what every layer below it is keyed
// by: builtin-turn.cjs holds its AbortControllers per job id (a session/agent
// key would abort the wrong turn when an agent is working in two places), and
// the daemon's queue aborts per job id too. A session-scoped "stop everything
// here" is therefore a fan-out of single cancels, done in the client, rather
// than a second server primitive that would have to re-derive the same set.
//
// WHY THE ACTIVITY LINE COULD NOT DRIVE THIS. The "X is thinking…" line is
// derived from PLACEHOLDER MESSAGES, which carry no job id — there is nothing
// there to cancel. The `agent_jobs`-backed work store is the real source, so
// the Stop control is hung off that and merely rendered next to the line.

export interface StopWorkResult {
  /** How many jobs the server moved to 'cancelled' on this call. */
  stopped: number;
  /** How many were already terminal — a no-op, and NOT a failure. */
  alreadyDone: number;
  /** How many could not be stopped (network, permission, 5xx). */
  failed: number;
}

interface CancelResponse {
  data?: { stopped?: boolean } | null;
}

async function cancelOne(jobId: string): Promise<'stopped' | 'already-done' | 'failed'> {
  try {
    const response = await fetch(
      apiUrl(`/backend/agent-jobs/${encodeURIComponent(jobId)}/cancel`),
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() } },
    );
    if (!response.ok) return 'failed';
    const body = await response.json().catch(() => null) as CancelResponse | null;
    // The route is idempotent: a job that was already finished answers 200 with
    // stopped:false. That is not an error and must not be reported as one — the
    // button is pressed precisely when you cannot tell if anything is still
    // running, and a turn that ended a moment ago is the success case.
    return body?.data?.stopped ? 'stopped' : 'already-done';
  } catch {
    return 'failed';
  }
}

/**
 * Stop every job in the list, concurrently.
 *
 * Concurrent and not sequential because these are independent turns and the
 * user asked for all of them to end NOW; serialising would leave the last agent
 * running for as long as the first three take to answer. Nothing rejects — the
 * per-job outcome is counted, so one dead socket cannot swallow the rest.
 */
export async function stopAgentWork(jobIds: readonly string[]): Promise<StopWorkResult> {
  const ids = [...new Set(jobIds.map(id => String(id || '').trim()).filter(Boolean))];
  const result: StopWorkResult = { stopped: 0, alreadyDone: 0, failed: 0 };
  if (ids.length === 0) return result;
  const outcomes = await Promise.all(ids.map(cancelOne));
  for (const outcome of outcomes) {
    if (outcome === 'stopped') result.stopped += 1;
    else if (outcome === 'already-done') result.alreadyDone += 1;
    else result.failed += 1;
  }
  return result;
}

/**
 * The button's label and title.
 *
 * Named, when there is exactly one agent and we know who it is: "Stop Coder"
 * answers "will this stop the right thing" without a hover. Past one it becomes
 * a count, because a list of four names in a status line is unreadable.
 */
export function stopLabel(agentNames: readonly (string | null)[]): { label: string; title: string } {
  const named = agentNames.map(name => (name || '').trim()).filter(Boolean);
  if (named.length === 1) {
    return { label: 'Stop', title: `Stop ${named[0]} — end this turn now` };
  }
  const count = agentNames.length;
  if (count <= 1) return { label: 'Stop', title: 'Stop this agent — end this turn now' };
  return { label: `Stop all (${count})`, title: `Stop all ${count} agents working here` };
}

/**
 * What to tell the user afterwards. Empty string means "say nothing" — the
 * badge and the activity line vanishing IS the confirmation, and a toast on top
 * of that is noise.
 */
export function stopOutcomeMessage(result: StopWorkResult): string {
  if (result.failed > 0) {
    const total = result.failed + result.stopped + result.alreadyDone;
    return result.failed === total
      ? 'Could not stop the agent. Nothing was changed.'
      : `Stopped ${result.stopped}, but ${result.failed} could not be stopped.`;
  }
  if (result.stopped === 0 && result.alreadyDone > 0) return 'That turn had already finished.';
  return '';
}
