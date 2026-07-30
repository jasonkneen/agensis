import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import type { AgentWork } from '../../src/lib/agentWork';
import {
  TASK_DISPATCH_SKEW_MS,
  formatIdleElapsed,
  idleTaskTitle,
  taskActivityState,
  workingTaskTitle,
} from '../../src/lib/taskActivity';

// The rule under test is the one that keeps the chip honest: all of an agent's
// task work lands in ONE DM session, so "a job is running in this session" alone
// would light up every task that agent has ever been given. A task only claims a
// job when its own updated_at is at least as new as the job's start — which the
// server guarantees for a real dispatch, because both dispatch paths write
// `update tasks set … updated_at = now()` immediately before creating the job.

const T0 = Date.parse('2026-07-29T09:00:00.000Z');

function task(o: Partial<Task> = {}): Pick<Task, 'status' | 'updated_at'> {
  return { status: 'in_progress', updated_at: new Date(T0).toISOString(), ...o } as Task;
}

function work(anchorAt: number, jobs = 1): AgentWork {
  return { anchorAt, jobs };
}

describe('taskActivityState', () => {
  it('says nothing at all for a task that is not in progress', () => {
    for (const status of ['todo', 'done', 'cancelled'] as const) {
      expect(taskActivityState(task({ status }), work(T0)).kind).toBe('none');
    }
  });

  it('is working when a job is running and the task was touched at dispatch', () => {
    // Real shape: the task update lands a beat BEFORE the job starts.
    const state = taskActivityState(task({ updated_at: new Date(T0).toISOString() }), work(T0 + 400));
    expect(state.kind).toBe('working');
    expect(state.workingSince).toBe(T0 + 400);
    expect(state.jobs).toBe(1);
  });

  it('counts from the JOB start, not from the task row', () => {
    const state = taskActivityState(task({ updated_at: new Date(T0 + 5000).toISOString() }), work(T0));
    expect(state.workingSince).toBe(T0);
    expect(state.idleSince).toBe(T0 + 5000);
  });

  it('refuses a job that started long after this task last moved', () => {
    // The agent is mid-turn in its DM, but on something else entirely — a plain
    // human DM, or a different task. A stale in_progress row must not claim it.
    const stale = task({ updated_at: new Date(T0 - 4 * 3600_000).toISOString() });
    const state = taskActivityState(stale, work(T0));
    expect(state.kind).toBe('idle');
    expect(state.idleSince).toBe(T0 - 4 * 3600_000);
  });

  it('allows exactly the documented skew and no more', () => {
    const at = (offset: number) => taskActivityState(
      task({ updated_at: new Date(T0 - offset).toISOString() }),
      work(T0),
    ).kind;
    expect(at(TASK_DISPATCH_SKEW_MS)).toBe('working');
    expect(at(TASK_DISPATCH_SKEW_MS + 1)).toBe('idle');
  });

  it('is idle when in progress with no job running at all', () => {
    const state = taskActivityState(task(), null);
    expect(state.kind).toBe('idle');
    expect(Number.isNaN(state.workingSince)).toBe(true);
  });

  it('treats an unparseable updated_at as live rather than inventing an age', () => {
    // No usable clock on the row means the correlation cannot be evaluated;
    // erring toward the job that IS running beats fabricating an elapsed time.
    const state = taskActivityState(task({ updated_at: 'not a date' }), work(T0));
    expect(state.kind).toBe('working');
    expect(Number.isNaN(state.idleSince)).toBe(true);
  });

  it('carries the job count for the tooltip', () => {
    expect(taskActivityState(task(), work(T0, 3)).jobs).toBe(3);
  });
});

describe('formatIdleElapsed', () => {
  it('never shows seconds — a static chip must not look like it is counting', () => {
    expect(formatIdleElapsed(0)).toBe('just now');
    expect(formatIdleElapsed(59_000)).toBe('just now');
    expect(formatIdleElapsed(60_000)).toBe('1m');
    expect(formatIdleElapsed(59 * 60_000)).toBe('59m');
    expect(formatIdleElapsed(3600_000)).toBe('1h');
    expect(formatIdleElapsed(23 * 3600_000)).toBe('23h');
    expect(formatIdleElapsed(86_400_000)).toBe('1d');
    expect(formatIdleElapsed(9 * 86_400_000)).toBe('9d');
  });

  it('clamps a negative (clock-skewed) elapsed instead of rendering "-1m"', () => {
    expect(formatIdleElapsed(-5000)).toBe('just now');
  });

  it('is empty for a non-number, so the chip can drop out', () => {
    expect(formatIdleElapsed(Number.NaN)).toBe('');
  });
});

describe('chip tooltips', () => {
  it('says present tense for the live chip', () => {
    expect(workingTaskTitle('2m 4s', 1)).toContain('An agent is working on this task');
    expect(workingTaskTitle('2m 4s', 1)).toContain('started 2m 4s ago');
    expect(workingTaskTitle('2m 4s', 2)).toContain('2 jobs running');
  });

  it('says what the static number IS, so it cannot be misread as a timer', () => {
    expect(idleTaskTitle('4h')).toContain('no agent is running right now');
    expect(idleTaskTitle('4h')).toContain('last updated 4h ago');
    expect(idleTaskTitle('just now')).toContain('last updated just now');
  });
});
