import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentConnection, Task, WorkspaceAgent } from '../../src/types';
import { agentPanelState } from '../../src/lib/pm/agentPanel';
import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';

// The agent panel in the task drawer: the wording is pure and tested on its own, and the panel
// is checked through the real task drawer.

const agent = (over: Partial<WorkspaceAgent> = {}) => ({ id: 'ag1', name: 'Atlas', handle: 'atlas', enabled: true, ...over }) as WorkspaceAgent;
const connection = (over: Partial<AgentConnection> = {}) =>
  ({ id: 'c1', workspace_id: 'ws-1', agent_id: 'ag1', name: 'Atlas', handle: 'atlas', host: 'h', cwd: '/', status: 'online', metadata: {}, connected_at: '2026-10-12T09:00:00.000Z', last_seen_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z', ...over }) as AgentConnection;

describe('agentPanelState', () => {
  it('has no agent for an unassigned task or a person', () => {
    expect(agentPanelState({ assignee_id: null, status: 'todo' }, [agent()], []).agent).toBeNull();
    expect(agentPanelState({ assignee_id: 'a-person', status: 'todo' }, [agent()], []).agent).toBeNull();
  });

  it('reports the agent as busy, online or not connected from its live connection', () => {
    const task = { assignee_id: 'ag1', status: 'in_progress' as const };
    expect(agentPanelState(task, [agent()], [connection({ status: 'busy' })]).presence).toBe('busy');
    expect(agentPanelState(task, [agent()], [connection({ status: 'online' })]).presence).toBe('online');
    expect(agentPanelState(task, [agent()], []).presence).toBe('offline');
    expect(agentPanelState(task, [agent()], [connection({ status: 'offline' })]).presence).toBe('offline');
  });

  it('ignores another agent\'s connection', () => {
    expect(agentPanelState({ assignee_id: 'ag1', status: 'todo' }, [agent()], [connection({ agent_id: 'other' })]).presence).toBe('offline');
  });

  it('describes where the task stands', () => {
    const online = [connection()];
    expect(agentPanelState({ assignee_id: 'ag1', status: 'todo' }, [agent()], online).summary).toBe('Assigned. Waiting for its turn.');
    expect(agentPanelState({ assignee_id: 'ag1', status: 'todo' }, [agent()], []).summary).toBe('Waiting for the agent to connect.');
    expect(agentPanelState({ assignee_id: 'ag1', status: 'in_progress' }, [agent()], online).summary).toBe('Working on it.');
    expect(agentPanelState({ assignee_id: 'ag1', status: 'in_progress' }, [agent()], []).summary).toBe('Started, but the agent is not connected right now.');
    expect(agentPanelState({ assignee_id: 'ag1', status: 'done' }, [agent()], online).summary).toBe('Finished.');
    expect(agentPanelState({ assignee_id: 'ag1', status: 'cancelled' }, [agent()], online).summary).toBe('Cancelled.');
  });

  it('says so when the agent is disabled', () => {
    const state = agentPanelState({ assignee_id: 'ag1', status: 'todo' }, [agent({ enabled: false })], [connection()]);
    expect(state.disabled).toBe(true);
    expect(state.summary).toContain('disabled');
  });
});

function makeTask(over: Partial<Task>): Task {
  return {
    id: 't1', workspace_id: 'ws-1', created_by: null, assignee_id: 'ag1', parent_id: null, title: 'Agent task', description: '', status: 'todo',
    priority: 'normal', due_date: null, start_date: null, source_type: 'manual', source_id: null, completed_at: null,
    created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z', ...over,
  };
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function openDrawer(task: Task, agents: WorkspaceAgent[], connections: AgentConnection[]) {
  act(() => {
    root.render(
      createElement(TasksWindowContent, {
        tasks: [task], members: [], agents, agentConnections: connections, currentUserEmail: 'me@example.com', workspaceId: 'ws-1',
        onCreateTask: () => null, onUpdateTask: () => {}, onToggleStatus: () => {}, onDeleteTask: () => {}, onUpdateAgent: () => {},
        forcedView: 'table',
      } as never),
    );
  });
  act(() => {
    container.querySelector('tbody tr td:nth-child(2)')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const panel = () => container.querySelector('section[aria-label="Agent working on this task"]') as HTMLElement | null;

describe('agent panel in the task drawer', () => {
  it('shows the agent, that it is busy, and that it is working', () => {
    openDrawer(makeTask({ status: 'in_progress' }), [agent()], [connection({ status: 'busy' })]);
    expect(panel()).toBeTruthy();
    expect(panel()!.textContent).toContain('Atlas');
    expect(panel()!.textContent).toContain('@atlas');
    expect(panel()!.textContent).toContain('Busy');
    expect(panel()!.textContent).toContain('Working on it.');
    expect(panel()!.querySelector('[data-presence="busy"]')).toBeTruthy();
  });

  it('shows that the agent is not connected and the task is waiting', () => {
    openDrawer(makeTask({ status: 'todo' }), [agent()], []);
    expect(panel()!.textContent).toContain('Not connected');
    expect(panel()!.textContent).toContain('Waiting for the agent to connect.');
  });

  it('is absent for a task assigned to a person', () => {
    openDrawer(makeTask({ assignee_id: 'a-person' }), [agent()], []);
    expect(panel()).toBeNull();
  });

  it('is absent for an unassigned task', () => {
    openDrawer(makeTask({ assignee_id: null }), [agent()], []);
    expect(panel()).toBeNull();
  });
});
