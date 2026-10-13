import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import { isToday, taskNotifications } from '../../src/lib/pm/taskNotifications';

const NOW = new Date(2026, 9, 13, 12).getTime();
const at = (daysAgo: number) => new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();

function task(o: Partial<Task> & { id: string }): Task {
  return {
    workspace_id: 'w', created_by: null, assignee_id: null, parent_id: null, title: o.id, description: '',
    status: 'todo', priority: 'normal', due_date: null, start_date: null, source_type: 'manual', source_id: null,
    completed_at: null, created_at: at(30), updated_at: at(30), ...o,
  };
}
const opts = { userId: 'me', agentIds: new Set(['atlas']), now: NOW };

describe('taskNotifications', () => {
  it('flags my open overdue tasks, and nobody else\'s', () => {
    const list = taskNotifications(
      [task({ id: 'a', assignee_id: 'me', due_date: at(2) }), task({ id: 'b', assignee_id: 'other', due_date: at(2) }), task({ id: 'c', assignee_id: 'me', due_date: at(-2) })],
      opts,
    );
    expect(list.map(n => [n.kind, n.taskId])).toEqual([['overdue', 'a']]);
  });

  it('does not flag closed tasks as overdue', () => {
    expect(taskNotifications([task({ id: 'a', assignee_id: 'me', due_date: at(2), status: 'done', completed_at: at(1) })], opts)).toEqual([]);
  });

  it('flags a task someone else gave me in the last three days', () => {
    const list = taskNotifications(
      [
        task({ id: 'new', assignee_id: 'me', created_by: 'sarah', created_at: at(1) }),
        task({ id: 'old', assignee_id: 'me', created_by: 'sarah', created_at: at(10) }),
        task({ id: 'self', assignee_id: 'me', created_by: 'me', created_at: at(1) }),
      ],
      opts,
    );
    expect(list.map(n => [n.kind, n.taskId, n.actorId])).toEqual([['assigned', 'new', 'sarah']]);
  });

  it('flags a task an agent finished recently', () => {
    const list = taskNotifications(
      [task({ id: 'x', assignee_id: 'atlas', status: 'done', completed_at: at(0.5) }), task({ id: 'y', assignee_id: 'atlas', status: 'done', completed_at: at(9) }), task({ id: 'z', assignee_id: 'sarah', status: 'done', completed_at: at(0.5) })],
      opts,
    );
    expect(list.map(n => [n.kind, n.taskId, n.actorId])).toEqual([['agent_done', 'x', 'atlas']]);
  });

  it('sorts newest first', () => {
    const list = taskNotifications(
      [task({ id: 'older', assignee_id: 'me', due_date: at(5) }), task({ id: 'newer', assignee_id: 'me', due_date: at(1) })],
      opts,
    );
    expect(list.map(n => n.taskId)).toEqual(['newer', 'older']);
  });
});

describe('isToday', () => {
  it('compares calendar days', () => {
    expect(isToday(new Date(2026, 9, 13, 1).toISOString(), NOW)).toBe(true);
    expect(isToday(new Date(2026, 9, 12, 23).toISOString(), NOW)).toBe(false);
  });
});
