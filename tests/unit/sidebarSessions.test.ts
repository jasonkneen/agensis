import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { partitionSidebarSessions } from '../../src/lib/sidebarSessions';

// The invariant under test: **a desktop does not decide which channels exist.**
//
// `chat_sessions.canvas_id` records which desktop a channel was created on, and
// the sidebar used to hide any session whose canvas_id was not the open
// desktop's — described in the code as the session's "project". That is the
// model inverted: the workspace is the project, a desktop is only a view of it.
// Switching desktop therefore removed channels from the sidebar, which reads as
// data loss. It is not hypothetical; an account hit it.

interface Session {
  id: string;
  archived_at?: string | null;
  canvas_id?: string | null;
  kind?: 'channel' | 'dm' | 'thread';
}

const predicates = {
  isDirect: (session: Session) => session.kind === 'dm',
  isThread: (session: Session) => session.kind === 'thread',
};

function partition(sessions: Session[]) {
  return partitionSidebarSessions(sessions, predicates);
}

describe('sessions are never hidden by which desktop is open', () => {
  const sessions: Session[] = [
    { id: 'on-main', canvas_id: 'base' },
    { id: 'on-desktop-2', canvas_id: 'canvas_two' },
    { id: 'unassigned', canvas_id: null },
    { id: 'thread-on-desktop-2', canvas_id: 'canvas_two', kind: 'thread' },
    { id: 'dm', canvas_id: 'canvas_two', kind: 'dm' },
  ];

  it('lists a channel created on another desktop', () => {
    expect(partition(sessions).channels.map(s => s.id))
      .toEqual(['on-main', 'on-desktop-2', 'unassigned']);
  });

  it('lists a thread created on another desktop', () => {
    expect(partition(sessions).threads.map(s => s.id)).toEqual(['thread-on-desktop-2']);
  });

  it('lists DMs, as it always did', () => {
    expect(partition(sessions).direct.map(s => s.id)).toEqual(['dm']);
  });

  // The strongest form of the guarantee: there is no desktop id to pass, so no
  // caller can reintroduce the scoping by supplying one.
  it('takes no desktop argument at all', () => {
    expect(partitionSidebarSessions.length).toBe(2);
  });

  it('groups the same sessions whatever canvas_id they carry', () => {
    const ids = (groups: ReturnType<typeof partition>) => ({
      channels: groups.channels.map(s => s.id),
      direct: groups.direct.map(s => s.id),
      threads: groups.threads.map(s => s.id),
    });
    const stripped = sessions.map(session => ({ id: session.id, kind: session.kind }));
    const scattered = sessions.map((session, index) => ({ ...session, canvas_id: `desktop_${index}` }));
    expect(ids(partition(stripped))).toEqual(ids(partition(sessions)));
    expect(ids(partition(scattered))).toEqual(ids(partition(sessions)));
  });
});

describe('the partition itself', () => {
  it('drops archived sessions from all three groups', () => {
    const groups = partition([
      { id: 'live' },
      { id: 'gone', archived_at: '2026-07-01T00:00:00Z' },
      { id: 'gone-dm', archived_at: '2026-07-01T00:00:00Z', kind: 'dm' },
    ]);
    expect(groups.channels.map(s => s.id)).toEqual(['live']);
    expect(groups.direct).toEqual([]);
    expect(groups.threads).toEqual([]);
  });

  // A DM can be thread-shaped (a split of a DM). It must stay a DM, or it is
  // listed twice — once under Threads and once under Direct messages.
  it('classifies a thread-shaped DM as a DM, not a thread', () => {
    const groups = partitionSidebarSessions(
      [{ id: 'dm-split' }],
      { isDirect: () => true, isThread: () => true },
    );
    expect(groups.direct.map(s => s.id)).toEqual(['dm-split']);
    expect(groups.threads).toEqual([]);
  });

  it('covers every non-archived session exactly once', () => {
    const groups = partition([
      { id: 'a' }, { id: 'b', kind: 'dm' }, { id: 'c', kind: 'thread' }, { id: 'd' },
    ]);
    const seen = [...groups.channels, ...groups.direct, ...groups.threads].map(s => s.id).sort();
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles an empty list', () => {
    expect(partition([])).toEqual({ channels: [], direct: [], threads: [] });
  });
});

// The unit test above only guards the helper. This guards the call site: a
// filter added back inline in the sidebar would slip past everything else.
describe('the sidebar does not filter its session list by desktop', () => {
  // vitest runs from the repo root (vitest.config.ts lives there).
  const source = readFileSync(resolve('src/components/layout/Sidebar.tsx'), 'utf8');

  it('never reads canvas_id off a session', () => {
    expect(source).not.toMatch(/session\s*\.\s*canvas_id/);
  });

  it('does not take an active-desktop prop to scope sessions with', () => {
    expect(source).not.toMatch(/activeCanvasId/);
  });
});
