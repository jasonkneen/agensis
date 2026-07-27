import { describe, expect, it } from 'vitest';
import {
  buildDockParticipants,
  DEFAULT_HUDDLE_DOCK_TAB,
  IDLE_HUDDLE_LOCAL,
  normalizeHuddleDockTab,
  participantInitials,
  sameHuddleLocalState,
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

  it('stays up for a RECORD, which is neither live nor connected', () => {
    // Reading an ended huddle from a channel marker. The huddle side panel is
    // gone, so this is the only place that transcript can appear — without this
    // the panel would open and vanish in the same frame.
    expect(shouldShowHuddleDock({ ...base, record: true })).toBe(true);
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

// The dock opened and never connected. openHuddle records WHICH conversation
// the dock is for; the old toolbar button called startOrJoin() itself, and
// lifting the session above AppContent dropped that step — so the panel
// appeared, showed "connecting", and nothing ever happened.
describe('joining once per target', () => {
  // Mirrors the provider's guard: join when the session id changes, never on a
  // bare re-render, and again after a close/reopen of the same conversation.
  function joinsFor(events: Array<string | null>): number {
    let joined = '';
    let calls = 0;
    for (const sessionId of events) {
      if (sessionId === null) { joined = ''; continue; } // close clears the guard
      if (!sessionId || joined === sessionId) continue;
      joined = sessionId;
      calls += 1;
    }
    return calls;
  }

  it('joins once when a conversation is opened', () => {
    expect(joinsFor(['a'])).toBe(1);
  });

  it('does NOT re-join on re-renders of the same conversation', () => {
    expect(joinsFor(['a', 'a', 'a'])).toBe(1);
  });

  it('joins the new conversation when switching', () => {
    expect(joinsFor(['a', 'b'])).toBe(2);
  });

  it('joins again after closing and reopening the SAME conversation', () => {
    // Without clearing the guard on close, reopening sat inert forever because
    // it had been joined once before.
    expect(joinsFor(['a', null, 'a'])).toBe(2);
  });

  it('never joins without a target', () => {
    expect(joinsFor([null, '', null])).toBe(0);
  });
});

// The dock drives speech off what LiveKit says about OUR OWN connection, and
// LiveKit re-renders constantly. Comparing the values is what stops a room
// re-render from tearing the microphone down and back up.
describe('sameHuddleLocalState', () => {
  it('is unchanged when the room reports the same thing again', () => {
    expect(sameHuddleLocalState(
      { connected: true, micEnabled: true, speaker: 'Jason', failed: '' },
      { connected: true, micEnabled: true, speaker: 'Jason', failed: '' },
    )).toBe(true);
  });

  it('notices the mic being muted — the gate on transcribing anything', () => {
    expect(sameHuddleLocalState(
      { connected: true, micEnabled: true, speaker: '', failed: '' },
      { connected: true, micEnabled: false, speaker: '', failed: '' },
    )).toBe(false);
  });

  it('notices the session coming up, which is what confirms our join', () => {
    expect(sameHuddleLocalState(
      IDLE_HUDDLE_LOCAL,
      { ...IDLE_HUDDLE_LOCAL, connected: true },
    )).toBe(false);
  });

  it('notices a failure, which is the one thing the panel must keep on screen', () => {
    expect(sameHuddleLocalState(
      IDLE_HUDDLE_LOCAL,
      { ...IDLE_HUDDLE_LOCAL, failed: 'Could not connect' },
    )).toBe(false);
  });

  it('starts idle: nothing connected, nothing publishing, nothing wrong', () => {
    expect(IDLE_HUDDLE_LOCAL).toEqual({ connected: false, micEnabled: false, speaker: '', failed: '' });
  });
});
