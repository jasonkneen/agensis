import { describe, expect, it } from 'vitest';
import { foldHuddleState, huddleDuration, participantSummary } from '../../src/lib/huddleState';
import type { Huddle, HuddleEvent } from '../../src/types';

// The client-side fold is what the channel card renders from. It must agree with
// the server fold (server/huddles.cjs) on the three properties that make the
// card trustworthy:
//   - duplicate events are no-ops,
//   - out-of-order delivery still folds correctly,
//   - an ENDED huddle has ZERO participants (no Math.max(1, …) floor, which is
//     how a previous implementation claimed "1 participant" forever).

const HUDDLE: Huddle = {
  id: 'h1',
  workspace_id: 'ws1',
  session_id: 's1',
  room_name: 'agensis-h1',
  started_by: 'user-a',
  started_at: '2026-07-25T10:00:00.000Z',
  ended_at: null,
};

let nextSeq = 0;
function ev(
  kind: HuddleEvent['kind'],
  identity: string,
  createdAt: string,
  displayName = identity,
): HuddleEvent {
  nextSeq += 1;
  return {
    id: `e${nextSeq}`,
    huddle_id: HUDDLE.id,
    workspace_id: HUDDLE.workspace_id,
    session_id: HUDDLE.session_id,
    kind,
    identity,
    display_name: displayName,
    event_id: `lk-${nextSeq}`,
    seq: nextSeq,
    created_at: createdAt,
  };
}

describe('foldHuddleState', () => {
  it('returns null with no huddle', () => {
    expect(foldHuddleState(null, [])).toBeNull();
  });

  it('reports an active huddle with nobody connected yet as empty, not as one person', () => {
    // Real state, right after "Start huddle": the row exists, LiveKit has not
    // reported anyone joining. The card must say "waiting", not invent someone.
    const state = foldHuddleState(HUDDLE, [ev('started', 'user:user-a', '2026-07-25T10:00:00.000Z')])!;
    expect(state.active).toBe(true);
    expect(state.participantCount).toBe(0);
    expect(state.everJoinedCount).toBe(0);
  });

  it('folds joins and leaves into a live roster', () => {
    const state = foldHuddleState(HUDDLE, [
      ev('participant_joined', 'user:a', '2026-07-25T10:01:00.000Z', 'Ada'),
      ev('participant_joined', 'user:b', '2026-07-25T10:02:00.000Z', 'Sam'),
      ev('participant_left', 'user:a', '2026-07-25T10:03:00.000Z', 'Ada'),
    ])!;
    expect(state.participants.map(p => p.name)).toEqual(['Sam']);
    expect(state.participantCount).toBe(1);
    expect(state.peakParticipants).toBe(2);
    expect(state.everJoinedCount).toBe(2);
    expect(state.participants[0].userId).toBe('b');
  });

  it('is idempotent under duplicate events', () => {
    const join = ev('participant_joined', 'user:a', '2026-07-25T10:01:00.000Z', 'Ada');
    const state = foldHuddleState(HUDDLE, [join, { ...join, id: 'dup' }])!;
    expect(state.participantCount).toBe(1);
    expect(state.peakParticipants).toBe(1);
  });

  it('is order-independent — a websocket replaying events in any order folds the same', () => {
    const events = [
      ev('participant_joined', 'user:a', '2026-07-25T10:01:00.000Z', 'Ada'),
      ev('participant_joined', 'user:b', '2026-07-25T10:02:00.000Z', 'Sam'),
      ev('participant_left', 'user:a', '2026-07-25T10:03:00.000Z', 'Ada'),
    ];
    const expected = foldHuddleState(HUDDLE, events);
    // Every permutation of the same three events must fold identically.
    const permutations = [
      [events[2], events[0], events[1]],
      [events[1], events[2], events[0]],
      [events[2], events[1], events[0]],
    ];
    for (const permutation of permutations) {
      expect(foldHuddleState(HUDDLE, permutation)).toEqual(expected);
    }
  });

  it('reports ZERO participants for an ended huddle even with no leave events', () => {
    const ended: Huddle = { ...HUDDLE, ended_at: '2026-07-25T10:10:00.000Z' };
    const state = foldHuddleState(ended, [
      ev('participant_joined', 'user:a', '2026-07-25T10:01:00.000Z', 'Ada'),
      ev('participant_joined', 'user:b', '2026-07-25T10:02:00.000Z', 'Sam'),
    ])!;
    expect(state.active).toBe(false);
    expect(state.participants).toEqual([]);
    expect(state.participantCount).toBe(0);
    // The honest summary numbers survive.
    expect(state.peakParticipants).toBe(2);
    expect(state.everJoinedCount).toBe(2);
  });

  it('treats an "ended" event as authoritative before the row is updated', () => {
    const state = foldHuddleState(HUDDLE, [
      ev('participant_joined', 'user:a', '2026-07-25T10:01:00.000Z', 'Ada'),
      ev('ended', '', '2026-07-25T10:04:00.000Z'),
    ])!;
    expect(state.active).toBe(false);
    expect(state.endedAt).toBe('2026-07-25T10:04:00.000Z');
    expect(state.participantCount).toBe(0);
  });
});

describe('participantSummary', () => {
  const p = (name: string) => ({ identity: `user:${name}`, userId: name, name, joinedAt: null });

  it('is empty for nobody', () => {
    expect(participantSummary([])).toBe('');
  });

  it('names one and two people directly', () => {
    expect(participantSummary([p('Ada')])).toBe('Ada');
    expect(participantSummary([p('Ada'), p('Sam')])).toBe('Ada and Sam');
  });

  it('collapses the tail, with correct singular/plural', () => {
    expect(participantSummary([p('Ada'), p('Sam'), p('Jo')])).toBe('Ada, Sam and 1 other');
    expect(participantSummary([p('Ada'), p('Sam'), p('Jo'), p('Kim')])).toBe('Ada, Sam and 2 others');
  });
});

describe('huddleDuration', () => {
  const base = foldHuddleState(HUDDLE, [])!;

  it('counts up from startedAt while live', () => {
    expect(huddleDuration(base, Date.parse('2026-07-25T10:04:07.000Z'))).toBe('4:07');
    expect(huddleDuration(base, Date.parse('2026-07-25T11:04:07.000Z'))).toBe('1:04:07');
  });

  it('freezes at endedAt once ended, ignoring the clock', () => {
    const ended = foldHuddleState({ ...HUDDLE, ended_at: '2026-07-25T10:02:30.000Z' }, [])!;
    expect(huddleDuration(ended, Date.parse('2026-07-25T23:00:00.000Z'))).toBe('2:30');
  });

  it('never goes negative on a clock skew', () => {
    expect(huddleDuration(base, Date.parse('2026-07-25T09:00:00.000Z'))).toBe('0:00');
  });
});
