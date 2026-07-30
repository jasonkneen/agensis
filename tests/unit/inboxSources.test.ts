// Guards the two feeds the inbox QUERY cannot see — pending tool-call approvals
// and replies in followed threads — and the rule that decides where a row goes
// when you open it.
//
// The behaviours worth locking down are the ones that make the inbox a place
// you can stay in:
//   * an approval is only listed while it can still be ANSWERED (it expires);
//   * an approval is always unread, because the agent is stopped either way;
//   * approvals sort above blockers, which sort above everything else;
//   * a thread row points at its thread ROOT, and nothing else does — focusing
//     the thread panel on a reply would show an empty thread.
//
// Written with createElement rather than JSX so it stays a .ts file inside the
// only glob vitest runs (`tests/unit/**/*.test.ts`).

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxItem, PermissionRequest } from '../../src/types';
import type { ThreadInboxItem } from '../../src/lib/threadInbox';
import {
  approvalInboxItems,
  inboxOpenTarget,
  isApprovalContextKey,
  isThreadContextKey,
  mergeInboxItems,
  threadInboxItems,
  threadParentIdFromKey,
  unreadItemCount,
} from '../../src/components/inbox/inboxSources';
import {
  buildInboxRows,
  groupInboxItems,
  inboxPreview,
  inboxTypeLabel,
  senderLabel,
} from '../../src/components/inbox/inboxModel';
import { InboxList } from '../../src/components/inbox/InboxWindowContent';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const T = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function request(overrides: Partial<PermissionRequest> & { id: string }): PermissionRequest {
  return {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    sessionId: 'sess-1',
    messageId: 'msg-1',
    toolName: 'Bash',
    toolDetail: 'git clone https://example.test/repo',
    title: '',
    description: '',
    rules: ['Bash(git clone:*)'],
    scopes: ['once', 'session', 'always'],
    status: 'pending',
    scope: '',
    decidedBy: null,
    decidedByName: '',
    decidedAt: null,
    expiresAt: T(-5), // five minutes in the FUTURE
    createdAt: T(2),
    ...overrides,
  };
}

function thread(overrides: Partial<ThreadInboxItem> & { parentId: string }): ThreadInboxItem {
  return {
    sessionId: 'sess-9',
    sessionTitle: 'general',
    sessionFolder: 'Channels',
    parentPreview: 'Can someone look at the deploy?',
    parentSender: 'Jason',
    replyCount: 3,
    lastReplyAt: T(10),
    lastReplyPreview: 'Fixed — it was the edge function.',
    lastReplySender: 'Coder',
    unread: true,
    ...overrides,
  };
}

function serverItem(overrides: Partial<InboxItem> & { id: string }): InboxItem {
  return {
    category: 'mention',
    title: 'Jason: hey @coder',
    body: 'hey @coder can you look',
    contextKey: 'thread:sess-2',
    sessionId: 'sess-2',
    entityType: 'message',
    entityId: 'msg-77',
    actorName: 'Jason',
    createdAt: T(30),
    unread: true,
    ...overrides,
  };
}

describe('approvalInboxItems', () => {
  it('lists a pending, unexpired request as an always-unread approval', () => {
    const [item] = approvalInboxItems([request({ id: 'r1' })], NOW);
    expect(item.id).toBe('approval:r1');
    expect(item.category).toBe('approval');
    expect(item.contextKey).toBe('approval:r1');
    expect(item.entityType).toBe('permission_request');
    expect(item.entityId).toBe('r1');
    expect(item.sessionId).toBe('sess-1');
    expect(item.unread).toBe(true);
    // The daemon sent no `title`, so the summary is built from tool + detail.
    expect(item.title).toBe('Bash · git clone https://example.test/repo');
  });

  it('prefers the daemon’s own sentence when it sent one', () => {
    const [item] = approvalInboxItems(
      [request({ id: 'r1', title: 'Claude wants to clone agensis-agent' })],
      NOW,
    );
    expect(item.title).toBe('Claude wants to clone agensis-agent');
  });

  it('drops requests that were already decided', () => {
    const decided = [
      request({ id: 'a', status: 'allowed', scope: 'once' }),
      request({ id: 'd', status: 'denied' }),
      request({ id: 'e', status: 'expired' }),
    ];
    expect(approvalInboxItems(decided, NOW)).toEqual([]);
  });

  it('drops a request whose fuse has already burned down', () => {
    // The list route filters on expiry too, but a row can expire while the page
    // is open — offering buttons for a call that has already been refused is
    // the failure this guards.
    const expiring = request({ id: 'r1', expiresAt: T(1) }); // one minute AGO
    expect(approvalInboxItems([expiring], NOW)).toEqual([]);
    // ...and it was listed a couple of minutes earlier, on the same data.
    expect(approvalInboxItems([expiring], NOW - 3 * 60_000)).toHaveLength(1);
  });

  it('keeps a request that carries no expiry at all', () => {
    expect(approvalInboxItems([request({ id: 'r1', expiresAt: null })], NOW)).toHaveLength(1);
  });

  it('names the agent when the caller supplied a roster, and degrades without one', () => {
    const named = approvalInboxItems(
      [request({ id: 'r1', agentId: 'agent-7' })],
      NOW,
      new Map([['agent-7', 'Scout']]),
    );
    expect(named[0].actorName).toBe('Scout');
    expect(approvalInboxItems([request({ id: 'r1', agentId: 'agent-7' })], NOW)[0].actorName).toBe('');
  });
});

