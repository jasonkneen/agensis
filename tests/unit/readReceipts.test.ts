import { describe, expect, it } from 'vitest';
import {
  RECEIPT_REARM_MS,
  decideReceiptEmit,
  describeReaders,
  initialReceiptEmitState,
  noteReceiptSent,
  readersOf,
  receiptAnchorIds,
  type ReceiptMessage,
  type SessionReadMarker,
} from '../../src/lib/readReceipts';

// The emit policy and the "who read this" derivation. Both are pure, and both
// are where a receipt would lie if it were wrong: an emit that fires from a
// background tab claims someone read something they never looked at, and a
// comparison that is off by one message reports the message people are actually
// looking at as unread.
//
// The fake here is a plain object. Nothing in this file derives an input from an
// output, and nothing knows RECEIPT_REARM_MS except by importing it — a test
// that recomputed the throttle would be asserting that the fake agrees with the
// fake.

const ME = 'me-1';
const THEM = 'them-1';

function message(overrides: Partial<ReceiptMessage> = {}): ReceiptMessage {
  return { id: 'm1', created_at: '2026-07-01T12:00:00.000Z', sender_kind: 'human', sender_id: THEM, ...overrides };
}

function marker(userId: string, readAt: string): SessionReadMarker {
  return { session_id: 's1', user_id: userId, read_at: readAt };
}

describe('decideReceiptEmit', () => {
  const base = {
    currentUserId: ME,
    visibility: 'visible' as DocumentVisibilityState,
    state: initialReceiptEmitState(),
    now: 100_000,
  };

  it('emits for the newest visible message', () => {
    expect(decideReceiptEmit({ ...base, newestVisible: message() })).toEqual({ messageId: 'm1' });
  });

  it('does not emit while the tab is hidden — a background tab has been read by nobody', () => {
    const decision = decideReceiptEmit({ ...base, newestVisible: message(), visibility: 'hidden' });
    expect(decision).toEqual({ messageId: null, reason: 'hidden' });
  });

  it('does not emit when the newest id is unchanged', () => {
    const state = noteReceiptSent(initialReceiptEmitState(), 'm1', 0);
    const decision = decideReceiptEmit({ ...base, newestVisible: message(), state });
    expect(decision).toEqual({ messageId: null, reason: 'unchanged' });
  });

  it('does not emit for your own newest message', () => {
    const decision = decideReceiptEmit({ ...base, newestVisible: message({ sender_id: ME }) });
    expect(decision).toEqual({ messageId: null, reason: 'own-message' });
  });

  it("treats an agent message as somebody else's, even when the ids collide", () => {
    // An agent id and a user id are both uuids. Without the sender_kind check a
    // reader whose id happened to match an agent's would never mark anything
    // read in that conversation.
    const decision = decideReceiptEmit({
      ...base,
      newestVisible: message({ sender_kind: 'agent', sender_id: ME }),
    });
    expect(decision).toEqual({ messageId: 'm1' });
  });

  it('allows at most one emit per RECEIPT_REARM_MS for the same session', () => {
    const state = noteReceiptSent(initialReceiptEmitState(), 'm0', 100_000);
    const tooSoon = decideReceiptEmit({
      ...base, newestVisible: message({ id: 'm1' }), state, now: 100_000 + RECEIPT_REARM_MS - 1,
    });
    expect(tooSoon).toEqual({ messageId: null, reason: 'throttled' });

    const armed = decideReceiptEmit({
      ...base, newestVisible: message({ id: 'm1' }), state, now: 100_000 + RECEIPT_REARM_MS,
    });
    expect(armed).toEqual({ messageId: 'm1' });
  });

  it('a flush ignores the throttle AND the visibility check, but nothing else', () => {
    // pagehide has usually already flipped visibility to 'hidden', so a flush
    // that honoured it would never record the thing the flush exists for.
    const state = noteReceiptSent(initialReceiptEmitState(), 'm0', 100_000);
    expect(decideReceiptEmit({
      ...base, newestVisible: message({ id: 'm1' }), state, now: 100_001, visibility: 'hidden', flush: true,
    })).toEqual({ messageId: 'm1' });

    // Still suppressed for your own message and for an unchanged id.
    expect(decideReceiptEmit({
      ...base, newestVisible: message({ id: 'm1', sender_id: ME }), state, now: 100_001, flush: true,
    })).toEqual({ messageId: null, reason: 'own-message' });
    expect(decideReceiptEmit({
      ...base, newestVisible: message({ id: 'm0' }), state, now: 100_001, flush: true,
    })).toEqual({ messageId: null, reason: 'unchanged' });
  });

  it('emits nothing at all when the user has receipts switched off', () => {
    // The client half of the reciprocal opt-out. The server half — the marker is
    // never stored — is in tests/session-read-state.test.cjs, and it is the one
    // that actually enforces this. Both, because a client that keeps sending
    // would be relying on the server to refuse it silently every time.
    const decision = decideReceiptEmit({ ...base, newestVisible: message(), enabled: false });
    expect(decision).toEqual({ messageId: null, reason: 'disabled' });
  });

  it('emits nothing when there is nothing on screen', () => {
    expect(decideReceiptEmit({ ...base, newestVisible: null })).toEqual({
      messageId: null, reason: 'nothing-visible',
    });
  });
});

