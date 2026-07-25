import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';
import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';

// The task window is the part of this feature a human has to LOOK at to judge,
// so this file asserts what it actually renders in a DOM:
//   - the Gantt: how many day-columns each bar covers, whether it is a real
//     span / a parent rollup / an undated marker, where its title ended up, and
//     that dependency arrows exist. Before this feature every row drew an
//     identical narrow block truncated to one character, which no assertion in
//     the repo would have caught.
//   - the editor: that start/due date inputs exist and commit ISO dates, and
//     that the dependency picker cannot offer a cycle.

function localIso(y: number, m: number, d: number) {
  return new Date(y, m - 1, d).toISOString();
}

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
    created_at: localIso(2026, 7, 20),
    updated_at: localIso(2026, 7, 20),
    ...o,
  };
}

// "Ship UI work / 1..2" — the shape agents actually produce, plus the undated
// task that 14 of 14 real rows currently look like.
const TASKS: Task[] = [
  makeTask({ id: 'p', title: 'Ship UI work' }),
  makeTask({
    id: 'k1', title: 'Wire the panel', parent_id: 'p',
    start_date: localIso(2026, 8, 3), due_date: localIso(2026, 8, 7),
  }),
  makeTask({
    id: 'k2', title: 'Ancient one-day job', parent_id: 'p',
    start_date: localIso(2026, 8, 10), due_date: localIso(2026, 8, 10), depends_on: ['k1'],
  }),
  makeTask({ id: 'u', title: 'Totally undated task' }),
];

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix ScrollArea observes its viewport; jsdom ships no ResizeObserver.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() { }
      unobserve() { }
      disconnect() { }
    } as unknown as typeof ResizeObserver;
  }
});

type Update = { id: string; updates: Partial<Task> };

function render(tasks: Task[], updates: Update[] = []) {
  act(() => {
    root.render(createElement(TasksWindowContent, {
      tasks,
      members: [],
      agents: [],
      agentConnections: [],
      currentUserEmail: 'a@b.c',
      workspaceId: 'ws-1',
      onCreateTask: () => { },
      onUpdateTask: (id: string, patch: Partial<Task>) => { updates.push({ id, updates: patch }); },
      onToggleStatus: () => { },
      onDeleteTask: () => { },
      onUpdateAgent: () => { },
    } as never));
  });
}

function clickText(text: string) {
  const node = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(text));
  if (!node) throw new Error(`no button containing "${text}"`);
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function click(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

// React's onChange is wired to the native `input` event, and it reads the value
// off the node — so the value has to be set through the prototype setter React
// patched, then the event dispatched.
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function bars() {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-gantt-kind]'));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Gantt timeline rendering', () => {
  beforeEach(() => {
    render(TASKS);
    clickText('Timeline');
  });

  it('draws one row per task INCLUDING subtasks, not just top-level ones', () => {
    // parent_id was previously unused by the timeline: children never appeared,
    // so a parent's bar could not possibly span them.
    expect(bars()).toHaveLength(4);
  });

  it('gives a five-day task a five-day bar, not a one-day block', () => {
    const [, wide] = bars();
    expect(wide.dataset.ganttKind).toBe('span');
    expect(Number(wide.dataset.ganttDays)).toBe(5);
  });

  it('rolls the parent bar up to span its children', () => {
    const [parent] = bars();
    expect(parent.dataset.ganttKind).toBe('rollup');
    // Aug 3 (first child's start) .. Aug 10 (last child's due) inclusive.
    expect(Number(parent.dataset.ganttDays)).toBe(8);
  });

  it('renders an undated task as a single-day marker, not as a span', () => {
    const marker = bars().find(b => b.textContent?.includes('Totally undated task'));
    expect(marker?.dataset.ganttKind).toBe('point');
    expect(Number(marker?.dataset.ganttDays)).toBe(1);
  });

  it('puts the title OUTSIDE any bar too narrow to hold it', () => {
    // The reported bug: bars so narrow the label truncated to "T…". A one-day
    // bar is 32px, so its title has to live beside the bar.
    const oneDay = bars().find(b => b.textContent?.includes('Ancient one-day job'));
    expect(oneDay?.dataset.ganttLabel).toBe('outside');
    // …and the full title is really in the DOM, not an ellipsised fragment.
    expect(oneDay?.textContent).toContain('Ancient one-day job');
  });

  it('keeps the title inside a bar wide enough for it', () => {
    const wide = bars().find(b => b.textContent?.includes('Wire the panel'));
    expect(wide?.dataset.ganttLabel).toBe('inside');
  });

  it('draws a dependency arrow for each resolvable depends_on edge', () => {
    const arrows = container.querySelectorAll('path[marker-end="url(#gantt-arrow)"]');
    expect(arrows).toHaveLength(1);
  });

  it('labels every row readably in the sticky column', () => {
    for (const task of TASKS) {
      expect(container.textContent).toContain(task.title);
    }
  });
});

