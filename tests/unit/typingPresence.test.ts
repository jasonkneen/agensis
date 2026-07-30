import { describe, expect, it } from 'vitest';
import {
  TYPING_MAX_TARGETS,
  TYPING_REARM_MS,
  TYPING_TTL_MS,
  applyTypingFrame,
  buildTypingFrame,
  decideTypingEmit,
  mergeTypingIntoPresence,
  pruneExpiredTyping,
  shouldAnnounceTyping,
  typingPeersFor,
  type TypingEmitState,
  type TypingFrame,
  type TypingState,
} from '../../src/lib/typingPresence';

// The typing lane's two hard claims, both of which this product has already got
// wrong once in an adjacent surface:
//
//   1. IT EXPIRES BY ITSELF. src/lib/activityStatus.ts grew
//      isLiveActivityPlaceholder because a "Thinking 2m 11s" placeholder went on
//      claiming a run was live for hours after the agent had stopped. A typing
//      indicator that needs a stop frame to clear is the same bug: the stop
//      frame is the one thing guaranteed not to arrive when a tab is force-quit.
//      So the tests below never deliver a stop frame to prove expiry, and the
//      deadline is always computed from ARRIVAL.
//
//   2. IT IS CHEAP. `setTyping` used to call sendSnapshot() — a ~2 KB window
//      payload fanned to every socket in the workspace. The re-arm throttle is
//      what keeps a keystroke handler off that path, so it is pinned here with
//      an exact emission count rather than a "roughly".

const LOCAL = 'user-local';
const PEER = 'user-peer';

function frame(overrides: Partial<TypingFrame> = {}): TypingFrame {
  return {
    v: 1,
    userId: PEER,
    name: 'ada',
    color: '#22c55e',
    scope: 'chat',
    itemId: 'session-1',
    ttlMs: TYPING_TTL_MS,
    ...overrides,
  };
}

describe('typing expiry', () => {
  it('clears itself after the TTL with no stop frame ever delivered', () => {
    const t0 = 1_000_000;
    const state = applyTypingFrame({}, frame(), LOCAL, t0);
    expect(typingPeersFor(state, 'chat', 'session-1', t0)).toHaveLength(1);

    // No stop frame. Just time passing — a force-quit tab, a dropped socket.
    const after = pruneExpiredTyping(state, t0 + TYPING_TTL_MS + 1);
    expect(typingPeersFor(after, 'chat', 'session-1', t0 + TYPING_TTL_MS + 1)).toHaveLength(0);
    expect(after['chat:session-1']).toBeUndefined();
  });

  it('still shows for the full TTL from arrival when the sender clock is 5 minutes behind', () => {
    // The frame carries a DURATION, so a skewed sender cannot shorten it. This
    // is the guard on the failure class documented at activityStatus.ts:105-113,
    // where absolute cross-clock timestamps cost a 60s slack budget.
    const arrival = 1_000_000;
    const state = applyTypingFrame({}, frame({ ttlMs: TYPING_TTL_MS }), LOCAL, arrival);
    const peer = typingPeersFor(state, 'chat', 'session-1', arrival)[0];
    expect(peer.expiresAt).toBe(arrival + TYPING_TTL_MS);

    // Halfway through: still up, regardless of what the sender's clock said.
    expect(typingPeersFor(state, 'chat', 'session-1', arrival + TYPING_TTL_MS - 1)).toHaveLength(1);
  });

  it('clamps an over-long ttlMs to the receiver ceiling', () => {
    // A buggy or hostile sender must not be able to pin an indicator open.
    const t0 = 1_000_000;
    const state = applyTypingFrame({}, frame({ ttlMs: 60 * 60 * 1000 }), LOCAL, t0);
    expect(typingPeersFor(state, 'chat', 'session-1', t0)[0].expiresAt).toBe(t0 + TYPING_TTL_MS);
    expect(pruneExpiredTyping(state, t0 + TYPING_TTL_MS + 1)['chat:session-1']).toBeUndefined();
  });

  it('honours an explicit stop frame as an optimisation, not a requirement', () => {
    const t0 = 1_000_000;
    const up = applyTypingFrame({}, frame(), LOCAL, t0);
    const down = applyTypingFrame(up, frame({ ttlMs: 0 }), LOCAL, t0 + 500);
    expect(typingPeersFor(down, 'chat', 'session-1', t0 + 500)).toHaveLength(0);
  });

  it('returns the same state reference when nothing expired', () => {
    // useItemPresence lives at the App root; a fresh object per prune tick would
    // re-render every open window twice a second.
    const t0 = 1_000_000;
    const state = applyTypingFrame({}, frame(), LOCAL, t0);
    expect(pruneExpiredTyping(state, t0 + 1)).toBe(state);
  });
});

