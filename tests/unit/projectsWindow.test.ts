import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';

// The Projects window: the list, the project page tabs, and the Activity tab. The data hooks are
// mocked so the window renders without a backend.

const data = vi.hoisted(() => {
  const project = {
    id: 'p1', workspace_id: 'ws-1', created_by: null, name: 'Website Redesign', project_key: 'WEB', description: 'New site',
    status: 'active', color: 'indigo', icon: 'globe', lead_id: null, start_date: null, due_date: null,
    channel_id: null, brief_document_id: null, archived: false, version: 1, created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z',
  };
  const events = [
    { id: 'e1', workspace_id: 'ws-1', user_id: null, event_type: 'task_created', entity_type: 'task', entity_id: 't1', title: 'Task created: Wireframes', metadata: {}, created_at: '2026-10-12T09:00:00.000Z' },
    { id: 'e2', workspace_id: 'ws-1', user_id: null, event_type: 'task_created', entity_type: 'task', entity_id: 'elsewhere', title: 'Task created: Not in this project', metadata: {}, created_at: '2026-10-12T10:00:00.000Z' },
  ];
  return { project, events };
});

vi.mock('../../src/hooks/useProjects', () => ({
  useProjects: () => ({ projects: [data.project], createProject: async () => null, updateProject: async () => null, refetch: () => {} }),
}));
vi.mock('../../src/hooks/useActivity', () => ({
  useActivity: () => ({ events: data.events, loading: false, logEvent: () => {}, refetch: () => {} }),
}));

import { ProjectsWindowContent } from '../../src/components/windows/ProjectsWindowContent';

function makeTask(o: Partial<Task> & { id: string; title: string }): Task {
  return {
    workspace_id: 'ws-1', created_by: null, assignee_id: null, parent_id: null, description: '', status: 'todo', priority: 'normal',
    due_date: null, start_date: null, source_type: 'manual', source_id: null, completed_at: null,
    created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z', project_id: 'p1', ...o,
  } as Task;
}

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
      createElement(ProjectsWindowContent, {
        tasksProps: {
          tasks: [makeTask({ id: 't1', title: 'Wireframes' })],
          members: [], agents: [], agentConnections: [], currentUserEmail: 'a@b.c', workspaceId: 'ws-1',
          onCreateTask: () => null, onUpdateTask: () => {}, onToggleStatus: () => {}, onDeleteTask: () => {}, onUpdateAgent: () => {},
        },
      } as never),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });

function openProject() {
  const card = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Website Redesign'));
  if (!card) throw new Error('no project card');
  click(card);
}

const tab = (name: string) => Array.from(container.querySelectorAll('[role="tab"]')).find(t => t.textContent?.trim() === name) as HTMLElement;

describe('Projects window', () => {
  it('lists the project with its key and task count', () => {
    expect(container.textContent).toContain('Website Redesign');
    expect(container.textContent).toContain('WEB');
    expect(container.textContent).toContain('1 task');
  });

  it('opens the project page with every tab', () => {
    openProject();
    const names = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent?.trim());
    expect(names).toEqual(['Overview', 'Board', 'List', 'Table', 'Calendar', 'Timeline', 'Activity']);
  });

  it('shows only this project task activity on the Activity tab', () => {
    openProject();
    click(tab('Activity'));
    expect(container.textContent).toContain('Task created: Wireframes');
    expect(container.textContent).not.toContain('Not in this project');
  });

  it('shows the Board with the view switcher hidden inside a project', () => {
    openProject();
    click(tab('Board'));
    expect(container.textContent).toContain('Wireframes');
    expect(Array.from(container.querySelectorAll('[role="radio"]')).some(r => r.textContent?.trim() === 'Timeline')).toBe(false);
  });
});
