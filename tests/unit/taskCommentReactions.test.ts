import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Task } from '../../src/types';

// Emoji reactions on task comments, driven through the real task panel. The comments hook is
// mocked, so the test sees exactly what the panel asks it to save.

const hook = vi.hoisted(() => ({
  comments: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: string; updates: Record<string, unknown> }>,
}));

vi.mock('../../src/hooks/useTaskComments', () => ({
  useTaskComments: () => ({
    comments: hook.comments,
    topLevel: hook.comments,
    replyMap: {},
    loading: false,
    createComment: async () => null,
    updateComment: async (id: string, updates: Record<string, unknown>) => {
      hook.updates.push({ id, updates });
      return null;
    },
    resolveComment: async () => null,
    deleteComment: async () => true,
    refetch: () => {},
  }),
}));

import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';

const TASK: Task = {
  id: 't1', workspace_id: 'ws-1', created_by: null, assignee_id: null, parent_id: null, title: 'Commented task', description: '',
  status: 'todo', priority: 'normal', due_date: null, start_date: null, source_type: 'manual', source_id: null, completed_at: null,
  created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z',
};

const comment = (reactions: Record<string, string[]> | undefined) => ({
  id: 'c1', task_id: 't1', workspace_id: 'ws-1', user_id: 'someone', parent_id: null, content: 'Looks good', resolved: false,
  reactions, created_at: '2026-10-12T09:00:00.000Z', updated_at: '2026-10-12T09:00:00.000Z',
});

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
  hook.comments = [];
  hook.updates = [];
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

function openPanel(currentUserId: string | undefined) {
  act(() => {
    root.render(
      createElement(TasksWindowContent, {
        tasks: [TASK], members: [], agents: [], agentConnections: [], currentUserEmail: 'me@example.com', workspaceId: 'ws-1', currentUserId,
        onCreateTask: () => null, onUpdateTask: () => {}, onToggleStatus: () => {}, onDeleteTask: () => {}, onUpdateAgent: () => {},
        forcedView: 'table',
      } as never),
    );
  });
  act(() => {
    container.querySelector('tbody tr td:nth-child(2)')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });

const reactions = () => container.querySelector('[data-testid="comment-reactions"]') as HTMLElement;
const pickerButton = (emoji: string) =>
  Array.from(reactions().querySelectorAll<HTMLButtonElement>('button[aria-label^="React with"]')).find(b => b.textContent === emoji);
const chipButtons = () => Array.from(reactions().querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));

describe('task comment reactions', () => {
  it('shows each reaction with its count and marks the ones I made', () => {
    hook.comments = [comment({ '👍': ['me', 'other'], '✅': ['other'] })];
    openPanel('me');
    const chips = chipButtons();
    expect(chips.map(c => c.textContent?.trim())).toEqual(['👍 2', '✅ 1']);
    expect(chips.map(c => c.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });

  it('shows no chips when a comment has no reactions, and copes with the column being absent', () => {
    hook.comments = [comment(undefined)];
    openPanel('me');
    expect(chipButtons()).toHaveLength(0);
  });

  it('clicking a chip I made removes my reaction', () => {
    hook.comments = [comment({ '👍': ['me', 'other'] })];
    openPanel('me');
    click(chipButtons()[0]);
    expect(hook.updates).toEqual([{ id: 'c1', updates: { reactions: { '👍': ['other'] } } }]);
  });

  it('clicking a chip I did not make adds my reaction', () => {
    hook.comments = [comment({ '✅': ['other'] })];
    openPanel('me');
    click(chipButtons()[0]);
    expect(hook.updates).toEqual([{ id: 'c1', updates: { reactions: { '✅': ['other', 'me'] } } }]);
  });

  it('the + button opens the picker and choosing an emoji adds it', () => {
    hook.comments = [comment({})];
    openPanel('me');
    expect(pickerButton('🎉')).toBeUndefined();
    click(reactions().querySelector('button[aria-label="Add reaction"]')!);
    expect(pickerButton('🎉')).toBeTruthy();
    click(pickerButton('🎉')!);
    expect(hook.updates).toEqual([{ id: 'c1', updates: { reactions: { '🎉': ['me'] } } }]);
    expect(pickerButton('🎉')).toBeUndefined();
  });

  it('offers no way to react when nobody is signed in', () => {
    hook.comments = [comment({ '👍': ['other'] })];
    openPanel(undefined);
    expect(reactions().querySelector('button[aria-label="Add reaction"]')).toBeNull();
    click(chipButtons()[0]);
    expect(hook.updates).toEqual([]);
  });
});
