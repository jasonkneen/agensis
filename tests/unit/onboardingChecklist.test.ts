// Guards src/lib/onboardingChecklist.ts — the four first-run steps, extracted
// from GetStartedChecklist so the panel's checklist-vs-tips priority rule and
// the card itself read the same numbers.
//
// The done rules are the behaviour worth pinning: a workspace arrives with
// seeded agents, so "create your first agent" must not be ticked by them, and
// the channel/DM steps are told apart by the session folder alone.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_HANDLES,
  DIRECT_MESSAGES_FOLDER,
  computeChecklistSteps,
  remainingStepCount,
} from '../../src/lib/onboardingChecklist';

function steps(input: {
  agents?: { handle: string | null }[];
  sessions?: { folder: string | null }[];
  memberCount?: number;
}) {
  return computeChecklistSteps({
    agents: input.agents ?? [],
    sessions: input.sessions ?? [],
    memberCount: input.memberCount ?? 1,
  });
}

const done = (list: ReturnType<typeof steps>, id: string) => list.find(s => s.id === id)?.done;

describe('computeChecklistSteps', () => {
  it('starts a fresh workspace with four outstanding steps', () => {
    const list = steps({});
    expect(list.map(s => s.id)).toEqual(['agent', 'room', 'message', 'invite']);
    expect(remainingStepCount(list)).toBe(4);
  });

  it('does not count the seeded agents as an agent the user created', () => {
    const seeded = [...DEFAULT_AGENT_HANDLES].map(handle => ({ handle }));
    expect(done(steps({ agents: seeded }), 'agent')).toBe(false);
  });

  it('counts a seeded handle regardless of case', () => {
    expect(done(steps({ agents: [{ handle: 'Coder' }] }), 'agent')).toBe(false);
  });

  it('counts an agent the user actually created', () => {
    expect(done(steps({ agents: [{ handle: 'reviewer' }] }), 'agent')).toBe(true);
  });

  it('treats a handle-less agent as one the user created', () => {
    // A blank handle is not in the seeded set, and an agent with no handle at all
    // cannot have arrived from the default seed.
    expect(done(steps({ agents: [{ handle: null }] }), 'agent')).toBe(true);
  });

  it('tells a channel apart from a DM by folder alone', () => {
    const dm = steps({ sessions: [{ folder: DIRECT_MESSAGES_FOLDER }] });
    expect(done(dm, 'message')).toBe(true);
    expect(done(dm, 'room')).toBe(false);

    const channel = steps({ sessions: [{ folder: 'Channels' }] });
    expect(done(channel, 'room')).toBe(true);
    expect(done(channel, 'message')).toBe(false);
  });

  it('treats a session with no folder as a channel', () => {
    const list = steps({ sessions: [{ folder: null }] });
    expect(done(list, 'room')).toBe(true);
    expect(done(list, 'message')).toBe(false);
  });

  it('only counts the invite step once someone else is in the workspace', () => {
    expect(done(steps({ memberCount: 1 }), 'invite')).toBe(false);
    expect(done(steps({ memberCount: 2 }), 'invite')).toBe(true);
  });

  it('reaches zero remaining when all four are satisfied', () => {
    const list = steps({
      agents: [{ handle: 'reviewer' }],
      sessions: [{ folder: 'Channels' }, { folder: DIRECT_MESSAGES_FOLDER }],
      memberCount: 3,
    });
    expect(remainingStepCount(list)).toBe(0);
  });
});

describe('remainingStepCount', () => {
  it('counts only the unfinished steps', () => {
    expect(remainingStepCount([
      { id: 'agent', label: 'a', done: true },
      { id: 'room', label: 'b', done: false },
      { id: 'message', label: 'c', done: false },
    ])).toBe(2);
  });

  it('is zero for an empty list', () => {
    expect(remainingStepCount([])).toBe(0);
  });
});
