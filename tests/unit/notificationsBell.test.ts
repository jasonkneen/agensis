import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxGroup } from '../../src/components/inbox/inboxModel';
import { bellEntries, splitByDay } from '../../src/components/inbox/notificationsModel';
import { NotificationsBell } from '../../src/components/notifications/NotificationsBell';
import type { TaskNotification } from '../../src/lib/pm/taskNotifications';

vi.mock('../../src/hooks/useAgentRegistrations', () => ({ useAgentRegistrations: () => ({ pending: [] }) }));
vi.mock('../../src/hooks/useActivity', () => ({ useActivity: () => ({ events: [], loading: false, logEvent: () => {}, refetch: () => {} }) }));

const NOW = Date.now();
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60 * 1000).toISOString();

function group(o: Partial<InboxGroup> & { key: string }): InboxGroup {
  return {
    category: 'mention', title: 'Sarah: look at this', body: 'look at this', actorName: 'Sarah', items: [], latestAt: iso(5), unreadCount: 1,
    sessionId: null, entityType: null, entityId: null, ...o,
  };
}
const note = (o: Partial<TaskNotification> & { id: string }): TaskNotification => ({ kind: 'overdue', taskId: 't1', title: 'Press release', actorId: null, at: iso(60 * 30), ...o });
const actorName = (id: string | null) => (id ? `agent-${id}` : 'Someone');

describe('bellEntries', () => {
  const groups = [group({ key: 'm' }), group({ key: 'b', category: 'blocker', actorName: 'Atlas', title: 'Which logo?', latestAt: iso(2) })];
  const tasks = [note({ id: 'n1' })];

  it('merges inbox groups and task notes, newest first', () => {
    expect(bellEntries(groups, tasks, 'all', actorName).map(e => e.id)).toEqual(['inbox:b', 'inbox:m', 'task:n1']);
  });

  it('filters to mentions, to items that need you, and to tasks', () => {
    expect(bellEntries(groups, tasks, 'mentions', actorName).map(e => e.id)).toEqual(['inbox:m']);
    expect(bellEntries(groups, tasks, 'needs_you', actorName).map(e => e.id)).toEqual(['inbox:b']);
    expect(bellEntries(groups, tasks, 'tasks', actorName).map(e => e.id)).toEqual(['task:n1']);
  });

  it('words an agent-finished task with the agent name', () => {
    const [entry] = bellEntries([], [note({ id: 'n2', kind: 'agent_done', actorId: 'atlas', title: 'Build layout' })], 'all', actorName);
    expect(entry.heading).toBe('agent-atlas Build layout was finished');
  });

  it('splits into today and earlier', () => {
    const { today, earlier } = splitByDay(bellEntries(groups, [note({ id: 'old', at: iso(60 * 72) })], 'all', actorName), NOW);
    expect(today.map(e => e.id)).toEqual(['inbox:b', 'inbox:m']);
    expect(earlier.map(e => e.id)).toEqual(['task:old']);
  });
});

describe('NotificationsBell', () => {
  let container: HTMLDivElement;
  let root: Root;
  const calls = { read: [] as string[], inbox: 0, task: [] as string[] };

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (typeof globalThis.ResizeObserver === 'undefined') {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
  });
  beforeEach(() => {
    calls.read = [];
    calls.inbox = 0;
    calls.task = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(
        createElement(NotificationsBell, {
          workspaceId: 'ws-1',
          variant: 'inline',
          feeds: {
            groups: [group({ key: 'm' })],
            taskNotes: [note({ id: 'n1' })],
            unreadCount: 1,
            actorName,
            onMarkRead: vi.fn(async (key: string) => {
              calls.read.push(key);
              return true;
            }),
            onOpenInbox: () => {
              calls.inbox += 1;
            },
            onOpenTask: (id: string) => calls.task.push(id),
          },
        }),
      );
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  const bell = () => container.querySelector('button[aria-label^="Notifications"]') as HTMLElement;
  const popover = () => document.querySelector('[data-slot="popover-content"]');

  it('shows a badge with unread inbox items plus overdue tasks', () => {
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 pending');
  });

  it('opens the popover listing entries and marks everything read', () => {
    click(bell());
    expect(popover()?.textContent).toContain('Press release is overdue');
    const markAll = Array.from(popover()!.querySelectorAll('button')).find(b => b.textContent === 'Mark all read') as HTMLElement;
    click(markAll);
    expect(calls.read).toEqual(['m']);
  });

  it('opens the task for a task entry and the Inbox for an inbox entry', () => {
    click(bell());
    const rows = Array.from(popover()!.querySelectorAll('button'));
    click(rows.find(r => r.textContent?.includes('Press release'))!);
    expect(calls.task).toEqual(['t1']);
    click(bell());
    click(Array.from(popover()!.querySelectorAll('button')).find(r => r.textContent?.includes('Sarah'))!);
    expect(calls.inbox).toBe(1);
  });
});