describe('receiver validation', () => {
  it('ignores frames from the local user', () => {
    // relayBroadcast does not exclude the sender, so every client hears itself.
    const state = applyTypingFrame({}, frame({ userId: LOCAL }), LOCAL, 1_000);
    expect(state).toEqual({});
  });

  it.each([
    ['wrong version', frame({ v: 2 as unknown as 1 })],
    ['missing userId', frame({ userId: '' })],
    ['missing itemId', frame({ itemId: '' })],
    ['unknown scope', frame({ scope: 'canvas' as unknown as 'chat' })],
    ['non-numeric ttl', frame({ ttlMs: 'soon' as unknown as number })],
  ])('drops a malformed frame: %s', (_label, bad) => {
    expect(applyTypingFrame({}, bad, LOCAL, 1_000)).toEqual({});
  });

  it('drops a non-object payload', () => {
    expect(applyTypingFrame({}, null, LOCAL, 1_000)).toEqual({});
    expect(applyTypingFrame({}, 'typing', LOCAL, 1_000)).toEqual({});
  });

  it('keeps two peers typing in the same item apart', () => {
    const t0 = 1_000;
    let state = applyTypingFrame({}, frame({ userId: 'peer-a' }), LOCAL, t0);
    state = applyTypingFrame(state, frame({ userId: 'peer-b' }), LOCAL, t0);
    expect(typingPeersFor(state, 'chat', 'session-1', t0).map(p => p.userId).sort())
      .toEqual(['peer-a', 'peer-b']);
  });
});

describe('emit throttle', () => {
  function burst(keystrokeAtMs: number[]): number[] {
    let state: TypingEmitState = {};
    const emitted: number[] = [];
    for (const now of keystrokeAtMs) {
      const decision = decideTypingEmit(state, 'chat', 'session-1', true, now);
      state = decision.state;
      if (decision.emit) emitted.push(now);
    }
    return emitted;
  }

  it('emits exactly three times for 40 keystrokes spread over 10 seconds', () => {
    // 40 keystrokes = 10s at ~48wpm. Three frames, not forty.
    const keystrokes = Array.from({ length: 40 }, (_, i) => 1_000_000 + i * 250);
    const emitted = burst(keystrokes);
    expect(emitted).toEqual([1_000_000, 1_004_000, 1_008_000]);
  });

  it('emits on the first keystroke of a burst', () => {
    expect(burst([500])).toEqual([500]);
  });

  it('re-arms only after TYPING_REARM_MS', () => {
    expect(burst([0, TYPING_REARM_MS - 1])).toEqual([0]);
    expect(burst([0, TYPING_REARM_MS])).toEqual([0, TYPING_REARM_MS]);
  });

  it('sends one stop frame, and only if the target was announced', () => {
    const started = decideTypingEmit({}, 'chat', 'session-1', true, 0);
    expect(started.emit).toBe(true);

    const stopped = decideTypingEmit(started.state, 'chat', 'session-1', false, 100);
    expect(stopped.emit).toBe(true);

    // Blur then send then clear all resolve to "stop"; only the first reaches
    // the wire.
    expect(decideTypingEmit(stopped.state, 'chat', 'session-1', false, 200).emit).toBe(false);
  });

  it('never emits a stop for a target that was never announced', () => {
    expect(decideTypingEmit({}, 'chat', 'session-1', false, 0).emit).toBe(false);
  });

  it('re-emits immediately after a stop, so a resumed burst is not swallowed', () => {
    const started = decideTypingEmit({}, 'chat', 'session-1', true, 0);
    const stopped = decideTypingEmit(started.state, 'chat', 'session-1', false, 100);
    expect(decideTypingEmit(stopped.state, 'chat', 'session-1', true, 200).emit).toBe(true);
  });

  it('caps concurrent targets so one socket cannot become a fan-out multiplier', () => {
    let state: TypingEmitState = {};
    const accepted: string[] = [];
    for (let i = 0; i < 10; i++) {
      const decision = decideTypingEmit(state, 'chat', `session-${i}`, true, 1_000);
      state = decision.state;
      if (decision.emit) accepted.push(`session-${i}`);
    }
    expect(accepted).toHaveLength(TYPING_MAX_TARGETS);
  });

  it('frees a capped slot once the target has gone stale', () => {
    let state: TypingEmitState = {};
    for (let i = 0; i < TYPING_MAX_TARGETS; i++) {
      state = decideTypingEmit(state, 'chat', `session-${i}`, true, 1_000).state;
    }
    expect(decideTypingEmit(state, 'chat', 'session-new', true, 1_000).emit).toBe(false);
    // An abandoned composer must not hold its slot forever.
    expect(decideTypingEmit(state, 'chat', 'session-new', true, 1_000 + TYPING_TTL_MS + 1).emit).toBe(true);
  });

  it('ignores an empty itemId', () => {
    expect(decideTypingEmit({}, 'chat', '', true, 0).emit).toBe(false);
  });
});

