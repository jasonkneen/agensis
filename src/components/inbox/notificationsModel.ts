import type { InboxGroup } from './inboxModel';
import { inboxPreview, inboxTypeLabel, senderLabel } from './inboxModel';
import { isToday, type TaskNotification } from '../../lib/pm/taskNotifications';

// What the bell lists: the Inbox's own groups plus notifications derived from
// tasks, merged newest first and split into Today and Earlier (approved mock).

export type BellFilter = 'all' | 'mentions' | 'needs_you' | 'tasks';

export const BELL_FILTERS: Array<[BellFilter, string]> = [
  ['all', 'All'],
  ['mentions', 'Mentions'],
  ['needs_you', 'Needs you'],
  ['tasks', 'Tasks'],
];

export interface BellEntry {
  id: string;
  source: 'inbox' | 'task';
  /** First line: who and what happened. */
  heading: string;
  /** Second line: where. */
  detail: string;
  at: string;
  unread: boolean;
  /** Inbox group key, or task id. */
  target: string;
  tone: 'urgent' | 'normal';
}

const TASK_VERBS = { overdue: 'is overdue', assigned: 'was assigned to you', agent_done: 'was finished' } as const;

export function bellEntries(
  groups: InboxGroup[],
  tasks: TaskNotification[],
  filter: BellFilter,
  actorName: (id: string | null) => string,
): BellEntry[] {
  const entries: BellEntry[] = [];

  if (filter !== 'tasks') {
    for (const group of groups) {
      const needsYou = group.category === 'approval' || group.category === 'blocker' || group.category === 'error';
      if (filter === 'mentions' && group.category !== 'mention') continue;
      if (filter === 'needs_you' && !needsYou) continue;
      const label = inboxTypeLabel(group);
      entries.push({
        id: `inbox:${group.key}`,
        source: 'inbox',
        heading: `${senderLabel(group)}: ${label.text}${label.chip ? ` ${label.chip}` : ''}`,
        detail: inboxPreview(group),
        at: group.latestAt,
        unread: group.unreadCount > 0,
        target: group.key,
        tone: label.tone === 'muted' ? 'normal' : 'urgent',
      });
    }
  }

  if (filter === 'all' || filter === 'tasks') {
    for (const note of tasks) {
      const who = note.kind === 'overdue' ? '' : `${actorName(note.actorId)} `;
      entries.push({
        id: `task:${note.id}`,
        source: 'task',
        heading: `${who}${note.title} ${TASK_VERBS[note.kind]}`.trim(),
        detail: note.kind === 'agent_done' ? 'Moved to Done' : 'Task',
        at: note.at,
        unread: false,
        target: note.taskId,
        tone: note.kind === 'overdue' ? 'urgent' : 'normal',
      });
    }
  }

  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function splitByDay(entries: BellEntry[], now: number): { today: BellEntry[]; earlier: BellEntry[] } {
  return {
    today: entries.filter(entry => isToday(entry.at, now)),
    earlier: entries.filter(entry => !isToday(entry.at, now)),
  };
}
