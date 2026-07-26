// Can a workspace-scoped write succeed yet, and if not, what do we tell the user?
//
// This exists because of the first thing a new account ever does. Sign-up used
// to mint the session (which renders the app) and only THEN seed the two
// starter workspaces — so `GET /backend/workspaces` raced the seeding INSERT and
// reliably lost, the client cached an empty list, and nothing ever refetched it.
// The workspace id stayed null for the whole session while the onboarding tour's
// "Add" buttons sat there looking perfectly clickable. Every click returned
// `WORKSPACE_UNAVAILABLE` without a request leaving the browser, and waiting did
// not help: only a page reload did.
//
// So the fix is two-sided, and this module is the half worth testing on its own:
// given what the client knows about the workspace list, decide whether a control
// may be enabled, whether a missing workspace should be created now, and which
// sentence explains the wait. No React, no DOM, no fetch — the sequencing bug
// above was invisible precisely because it only ever showed up as a rendered
// button, and this decision should be checkable without one.

import type { WriteFailure } from './writeFeedback';

export type WorkspaceReadinessStatus =
  /** The workspace list request is still in flight. */
  | 'loading'
  /** The list settled and the user has none — one has to be created. */
  | 'missing'
  /** Creating the missing workspace right now. */
  | 'preparing'
  /** At least one workspace is known; writes can go ahead. */
  | 'ready'
  /** Creating it was attempted and failed. */
  | 'unavailable';

export interface WorkspaceReadinessInput {
  /** True while the workspace list request is in flight. */
  loading: boolean;
  /** How many workspaces the client currently knows about. */
  workspaceCount: number;
  /** True while a create-the-missing-workspace attempt is running. */
  repairing: boolean;
  /** How the last create attempt failed, or null if none has. */
  repairFailure: WriteFailure | null;
}

export interface WorkspaceReadiness {
  status: WorkspaceReadinessStatus;
  /** Whether a workspace-scoped write can succeed right now. */
  ready: boolean;
  /** One plain explanation for a disabled control. Null when ready. */
  reason: string | null;
  /** Whether the caller should start creating the missing workspace now. */
  shouldRepair: boolean;
  /** Whether offering the user a "try again" is worth anything. */
  canRetry: boolean;
}

export const WORKSPACE_LOADING_REASON = 'Loading your workspace…';
export const WORKSPACE_PREPARING_REASON = 'Setting up your workspace — this only takes a moment.';

/** Names the failure rather than hiding it behind "try later". */
export function workspaceSetupFailedReason(failure: WriteFailure | null): string {
  const detail = failure?.reason?.trim();
  return detail
    ? `We couldn't finish setting up your workspace. ${detail}`
    : "We couldn't finish setting up your workspace.";
}

/**
 * Order matters. A known workspace wins over everything — a list that is being
 * refreshed in the background is still usable, and disabling controls during a
 * refetch would be its own small lie. Only after that does an in-flight fetch,
 * an in-flight repair, and a failed repair each get their own answer, so
 * "still working on it" is never rendered as "this is broken".
 */
export function describeWorkspaceReadiness(input: WorkspaceReadinessInput): WorkspaceReadiness {
  if (input.workspaceCount > 0) {
    return { status: 'ready', ready: true, reason: null, shouldRepair: false, canRetry: false };
  }
  if (input.loading) {
    return { status: 'loading', ready: false, reason: WORKSPACE_LOADING_REASON, shouldRepair: false, canRetry: false };
  }
  if (input.repairing) {
    return { status: 'preparing', ready: false, reason: WORKSPACE_PREPARING_REASON, shouldRepair: false, canRetry: false };
  }
  if (input.repairFailure) {
    return {
      status: 'unavailable',
      ready: false,
      reason: workspaceSetupFailedReason(input.repairFailure),
      // Never auto-loop: a repair that just failed gets retried when the user
      // asks, not on every render.
      shouldRepair: false,
      canRetry: input.repairFailure.retryable,
    };
  }
  return { status: 'missing', ready: false, reason: WORKSPACE_PREPARING_REASON, shouldRepair: true, canRetry: false };
}
