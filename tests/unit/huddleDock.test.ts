import { describe, expect, it } from 'vitest';
import {
  buildDockParticipants,
  DEFAULT_HUDDLE_DOCK_TAB,
  normalizeHuddleDockTab,
  participantInitials,
  shouldShowHuddleDock,
} from '../../src/lib/huddleDock';

// The huddle used to live inside the channel view, so navigating away dropped
// the call. It is now one floating panel mounted above every view. These pin
// the decisions that panel makes, none of which need a LiveKit connection.

describe('shouldShowHuddleDock', () => {
  const base = { hasTarget: true, connected: false, live: false, hasError: false };

  it('shows nothing until the user has actually asked for a huddle', () => {
    expect(shouldShowHuddleDock({ ...base, hasTarget: false, connected: true, live: true })).toBe(false);
  });

  it('stays up while CONNECTING — a target exists but the socket is not yet open', () => {
    // Hiding here makes the button look broken for the second before audio is up.
    expect(shouldShowHuddleDock({ ...base, connected: false, live: true })).toBe(true);
  });

  it('stays up on ERROR, which is when the user most needs something to read', () => {
    // A panel that vanishes on failure leaves no trace of what went wrong.
    expect(shouldShowHuddleDock({ ...base, hasError: true })).toBe(true);
  });

  it('stays up while connected even if the huddle row is not marked live', () => {
    expect(shouldShowHuddleDock({ ...base, connected: true })).toBe(true);
  });

  it('closes once there is no connection, no call and no error', () => {
    expect(shouldShowHuddleDock(base)).toBe(false);
  });
});

describe('buildDockParticipants', () => {
  it('includes AGENTS, which no presence event will ever mention', () => {
    // An agent is in the call in every way that matters — it hears the
    // transcript and speaks — but never holds a LiveKit connection. Dropping
    // them makes a call with three agents look empty.
    const out = buildDockParticipants({
      humans: [{ identity: 'user:1', name: 'Jason' }],
      agents: [{ id: 'a1', name: 'boris' }],
    });
    expect(out.map(p => p.kind)).toEqual(['human', 'agent']);
  });

  it('marks the active agent and the one currently speaking', () => {
    const out = buildDockParticipants({
      humans: [],
      agents: [{ id: 'a1', name: 'boris' }, { id: 'a2', name: 'Coder' }],
      activeAgentId: 'a1',
      speakingName: 'Coder',
    });
    expect(out.find(p => p.id === 'a1')?.active).toBe(true);
    expect(out.find(p => p.id === 'a2')?.speaking).toBe(true);
  });

  it('never lists the same identity twice', () => {
    const out = buildDockParticipants({
      humans: [{ identity: 'user:1', name: 'Jason' }, { identity: 'user:1', name: 'Jason' }],
      agents: [],
    });
    expect(out).toHaveLength(1);
  });

  it('skips entries with no id rather than rendering a blank chip', () => {
    const out = buildDockParticipants({
      humans: [{ identity: '  ', name: 'Ghost' }],
      agents: [{ id: '', name: 'Nobody' }],
    });
    expect(out).toEqual([]);
  });
});

describe('participantInitials', () => {
  it('takes one letter from each of two names', () => {
    expect(participantInitials('Jason Kneen')).toBe('JK');
  });

  it('takes two letters from a single name', () => {
    expect(participantInitials('boris')).toBe('BO');
  });

  it('never returns an empty chip', () => {
    // NO EMOJI and no blanks: a chip with nothing in it reads as a bug.
    expect(participantInitials('')).toBe('??');
    expect(participantInitials('   ')).toBe('??');
  });
});

describe('normalizeHuddleDockTab', () => {
  it('accepts the real tabs and rejects anything else', () => {
    expect(normalizeHuddleDockTab('transcript')).toBe('transcript');
    expect(normalizeHuddleDockTab('notes')).toBe('notes');
    expect(normalizeHuddleDockTab('nonsense')).toBe(DEFAULT_HUDDLE_DOCK_TAB);
    expect(normalizeHuddleDockTab(null)).toBe(DEFAULT_HUDDLE_DOCK_TAB);
    expect(normalizeHuddleDockTab({ tab: 'chat' })).toBe(DEFAULT_HUDDLE_DOCK_TAB);
  });
});
