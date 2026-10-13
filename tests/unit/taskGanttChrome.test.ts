import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';
import { TaskGantt } from '../../src/components/windows/TaskBoardViews';

// Gantt chrome from the approved timeline mock: weekend columns, the Today label,
// an outline on overdue bars, and a subtask progress fill. Dates are relative to
// today so the assertions hold on any day the suite runs.

const DAY = 86400000;
const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const iso = (offsetDays: number) => new Date(today() + offsetDays * DAY).toISOString();

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
    created_at: iso(-10),
    updated_at: iso(-10),
    ...o,
  };
}

const parent = makeTask({ id: 'p', title: 'Ship UI work', start_date: iso(-4), due_date: iso(6) });
const childDone = makeTask({ id: 'c1', title: 'Wire the panel', parent_id: 'p', status: 'done', start_date: iso(-4), due_date: iso(-2) });
const childOpen = makeTask({ id: 'c2', title: 'Polish states', parent_id: 'p', start_date: iso(-1), due_date: iso(6) });
const overdue = makeTask({ id: 'o', title: 'Late review', start_date: iso(-6), due_date: iso(-3) });
const onTime = makeTask({ id: 'n', title: 'On time', start_date: iso(0), due_date: iso(5) });

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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderGantt() {
  const allTasks = [parent, childDone, childOpen, overdue, onTime];
  act(() => {
    root.render(
      createElement(TaskGantt, {
        tasks: [parent, overdue, onTime],
        allTasks,
        hideDone: false,
        memberLabel: () => null,
        selectedTaskId: null,
        onSelectTask: () => {},
        onReschedule: () => {},
      }),
    );
  });
}

describe('Gantt chrome', () => {
  it('shades weekend columns behind the rows', () => {
    renderGantt();
    expect(container.querySelectorAll('.bg-muted\\/40').length).toBeGreaterThan(0);
  });

  it('labels the today line in the header', () => {
    renderGantt();
    const label = Array.from(container.querySelectorAll<HTMLElement>('.text-primary')).find(el => el.textContent === 'Today');
    expect(label).toBeTruthy();
  });

  it('outlines overdue bars and not on-time bars', () => {
    renderGantt();
    const overdueBar = container.querySelector<HTMLElement>('[data-gantt-id="o"] [class*="outline-destructive"]');
    const onTimeBar = container.querySelector<HTMLElement>('[data-gantt-id="n"] [class*="outline-destructive"]');
    expect(overdueBar).toBeTruthy();
    expect(onTimeBar).toBeNull();
  });

  it('shows a task labelled milestone in the strip above the rows, not as a row', () => {
    const milestone = makeTask({ id: 'm', title: 'Pricing review', labels: ['milestone'], due_date: iso(3), start_date: iso(-2) });
    act(() => {
      root.render(
        createElement(TaskGantt, {
          tasks: [milestone],
          allTasks: [milestone],
          hideDone: false,
          memberLabel: () => null,
          selectedTaskId: null,
          onSelectTask: () => {},
          onReschedule: () => {},
        }),
      );
    });
    // Milestones sit in a strip above the rows, so they are not rows any more.
    expect(container.querySelector('[data-gantt-id="m"]')).toBeNull();
    expect(container.textContent).toContain('Pricing review');
  });

  it('groups rows under status headers when Group: Status is on', () => {
    renderGantt();
    const toggle = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Group: Status');
    expect(toggle).toBeTruthy();
    act(() => toggle!.click());
    const headers = Array.from(container.querySelectorAll('div')).filter(d => d.className.includes('uppercase') && d.className.includes('font-semibold'));
    const labels = headers.map(h => h.textContent);
    // The fixture has no in-progress task, so that group must not appear.
    expect(labels).toEqual(['To do', 'Done']);
  });

  it('fills a parent bar by the share of its subtasks that are done', () => {
    renderGantt();
    const fill = container.querySelector<HTMLElement>('[data-gantt-id="p"] span[style*="width: 50%"]');
    expect(fill).toBeTruthy();
  });
});
