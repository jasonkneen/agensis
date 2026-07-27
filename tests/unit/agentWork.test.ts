import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_WORKING_MS,
  agentWorkSnapshot,
  applyAgentJobRow,
  clearAgentWork,
  formatElapsed,
  getSessionWork,
  getThreadWork,
  resetAgentWork,
  subscribeToAgentWork,
} from '../../src/lib/agentWork';
import type { AgentJobRow } from '../../src/types';

// The contract these tests pin, in order of how expensive it is to get wrong:
//  1. the store publishes when the working SET changes and NEVER otherwise —
//     no per-second publish, no publish for a re-delivered identical row;
//  2. snapshots are reference-stable per key, which is what stops session A's
//     badge re-rendering when session B starts working;
//  3. only a 'running' row with a real timestamp counts as work (no invented
//     elapsed times);
//  4. a job that finishes while the seed fetch is in flight stays finished.

const T0 = Date.parse('2026-07-25T12:00:00.000Z');

function job(overrides: Partial<AgentJobRow> & { id: string }): Partial<AgentJobRow> {
  return {
    workspace_id: 'ws-1',
    agent_id: 'agent-1',
    session_id: 'session-a',
    status: 'running',
    started_at: new Date(T0).toISOString(),
    created_at: new Date(T0).toISOString(),
    metadata: {},
    ...overrides,
  };
}