describe('readersOf', () => {
  const sent = message({ id: 'm5', created_at: '2026-07-01T12:00:00.000Z', sender_id: ME });

  it('counts a marker at or after the message', () => {
    expect(readersOf(sent, [marker(THEM, '2026-07-01T12:00:05.000Z')])).toEqual([THEM]);
  });

  it('compares with >=, so the message a marker points AT is read', () => {
    // The off-by-one that matters: a marker is set to the created_at of a
    // message that WAS seen, so `>` reports the most recently read message —
    // the one people are looking at — as unread.
    expect(readersOf(sent, [marker(THEM, '2026-07-01T12:00:00.000Z')])).toEqual([THEM]);
  });

  it('ignores a marker from before the message', () => {
    expect(readersOf(sent, [marker(THEM, '2026-07-01T11:59:59.999Z')])).toEqual([]);
  });

  it('excludes the author — "you read your own message" is not information', () => {
    expect(readersOf(sent, [
      marker(ME, '2026-07-01T12:00:05.000Z'),
      marker(THEM, '2026-07-01T12:00:05.000Z'),
    ])).toEqual([THEM]);
  });

  it('returns nothing for a message with no usable timestamp', () => {
    // Fails CLOSED. A message mid-send has no created_at, and guessing "now"
    // would draw an eye for a message that has not reached anyone.
    expect(readersOf(message({ created_at: null }), [marker(THEM, '2026-07-01T12:00:05.000Z')])).toEqual([]);
    expect(readersOf(message({ created_at: 'not a date' }), [marker(THEM, '2026-07-01T12:00:05.000Z')])).toEqual([]);
  });

  it('counts a duplicated marker once', () => {
    expect(readersOf(sent, [
      marker(THEM, '2026-07-01T12:00:05.000Z'),
      marker(THEM, '2026-07-01T12:00:06.000Z'),
    ])).toEqual([THEM]);
  });
});

describe('receiptAnchorIds', () => {
  it('marks only the LAST message of each of your contiguous runs', () => {
    // A five-message burst would otherwise draw five identical indicators.
    const thread: ReceiptMessage[] = [
      { id: 'a', sender_kind: 'human', sender_id: ME },
      { id: 'b', sender_kind: 'human', sender_id: ME },
      { id: 'c', sender_kind: 'human', sender_id: THEM },
      { id: 'd', sender_kind: 'human', sender_id: ME },
    ];
    expect([...receiptAnchorIds(thread, ME)]).toEqual(['b', 'd']);
  });

  it('never marks somebody else\'s message', () => {
    const thread: ReceiptMessage[] = [{ id: 'a', sender_kind: 'human', sender_id: THEM }];
    expect([...receiptAnchorIds(thread, ME)]).toEqual([]);
  });

  it('marks nothing when there is no signed-in user', () => {
    const thread: ReceiptMessage[] = [{ id: 'a', sender_kind: 'human', sender_id: ME }];
    expect([...receiptAnchorIds(thread, null)]).toEqual([]);
  });
});

describe('describeReaders', () => {
  const names: Record<string, string> = { u1: 'Ana', u2: 'Ben', u3: 'Cara', u4: 'Dev', u5: 'Eve' };
  const resolve = (id: string) => names[id] ?? null;

  it('names one, two and three readers in prose', () => {
    expect(describeReaders(['u1'], resolve)).toBe('Read by Ana');
    expect(describeReaders(['u1', 'u2'], resolve)).toBe('Read by Ana and Ben');
    expect(describeReaders(['u1', 'u2', 'u3'], resolve)).toBe('Read by Ana, Ben and Cara');
  });

  it('truncates past the limit', () => {
    expect(describeReaders(['u1', 'u2', 'u3', 'u4', 'u5'], resolve)).toBe('Read by Ana, Ben, Cara and 2 others');
    expect(describeReaders(['u1', 'u2', 'u3', 'u4'], resolve)).toBe('Read by Ana, Ben, Cara and 1 other');
  });

  it('renders an unresolvable id as "Someone", never a raw uuid', () => {
    // A uuid in a tooltip is useless to the reader and a small identifier leak
    // into any screenshot of it.
    const text = describeReaders(['3f7c1a52-0000-4000-8000-000000000000'], () => null);
    expect(text).toBe('Read by Someone');
    expect(text).not.toContain('3f7c1a52');
  });

  it('says nothing when nobody has read it', () => {
    expect(describeReaders([], resolve)).toBe('');
  });
});
