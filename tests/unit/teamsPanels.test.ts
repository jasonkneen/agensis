import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task, WorkspaceAgent } from '../../src/types';
import type { WorkspaceMember } from '../../src/hooks/useSharing';
import type { Team } from '../../src/hooks/useTeams';
import { MembersPage, TeamsPage } from '../../src/components/projects/TeamsPanels';

const members = [
  { id: 'm1', workspace_id: 'w', user_id: 'u1', role: 'editor', invited_by: null, created_at: '', email: 'sarah@x.io' },
  { id: 'm2', workspace_id: 'w', user_id: 'u2', role: 'admin', invited_by: null, created_at: '', email: 'john@x.io' },
] as WorkspaceMember[];
const agents = [{ id: 'atlas', name: 'Atlas', handle: 'atlas', enabled: true }] as unknown as WorkspaceAgent[];
const team = { id: 't1', workspace_id: 'w', created_by: null, name: 'Design', description: '', color: 'indigo', member_ids: ['u1', 'atlas'], version: 1, created_at: '', updated_at: '' } as Team;
const tasks = [
  { id: 'a', status: 'todo', assignee_id: 'u1', project_id: 'p1' },
  { id: 'b', status: 'in_progress', assignee_id: 'atlas', project_id: 'p1' },
] as unknown as Task[];

let container: HTMLDivElement;
let root: Root;
const calls = { created: [] as unknown[], updated: [] as unknown[], deleted: [] as string[] };
const actions = {
  createTeam: vi.fn(async (input: unknown) => { calls.created.push(input); return null; }),
  updateTeam: vi.fn(async (id: string, updates: unknown) => { calls.updated.push([id, updates]); return null; }),
  deleteTeam: vi.fn(async (id: string) => { calls.deleted.push(id); }),
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  calls.created = []; calls.updated = []; calls.deleted = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
const button = (text: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLElement;
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => { setter?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('TeamsPage', () => {
  const render = (teams: Team[]) => act(() => { root.render(createElement(TeamsPage, { teams, actions, members, agents, tasks })); });

  it('shows team cards with people, agent and open-task counts', () => {
    render([team]);
    expect(container.textContent).toContain('Design');
    expect(container.textContent).toContain('1 person · 1 agent · 2 open tasks');
  });

  it('creates a team from the name field', () => {
    render([]);
    expect(container.textContent).toContain('No teams yet');
    type(container.querySelector('input[aria-label="New team name"]') as HTMLInputElement, 'Marketing');
    click(button('New team'));
    expect(calls.created).toEqual([{ name: 'Marketing' }]);
  });

  it('adds a member to a team from its edit panel, and deletes the team', () => {
    render([team]);
    click(button('Edit'));
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
    expect(boxes).toHaveLength(3);
    click(boxes[1]);
    expect(calls.updated).toEqual([['t1', { member_ids: ['u1', 'atlas', 'u2'] }]]);
    click(button('Delete team'));
    expect(calls.deleted).toEqual(['t1']);
  });
});

describe('MembersPage', () => {
  const render = () => act(() => { root.render(createElement(MembersPage, { teams: [team], members, agents, tasks })); });

  it('lists people and agents together with role, team and open tasks', () => {
    render();
    const rows = Array.from(container.querySelectorAll('tbody tr')).map(r => r.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('sarah');
    expect(rows[0]).toContain('Editor');
    expect(rows[0]).toContain('Design');
    expect(rows[2]).toContain('atlas');
    expect(rows[2]).toContain('Task runner');
  });

  it('filters to agents only', () => {
    render();
    click(button('Agents'));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  });
});