describe('threadInboxItems', () => {
  it('maps a followed thread onto the sidebar’s existing read-state key', () => {
    const [item] = threadInboxItems([thread({ parentId: 'p1' })]);
    expect(item.id).toBe('msgthread:p1');
    expect(item.contextKey).toBe('msgthread:p1');
    expect(item.category).toBe('thread');
    expect(item.sessionId).toBe('sess-9');
    // The thread ROOT, so opening this can focus the thread panel on it.
    expect(item.entityType).toBe('message');
    expect(item.entityId).toBe('p1');
    // Its place in the list is set by the reply, not by when the thread started.
    expect(item.createdAt).toBe(T(10));
    expect(item.actorName).toBe('Coder');
    expect(item.body).toBe('Fixed — it was the edge function.');
    expect(item.unread).toBe(true);
  });

  it('carries the server’s read state through rather than inventing one', () => {
    const [item] = threadInboxItems([thread({ parentId: 'p1', unread: false })]);
    expect(item.unread).toBe(false);
  });

  it('names a thread by its latest reply when the parent is an upload manifest', () => {
    const [item] = threadInboxItems([thread({
      parentId: 'p1',
      parentPreview: '[Linked files] - Screenshot 2026-07-27 at 10.16.32.png',
    })]);
    expect(item.title).toBe('Fixed — it was the edge function.');
  });

  it('skips a row with no parent id — it has nothing to open or mark read', () => {
    expect(threadInboxItems([thread({ parentId: '  ' })])).toEqual([]);
  });
});

describe('mergeInboxItems', () => {
  it('keeps the first occurrence of an id, so a server row is never shadowed', () => {
    const authoritative = serverItem({ id: 'approval:r1', category: 'blocker', title: 'from the server' });
    const reshaped = approvalInboxItems([request({ id: 'r1' })], NOW);
    const merged = mergeInboxItems([authoritative], reshaped);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('from the server');
  });

  it('concatenates distinct feeds and drops nothing', () => {
    const merged = mergeInboxItems(
      [serverItem({ id: 's1' })],
      approvalInboxItems([request({ id: 'r1' })], NOW),
      threadInboxItems([thread({ parentId: 'p1' })]),
    );
    expect(merged.map(item => item.id)).toEqual(['s1', 'approval:r1', 'msgthread:p1']);
  });
});

describe('unreadItemCount', () => {
  it('counts items, not rows', () => {
    expect(unreadItemCount([
      serverItem({ id: 'a', unread: true }),
      serverItem({ id: 'b', unread: true }),
      serverItem({ id: 'c', unread: false }),
    ])).toBe(2);
  });
});

describe('context key namespaces', () => {
  it('recognises each namespace and nothing else', () => {
    expect(isApprovalContextKey('approval:r1')).toBe(true);
    expect(isApprovalContextKey('blocker:r1')).toBe(false);
    expect(isThreadContextKey('msgthread:p1')).toBe(true);
    // 'thread:<sessionId>' is the MENTION key and must not be mistaken for one.
    expect(isThreadContextKey('thread:sess-1')).toBe(false);
    expect(threadParentIdFromKey('msgthread:p1')).toBe('p1');
    expect(threadParentIdFromKey('thread:sess-1')).toBe('');
  });
});

