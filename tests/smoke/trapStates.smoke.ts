// TRAP STATES: a stored preference must never be able to hide the control that
// clears it.
//
// This is the class the 2026-07-27 incident belongs to, and the reason it was
// invisible to every existing suite: each half was individually correct.
// `ownerFilter` persisted correctly. The Mine/All toggle rendered correctly
// under its condition. Only the COMBINATION — a stored 'mine' in a workspace
// whose agents were created by somebody else — filtered every agent away AND
// removed the only control that could undo it. Unrecoverable from the UI, and
// indistinguishable from data loss for the person holding it.
//
// So the assertion here is not "the toggle exists". It is RECOVERY: seed the
// stored preference that empties the surface, mount it, and require that either
// the filter yields, or some single control on screen brings the data back when
// clicked. Each control is tried on a fresh mount (see assertRecoverable), so
// nothing can recover by accident.
//
// ADDING A FILTER? The coverage guard at the bottom fails until the new
// preference is either in TRAPS or declared non-filtering with a reason.

import { describe, expect, it, beforeEach } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRecoverable, backend } from './harness';
import {
  AGENT_MARKERS,
  CURRENT_USER_EMAIL,
  CURRENT_USER_ID,
  INBOX_MARKERS,
  TASK_MARKERS,
  ACTIVITY_MARKERS,
  WORKSPACE_ID,
  asyncNull,
  asyncTrue,
  noop,
  seedActivity,
  seedAgents,
  seedInboxItems,
  seedTaskMembers,
  seedTasks,
} from './fixtures';

import { AgentsWindowContent } from '../../src/components/windows/AgentsWindowContent';
import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';
import { ActivityWindowContent } from '../../src/components/windows/ActivityWindowContent';
import { InboxWindowContent } from '../../src/components/inbox/InboxWindowContent';

/** The key `viewPreferenceKey` builds. Written raw so a change to it is caught. */
function prefKey(name: string): string {
  return `agensis.${name}:${WORKSPACE_ID}`;
}

interface TrapCase {
  surface: string;
  /** The persisted preference name, as passed to viewPreferenceKey. */
  preference: string;
  /** What is written to storage before the surface ever mounts. */
  stored: string;
  /** What the stored value does, for the failure line. */
  note: string;
  seeded: string[];
  /** Set up any seeded backend data this surface loads for itself. */
  prepare?: () => void;
  render: () => ReactElement;
}

function agentsWindow(): ReactElement {
  // Created by somebody else, and no live connections — so 'mine' matches
  // nothing and every agent reads as 'disconnected'.
  return createElement(AgentsWindowContent, {
    agents: seedAgents(),
    webhooks: [],
    connections: [],
    workspaceId: WORKSPACE_ID,
    currentUserId: CURRENT_USER_ID,
    onCreateAgent: asyncTrue,
    onUpdateAgent: noop,
    onDeleteAgent: noop,
    onDisconnectAgent: asyncNull,
    onCreateWebhook: asyncNull,
    onUpdateWebhook: asyncNull,
    onConfigureWebhook: async () => ({ webhook: null, error: null }),
    onOpenConnections: noop,
  });
}

function tasksWindow(tasks = seedTasks()): ReactElement {
  return createElement(TasksWindowContent, {
    tasks,
    members: seedTaskMembers(),
    agents: seedAgents(),
    agentConnections: [],
    currentUserEmail: CURRENT_USER_EMAIL,
    workspaceId: WORKSPACE_ID,
    currentUserId: CURRENT_USER_ID,
    onCreateTask: noop,
    onUpdateTask: noop,
    onToggleStatus: noop,
    onDeleteTask: noop,
    onUpdateAgent: noop,
  });
}