describe('Gantt timeline with no dates anywhere', () => {
  it('still renders every task as a marker instead of vanishing', () => {
    // The production state: 0 of 14 tasks have any date.
    render([
      makeTask({ id: 'a', title: 'Alpha' }),
      makeTask({ id: 'b', title: 'Beta' }),
      makeTask({ id: 'c', title: 'Gamma' }),
    ]);
    clickText('Timeline');
    const kinds = bars().map(b => b.dataset.ganttKind);
    expect(kinds).toEqual(['point', 'point', 'point']);
    expect(container.textContent).toContain('unscheduled');
  });
});

// --- The editor: dates and dependencies have to be SETTABLE ----------------
// The whole reason the timeline had nothing to draw is that no UI ever wrote
// start_date, due_date or depends_on.

// a <- b <- c is a chain; d is unrelated. So `a` may only depend on `d`:
// offering b or c would close a loop.
const CHAIN: Task[] = [
  makeTask({ id: 'a', title: 'Chain step A' }),
  makeTask({ id: 'b', title: 'Chain step B', depends_on: ['a'] }),
  makeTask({ id: 'c', title: 'Chain step C', depends_on: ['b'] }),
  makeTask({ id: 'd', title: 'Unrelated D' }),
];

function expandFirstRow() {
  const expand = container.querySelector('button[aria-label="Expand task"]');
  if (!expand) throw new Error('no expand button');
  click(expand);
}

describe('task editor: schedule fields', () => {
  it('exposes a start date and a due date input', () => {
    render(CHAIN);
    expandFirstRow();
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    expect(inputs).toHaveLength(2);
    expect(container.textContent).toContain('Start date');
    expect(container.textContent).toContain('Due date');
  });

  it('shows existing dates as local calendar days', () => {
    render([makeTask({
      id: 'a', title: 'Dated', start_date: localIso(2026, 8, 3), due_date: localIso(2026, 8, 7),
    })]);
    expandFirstRow();
    const [start, due] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    expect(start.value).toBe('2026-08-03');
    expect(due.value).toBe('2026-08-07');
  });

  it('commits a picked start date as an ISO timestamp at local midnight', () => {
    const updates: Update[] = [];
    render(CHAIN, updates);
    expandFirstRow();
    const [start] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    setInputValue(start, '2026-08-03');
    expect(updates).toEqual([{ id: 'a', updates: { start_date: new Date(2026, 7, 3).toISOString() } }]);
  });

  it('clears the date when the input is emptied', () => {
    const updates: Update[] = [];
    render([makeTask({ id: 'a', title: 'Dated', due_date: localIso(2026, 8, 7) })], updates);
    expandFirstRow();
    const [, due] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    setInputValue(due, '');
    expect(updates).toEqual([{ id: 'a', updates: { due_date: null } }]);
  });
});

describe('task editor: dependency picker', () => {
  it('offers every task that would not create a cycle, and no others', () => {
    render(CHAIN);
    expandFirstRow(); // row "a"
    const labels = Array.from(container.querySelectorAll('label'))
      .filter(l => l.querySelector('input[type="checkbox"]'))
      .map(l => l.textContent || '');
    // b and c transitively depend on a, so neither may be offered back to a.
    expect(labels.some(l => l.includes('Unrelated D'))).toBe(true);
    expect(labels.some(l => l.includes('Chain step B'))).toBe(false);
    expect(labels.some(l => l.includes('Chain step C'))).toBe(false);
    expect(labels.some(l => l.includes('Chain step A'))).toBe(false);
  });

  it('commits a ticked dependency as a task id array', () => {
    const updates: Update[] = [];
    render(CHAIN, updates);
    expandFirstRow();
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!box) throw new Error('no dependency checkbox');
    click(box);
    expect(updates).toEqual([{ id: 'a', updates: { depends_on: ['d'] } }]);
  });

  it('un-ticks an existing dependency back to an empty list', () => {
    const updates: Update[] = [];
    render(CHAIN, updates);
    // Expand row "b", whose only dependency is "a".
    const expands = container.querySelectorAll('button[aria-label="Expand task"]');
    click(expands[1]);
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    const ticked = boxes.find(b => b.checked);
    expect(ticked).toBeTruthy();
    click(ticked!);
    expect(updates).toEqual([{ id: 'b', updates: { depends_on: [] } }]);
  });
});
