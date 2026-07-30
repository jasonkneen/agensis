import { describe, expect, it } from 'vitest';
import {
  sortThreadInbox, threadInboxBadgeCount, threadReplyLabel, threadRowSource, threadRowTitle,
  type ThreadInboxItem,
} from '../../src/lib/threadInbox';

// The Threads section exists so a reply you have not seen is the first thing in
// it. Every rule here is one of the ways that quietly stops being true.
const item = (over: Partial<ThreadInboxItem>): ThreadInboxItem => ({
  parentId: 'p', sessionId: 's', sessionTitle: 'Coder', sessionFolder: 'General',
  parentPreview: 'hello', parentSender: 'jason', replyCount: 1, toolCount: 0,
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

  it('falls back to the LATEST REPLY when the parent has no text', () => {
    // Real case: an attachment, an image, or a tool step. A blank row is one
    // nobody can click with confidence — and the reply is what the thread is
    // actually about, so it names the row better than the session does.
    expect(threadRowTitle(item({ parentPreview: '   ', lastReplyPreview: 'moved it to staging' })))
      .toBe('moved it to staging');
  });

  it('treats an ATTACHMENT MANIFEST as no text at all', () => {
    // buildFileContext writes uploads into the message as "[Linked files]" plus
    // one line per file, and that text stays in the message for the agent to
    // read. Four uploads in a row produced four sidebar rows all reading
    // "[Linked files] - Screenshot 2026-07-27 at …", every one truncated to the
    // same thing. A list whose rows cannot be told apart is not a list.
    const preview = '[Linked files]\n- Screenshot 2026-07-27 at 10.14.22.png (upload): /tmp/a.png';
    expect(threadRowTitle(item({ parentPreview: preview, lastReplyPreview: 'looks right now' })))
      .toBe('looks right now');
    expect(threadRowTitle(item({ parentPreview: '[Image] cat.png', lastReplyPreview: 'ship it' }))).toBe('ship it');
  });

  it('keeps real text that merely CONTAINS a bracket', () => {
    // The rule is anchored at the start on a known set of markers, so a message
    // that happens to mention one is still a title.
    expect(threadRowTitle(item({ parentPreview: 'see [Linked files] above' }))).toBe('see [Linked files] above');
  });

  it('falls back to the session only when there is no reply text either', () => {
    expect(threadRowTitle(item({ parentPreview: '', lastReplyPreview: '', sessionTitle: 'Coder' })))
      .toBe('Thread in Coder');
    expect(threadRowTitle(item({ parentPreview: '', lastReplyPreview: '', sessionTitle: '' }))).toBe('Thread');
  });
});

describe('threadRowSource', () => {
  it('separates a thread in a DM from a thread in a channel', () => {
    // The sidebar row's leading icon comes from this, so it has to be the one
    // fact that distinguishes two rows whose titles read alike.
    expect(threadRowSource(item({ sessionFolder: 'Direct messages' }))).toBe('dm');
    expect(threadRowSource(item({ sessionFolder: 'direct messages ' }))).toBe('dm');
    expect(threadRowSource(item({ sessionFolder: 'General' }))).toBe('channel');
    expect(threadRowSource(item({ sessionFolder: '' }))).toBe('channel');
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

  // The server used to fold tool steps into replyCount, so this row and the
  // channel's thread chip disagreed about the same thread — 98 vs 14 on real
  // data. Now both exclude tool steps, and the sidebar says what the tool work
  // was rather than hiding it.
  it('names tool work separately instead of folding it into the reply count', () => {
    expect(threadReplyLabel(14, 84)).toBe('14 replies, 84 tool calls');
    expect(threadReplyLabel(1, 1)).toBe('1 reply, 1 tool call');
  });

  it('a thread with only tool steps reads as work, not as silence', () => {
    // "0 replies" alone would read as nothing having happened, when in fact the
    // agent is mid-run. The thread stays in the list for exactly that reason.
    expect(threadReplyLabel(0, 9)).toBe('9 tool calls');
    expect(threadReplyLabel(0, 1)).toBe('1 tool call');
  });

  // DEPLOY-ORDER SAFETY. The server change ships on Fly and this ships on
  // Netlify, and Netlify auto-deploys on push — so for a window the client can
  // be newer than the API and `toolCount` arrives undefined. It must degrade to
  // exactly the old label rather than rendering NaN into the sidebar.
  it('tolerates a toolCount the API is not sending yet', () => {
    expect(threadReplyLabel(3, undefined as unknown as number)).toBe('3 replies');
    expect(threadReplyLabel(3, NaN)).toBe('3 replies');
    expect(threadReplyLabel(3, null as unknown as number)).toBe('3 replies');
  });

  it('omits tool work entirely when there is none', () => {
    expect(threadReplyLabel(3, 0)).toBe('3 replies');
    expect(threadReplyLabel(3)).toBe('3 replies');
    expect(threadReplyLabel(3, -2)).toBe('3 replies');
    expect(threadReplyLabel(3, 1.9)).toBe('3 replies, 1 tool call');
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