const TRAPS: TrapCase[] = [
  {
    // THE INCIDENT. Regression-locked here: a stored 'mine' over a workspace of
    // agents somebody else created.
    surface: 'Agents',
    preference: 'agents.owner-filter',
    stored: 'mine',
    note: "owner filter 'mine' with no agents created by the current user",
    seeded: AGENT_MARKERS,
    render: agentsWindow,
  },
  {
    surface: 'Agents',
    preference: 'agents.status-filter',
    stored: JSON.stringify(['busy']),
    note: "status filter 'busy' with every agent disconnected",
    seeded: AGENT_MARKERS,
    render: agentsWindow,
  },
  {
    surface: 'Tasks',
    preference: 'tasks.filter',
    stored: 'mine',
    note: "assignment filter 'mine' with nothing assigned to the current user",
    seeded: TASK_MARKERS,
    render: () => tasksWindow(),
  },
  {
    surface: 'Tasks',
    preference: 'tasks.hide-done',
    stored: '1',
    note: 'hide-done with every task already done',
    seeded: TASK_MARKERS,
    render: () => tasksWindow(seedTasks({ status: 'done', completed_at: '2026-07-27T04:00:00.000Z' })),
  },
  {
    surface: 'Activity',
    preference: 'activity.filter',
    stored: 'docs',
    note: "family filter 'docs' with only task events",
    seeded: ACTIVITY_MARKERS,
    render: () => createElement(ActivityWindowContent, {
      events: seedActivity(),
      loading: false,
      workspaceId: WORKSPACE_ID,
      currentUserId: CURRENT_USER_ID,
    }),
  },
  {
    surface: 'Inbox',
    preference: 'inbox.unread-only',
    stored: '1',
    note: 'unread-only with everything already read',
    seeded: INBOX_MARKERS,
    prepare: () => {
      backend.routes.set('/inbox', { items: seedInboxItems({ unread: false }), unreadCount: 0 });
    },
    render: () => createElement(InboxWindowContent, { workspaceId: WORKSPACE_ID }),
  },
];

beforeEach(() => {
  localStorage.clear();
  backend.reset();
});

