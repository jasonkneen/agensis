import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';
import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';

// The second half of 746fed7. That commit clamped the panel BOX (min-w-0 on the
// aside, a wrapping title) and the box has been the right size ever since — but
// everything drawn inside it was still laid out ~80px wider than the box and
// clipped, so the reported symptom never went away: half a word of "In progress",
// half of "Add a description…".
//
// Cause: Radix ScrollArea puts a `display:table; min-width:100%` wrapper inside
// its viewport so content can be wider than the pane and scroll sideways. A
// table shrink-wraps to MIN-CONTENT, and this panel's min-content is 397px —
// `.task-detail`'s ml-8 + pl-5 + pr-3 around two `min-w-32` date labels — while
// the panel is clamped to 318-380px. Measured in a real browser at a 560px
// window: panel 318px, content 397px, 79px of every control clipped.
//
// jsdom loads no stylesheet and lays out nothing, so what is assertable here is
// the override being present — the same bargain the sticky-label test in
// tasksWindowRender.test.ts makes, and the reason the measurement above was done
// in Chromium rather than here.
const VIEWPORT_BLOCK = '[&_[data-radix-scroll-area-viewport]>div]:!block';

function makeTask(o: Partial<Task> & { id: string; title: string }): Task {
  return {
    workspace_id: 'ws-1', created_by: null, assignee_id: null, parent_id: null,
    description: '', status: 'in_progress', priority: 'normal', due_date: null,
    start_date: null, source_type: 'manual', source_id: null, completed_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...o,
  } as Task;
}

const LONG = "Can't escalate, share or save a thread — no path from a DM to another agent or channel";

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

function openEditor() {
  act(() => {
    root.render(createElement(TasksWindowContent, {
      tasks: [makeTask({ id: 't1', title: LONG })],
      members: [], agents: [], agentConnections: [],
      currentUserEmail: 'a@b.c', workspaceId: 'ws-1',
      onCreateTask: () => { }, onUpdateTask: () => { }, onToggleStatus: () => { },
      onDeleteTask: () => { }, onUpdateAgent: () => { },
    } as never));
  });
  const board = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Board');
  act(() => { board!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  const card = Array.from(container.querySelectorAll<HTMLElement>('div[draggable="true"]'))
    .find(c => c.textContent?.includes('Can\'t escalate'));
  act(() => { card!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  const panel = container.querySelector<HTMLElement>('.task-edit-panel');
  if (!panel) throw new Error('editor panel did not open');
  return panel;
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the task editor panel keeps its content inside its own width', () => {
  it('overrides the Radix table wrapper so content cannot exceed the pane', () => {
    const panel = openEditor();
    const scroller = panel.querySelector('[data-slot="scroll-area"]');
    expect(scroller).toBeTruthy();
    expect(scroller!.className).toContain(VIEWPORT_BLOCK);
  });

  it('lets the scrolled column give ground instead of setting a new min-width floor', () => {
    const panel = openEditor();
    const viewport = panel.querySelector('[data-slot="scroll-area-viewport"]');
    const column = viewport!.querySelector('.flex.flex-col.gap-4.p-3');
    expect(column).toBeTruthy();
    expect(column!.classList.contains('min-w-0')).toBe(true);
  });

  it('still clamps the panel box itself (the half 746fed7 already fixed)', () => {
    // A control, so a regression in the override above cannot be mistaken for
    // this one having quietly gone away too.
    const panel = openEditor();
    expect(panel.classList.contains('min-w-0')).toBe(true);
    expect(panel.style.width).not.toBe('');
  });
});