describe('inboxOpenTarget', () => {
  it('points a thread row at its thread root', () => {
    expect(inboxOpenTarget({
      category: 'thread', sessionId: 'sess-9', entityType: 'message', entityId: 'p1',
    })).toEqual({ sessionId: 'sess-9', threadParentId: 'p1' });
  });

  it('opens the conversation only for every other category', () => {
    // A mention's entityId is the message that mentioned you, which may itself
    // be a REPLY — focusing the thread panel on it would show an empty thread.
    expect(inboxOpenTarget({
      category: 'mention', sessionId: 'sess-2', entityType: 'message', entityId: 'msg-77',
    })).toEqual({ sessionId: 'sess-2', threadParentId: null });
    expect(inboxOpenTarget({
      category: 'approval', sessionId: 'sess-1', entityType: 'permission_request', entityId: 'r1',
    })).toEqual({ sessionId: 'sess-1', threadParentId: null });
  });

  it('offers nothing for an item with no conversation behind it', () => {
    expect(inboxOpenTarget({
      category: 'comment', sessionId: null, entityType: 'document', entityId: 'doc-1',
    })).toBeNull();
  });
});

describe('ordering across the merged feeds', () => {
  it('pins approvals above blockers, and both above everything newer', () => {
    const merged = mergeInboxItems(
      [
        serverItem({ id: 'fresh', createdAt: T(0), contextKey: 'thread:new' }),
        serverItem({ id: 'blk', createdAt: T(120), contextKey: 'blocker:1', category: 'blocker' }),
      ],
      // The approval is the OLDEST thing here and still sorts first, because it
      // is the only one on a timer.
      approvalInboxItems([request({ id: 'r1', createdAt: T(200) })], NOW),
      threadInboxItems([thread({ parentId: 'p1', lastReplyAt: T(5) })]),
    );
    expect(groupInboxItems(merged).map(group => group.key)).toEqual([
      'approval:r1', 'blocker:1', 'thread:new', 'msgthread:p1',
    ]);
  });
});

describe('row copy for the new categories', () => {
  const groupOf = (items: InboxItem[]) => groupInboxItems(items)[0];

  it('reads an approval as the call being asked about, not the daemon’s prose', () => {
    // The description has to be NON-EMPTY here or the assertion is vacuous: with
    // an empty body the generic fallback lands on the title anyway, and the test
    // passes over an implementation that has no approval case at all.
    const group = groupOf(approvalInboxItems(
      [request({ id: 'r1', description: 'Needed to inspect the agent repo.' })],
      NOW,
    ));
    expect(inboxTypeLabel(group)).toEqual({
      text: 'Needs your approval', chip: null, tone: 'blocker',
    });
    expect(inboxPreview(group)).toBe('Bash · git clone https://example.test/repo');
    expect(senderLabel(group)).toBe('An agent');
  });

  it('reads a thread reply as "Replied in <thread>", previewing the reply', () => {
    const group = groupOf(threadInboxItems([thread({ parentId: 'p1' })]));
    expect(inboxTypeLabel(group)).toEqual({
      text: 'Replied in', chip: 'Can someone look at the deploy?', tone: 'muted',
    });
    expect(inboxPreview(group)).toBe('Fixed — it was the edge function.');
    expect(senderLabel(group)).toBe('Coder');
  });
});

describe('InboxList rendering the merged feeds', () => {
  function render(items: InboxItem[]) {
    return renderToStaticMarkup(createElement(InboxList, {
      rows: buildInboxRows(groupInboxItems(items), NOW),
      unreadOnly: false,
      loading: false,
      selectedKey: null,
      onSelect: () => {},
      onMarkRead: () => {},
    }));
  }

  it('draws the approval first, labelled, above a newer mention', () => {
    const html = render(mergeInboxItems(
      [serverItem({ id: 'fresh', createdAt: T(0), contextKey: 'thread:new', actorName: 'Jason' })],
      approvalInboxItems([request({ id: 'r1', createdAt: T(200) })], NOW, new Map([['agent-1', 'Scout']])),
    ));
    expect(html).toContain('Needs your approval');
    expect(html.indexOf('Needs your approval')).toBeLessThan(html.indexOf('Mentioned you'));
    expect(html).toContain('Scout');
  });

  it('draws a thread reply with the thread name as its chip', () => {
    const html = render(threadInboxItems([thread({ parentId: 'p1' })]));
    expect(html).toContain('Replied in');
    expect(html).toContain('Can someone look at the deploy?');
    expect(html).toContain('Fixed — it was the edge function.');
  });

  it('says why the list is empty rather than showing a blank pane', () => {
    // The Unread filter emptying itself is the NORMAL end state of triage, and
    // a surface that goes silently blank there reads as broken data.
    const empty = renderToStaticMarkup(createElement(InboxList, {
      rows: [], unreadOnly: true, loading: false, selectedKey: null,
      onSelect: () => {}, onMarkRead: () => {},
    }));
    expect(empty).toContain('No unread messages');
    expect(empty).toContain('Turn off the unread filter');
  });
});