describe('smoke: a stored preference cannot strand the user', () => {
  for (const trap of TRAPS) {
    it(`${trap.surface} recovers from ${trap.preference} = ${trap.stored}`, async () => {
      localStorage.setItem(prefKey(trap.preference), trap.stored);
      trap.prepare?.();
      const { recoveredBy } = await assertRecoverable(
        `${trap.surface} [${trap.note}]`,
        trap.render,
        trap.seeded,
      );
      expect(recoveredBy).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// Coverage guard
//
// Same idea as tests/lint-coverage.test.cjs: a check nobody remembers to extend
// is a check that quietly stops covering things. Every persisted preference in
// src/ must be accounted for — either it is one of the traps above, or it is
// listed here as something that cannot empty a list, with the reason.
//
// The scan keys off `viewPreferenceKey('name', …)`, which is the single door to
// a namespaced storage key, rather than off `usePersistedPreference` alone. It
// used to key off the hook, and that stopped seeing anything the moment a
// preference was read through a WRAPPER hook (usePaneSplit takes an already-
// built key, so the hook call names no preference at all) — the guard would
// have gone quiet and then reported the still-live 'agents.split' as stale. The
// `usePersistedPreference` pattern is still scanned, but only to catch a key
// built from a bare constant that skips viewPreferenceKey entirely.
// ---------------------------------------------------------------------------

const NOT_A_FILTER: Record<string, string> = {
  'agents.layout-view': 'chooses grid/network/both — every mode shows the same agents',
  // The Both view's divider position, in px of grid height. It decides how the
  // height is DIVIDED, never which agents exist — and it is the same class of
  // hazard as 'feedback.anchor' rather than of ownerFilter: a stored number
  // that could, unclamped, leave a pane at zero height. It cannot, because
  // agentSplitGridHeight re-derives it from the measured container on every
  // render (never from storage directly) and holds both panes above their
  // floors, shrinking them proportionally when the window is too short to seat
  // both. Pinned by the "stored in a tall window, restored in a short one" and
  // "neither pane below its minimum" cases in tests/unit/agentsView.test.ts.
  'agents.split': 'grid/map divider position, re-clamped against the live container every render — hides no data',
  'tasks.view': 'chooses list/kanban/gantt — every view shows the same tasks',
  'sidebar.dm-filter': 'scoped to the DM list in the sidebar, which is not one of the seeded surfaces',
  'memory.category-filter': 'MemorySection facts pane; the file browser is the seeded Memory surface',
  // The Agent-files divider position, in px of file-list width. Same class as
  // 'agents.split': a stored number that could, unclamped, squeeze a pane to
  // nothing. It cannot. `memorySplitListWidth` re-derives it from the measured
  // container on every render (never from storage directly) and holds BOTH the
  // list and the preview above their floors — so the file list, the agent chips
  // and every row stay on screen at every stored value and every window width.
  // Below MEMORY_SPLIT_MIN_CONTAINER_PX the divider is not rendered at all and
  // the stored number has no effect. Pinned by the "stored in a wide window,
  // restored into a narrow one" and "never puts either pane below its minimum"
  // cases in tests/unit/memoryBrowserView.test.ts, and by the shared clamp's own
  // cases in tests/unit/splitPane.test.ts.
  'memory.file-split': 'file-list/preview divider position, re-clamped against the live container every render — hides no data',
  'tips.dismissed': 'onboarding tips, not a data list',
  // Also collapses an owner broadcast in that same slot (OwnerMessageCard), so
  // a stored `true` means a message can ARRIVE collapsed. Not a filter and not a
  // trap: the header, the FOR YOU marker and the expand chevron all still
  // render, so the message announces itself and one click opens it. Pinned by
  // "arrives collapsed if the user had collapsed a tip" in
  // tests/unit/ownerMessageRender.test.ts.
  'tips.collapsed': 'collapses the tip / owner-message card to its header — the expander stays visible',
  // A dragged position, not a filter: it moves the feedback button, it never
  // decides which rows exist. It IS clamped back into the viewport on resize
  // (feedbackButtonDrag tests), so a stored position cannot strand the control
  // off-screen — which is the equivalent trap for a position rather than a list.
  'feedback.anchor': 'stored button position, clamped into view on resize — hides no data',
};

/** Preferences whose key is a bare constant rather than viewPreferenceKey(...). */
const UNSCOPED_PREFERENCES = new Set(['CHECKLIST_DISMISS_KEY', 'CHECKLIST_COLLAPSE_KEY']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('smoke: every persisted preference is accounted for', () => {
  it('no filter escapes the trap-state gate', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const found = new Set<string>();
    const unresolved: string[] = [];

    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8');
      // Every namespaced key in the app is built here, wherever it is then read
      // from — directly, or through a wrapper hook like usePaneSplit.
      for (const match of text.matchAll(/viewPreferenceKey\(\s*'([^']+)'/g)) {
        found.add(match[1]);
      }
      // A key built from a bare constant never reaches viewPreferenceKey, so it
      // would be invisible above. The call spans lines:
      // usePersistedPreference(\n  viewPreferenceKey('x', …
      const pattern = /usePersistedPreference\(\s*(?:viewPreferenceKey\(\s*'([^']+)'|([A-Z_][A-Z0-9_]*))/g;
      for (const match of text.matchAll(pattern)) {
        const constant = match[2];
        if (constant && !UNSCOPED_PREFERENCES.has(constant)) {
          unresolved.push(`${file.slice(src.length + 1)}: ${constant}`);
        }
      }
    }

    expect(
      unresolved,
      'A persisted preference is keyed by a constant this guard does not know. Add it to '
      + 'UNSCOPED_PREFERENCES (with a reason it cannot empty a list) or key it through viewPreferenceKey.',
    ).toEqual([]);

    const covered = new Set(TRAPS.map(t => t.preference));
    const uncovered = [...found].filter(name => !covered.has(name) && !(name in NOT_A_FILTER)).sort();

    expect(
      uncovered,
      'These persisted preferences are covered by NOTHING. If one can filter a list, add a TrapCase '
      + 'for it in tests/smoke/trapStates.smoke.ts; if it cannot, add it to NOT_A_FILTER with the reason. '
      + 'A persisted filter that hides its own clearing control is the 2026-07-27 incident.',
    ).toEqual([]);

    // The guard must also not rot in the other direction: an entry here for a
    // preference that no longer exists is dead weight that hides a real gap.
    const stale = [...covered, ...Object.keys(NOT_A_FILTER)].filter(name => !found.has(name)).sort();
    expect(stale, 'Listed here but no longer used in src/ — remove it.').toEqual([]);
  });
});
