import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PresenceRoster } from '../../src/components/presence/PresenceRoster';
import { useWorkspacePresence, type WorkspacePresenceUser } from '../../src/hooks/useWorkspacePresence';
import type { AgentConnection, PresenceVisibilityMode } from '../../src/types';

// Two claims about the presence roster that only a mount can settle, both of
// them re-runs of bugs this panel has already shipped once.
//
//   1. AGENTS COME FROM THE DAEMON, NOT THE BROWSER. An agent never holds a
//      cursor or a LiveKit session, so a roster assembled from browser presence
//      alone shows an empty room while three agents are working in it. The
//      hook's only agent source is `agentConnections` — the daemon heartbeat's
//      view of liveness — and this asserts that with every browser-presence
//      input empty.
//
//   2. CONNECTION METADATA IS NOT ACTIVITY. Host and cwd used to be
//      pre-formatted into `activityItems` next to "Connected daemon", so the
//      panel rendered all three as a stack of truncating chips — one agent cost
//      four lines and a folder path you could not read. They are structured
//      fields now, and the ROW must not print them: the assertion is on the
//      rendered text, because the chips came back the moment the strings were
//      in reach of the row.

const AGENT_CWD = '/Users/jkneen/Documents/GitHub/agensis';
const AGENT_HOST = 'OzBook-M3-5.local';

function agentConnection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: 'conn-1',
    workspace_id: 'ws-1',
    agent_id: 'agent-1',
    name: 'Coder',
    handle: 'coder',
    host: AGENT_HOST,
    cwd: AGENT_CWD,
    status: 'online',
    metadata: {},
    connected_at: '',
    last_seen_at: '',
    updated_at: '',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix's popover measures its trigger; jsdom ships no ResizeObserver.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() { }
      unobserve() { }
      disconnect() { }
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Runs the hook for real and hands its result back — it is pure `useMemo`. */
function readPresence(inputs: Parameters<typeof useWorkspacePresence>[0]): WorkspacePresenceUser[] {
  let captured: WorkspacePresenceUser[] = [];
  function Probe() {
    captured = useWorkspacePresence(inputs);
    return null;
  }
  root = createRoot(container);
  act(() => { root.render(createElement(Probe)); });
  return captured;
}

function renderRoster(users: WorkspacePresenceUser[], modes: Record<string, PresenceVisibilityMode> = {}) {
  root = createRoot(container);
  act(() => {
    root.render(createElement(PresenceRoster, {
      users,
      getMode: (id?: string | null) => (id && modes[id]) || 'visible',
      onModeChange: () => { },
      favoriteIds: [],
      focusedUserId: null,
      onToggleFavorite: () => { },
      onFocusUser: () => { },
      onOpenRemoteWindow: () => { },
      onMessageAgent: () => { },
    }));
  });
  // The panel is a popover: nothing is in the document until it is opened.
  const trigger = container.querySelector<HTMLButtonElement>('.presence-avatar-trigger');
  act(() => { trigger?.click(); });
  return document.querySelector<HTMLElement>('[data-presence-popover]');
}

describe('presence roster: agents are sourced from the daemon', () => {
  const noBrowserPresence = {
    user: null,
    cursors: [],
    remotePresenceUsers: [] as never[],
    documents: [],
    sessions: [],
    agents: [],
  };

  it('lists a connected agent with zero cursors and zero browser presence', () => {
    const users = readPresence({ ...noBrowserPresence, agentConnections: [agentConnection()] });
    expect(users).toHaveLength(1);
    expect(users[0].kind).toBe('agent');
    expect(users[0].name).toBe('Coder');
  });

  it('drops an agent whose daemon has gone offline', () => {
    const users = readPresence({
      ...noBrowserPresence,
      agentConnections: [agentConnection({ status: 'offline' })],
    });
    expect(users).toHaveLength(0);
  });

  it('carries host and cwd as fields, never as activity chips', () => {
    const [agent] = readPresence({ ...noBrowserPresence, agentConnections: [agentConnection()] });
    expect(agent.host).toBe(AGENT_HOST);
    expect(agent.cwd).toBe(AGENT_CWD);
    // The regression itself: these three strings used to BE the activity list.
    expect(agent.activityItems ?? []).toEqual([]);
  });
});

describe('presence roster: the row', () => {
  const AGENT: WorkspacePresenceUser = {
    id: 'agent:agent-1',
    name: 'Coder',
    color: '#3b82f6',
    kind: 'agent',
    status: 'online',
    agentId: 'agent-1',
    handle: 'coder',
    host: AGENT_HOST,
    cwd: AGENT_CWD,
    windows: [],
  };
  const HUMAN: WorkspacePresenceUser = {
    id: 'user-2',
    name: 'devon',
    color: '#22c55e',
    activityItems: ['Channel: general', 'Doc: Roadmap'],
    windows: [],
  };
  const SELF: WorkspacePresenceUser = {
    id: 'user-1',
    name: 'jkneen',
    color: '#ef4444',
    isCurrentUser: true,
  };

  it('keeps the folder path off the row entirely', () => {
    const panel = renderRoster([AGENT]);
    expect(panel).not.toBeNull();
    expect(panel!.textContent).not.toContain(AGENT_CWD);
    expect(panel!.textContent).not.toContain(AGENT_HOST);
    expect(panel!.textContent).not.toContain('Connected daemon');
  });

  it('gives every participant exactly one row', () => {
    const panel = renderRoster([SELF, HUMAN, AGENT]);
    expect(panel!.querySelectorAll('[data-presence-row]')).toHaveLength(3);
  });

  it('gives each row at most one primary action plus one disclosure', () => {
    const panel = renderRoster([SELF, HUMAN, AGENT]);
    for (const row of Array.from(panel!.querySelectorAll('[data-presence-row]'))) {
      // The old row carried six: message, favourite, View, Visible, Dim, Muted.
      expect(row.querySelectorAll('button').length).toBeLessThanOrEqual(2);
    }
  });

  it('makes Message the primary for an agent and View for a human', () => {
    const panel = renderRoster([HUMAN, AGENT]);
    const [humanRow, agentRow] = Array.from(panel!.querySelectorAll('[data-presence-row]'));
    expect(humanRow.textContent).toContain('View');
    expect(agentRow.textContent).toContain('Message');
  });

  it('names a non-default visibility on the row, and stays quiet on the default', () => {
    expect(renderRoster([HUMAN])!.textContent).not.toContain('Dimmed');
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    expect(renderRoster([HUMAN], { 'user-2': 'hidden' })!.textContent).toContain('Muted');
  });

  it('summarises a human\'s activity in one line instead of a chip per item', () => {
    const panel = renderRoster([HUMAN]);
    expect(panel!.textContent).toContain('Channel: general +1');
    expect(panel!.textContent).not.toContain('Doc: Roadmap');
  });
});
