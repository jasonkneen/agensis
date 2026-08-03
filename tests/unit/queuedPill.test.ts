import { describe, expect, it } from 'vitest';
import { queuedLabel, queuedState } from '../../src/lib/queuedPill';
import { unseenAnchorId } from '../../src/lib/seenPill';
import type { ReceiptMessage } from '../../src/lib/readReceipts';
import type { AgentWork } from '../../src/lib/agentWork';

// The claim: "queued" means your message was created AFTER the running turn
// started, so it cannot be what that turn is answering. Everything here pins
// that one rule and its edges.

const ME = 'user-1';
const T0 = Date.parse('2026-08-03T12:00:00.000Z');

function at(ms: number, overrides: Partial<ReceiptMessage> = {}): ReceiptMessage {
  return {
    id: `m-${ms}`,
    sender_id: ME,
    sender_kind: 'user',
    created_at: new Date(ms).toISOString(),
    ...overrides,
  } as ReceiptMessage;
}

function work(anchorAt: number, jobs = 1): AgentWork {
  return { anchorAt, jobs } as AgentWork;
}

describe('queuedState', () => {
  it('queues a message typed after the turn started', () => {
    expect(queuedState(at(T0 + 5_000), work(T0), ME)).toEqual({ queued: true, workers: 1 });
  });

  it('does NOT queue the message the agent is answering', () => {
    // Sent before the turn began: this is what the turn is FOR, and the
    // activity line above the composer already covers it.
    expect(queuedState(at(T0 - 5_000), work(T0), ME).queued).toBe(false);
  });

  it('does not queue on an equal timestamp', () => {
    // Send-then-start regularly serialises to the same millisecond. Treating
    // that as queued would chip the very message being answered.
    expect(queuedState(at(T0), work(T0), ME).queued).toBe(false);
  });

  it('ignores a sub-millisecond gap rather than trusting two clocks', () => {
    expect(queuedState(at(T0 + 100), work(T0), ME).queued).toBe(false);
    expect(queuedState(at(T0 + 400), work(T0), ME).queued).toBe(true);
  });

  it('is silent when nothing is running', () => {
    expect(queuedState(at(T0 + 5_000), null, ME).queued).toBe(false);
    expect(queuedState(at(T0 + 5_000), work(T0, 0), ME).queued).toBe(false);
  });

  it('only ever marks YOUR messages', () => {
    // "Somebody else's post is queued" is not a fact you can act on, and it
    // would chip most rows in a busy channel.
    const theirs = at(T0 + 5_000, { sender_id: 'agent-1', sender_kind: 'agent' });
    expect(queuedState(theirs, work(T0), ME).queued).toBe(false);
  });

  it('claims nothing without a viewer or a usable timestamp', () => {
    expect(queuedState(at(T0 + 5_000), work(T0), null).queued).toBe(false);
    expect(queuedState(at(T0 + 5_000, { created_at: 'not-a-date' }), work(T0), ME).queued).toBe(false);
    expect(queuedState(null, work(T0), ME).queued).toBe(false);
  });

  it('carries the worker count through for the label', () => {
    expect(queuedState(at(T0 + 5_000), work(T0, 3), ME)).toEqual({ queued: true, workers: 3 });
  });
});

describe('queuedLabel', () => {
  it('says nothing when not queued', () => {
    expect(queuedLabel({ queued: false, workers: 0 })).toEqual({ label: '', title: '' });
  });

  it('explains the wait without inventing a position or an ETA', () => {
    const { label, title } = queuedLabel({ queued: true, workers: 1 });
    expect(label).toBe('Queued');
    expect(title).toBe('Sent while the agent was already working — this is next in line');
    expect(title).not.toMatch(/\d+(st|nd|rd|th)/);
  });

  it('pluralises for several agents', () => {
    expect(queuedLabel({ queued: true, workers: 2 }).title)
      .toBe('Sent while 2 agents were already working — this is next in line');
  });
});

describe('unseenAnchorId', () => {
  const mine = (id: string) => ({ id, sender_id: ME, sender_kind: 'user', created_at: new Date(T0).toISOString() } as ReceiptMessage);
  const theirs = (id: string) => ({ id, sender_id: 'agent-1', sender_kind: 'agent', created_at: new Date(T0).toISOString() } as ReceiptMessage);

  it('is the newest message, when that message is yours', () => {
    expect(unseenAnchorId([theirs('a'), mine('b'), mine('c')], ME)).toBe('c');
  });

  it('is null once the other side has replied — the reply IS the answer', () => {
    expect(unseenAnchorId([mine('a'), theirs('b')], ME)).toBeNull();
  });

  it('marks ONE message, never the whole run', () => {
    // Three "Sent" chips stacked say one thing three times.
    const anchor = unseenAnchorId([mine('a'), mine('b'), mine('c')], ME);
    expect(anchor).toBe('c');
  });

  it('claims nothing for an empty transcript or an anonymous viewer', () => {
    expect(unseenAnchorId([], ME)).toBeNull();
    expect(unseenAnchorId([mine('a')], null)).toBeNull();
  });
});
