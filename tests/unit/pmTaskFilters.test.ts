import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import { activeExtraFilterCount, allLabels, groupTasks, matchesExtraFilters } from '../../src/lib/pm/taskFilters';

const NOW = new Date(2026, 9, 14, 12).getTime(); // Wednesday
const at = (day: number) => new Date(2026, 9, day, 12).toISOString();

function task(o: Partial<Task> & { id: string }): Task {
  return {
    workspace_id: 'w', created_by: null, assignee_id: null, parent_id: null, title: o.id, description: '', status: 'todo',
    priority: 'normal', due_date: null, start_date: null, source_type: 'manual', source_id: null, completed_at: null,
    created_at: at(1), updated_at: at(1), ...o,
  };
}
const ctx = { assigneeLabel: (id: string | null) => (id ? `user-${id}` : 'Unassigned'), projectName: (id: string | null | undefined) => `proj-${id}`, now: NOW };

describe('matchesExtraFilters', () => {
  it('matches everything when nothing is selected', () => {
    expect(matchesExtraFilters(task({ id: 'a' }), { priorities: [], labels: [] })).toBe(true);
  });
  it('requires one of the selected priorities and one of the selected labels', () => {
    const t = task({ id: 'a', priority: 'high', labels: ['design'] });
    expect(matchesExtraFilters(t, { priorities: ['high', 'urgent'], labels: [] })).toBe(true);
    expect(matchesExtraFilters(t, { priorities: ['low'], labels: [] })).toBe(false);
    expect(matchesExtraFilters(t, { priorities: [], labels: ['design', 'backend'] })).toBe(true);
    expect(matchesExtraFilters(t, { priorities: [], labels: ['backend'] })).toBe(false);
    expect(matchesExtraFilters(task({ id: 'b' }), { priorities: [], labels: ['design'] })).toBe(false);
  });
});

describe('helpers', () => {
  it('lists labels once, sorted', () => {
    expect(allLabels([{ labels: ['b', 'a'] }, { labels: ['a'] }, {}])).toEqual(['a', 'b']);
  });
  it('counts switched-on filters', () => {
    expect(activeExtraFilterCount({ priorities: [], labels: [] }, 'status')).toBe(0);
    expect(activeExtraFilterCount({ priorities: ['high'], labels: ['x'] }, 'assignee')).toBe(3);
  });
});

describe('groupTasks', () => {
  it('groups by assignee with Unassigned last', () => {
    const groups = groupTasks([task({ id: '1' }), task({ id: '2', assignee_id: 'u1' }), task({ id: '3', assignee_id: 'u1' })], 'assignee', ctx);
    expect(groups.map(g => [g.label, g.tasks.length])).toEqual([['user-u1', 2], ['Unassigned', 1]]);
  });
  it('orders priority groups urgent first', () => {
    const groups = groupTasks([task({ id: '1', priority: 'low' }), task({ id: '2', priority: 'urgent' })], 'priority', ctx);
    expect(groups.map(g => g.label)).toEqual(['Urgent', 'Low']);
  });
  it('puts tasks with no project last', () => {
    const groups = groupTasks([task({ id: '1' }), task({ id: '2', project_id: 'p' })], 'project', ctx);
    expect(groups.map(g => g.label)).toEqual(['proj-p', 'No project']);
  });
  it('groups by due week: earlier, this week, next week, later, none', () => {
    const groups = groupTasks(
      [task({ id: 'none' }), task({ id: 'late', due_date: at(30) }), task({ id: 'next', due_date: at(21) }), task({ id: 'this', due_date: at(15) }), task({ id: 'old', due_date: at(2) })],
      'due',
      ctx,
    );
    expect(groups.map(g => g.label).slice(0, 3)).toEqual(['Earlier', 'This week', 'Next week']);
    expect(groups[groups.length - 1].label).toBe('No due date');
    expect(groups).toHaveLength(5);
  });
});
