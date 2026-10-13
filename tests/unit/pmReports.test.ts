import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import { averageVelocity, burndown, createdVsCompleted, statusBreakdown, velocity, workload, workspaceTotals } from '../../src/lib/pm/reports';

const day = (n: number) => new Date(2026, 9, n, 12).getTime(); // October 2026, noon
const iso = (n: number) => new Date(day(n)).toISOString();

function task(o: Partial<Task> & { id: string }): Task {
  return {
    workspace_id: 'w', created_by: null, assignee_id: null, parent_id: null, title: o.id, description: '',
    status: 'todo', priority: 'normal', due_date: null, start_date: null, source_type: 'manual', source_id: null,
    completed_at: null, created_at: iso(1), updated_at: iso(1), ...o,
  };
}

describe('burndown', () => {
  const tasks = [
    task({ id: 'a', created_at: iso(1), status: 'done', completed_at: iso(3) }),
    task({ id: 'b', created_at: iso(1) }),
    task({ id: 'c', created_at: iso(2) }),
  ];

  it('counts open tasks per day and stops at today', () => {
    const points = burndown(tasks, day(1), day(10), day(4));
    expect(points.map(p => p.remaining)).toEqual([2, 3, 2, 2]);
    expect(points).toHaveLength(4);
  });

  it('draws an ideal line from the starting scope to zero', () => {
    const points = burndown(tasks, day(1), day(5), day(5));
    expect(points[0].ideal).toBe(2);
    expect(points[points.length - 1].ideal).toBe(0);
  });

  it('does not count cancelled tasks that never finished as scope', () => {
    const withCancelled = [...tasks, task({ id: 'x', status: 'cancelled', completed_at: null, updated_at: iso(2) })];
    const points = burndown(withCancelled, day(1), day(4), day(4));
    expect(points[0].remaining).toBe(2);
  });
});

describe('velocity', () => {
  it('buckets completions into Monday weeks, oldest first, marking the current one', () => {
    // 2026-10-13 is a Tuesday; its week starts Monday the 12th.
    const done = [
      task({ id: '1', status: 'done', completed_at: iso(13) }),
      task({ id: '2', status: 'done', completed_at: iso(8) }),
      task({ id: '3', status: 'done', completed_at: iso(9) }),
      task({ id: '4', status: 'todo' }),
    ];
    const weeks = velocity(done, 3, day(13));
    expect(weeks.map(w => w.done)).toEqual([0, 2, 1]);
    expect(weeks.map(w => w.current)).toEqual([false, false, true]);
  });

  it('averages finished weeks only', () => {
    expect(averageVelocity([{ weekStart: 0, done: 2, current: false }, { weekStart: 1, done: 4, current: false }, { weekStart: 2, done: 9, current: true }])).toBe(3);
    expect(averageVelocity([])).toBe(0);
  });
});

describe('createdVsCompleted', () => {
  it('is cumulative and never plots the future', () => {
    const points = createdVsCompleted(
      [task({ id: 'a', created_at: iso(1), status: 'done', completed_at: iso(2) }), task({ id: 'b', created_at: iso(2) })],
      day(1), day(10), day(3),
    );
    expect(points.map(p => [p.created, p.completed])).toEqual([[1, 0], [2, 1], [2, 1]]);
  });
});

describe('statusBreakdown and workload', () => {
  it('counts every status including empty ones', () => {
    expect(statusBreakdown([task({ id: 'a', status: 'done' }), task({ id: 'b' })]).map(s => s.count)).toEqual([1, 0, 1, 0]);
  });

  it('puts people and agents in one list, busiest first, ignoring closed and unassigned', () => {
    const rows = workload(
      [
        task({ id: '1', assignee_id: 'u1' }),
        task({ id: '2', assignee_id: 'ag', status: 'in_progress' }),
        task({ id: '3', assignee_id: 'ag' }),
        task({ id: '4', assignee_id: 'u1', status: 'done' }),
        task({ id: '5' }),
      ],
      new Set(['ag']),
    );
    expect(rows).toEqual([
      { id: 'ag', isAgent: true, inProgress: 1, todo: 1, total: 2 },
      { id: 'u1', isAgent: false, inProgress: 0, todo: 1, total: 1 },
    ]);
  });
});

describe('workspaceTotals', () => {
  it('counts open, agent-held, overdue and done this week', () => {
    const totals = workspaceTotals(
      [
        task({ id: '1', assignee_id: 'ag', due_date: iso(5) }),
        task({ id: '2' }),
        task({ id: '3', status: 'done', completed_at: iso(13) }),
        task({ id: '4', status: 'done', completed_at: iso(2) }),
      ],
      new Set(['ag']),
      day(13),
    );
    expect(totals).toEqual({ openTasks: 2, agentTasks: 1, doneThisWeek: 1, overdue: 1 });
  });
});
