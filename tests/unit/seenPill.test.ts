import { describe, expect, it } from 'vitest';
import { SEEN_GLYPH, describeSeenBy, seenAnchorIds, seenPillLabel } from '../../src/lib/seenPill';
import type { ReceiptMessage } from '../../src/lib/readReceipts';

const ME = 'user-1';

function mine(id: string): ReceiptMessage {
  return { id, sender_id: ME, sender_kind: 'user', created_at: '2026-01-01T00:00:00.000Z' } as ReceiptMessage;
}

function theirs(id: string): ReceiptMessage {
  return { id, sender_id: 'agent-1', sender_kind: 'agent', created_at: '2026-01-01T00:00:00.000Z' } as ReceiptMessage;
}

const NAMES: Record<string, string> = { 'agent-1': 'Coder', 'agent-2': 'Grok', 'user-2': 'Ana' };
const resolve = (id: string) => NAMES[id] ?? null;

describe('describeSeenBy', () => {
  it('is empty when nobody has read it, so the caller can skip the pill', () => {
    expect(describeSeenBy([], resolve)).toBe('');
  });

  it('names one reader without a list', () => {
    expect(describeSeenBy(['agent-1'], resolve)).toBe('Seen by Coder');
  });

  it('joins the last name with "and"', () => {
    expect(describeSeenBy(['agent-1', 'agent-2'], resolve)).toBe('Seen by Coder and Grok');
  });

  it('never leaks a raw uuid for an unknown reader', () => {
    const label = describeSeenBy(['3f8b0c22-0000-4000-8000-000000000000'], resolve);
    expect(label).toBe('Seen by Someone');
    expect(label).not.toContain('3f8b');
  });

  it('summarises the tail past the cap', () => {
    expect(describeSeenBy(['agent-1', 'agent-2', 'user-2', 'x', 'y', 'z'], resolve))
      .toBe('Seen by Coder, Grok, Ana, Someone and 2 others');
  });
});

describe('seenPillLabel', () => {
  it('states the count in words, because the glyph announces as "eyes"', () => {
    expect(seenPillLabel(['agent-1'], resolve)).toBe('Seen by 1 reader: Coder');
    expect(seenPillLabel(['agent-1', 'agent-2'], resolve)).toBe('Seen by 2 readers: Coder and Grok');
  });

  it('says so when nothing has been read', () => {
    expect(seenPillLabel([], resolve)).toBe('Not seen yet');
  });
});

describe('seenAnchorIds', () => {
  it('marks EVERY message of the trailing run — the mid-stream case', () => {
    const anchors = seenAnchorIds([theirs('a'), mine('b'), mine('c'), mine('d')], ME);
    expect([...anchors].sort()).toEqual(['b', 'c', 'd']);
  });

  it('keeps last-of-run only for runs somebody has already replied to', () => {
    const anchors = seenAnchorIds([mine('a'), mine('b'), theirs('c'), mine('d'), mine('e')], ME);
    // a/b are historical: only b anchors. d/e are the trailing run: both anchor.
    expect([...anchors].sort()).toEqual(['b', 'd', 'e']);
  });

  it('never anchors somebody else\'s message', () => {
    const anchors = seenAnchorIds([mine('a'), theirs('b')], ME);
    expect(anchors.has('b')).toBe(false);
    expect(anchors.has('a')).toBe(true);
  });

  it('anchors nothing without a viewer, so an anonymous session claims no receipts', () => {
    expect(seenAnchorIds([mine('a'), mine('b')], null).size).toBe(0);
  });

  it('treats an agent message from your own id as not yours', () => {
    const agentEcho = { id: 'z', sender_id: ME, sender_kind: 'agent', created_at: '2026-01-01T00:00:00.000Z' } as ReceiptMessage;
    expect(seenAnchorIds([agentEcho], ME).size).toBe(0);
  });

  it('is a single glyph, so the pill cannot silently become a string of emoji', () => {
    expect([...SEEN_GLYPH]).toHaveLength(1);
  });
});
