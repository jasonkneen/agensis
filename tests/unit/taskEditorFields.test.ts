import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';
import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';

// The task editor's label and estimate fields, from the approved task drawer mock,
// exercised through the real Tasks window: expand a task, edit the field, and
// check the update the window sends.

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
    created_at: new Date(2026, 6, 20).toISOString(),
    updated_at: new Date(2026, 6, 20).toISOString(),
    ...o,
  };
}

type Update = { id: string; updates: Partial<Task> };

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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

function renderWindow(tasks: Task[], updates: Update[], view: 'table' | 'list' = 'table') {
  act(() => {
    root.render(
      createElement(TasksWindowContent, {
        tasks,
        members: [],
        agents: [],
        agentConnections: [],
        currentUserEmail: 'a@b.c',
        workspaceId: 'ws-1',
        onCreateTask: () => null,
        onUpdateTask: (id: string, patch: Partial<Task>) => {
          updates.push({ id, updates: patch });
        },
        onToggleStatus: () => {},
        onDeleteTask: () => {},
        onUpdateAgent: () => {},
        // The side panel is the editor every view shares. 'list' leaves the saved default, which is the List.
        ...(view === 'table' ? { forcedView: 'table' } : {}),
      } as never),
    );
  });
}

function expandFirstRow() {
  const cell = container.querySelector('tbody tr td:nth-child(2)');
  if (!cell) throw new Error('no table row to open');
  act(() => {
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressEnter(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

const field = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector) as T;

describe('task editor: estimate', () => {
  it('saves a typed estimate on Enter', () => {
    const updates: Update[] = [];
    renderWindow([makeTask({ id: 'a', title: 'Estimate me' })], updates);
    expandFirstRow();
    const input = field<HTMLInputElement>('input[aria-label="Estimate"]');
    setValue(input, '3d');
    pressEnter(input);
    expect(updates).toEqual([{ id: 'a', updates: { estimate: '3d' } }]);
  });

  it('does not save when the estimate has not changed', () => {
    const updates: Update[] = [];
    renderWindow([makeTask({ id: 'a', title: 'Same', estimate: '2d' })], updates);
    expandFirstRow();
    const input = field<HTMLInputElement>('input[aria-label="Estimate"]');
    expect(input.value).toBe('2d');
    pressEnter(input);
    expect(updates).toEqual([]);
  });

  it('clears the estimate when the field is emptied', () => {
    const updates: Update[] = [];
    renderWindow([makeTask({ id: 'a', title: 'Clear me', estimate: '2d' })], updates);
    expandFirstRow();
    const input = field<HTMLInputElement>('input[aria-label="Estimate"]');
    setValue(input, '');
    pressEnter(input);
    expect(updates).toEqual([{ id: 'a', updates: { estimate: null } }]);
  });
});

describe('task editor: labels', () => {
  it('shows the existing labels', () => {
    renderWindow([makeTask({ id: 'a', title: 'Labelled', labels: ['design', 'backend'] })], []);
    expandFirstRow();
    const text = field<HTMLElement>('[aria-label="Labels"]').textContent;
    expect(text).toContain('design');
    expect(text).toContain('backend');
  });

  it('adds a label, lower-cased, on Enter', () => {
    const updates: Update[] = [];
    renderWindow([makeTask({ id: 'a', title: 'Add one', labels: ['design'] })], updates);
    expandFirstRow();
    const input = field<HTMLInputElement>('input[aria-label="Add label"]');
    setValue(input, 'Milestone');
    pressEnter(input);
    expect(updates).toEqual([{ id: 'a', updates: { labels: ['design', 'milestone'] } }]);
  });

  it('ignores a label the task already has', () => {
    const updates: Update[] = [];
    renderWindow([makeTask({ id: 'a', title: 'Dup', labels: ['design'] })], updates);
    expandFirstRow();
    const input = field<HTMLInputElement>('input[aria-label="Add label"]');
    setValue(input, 'design');
    pressEnter(input);
    expect(updates).toEqual([]);
  });

  it('removes a label with its remove button', () => {
    const updates: Update[] = [];
    renderWindow([makeTask({ id: 'a', title: 'Drop one', labels: ['design', 'backend'] })], updates);
    expandFirstRow();
    const remove = field<HTMLButtonElement>('button[aria-label="Remove label design"]');
    act(() => {
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(updates).toEqual([{ id: 'a', updates: { labels: ['backend'] } }]);
  });
});

describe('task editor: the List view opens the same side panel', () => {
  it('has no estimate field until the row is opened in the panel', () => {
    renderWindow([makeTask({ id: 'a', title: 'List task' })], [], 'list');
    expect(container.querySelector('input[aria-label="Estimate"]')).toBeNull();
    const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open task panel"]');
    expect(open).toBeTruthy();
    act(() => {
      open!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('input[aria-label="Estimate"]')).toBeTruthy();
    expect(container.querySelector('input[aria-label="Add label"]')).toBeTruthy();
    expect(container.querySelector('select[aria-label="Task project"]')).toBeTruthy();
  });

  it('saves an estimate typed in the panel opened from the List', () => {
    const updates: Update[] = [];
    renderWindow([makeTask({ id: 'a', title: 'List task' })], updates, 'list');
    act(() => {
      container.querySelector('button[aria-label="Open task panel"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const input = field<HTMLInputElement>('input[aria-label="Estimate"]');
    setValue(input, '1w');
    pressEnter(input);
    expect(updates).toEqual([{ id: 'a', updates: { estimate: '1w' } }]);
  });
});
