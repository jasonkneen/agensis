import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';
import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';

// The task toolbar's Agent-assigned, Overdue and search filters, from the approved task
// list mock. Driven through the real Tasks window in the Table view, one row per task.

const DAY = 86400000;
const day = (offset: number) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return new Date(d.getTime() + offset * DAY).toISOString();
};

function makeTask(o: Partial<Task> & { id: string; title: string }): Task {
  return {
    workspace_id: 'ws-1',
    created_by: null,
    assignee_id: null,
    parent_id: null,
    description: '',
    status: 'todo',
    priority: 'normal',
    due_date: null,
    start_date: null,
    source_type: 'manual',
    source_id: null,
    completed_at: null,
    created_at: day(-10),
    updated_at: day(-10),
    ...o,
  };
}

const TASKS: Task[] = [
  makeTask({ id: 'agent', title: 'Agent job', assignee_id: 'ag1' }),
  makeTask({ id: 'late', title: 'Late job', due_date: day(-3) }),
  makeTask({ id: 'done-late', title: 'Finished late job', due_date: day(-3), status: 'done' }),
  makeTask({ id: 'plain', title: 'Plain job', description: 'Rework the pricing page' }),
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
  });
  act(() => {
    root.render(
      createElement(TasksWindowContent, {
        tasks: TASKS,
        members: [],
        agents: [{ id: 'ag1', name: 'Atlas', enabled: true }],
        agentConnections: [],
        currentUserEmail: 'a@b.c',
        workspaceId: 'ws-1',
        onCreateTask: () => null,
        onUpdateTask: () => {},
        onToggleStatus: () => {},
        onDeleteTask: () => {},
        onUpdateAgent: () => {},
        forcedView: 'table',
      } as never),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

const titles = () => Array.from(container.querySelectorAll('tbody tr')).map(row => row.querySelectorAll('td')[1]?.textContent ?? '');

function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text);
  if (!button) throw new Error(`no button "${text}"`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function typeSearch(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('task toolbar filters', () => {
  it('shows every task with no filter on', () => {
    expect(titles()).toHaveLength(4);
  });

  it('Agent-assigned keeps only tasks assigned to an agent, and toggles off again', () => {
    clickButton('Agent-assigned');
    expect(titles()).toEqual(['Agent job']);
    clickButton('Agent-assigned');
    expect(titles()).toHaveLength(4);
  });

  it('Overdue keeps open tasks past their due date and drops finished ones', () => {
    clickButton('Overdue');
    expect(titles()).toEqual(['Late job']);
  });

  it('search matches the title or the description, ignoring case', () => {
    typeSearch('LATE');
    expect(titles().sort()).toEqual(['Finished late job', 'Late job']);
    typeSearch('pricing');
    expect(titles()).toEqual(['Plain job']);
    typeSearch('');
    expect(titles()).toHaveLength(4);
  });

  it('combines filters', () => {
    clickButton('Overdue');
    typeSearch('finished');
    expect(titles()).toEqual([]);
  });
});

describe('task toolbar sort', () => {
  const SORT_TASKS: Task[] = [
    makeTask({ id: 'a', title: 'Charlie', priority: 'low', due_date: day(5) }),
    makeTask({ id: 'b', title: 'Alpha', priority: 'urgent' }),
    makeTask({ id: 'c', title: 'Bravo', priority: 'high', due_date: day(1) }),
  ];

  function renderSorted(sort: 'default' | 'priority' | 'due' | 'title') {
    act(() => {
      root.render(
        createElement(TasksWindowContent, {
          tasks: SORT_TASKS,
          members: [],
          agents: [],
          agentConnections: [],
          currentUserEmail: 'a@b.c',
          workspaceId: 'ws-1',
          onCreateTask: () => null,
          onUpdateTask: () => {},
          onToggleStatus: () => {},
          onDeleteTask: () => {},
          onUpdateAgent: () => {},
          forcedView: 'table',
        } as never),
      );
    });
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Sort tasks"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(select, sort);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('keeps the existing order by default', () => {
    renderSorted('default');
    expect(titles()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('sorts by priority, most urgent first', () => {
    renderSorted('priority');
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('sorts by due date, soonest first, with undated tasks last', () => {
    renderSorted('due');
    expect(titles()).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('sorts by title', () => {
    renderSorted('title');
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});
