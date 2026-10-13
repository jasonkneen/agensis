import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommandPalette from '../../src/components/search/CommandPalette';
import type { Project } from '../../src/hooks/useProjects';

// The Section 10 palette additions: projects are searchable, and three actions start
// work in the Projects window. The dialog parts are stubbed so only the items render.

vi.mock('../../src/lib/backendClient', () => ({ backendClient: { from: vi.fn() } }));
vi.mock('@agensis/ui/components/command', () => {
  const box = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return {
    Command: box, CommandDialog: box, CommandEmpty: box, CommandGroup: box, CommandInput: () => null, CommandList: box,
    CommandItem: ({ children, value, onSelect }: { children?: React.ReactNode; value: string; onSelect?: () => void }) =>
      React.createElement('div', { 'data-result': value, onClick: onSelect }, children),
  };
});

const project = (o: Partial<Project> & { id: string; name: string }) => ({ project_key: null, description: '', status: 'active', archived: false, ...o }) as Project;

let host: HTMLDivElement;
let root: Root;
const calls = { project: [] as string[], newTask: 0, newProject: 0, dashboard: 0, closed: 0 };

function render(props: Record<string, unknown> = {}) {
  act(() =>
    root.render(
      React.createElement(CommandPalette, {
        open: true, documents: [], sessions: [], facts: [],
        onClose: () => { calls.closed += 1; }, onDocumentOpen: vi.fn(), onSessionOpen: vi.fn(), onViewChange: vi.fn(),
        projects: [project({ id: 'p1', name: 'Website Redesign', project_key: 'WEB' }), project({ id: 'p2', name: 'Old one', archived: true })],
        onProjectOpen: (id: string) => calls.project.push(id),
        onNewTask: () => { calls.newTask += 1; },
        onNewProject: () => { calls.newProject += 1; },
        onOpenProjectsDashboard: () => { calls.dashboard += 1; },
        ...props,
      }),
    ),
  );
}
const result = (id: string) => host.querySelector(`[data-result="${id}"]`) as HTMLElement;
const click = (el: HTMLElement) => act(() => el.click());

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(calls, { project: [], newTask: 0, newProject: 0, dashboard: 0, closed: 0 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('lists live projects, not archived ones, and opens a project on select', () => {
  render();
  expect(result('project-p1')).toBeTruthy();
  expect(result('project-p2')).toBeNull();
  expect(result('project-p1').textContent).toContain('WEB');
  click(result('project-p1'));
  expect(calls.project).toEqual(['p1']);
  expect(calls.closed).toBe(1);
});

it('offers New task, New project and Go to Projects dashboard', () => {
  render();
  click(result('action-new-task'));
  click(result('action-new-project'));
  click(result('action-go-projects-dashboard'));
  expect([calls.newTask, calls.newProject, calls.dashboard]).toEqual([1, 1, 1]);
});

it('leaves those actions out when no handler is given', () => {
  render({ onNewTask: undefined, onNewProject: undefined, onOpenProjectsDashboard: undefined });
  expect(result('action-new-task')).toBeNull();
  expect(result('action-new-project')).toBeNull();
  expect(result('action-go-projects-dashboard')).toBeNull();
});
