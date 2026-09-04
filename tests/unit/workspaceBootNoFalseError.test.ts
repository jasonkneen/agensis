// @vitest-environment jsdom
//
// The boot sequence that renders "We couldn't load your workspaces" over an
// account whose workspaces are fine.
//
// useWorkspaces(userId) starts with loading=true, but its fetch effect returns
// early — `setLoading(false)`, no request — whenever userId is undefined. On a
// cold load that is the normal state for the first render pass: useAuth
// restores the session asynchronously, so `user` is undefined until getSession
// resolves. The hook therefore settles into loading=false, workspaceCount=0,
// fetchConfirmedEmpty=false, which describeWorkspaceReadiness reads as
// 'unavailable' — the connection-error branch — even though no request was ever
// attempted and nothing failed.
//
// App gates the whole tree on authLoading, so this is only visible where a
// component renders the rail's error before auth settles, or where userId
// arrives late enough that the error paints first. Either way the fix is that
// "no user yet" is not a failed fetch.
import { describe, expect, it } from 'vitest';
import { describeWorkspaceReadiness } from '../../src/lib/workspaceReadiness';

describe('workspace readiness during boot', () => {
  it('does not report a connection failure before a user id exists', () => {
    // Exactly the state useWorkspaces holds after its effect early-returns for
    // an undefined userId: not loading, no workspaces, no confirmed-empty
    // fetch, no repair attempted.
    const readiness = describeWorkspaceReadiness({
      loading: false,
      workspaceCount: 0,
      repairing: false,
      repairFailure: null,
      fetchConfirmedEmpty: false,
      identityKnown: false,
    });

    expect(readiness.status).not.toBe('unavailable');
    expect(readiness.reason).not.toMatch(/connection problem/);
  });

  it('still reports a real failure once a user id is known', () => {
    // Same shape, but identity resolved: a settled fetch that neither confirmed
    // empty nor returned rows IS the transient-error case the message is for.
    const readiness = describeWorkspaceReadiness({
      loading: false,
      workspaceCount: 0,
      repairing: false,
      repairFailure: null,
      fetchConfirmedEmpty: false,
      identityKnown: true,
    });

    expect(readiness.status).toBe('unavailable');
    expect(readiness.reason).toMatch(/connection problem/);
    expect(readiness.canRetry).toBe(true);
  });
});

describe('useWorkspaces during boot', () => {
  it('reports pending, not a connection failure, while the session is restoring', async () => {
    // The end-to-end version of the case above: mount the real hook with no
    // user id (what App passes as `user?.id` before getSession resolves) and
    // assert on the readiness it hands the rail. The pure-function test would
    // still pass if the hook forgot to pass identityKnown through.
    const React = await import('react');
    const { act } = React;
    const { createRoot } = await import('react-dom/client');
    const { useWorkspaces } = await import('../../src/hooks/useWorkspaces');

    const seen: string[] = [];
    function Probe({ userId }: { userId: string | undefined }) {
      const { readiness } = useWorkspaces(userId);
      seen.push(`${readiness.status}:${readiness.reason ?? ''}`);
      return null;
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(Probe, { userId: undefined })); });
    await act(async () => { await Promise.resolve(); });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some(entry => entry.startsWith('unavailable'))).toBe(false);
    expect(seen.some(entry => entry.includes('connection problem'))).toBe(false);
    expect(seen[seen.length - 1]).toMatch(/^(loading|pending):/);

    await act(async () => { root.unmount(); });
    host.remove();
  });
});

describe('boot state never triggers seeding', () => {
  it('refuses to repair while identity is unknown', () => {
    // The duplicate-workspace incident (26 stray Personal+Work pairs) came from
    // treating an unproven empty list as a new account. `pending` must stay on
    // the safe side of that: no repair, and no retry button offering one.
    const readiness = describeWorkspaceReadiness({
      loading: false,
      workspaceCount: 0,
      repairing: false,
      repairFailure: null,
      // Even if a stale confirmed-empty were somehow set, no user id means no
      // account to seed into.
      fetchConfirmedEmpty: true,
      identityKnown: false,
    });

    expect(readiness.shouldRepair).toBe(false);
    expect(readiness.canRetry).toBe(false);
    expect(readiness.ready).toBe(false);
  });

  it('still seeds a genuinely empty account once identity is known', () => {
    const readiness = describeWorkspaceReadiness({
      loading: false,
      workspaceCount: 0,
      repairing: false,
      repairFailure: null,
      fetchConfirmedEmpty: true,
      identityKnown: true,
    });

    expect(readiness.status).toBe('missing');
    expect(readiness.shouldRepair).toBe(true);
  });
});
