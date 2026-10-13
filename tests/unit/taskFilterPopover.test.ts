import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';
import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';

// The Filter popover from the approved Section 10 mock, through the real Tasks window:
// priority and label filters narrow the List, and "Group the List by" regroups it.

function makeTask(o: Partial<Task> & { id: string; title: string }): Task {
  return {
    workspace_id: 'ws-1', created_by: null, assignee_id: null, parent_id: null, description: '', status: 'todo', priority: 'normal',
    due_date: null, start_date: null, source_type: 'manual', source_id: null, completed_at: null,
    created_at: new Date(2026, 6, 20).toISOString(), updated_at: new Date(2026, 6, 20).toISOString(), ...o,
  };
}

const tasks = [
  makeTask({ id: 'a', title: 'Urgent design task', priority: 'urgent', labels: ['design'], assignee_id: 'u1' }),
  makeTask({ id: 'b', title: 'Low backend task', priority: 'low', labels: ['backend'] }),
  makeTask({ id: 'c', title: 'Plain normal task' }),
];

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});
beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      createElement(TasksWindowContent, {
        tasks,
        members: [{ id: 'm', workspace_id: 'ws-1', user_id: 'u1', role: 'editor', invited_by: null, created_at: '', email: 'sarah@x.io' }],
        agents: [], agentConnections: [], currentUserEmail: 'a@b.c', workspaceId: 'ws-1',
        onCreateTask: () => null, onUpdateTask: () => {}, onToggleStatus: () => {}, onDeleteTask: () => {}, onUpdateAgent: () => {},
      } as never),
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
const openFilter = () => click(container.querySelector('button[aria-label="Filter and group"]')!);
const pop = () => document.querySelector('[data-testid="filter-popover"]') as HTMLElement;
const chip = (text: string) => Array.from(pop().querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLElement;
const sections = () => Array.from(container.querySelectorAll('section[aria-label]')).map(s => s.getAttribute('aria-label'));

describe('Filter popover', () => {
  it('starts grouped by status with every task shown', () => {
    expect(container.textContent).toContain('Urgent design task');
    expect(container.textContent).toContain('Plain normal task');
    expect(sections()).toEqual(['To do']);
  });

  it('narrows the List to a selected priority and shows a count on the button', () => {
    openFilter();
    click(chip('urgent'));
    expect(container.textContent).toContain('Urgent design task');
    expect(container.textContent).not.toContain('Low backend task');
    expect(container.querySelector('button[aria-label="Filter and group"]')!.textContent).toContain('1');
  });

  it('narrows to a selected label', () => {
    openFilter();
    click(chip('backend'));
    expect(container.textContent).toContain('Low backend task');
    expect(container.textContent).not.toContain('Urgent design task');
  });

  it('groups the List by assignee and by priority', () => {
    openFilter();
    click(chip('Assignee'));
    expect(sections()).toEqual(['sarah', 'Unassigned']);
    click(chip('Priority'));
    expect(sections()).toEqual(['Urgent', 'Normal', 'Low']);
  });

  it('clears everything', () => {
    openFilter();
    click(chip('urgent'));
    click(chip('Assignee'));
    click(chip('Clear all'));
    expect(sections()).toEqual(['To do']);
    expect(container.textContent).toContain('Low backend task');
  });
});
