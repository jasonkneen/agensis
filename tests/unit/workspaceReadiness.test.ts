import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_LOADING_REASON,
  WORKSPACE_PREPARING_REASON,
  describeWorkspaceReadiness,
  workspaceSetupFailedReason,
  type WorkspaceReadinessInput,
} from '../../src/lib/workspaceReadiness';
import { WORKSPACE_UNAVAILABLE, classifyWriteFailure } from '../../src/lib/writeFeedback';

// The first thing a new account does, decided without a browser.
//
// The bug this replaces: sign-up minted the session (rendering the app) and
// seeded the starter workspaces concurrently, so the workspace fetch returned
// an empty list, cached it, and nothing refetched. The onboarding tour's "Add"
// buttons stayed enabled against a null workspace id for the whole session —
// every click failed with no request sent, and waiting never helped.
//
// So the cases that matter are the ones where "not ready" must be distinguished
// from "broken": still loading and mid-setup both have to keep the buttons
// disabled WITHOUT claiming anything failed, and a genuine setup failure has to
// say what went wrong instead of sitting silently at zero workspaces forever.

function input(overrides: Partial<WorkspaceReadinessInput> = {}): WorkspaceReadinessInput {
  return {
    loading: false,
    workspaceCount: 0,
    repairing: false,
    repairFailure: null,
    ...overrides,
  };
}

describe('describeWorkspaceReadiness', () => {
  it('is not ready while the workspace list is still loading', () => {
    const readiness = describeWorkspaceReadiness(input({ loading: true }));
    expect(readiness.status).toBe('loading');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe(WORKSPACE_LOADING_REASON);
  });

  it('does not seed while the list is still in flight', () => {
    // Seeding off an empty-because-unfinished fetch is exactly how the account
    // ended up with a duplicate set of starter workspaces.
    expect(describeWorkspaceReadiness(input({ loading: true })).shouldRepair).toBe(false);
  });

  it('asks for a workspace to be created once the list settles empty', () => {
    const readiness = describeWorkspaceReadiness(input({ loading: false, workspaceCount: 0 }));
    expect(readiness.status).toBe('missing');
    expect(readiness.ready).toBe(false);
    expect(readiness.shouldRepair).toBe(true);
  });

  it('is ready as soon as one workspace is known', () => {
    const readiness = describeWorkspaceReadiness(input({ workspaceCount: 1 }));
    expect(readiness.status).toBe('ready');
    expect(readiness.ready).toBe(true);
    expect(readiness.reason).toBeNull();
    expect(readiness.shouldRepair).toBe(false);
  });

  it('stays ready while a background refetch is in flight', () => {
    // A cached list is still a usable list; disabling the controls during a
    // refresh would be a second, smaller version of the same lie.
    const readiness = describeWorkspaceReadiness(input({ loading: true, workspaceCount: 2 }));
    expect(readiness.status).toBe('ready');
    expect(readiness.ready).toBe(true);
  });

  it('reports the wait, not a failure, while setup is running', () => {
    const readiness = describeWorkspaceReadiness(input({ repairing: true }));
    expect(readiness.status).toBe('preparing');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe(WORKSPACE_PREPARING_REASON);
    expect(readiness.shouldRepair).toBe(false);
  });

  it('does not re-seed on every render while the insert is in flight', () => {
    expect(describeWorkspaceReadiness(input({ repairing: true })).shouldRepair).toBe(false);
  });

  describe('when seeding failed', () => {
    const rejected = classifyWriteFailure(
      { message: 'You cannot create a workspace for another user', status: 403 },
      { online: true },
    );

    it('names the failure instead of leaving the user at zero workspaces silently', () => {
      const readiness = describeWorkspaceReadiness(input({ repairFailure: rejected }));
      expect(readiness.status).toBe('unavailable');
      expect(readiness.ready).toBe(false);
      expect(readiness.reason).toContain(rejected.reason);
    });

    it('does not retry automatically', () => {
      // An auto-retry off a render-derived flag is an infinite request loop.
      expect(describeWorkspaceReadiness(input({ repairFailure: rejected })).shouldRepair).toBe(false);
    });

    it('offers a retry only when repeating the write could plausibly work', () => {
      const transient = classifyWriteFailure({ message: 'Failed to fetch' }, { online: true });
      expect(transient.retryable).toBe(true);
      expect(describeWorkspaceReadiness(input({ repairFailure: transient })).canRetry).toBe(true);
      expect(rejected.retryable).toBe(false);
      expect(describeWorkspaceReadiness(input({ repairFailure: rejected })).canRetry).toBe(false);
    });

    it('is superseded by a workspace arriving from anywhere else', () => {
      const readiness = describeWorkspaceReadiness(input({ repairFailure: rejected, workspaceCount: 1 }));
      expect(readiness.status).toBe('ready');
      expect(readiness.ready).toBe(true);
    });
  });
});

describe('workspaceSetupFailedReason', () => {
  it('carries the underlying reason so the user is not told to just try later', () => {
    const failure = classifyWriteFailure({ message: 'Rate limit exceeded' }, { online: true });
    expect(workspaceSetupFailedReason(failure)).toContain(failure.reason);
  });

  it('still says something specific when there is no underlying reason', () => {
    expect(workspaceSetupFailedReason(null)).toMatch(/setting up your workspace/i);
  });

  it('never renders the bare generic sentence the tour used to show', () => {
    expect(workspaceSetupFailedReason(WORKSPACE_UNAVAILABLE)).not.toMatch(/create it later from the Agents window/i);
  });
});
