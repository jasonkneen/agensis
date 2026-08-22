// Agents are LiveKit participants now, so the huddle roster comes from the ROOM.
//
// Previously the chips merged a LiveKit human list with a separately-maintained
// agent roster, because agents held no LiveKit connection and no presence event
// ever mentioned them. That meant a chip could show an agent that was not in the
// call — the two lists had no way to disagree out loud.

import { describe, it, expect } from 'vitest';
import {
  buildRoomDockParticipants,
  roomParticipantFrom,
  sameRoomParticipants,
  type HuddleRoomParticipant,
} from '../../src/lib/huddleDock';

const agent = (over: Partial<HuddleRoomParticipant> = {}): HuddleRoomParticipant => ({
  identity: 'AG_abc', name: 'Claude', isLocal: false, isSpeaking: false,
  kind: 'agent', agentId: 'a1', handle: 'claude', accentColor: '#4f46e5', voiceReady: true, hasVideo: true, ...over,
});
const human = (over: Partial<HuddleRoomParticipant> = {}): HuddleRoomParticipant => ({
  identity: 'user:u1', name: 'Jason', isLocal: false, isSpeaking: false,
  kind: 'human', agentId: '', handle: '', accentColor: '', voiceReady: false, hasVideo: false, ...over,
});

describe('reading an agensis identity off a LiveKit participant', () => {
  it('recognises the voice worker by the attributes it stamps on itself', () => {
    const read = roomParticipantFrom({
      identity: 'AG_xyz',
      name: 'agent-AG_xyz',
      isSpeaking: true,
      attributes: {
        'agensis.kind': 'agent',
        'agensis.agentId': 'a1',
        'agensis.handle': 'claude',
        'agensis.name': 'Claude',
        'agensis.accentColor': '#4f46e5',
        'agensis.voiceReady': 'true',
      },
      videoTrackPublications: { size: 1 },
    });

    expect(read.kind).toBe('agent');
    expect(read.agentId).toBe('a1');
    // The agensis name wins over LiveKit's generated one, or the tile reads
    // "agent-AG_xyz" to a human.
    expect(read.name).toBe('Claude');
    expect(read.voiceReady).toBe(true);
    expect(read.hasVideo).toBe(true);
    expect(read.isSpeaking).toBe(true);
  });

  it('treats anyone without those attributes as a human', () => {
    const read = roomParticipantFrom({ identity: 'user:u1', name: 'Jason', attributes: {} });
    expect(read.kind).toBe('human');
    expect(read.agentId).toBe('');
    expect(read.voiceReady).toBe(false);
    expect(read.hasVideo).toBe(false);
  });

  it('never renders a nameless tile', () => {
    expect(roomParticipantFrom({ identity: 'user:u9' }).name).toBe('user:u9');
  });
});

describe('the participant chips', () => {
  it('lists humans and agents together, from one source', () => {
    const chips = buildRoomDockParticipants([human(), agent()]);
    expect(chips.map(c => [c.kind, c.name])).toEqual([['human', 'Jason'], ['agent', 'Claude']]);
  });

  it('keys an agent by its agent id, so it matches the rest of the app', () => {
    const [chip] = buildRoomDockParticipants([agent()]);
    expect(chip.id).toBe('a1');
  });

  it('marks the active agent and whoever is speaking', () => {
    const chips = buildRoomDockParticipants([agent({ isSpeaking: true }), agent({ identity: 'AG_2', agentId: 'a2', name: 'Grok' })], 'a2');
    expect(chips[0].speaking).toBe(true);
    expect(chips[0].active).toBe(false);
    expect(chips[1].active).toBe(true);
  });

  it('calls the local participant "You"', () => {
    const [chip] = buildRoomDockParticipants([human({ isLocal: true, name: 'Jason' })]);
    expect(chip.name).toBe('You');
  });

  it('shows each participant once, however many tracks they publish', () => {
    expect(buildRoomDockParticipants([human(), human(), agent(), agent()])).toHaveLength(2);
  });
});

describe('roster equality', () => {
  it('ignores nothing that is rendered', () => {
    expect(sameRoomParticipants([agent()], [agent()])).toBe(true);
    expect(sameRoomParticipants([agent()], [agent({ isSpeaking: true })])).toBe(false);
    expect(sameRoomParticipants([agent()], [agent({ hasVideo: false })])).toBe(false);
    expect(sameRoomParticipants([agent()], [agent({ name: 'Other' })])).toBe(false);
    expect(sameRoomParticipants([agent()], [])).toBe(false);
  });

  it('is what stops the dock re-rendering on every LiveKit frame', () => {
    // LiveKit re-emits participants continuously while anyone talks; two reports
    // that render identically must compare equal even as distinct objects.
    const a = [human(), agent()];
    const b = [human(), agent()];
    expect(a).not.toBe(b);
    expect(sameRoomParticipants(a, b)).toBe(true);
  });
});
