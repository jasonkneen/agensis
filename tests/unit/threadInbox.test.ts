import { describe, expect, it } from 'vitest';
import {
  sortThreadInbox, threadInboxBadgeCount, threadReplyLabel, threadRowTitle,
  type ThreadInboxItem,
} from '../../src/lib/threadInbox';

// The Threads section exists so a reply you have not seen is the first thing in
// it. Every rule here is one of the ways that quietly stops being true.
const item = (over: Partial<ThreadInboxItem>): ThreadInboxItem => ({
  parentId: 'p', sessionId: 's', sessionTitle: 'Coder', sessionFolder: 'General',
  parentPreview: 'hello', parentSender: 'jason', replyCount: 1,
  lastReplyAt: '2026-07-26T10:00:00.000Z', lastReplyPreview: 'hi',
  lastReplySender: 'Coder', unread: false, ...over,
});

describe('threadRowTitle', () => {
  it('names a thread by the message that started it', () => {
    expect(threadRowTitle(item({ parentPreview: 'are you checking?' }))).toBe('are you checking?');
  });

  it('collapses whitespace so a multi-line parent stays one row', () => {
    expect(threadRowTitle(item({ parentPreview: 'ok\n\n  updated ' }))).toBe('ok updated');
  });

  it('falls back to the session when the parent has NO text', () => {
    // Real case: an attachment, an image, or a tool step. A blank row is one
    // nobody can click with confidence.
    expect(threadRowTitle(item({ parentPreview: '   ', sessionTitle: 'Coder' }))).toBe('Thread in Coder');
    expect(threadRowTitle(item({ parentPreview: '', sessionTitle: '' }))).toBe('Thread');
  });
});

describe('threadReplyLabel', () => {
  it('singular and plural, including zero', () => {
    expect(threadReplyLabel(1)).toBe('1 reply');
    expect(threadReplyLabel(11)).toBe('11 replies');
    expect(threadReplyLabel(0)).toBe('0 replies');
  });

  it('never renders a negative or fractional count', () => {
    expect(threadReplyLabel(-3)).toBe('0 replies');
    expect(threadReplyLabel(2.7)).toBe('2 replies');
  });
});

describe('sortThreadInbox', () => {
  it('lifts unread above read', () => {
    const sorted = sortThreadInbox([
      item({ parentId: 'read-new', unread: false }),
      item({ parentId: 'unread-old', unread: true }),
    ]);
    expect(sorted.map(i => i.parentId)).toEqual(['unread-old', 'read-new']);
  });

  it('PRESERVES recency order inside each block', () => {
    // The server returns newest-first; this is a partition, not a re-sort, so
    // two unread threads must not swap.
    const sorted = sortThreadInbox([
      item({ parentId: 'u1', unread: true }),
      item({ parentId: 'r1', unread: false }),
      item({ parentId: 'u2', unread: true }),
      item({ parentId: 'r2', unread: false }),
    ]);
    expect(sorted.map(i => i.parentId)).toEqual(['u1', 'u2', 'r1', 'r2']);
  });

  it('does not mutate its input', () => {
    const input = [item({ parentId: 'a', unread: false }), item({ parentId: 'b', unread: true })];
    sortThreadInbox(input);
    expect(input.map(i => i.parentId)).toEqual(['a', 'b']);
  });
});

describe('threadInboxBadgeCount', () => {
  it('counts what needs attention, not what exists', () => {
    // A badge showing every thread never reaches zero, so it never means
    // anything; the section would read as decoration.
    expect(threadInboxBadgeCount([
      item({ unread: true }), item({ unread: false }), item({ unread: true }),
    ])).toBe(2);
    expect(threadInboxBadgeCount([item({ unread: false })])).toBe(0);
    expect(threadInboxBadgeCount([])).toBe(0);
  });
});