describe('agentWork store', () => {
  beforeEach(() => {
    clearAgentWork();
  });

  afterEach(() => {
    clearAgentWork();
  });

  it('derives a session anchor from a running job', () => {
    applyAgentJobRow(job({ id: 'job-1' }), 'INSERT');
    expect(getSessionWork('session-a')).toEqual({ anchorAt: T0, jobs: 1 });
    expect(getSessionWork('session-b')).toBeNull();
  });

  it('ignores queued jobs and rows with no usable timestamp', () => {
    applyAgentJobRow(job({ id: 'queued', status: 'queued', started_at: null }), 'INSERT');
    expect(getSessionWork('session-a')).toBeNull();

    applyAgentJobRow(job({ id: 'no-clock', started_at: null, created_at: 'not-a-date' }), 'INSERT');
    expect(getSessionWork('session-a')).toBeNull();

    // started_at missing but created_at parseable: anchor to the insert.
    applyAgentJobRow(job({ id: 'fallback', started_at: null }), 'INSERT');
    expect(getSessionWork('session-a')).toEqual({ anchorAt: T0, jobs: 1 });
  });

  it('clears the session when the job finishes', () => {
    applyAgentJobRow(job({ id: 'job-1' }), 'INSERT');
    applyAgentJobRow(job({ id: 'job-1', status: 'done' }), 'UPDATE');
    expect(getSessionWork('session-a')).toBeNull();
  });

  it('keys thread work off metadata.threadParentId', () => {
    applyAgentJobRow(job({ id: 'job-1', metadata: { threadParentId: 'msg-9', handle: 'coder' } }), 'INSERT');
    expect(getThreadWork('msg-9')).toEqual({ anchorAt: T0, jobs: 1 });
    // A thread job is still work in its session — the channel row shows it too.
    expect(getSessionWork('session-a')).toEqual({ anchorAt: T0, jobs: 1 });
    // A session-level job is NOT attributed to any thread.
    applyAgentJobRow(job({ id: 'job-2', session_id: 'session-b' }), 'INSERT');
    expect(getThreadWork('session-b')).toBeNull();
  });

  it('reports the oldest anchor and the job count when two agents share a key', () => {
    const later = T0 + 30_000;
    applyAgentJobRow(job({ id: 'job-1', started_at: new Date(later).toISOString() }), 'INSERT');
    applyAgentJobRow(job({ id: 'job-2', agent_id: 'agent-2' }), 'INSERT');
    expect(getSessionWork('session-a')).toEqual({ anchorAt: T0, jobs: 2 });

    applyAgentJobRow(job({ id: 'job-2', status: 'error' }), 'UPDATE');
    expect(getSessionWork('session-a')).toEqual({ anchorAt: later, jobs: 1 });
  });

  it('publishes only when the working set changes', () => {
    let notifications = 0;
    const off = subscribeToAgentWork(() => { notifications += 1; });

    applyAgentJobRow(job({ id: 'job-1' }), 'INSERT');
    expect(notifications).toBe(1);

    // Re-delivered identical row (realtime retry / seed fetch overlap).
    applyAgentJobRow(job({ id: 'job-1' }), 'UPDATE');
    applyAgentJobRow(job({ id: 'job-1' }), 'UPDATE');
    expect(notifications).toBe(1);

    // A row for a job that is not work at all must not wake anyone.
    applyAgentJobRow(job({ id: 'job-2', status: 'cancelled' }), 'UPDATE');
    expect(notifications).toBe(1);

    applyAgentJobRow(job({ id: 'job-1', status: 'done' }), 'UPDATE');
    expect(notifications).toBe(2);

    off();
    applyAgentJobRow(job({ id: 'job-3' }), 'INSERT');
    expect(notifications).toBe(2);
  });

  it('keeps unchanged entries reference-identical so other keys do not re-render', () => {
    applyAgentJobRow(job({ id: 'job-1' }), 'INSERT');
    const first = getSessionWork('session-a');

    applyAgentJobRow(job({ id: 'job-2', session_id: 'session-b' }), 'INSERT');
    expect(getSessionWork('session-a')).toBe(first);
    expect(getSessionWork('session-b')).not.toBe(first);

    applyAgentJobRow(job({ id: 'job-2', session_id: 'session-b', status: 'done' }), 'UPDATE');
    expect(getSessionWork('session-a')).toBe(first);
    expect(getSessionWork('session-b')).toBeNull();
  });

  it('keeps the whole snapshot identity when nothing derived changed', () => {
    applyAgentJobRow(job({ id: 'job-1' }), 'INSERT');
    const snapshot = agentWorkSnapshot();
    applyAgentJobRow(job({ id: 'job-1' }), 'UPDATE');
    expect(agentWorkSnapshot().bySession).toBe(snapshot.bySession);
    expect(agentWorkSnapshot().byThread).toBe(snapshot.byThread);
  });

  it('does not let a slow seed fetch resurrect a job that already finished', () => {
    const fetchStartedAt = T0;
    // Realtime says job-1 finished while the fetch was in flight...
    applyAgentJobRow(job({ id: 'job-1', status: 'done' }), 'UPDATE', fetchStartedAt + 1);
    // ...and the fetch (which read the DB earlier) still reports it running.
    resetAgentWork(
      [job({ id: 'job-1' }), job({ id: 'job-2', session_id: 'session-b' })],
      fetchStartedAt,
      fetchStartedAt + 2,
    );
    expect(getSessionWork('session-a')).toBeNull();
    expect(getSessionWork('session-b')).toEqual({ anchorAt: T0, jobs: 1 });
  });

  it('creates no timers of its own — the clock belongs to the badge leaf', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const setTimeout = vi.spyOn(globalThis, 'setTimeout');
    const off = subscribeToAgentWork(() => {});
    applyAgentJobRow(job({ id: 'job-1' }), 'INSERT');
    resetAgentWork([job({ id: 'job-1' })], T0, T0 + 1);
    applyAgentJobRow(job({ id: 'job-1', status: 'done' }), 'UPDATE');
    off();
    expect(setInterval).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
    setInterval.mockRestore();
    setTimeout.mockRestore();
  });

  it('replaces the set on a seed fetch with no race window', () => {
    applyAgentJobRow(job({ id: 'stale', session_id: 'session-z' }), 'INSERT');
    resetAgentWork([job({ id: 'job-1' })]);
    expect(getSessionWork('session-z')).toBeNull();
    expect(getSessionWork('session-a')).toEqual({ anchorAt: T0, jobs: 1 });
  });

  it('drops everything on clear and notifies', () => {
    applyAgentJobRow(job({ id: 'job-1' }), 'INSERT');
    let notifications = 0;
    const off = subscribeToAgentWork(() => { notifications += 1; });
    clearAgentWork();
    expect(notifications).toBe(1);
    expect(getSessionWork('session-a')).toBeNull();
    // Clearing an already-empty store is a no-op.
    clearAgentWork();
    expect(notifications).toBe(1);
    off();
  });

  it('forgets a DELETEd job row', () => {
    applyAgentJobRow(job({ id: 'job-1' }), 'INSERT');
    applyAgentJobRow(job({ id: 'job-1' }), 'DELETE');
    expect(getSessionWork('session-a')).toBeNull();
  });

  it('ignores rows with no id', () => {
    applyAgentJobRow({ session_id: 'session-a', status: 'running', started_at: new Date(T0).toISOString() }, 'INSERT');
    expect(getSessionWork('session-a')).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('counts seconds, then minutes + seconds, then hours + minutes', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(1_000)).toBe('1s');
    expect(formatElapsed(59_000)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m 0s');
    expect(formatElapsed(355_000)).toBe('5m 55s');
    expect(formatElapsed(3_599_000)).toBe('59m 59s');
    expect(formatElapsed(3_600_000)).toBe('1h 0m');
    expect(formatElapsed(7_830_000)).toBe('2h 10m');
  });

  it('never shows a negative elapsed for a clock-skewed anchor', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});

describe('MAX_WORKING_MS', () => {
  // The badge stops believing a job once the server's own reaper would have
  // killed it (30 minutes from started_at, 31 for farm jobs) — because the
  // reaper's terminal write never reaches realtime subscribers, so nothing else
  // would ever stop the clock.
  it('sits at or above the server hard ceiling on a running job', () => {
    expect(MAX_WORKING_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });
});