describe('who may announce typing', () => {
  const base = { hasSink: true, isDirectMessage: false, readOnly: false };

  it('allows a normal channel composer', () => {
    expect(shouldAnnounceTyping(base)).toBe(true);
  });

  it('never announces in a direct message', () => {
    // `item-presence:<workspaceId>` fans out to every member with `read`, and
    // the frame carries the session id. Emitting for a DM tells the whole
    // workspace that a private session exists and is live. The sidebar's
    // filtering is a UI convenience, not an access boundary.
    expect(shouldAnnounceTyping({ ...base, isDirectMessage: true })).toBe(false);
  });

  it('stays silent in a read-only window', () => {
    expect(shouldAnnounceTyping({ ...base, readOnly: true })).toBe(false);
  });

  it('stays silent when nothing is listening', () => {
    expect(shouldAnnounceTyping({ ...base, hasSink: false })).toBe(false);
  });
});

describe('frame construction', () => {
  it('carries a relative ttlMs and stays small on the wire', () => {
    const started = buildTypingFrame({
      userId: 'u-0123456789abcdef',
      name: 'jasonkneen',
      color: '#8b5cf6',
      scope: 'chat',
      itemId: '9f6c1a2e-4b7d-4a11-9c31-2f5e8d0b7a63',
      typing: true,
    });
    expect(started.ttlMs).toBe(TYPING_TTL_MS);
    expect(started.v).toBe(1);
    // The whole point of the lane: ~2 KB snapshot vs this.
    expect(JSON.stringify(started).length).toBeLessThan(200);
  });

  it('encodes a stop as ttlMs 0, never a separate event', () => {
    expect(buildTypingFrame({
      userId: 'u1', name: 'a', color: '#fff', scope: 'document', itemId: 'd1', typing: false,
    }).ttlMs).toBe(0);
  });
});

describe('merge into the sidebar presence map', () => {
  const t0 = 1_000_000;

  function typingAt(scope: 'chat' | 'document', itemId: string, userId: string): TypingState {
    return applyTypingFrame({}, frame({ scope, itemId, userId }), LOCAL, t0);
  }

  it('flags an existing presence row as typing', () => {
    const base = { 'session-1': [{ userId: PEER, name: 'ada', color: '#22c55e' }] };
    const merged = mergeTypingIntoPresence(base, typingAt('chat', 'session-1', PEER), 'chat', t0);
    expect(merged['session-1'][0].typing).toBe(true);
    // The input map is not mutated — App holds it across renders.
    expect(base['session-1'][0].typing).toBeUndefined();
  });

  it('adds a typing peer that has no presence row yet', () => {
    // Presence is derived from open floating windows and arrives on a 2s
    // heartbeat; a typing frame is itself proof of presence and gets there
    // first.
    const merged = mergeTypingIntoPresence({}, typingAt('chat', 'session-1', PEER), 'chat', t0);
    expect(merged['session-1']).toEqual([
      { userId: PEER, name: 'ada', color: '#22c55e', typing: true },
    ]);
  });

  it('does not leak a document typing frame into the chat map', () => {
    const merged = mergeTypingIntoPresence({}, typingAt('document', 'doc-1', PEER), 'chat', t0);
    expect(merged).toEqual({});
  });

  it('leaves rows alone once the frame has expired', () => {
    const base = { 'session-1': [{ userId: PEER, name: 'ada', color: '#22c55e' }] };
    const merged = mergeTypingIntoPresence(
      base,
      typingAt('chat', 'session-1', PEER),
      'chat',
      t0 + TYPING_TTL_MS + 1,
    );
    expect(merged).toBe(base);
  });

  it('returns the same reference when nobody is typing', () => {
    const base = { 'session-1': [{ userId: PEER, name: 'ada', color: '#22c55e' }] };
    expect(mergeTypingIntoPresence(base, {}, 'chat', t0)).toBe(base);
  });

  it('handles an itemId containing a colon', () => {
    const merged = mergeTypingIntoPresence({}, typingAt('chat', 'a:b:c', PEER), 'chat', t0);
    expect(Object.keys(merged)).toEqual(['a:b:c']);
  });
});
