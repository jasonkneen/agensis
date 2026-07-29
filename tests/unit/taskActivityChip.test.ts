import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';
import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';
import { clearAgentWork, resetAgentWork } from '../../src/lib/agentWork';

// The chip is a claim about the present tense, made in three places at once, so
// what it renders is asserted in a real DOM rather than inferred from the pure
// helper. Every case here fails if the chip is dropped from that view — which is
// the failure mode a logic-only test cannot see.

const WORKING = '[title^="An agent is working on this task"]';
const IDLE = '[title^="In progress — no agent is running"]';

// Anchored to the real clock: the live chip's expiry is measured against
// Date.now() inside the component (that is the point of it), so a frozen literal
// would make these pass or fail depending on the day they were run.
const NOW = Date.now();
const SESSION = 'sess-coder-dm';

function makeTask(o: Partial<Task> & { id: string; title: string }): Task {
  return {
    workspace_id: 'ws-1',
    created_by: null,
    assignee_id: null,
    parent_id: null,
    description: '',
    status: 'in_progress',
    priority: 'normal',
    due_date: null,
    start_date: null,
    source_type: 'chat',
    source_id: SESSION,
    completed_at: null,
    created_at: new Date(NOW - 86_400_000).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...o,
  } as Task;
}

/** Seed the agent-work store as if a turn were running in the task's DM. */
function runningJob(startedAt: number, sessionId = SESSION) {
  resetAgentWork(
    [{ id: 'job-1', session_id: sessionId, status: 'running', started_at: new Date(startedAt).toISOString() }],
    undefined,
    startedAt,
  );
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => { };
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() { }
      unobserve() { }
      disconnect() { }
    } as unknown as typeof ResizeObserver;
  }
});

function render(tasks: Task[]) {
  act(() => {
    root.render(createElement(TasksWindowContent, {
      tasks,
      members: [],
      agents: [],
      agentConnections: [],
      currentUserEmail: 'a@b.c',
      workspaceId: 'ws-1',
      onCreateTask: () => { },
      onUpdateTask: () => { },
      onToggleStatus: () => { },
      onDeleteTask: () => { },
      onUpdateAgent: () => { },
    } as never));
  });
}

function switchView(label: string) {
  const node = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === label);
  if (!node) throw new Error(`no view button "${label}"`);
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  clearAgentWork();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearAgentWork();
});

describe('the activity chip appears in all three views', () => {
  const TASKS = [makeTask({ id: 't1', title: 'Wire the panel' })];

  it('list: live chip while a job is running in the task chat', () => {
    runningJob(NOW + 400);
    render(TASKS);
    expect(container.querySelectorAll(WORKING).length).toBe(1);
    expect(container.querySelectorAll(IDLE).length).toBe(0);
  });

  it('board: live chip on the card', () => {
    runningJob(NOW + 400);
    render(TASKS);
    switchView('Board');
    expect(container.querySelectorAll(WORKING).length).toBe(1);
  });

  it('timeline: live chip on the row', () => {
    runningJob(NOW + 400);
    render(TASKS);
    switchView('Timeline');
    // Guard against the assertion passing because the view never switched.
    expect(container.querySelectorAll('[data-gantt-kind]').length).toBe(1);
    expect(container.querySelectorAll(WORKING).length).toBe(1);
  });

  it('timeline: chip rides the bar when the title fits inside it', () => {
    // A dated span wide enough to hold its own title puts the label INSIDE the
    // bar, which is the other of the chip's two placements.
    runningJob(NOW + 400);
    render([makeTask({
      id: 't1',
      title: 'Wire',
      start_date: new Date(NOW).toISOString(),
      due_date: new Date(NOW + 20 * 86_400_000).toISOString(),
    })]);
    switchView('Timeline');
    expect(container.querySelector('[data-gantt-label]')?.getAttribute('data-gantt-label')).toBe('inside');
    expect(container.querySelectorAll(WORKING).length).toBe(1);
  });
});

describe('what the chip refuses to say', () => {
  it('shows no chip at all on a task that is not in progress', () => {
    runningJob(NOW + 400);
    render([makeTask({ id: 't1', title: 'Not started', status: 'todo' })]);
    expect(container.querySelectorAll(WORKING).length).toBe(0);
    expect(container.querySelectorAll(IDLE).length).toBe(0);
  });

  it('falls back to the static chip when nothing is running', () => {
    render([makeTask({ id: 't1', title: 'Wire the panel' })]);
    expect(container.querySelectorAll(WORKING).length).toBe(0);
    expect(container.querySelectorAll(IDLE).length).toBe(1);
  });

  it('does not claim a job that started long after this task last moved', () => {
    // Same session (the agent's one DM), but the running turn is somebody else's
    // — a plain DM, or a different task. The stale row must stay static.
    runningJob(NOW + 6 * 3600_000);
    render([makeTask({ id: 't1', title: 'Abandoned hours ago' })]);
    expect(container.querySelectorAll(WORKING).length).toBe(0);
    expect(container.querySelectorAll(IDLE).length).toBe(1);
  });

  it('does not borrow another session\'s job', () => {
    runningJob(NOW + 400, 'some-other-session');
    render([makeTask({ id: 't1', title: 'Wire the panel' })]);
    expect(container.querySelectorAll(WORKING).length).toBe(0);
    expect(container.querySelectorAll(IDLE).length).toBe(1);
  });

  it('stops counting past the server ceiling on a running job', () => {
    // reapStuckAgentJobs kills a job at 30 minutes and its terminal write never
    // reaches realtime, so "running" outlives the daemon. The chip must not
    // still be ticking an hour later.
    runningJob(NOW - 90 * 60_000);
    render([makeTask({ id: 't1', title: 'Job whose daemon died' })]);
    expect(container.querySelectorAll(WORKING).length).toBe(0);
    expect(container.querySelectorAll(IDLE).length).toBe(1);
  });
});
