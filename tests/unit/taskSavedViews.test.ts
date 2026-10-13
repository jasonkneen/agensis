import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';

// Saved task views in the toolbar: saving the current settings, and applying a saved view.
// The saved views hook is mocked so the window needs no backend.

const store = vi.hoisted(() => ({
  views: [] as Array<{ id: string; name: string; config: Record<string, unknown> }>,
  created: [] as Array<{ name: string; config: Record<string, unknown> }>,
  deleted: [] as string[],
}));

vi.mock('../../src/hooks/useSavedViews', () => ({
  useSavedViews: () => ({
    views: store.views,
    createView: async (name: string, config: Record<string, unknown>) => {
      store.created.push({ name, config });
      return { id: 'new-view', name, config };
    },
    deleteView: async (id: string) => {
      store.deleted.push(id);
    },
    refetch: () => {},
  }),
}));

import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';
import { normalizeViewConfig } from '../../src/lib/pm/savedViews';

const DAY = 86400000;
const iso = (offset: number) => new Date(Date.now() + offset * DAY).toISOString();

function makeTask(o: Partial<Task> & { id: string; title: string }): Task {
  return {
    workspace_id: 'ws-1', created_by: null, assignee_id: null, parent_id: null, description: '', status: 'todo', priority: 'normal',
    due_date: null, start_date: null, source_type: 'manual', source_id: null, completed_at: null, created_at: iso(-10), updated_at: iso(-10), ...o,
  };
}

const TASKS = [makeTask({ id: 'late', title: 'Late job', due_date: iso(-3) }), makeTask({ id: 'fine', title: 'Fine job' })];

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
  store.views = [];
  store.created = [];
  store.deleted = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderWindow() {
  act(() => {
    root.render(
      createElement(TasksWindowContent, {
        tasks: TASKS, members: [], agents: [], agentConnections: [], currentUserEmail: 'a@b.c', workspaceId: 'ws-1',
        onCreateTask: () => null, onUpdateTask: () => {}, onToggleStatus: () => {}, onDeleteTask: () => {}, onUpdateAgent: () => {},
        forcedView: 'table',
      } as never),
    );
  });
}

const titles = () => Array.from(container.querySelectorAll('tbody tr')).map(row => row.querySelectorAll('td')[1]?.textContent ?? '');
const buttonByText = (text: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });

function setInput(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pickView(id: string) {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Saved views"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(select, id);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('saved task views', () => {
  it('saves the current toolbar settings under a name', async () => {
    renderWindow();
    click(buttonByText('Overdue'));
    click(buttonByText('Save view'));
    setInput('input[aria-label="Saved view name"]', 'My overdue');
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(store.created).toHaveLength(1);
    expect(store.created[0].name).toBe('My overdue');
    expect(store.created[0].config).toMatchObject({ overdueOnly: true, agentsOnly: false, filter: 'all', sort: 'default' });
  });

  it('does not save without a name', () => {
    renderWindow();
    click(buttonByText('Save view'));
    expect(buttonByText('Save').disabled).toBe(true);
  });

  it('applies a saved view: its settings filter the list', () => {
    store.views = [{ id: 'v1', name: 'Overdue only', config: normalizeViewConfig({ overdueOnly: true }) }];
    renderWindow();
    expect(titles()).toHaveLength(2);
    pickView('v1');
    expect(titles()).toEqual(['Late job']);
  });

  it('applies a saved search and sort together', () => {
    store.views = [{ id: 'v2', name: 'Search', config: normalizeViewConfig({ search: 'fine', sort: 'title' }) }];
    renderWindow();
    pickView('v2');
    expect(titles()).toEqual(['Fine job']);
  });

  it('deletes the selected view', () => {
    store.views = [{ id: 'v1', name: 'Overdue only', config: normalizeViewConfig({ overdueOnly: true }) }];
    renderWindow();
    expect(container.querySelector('button[aria-label="Delete saved view"]')).toBeNull();
    pickView('v1');
    click(container.querySelector('button[aria-label="Delete saved view"]')!);
    expect(store.deleted).toEqual(['v1']);
  });
});
