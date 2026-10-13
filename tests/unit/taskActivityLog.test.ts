import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The activity log in the task drawer. The activity hook is mocked so it needs no backend.

const state = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));

vi.mock('../../src/hooks/useActivity', () => ({
  useActivity: () => ({ events: state.events, loading: false, logEvent: () => {}, refetch: () => {} }),
}));

import { TaskActivityLog } from '../../src/components/windows/TaskActivityLog';

const event = (id: string, entityId: string, title: string, createdAt: string, userId: string | null = null) => ({
  id, workspace_id: 'ws-1', user_id: userId, event_type: 'task_updated', entity_type: 'task', entity_id: entityId, title, metadata: {}, created_at: createdAt,
});

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  state.events = [];
});

function render(members: unknown[] = []) {
  act(() => {
    root.render(createElement(TaskActivityLog, { workspaceId: 'ws-1', userId: 'u1', taskId: 't1', members } as never));
  });
}

describe('TaskActivityLog', () => {
  it('says so when nothing is recorded for the task', () => {
    state.events = [event('e1', 'other-task', 'Other task changed', '2026-10-12T10:00:00.000Z')];
    render();
    expect(container.textContent).toContain('Nothing recorded for this task yet.');
    expect(container.textContent).not.toContain('Other task changed');
  });

  it('shows only this task, newest first', () => {
    state.events = [
      event('e1', 't1', 'Task created: Wireframes', '2026-10-10T09:00:00.000Z'),
      event('e2', 'other-task', 'Other task changed', '2026-10-12T09:00:00.000Z'),
      event('e3', 't1', 'Task completed: Wireframes', '2026-10-12T11:00:00.000Z'),
    ];
    render();
    const text = container.textContent ?? '';
    expect(text).toContain('Task completed: Wireframes');
    expect(text).toContain('Task created: Wireframes');
    expect(text).not.toContain('Other task changed');
    expect(text.indexOf('Task completed: Wireframes')).toBeLessThan(text.indexOf('Task created: Wireframes'));
  });

  it('shows the person by initials and an agent or the system as AI', () => {
    state.events = [
      event('e1', 't1', 'By a person', '2026-10-12T09:00:00.000Z', 'u9'),
      event('e2', 't1', 'By an agent', '2026-10-11T09:00:00.000Z', null),
    ];
    render([{ user_id: 'u9', email: 'sarah@example.com' }]);
    const badges = Array.from(container.querySelectorAll('li span:first-child')).map(el => el.textContent);
    expect(badges).toEqual(['SA', 'AI']);
  });

  it('shows at most eight events', () => {
    state.events = Array.from({ length: 12 }, (_, i) => event(`e${i}`, 't1', `Change ${i}`, `2026-10-${String(i + 1).padStart(2, '0')}T09:00:00.000Z`));
    render();
    expect(container.querySelectorAll('li')).toHaveLength(8);
    expect(container.textContent).toContain('Change 11');
    expect(container.textContent).not.toContain('Change 0');
  });
});
