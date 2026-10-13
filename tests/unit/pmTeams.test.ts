import { describe, expect, it } from 'vitest';
import { directory, teamStats, toggleMember } from '../../src/lib/pm/teams';

const team = { id: 't', name: 'Design', member_ids: ['u1', 'u2', 'atlas'] };
const agentIds = new Set(['atlas']);
const tasks = [
  { status: 'todo', assignee_id: 'u1', project_id: 'p1' },
  { status: 'in_progress', assignee_id: 'atlas', project_id: 'p2' },
  { status: 'in_progress', assignee_id: 'atlas', project_id: 'p2' },
  { status: 'done', assignee_id: 'u2', project_id: 'p3' },
  { status: 'todo', assignee_id: 'outsider', project_id: 'p4' },
] as const;

describe('teamStats', () => {
  it('counts people and agents separately, plus open tasks and projects they touch', () => {
    expect(teamStats(team, [...tasks], agentIds)).toEqual({ people: 2, agents: 1, openTasks: 3, projects: 2 });
  });

  it('is all zeros for an empty team', () => {
    expect(teamStats({ id: 'e', name: 'Empty', member_ids: [] }, [...tasks], agentIds)).toEqual({ people: 0, agents: 0, openTasks: 0, projects: 0 });
  });
});

describe('toggleMember', () => {
  it('adds then removes', () => {
    expect(toggleMember(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleMember(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('directory', () => {
  it('lists teams and open tasks per person or agent', () => {
    const rows = directory(
      [
        { id: 'u1', name: 'Sarah', isAgent: false, role: 'Editor' },
        { id: 'atlas', name: '@atlas', isAgent: true, role: 'Task runner' },
        { id: 'u9', name: 'Nobody', isAgent: false, role: 'Viewer' },
      ],
      [team, { id: 'e', name: 'Eng', member_ids: ['atlas'] }],
      [...tasks],
    );
    expect(rows.map(r => [r.id, r.teamNames, r.openTasks])).toEqual([
      ['u1', ['Design'], 1],
      ['atlas', ['Design', 'Eng'], 2],
      ['u9', [], 0],
    ]);
  });
});
