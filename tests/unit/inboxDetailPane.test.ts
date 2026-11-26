// The inbox reading pane, rendered: it reads like an email (no debug rows), and
// it offers a "Write a comment" box only where there is a chat thread for the
// comment to land in.
//
// Written with createElement rather than JSX so it stays a .ts file inside the
// only glob vitest runs (`tests/unit/**/*.test.ts`).

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxItem } from '../../src/types';
import { groupInboxItems } from '../../src/components/inbox/inboxModel';
import { InboxDetail } from '../../src/components/inbox/InboxDetailPane';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function item(overrides: Partial<InboxItem> & { id: string }): InboxItem {
  return {
    category: 'thread',
    title: 'Deploy thread',
    body: 'Fixed — it was the edge function.',
    contextKey: `msgthread:${overrides.id}`,
    sessionId: 'sess-9',
    entityType: 'message',
    entityId: 'p1',
    actorName: 'Coder',
    createdAt: new Date(NOW - 60_000).toISOString(),
    unread: true,
    ...overrides,
  };
}

function render(source: InboxItem, withReply = true) {
  const [group] = groupInboxItems([source]);
  return renderToStaticMarkup(createElement(InboxDetail, {
    group,
    now: NOW,
    onClose: () => {},
    onOpenSession: () => {},
    onReplyInThread: withReply ? async () => ({ delivered: true }) : undefined,
    workspaceId: null,
  }));
}

describe('InboxDetail', () => {
  it('shows no raw entity / id rows', () => {
    const html = render(item({ id: 't1' }));
    expect(html).not.toContain('>Entity<');
    expect(html).not.toContain('>Id<');
    expect(html).not.toContain('>p1<');
  });

  it('offers the comment box on a thread reply', () => {
    const html = render(item({ id: 't1' }));
    expect(html).toContain('data-inbox-reply');
    expect(html).toContain('Write a comment');
  });

  it('offers the comment box on a mention', () => {
    const html = render(item({ id: 'm1', category: 'mention', contextKey: 'thread:sess-9', entityId: 'msg-77' }));
    expect(html).toContain('data-inbox-reply');
  });

  it('hides it where there is no thread to reply into', () => {
    for (const source of [
      item({ id: 'c1', category: 'comment', sessionId: null, entityType: 'task', entityId: 'task-1', title: 'Comment on Roadmap' }),
      item({ id: 'e1', category: 'error', entityType: 'agent_job', entityId: 'job-1', title: 'Scout run failed' }),
      item({ id: 'b1', category: 'blocker', entityType: 'thread_item', entityId: 'b1', title: 'Ship or wait?', body: '' }),
    ]) {
      expect(render(source)).not.toContain('data-inbox-reply');
    }
  });

  it('hides it when no send path is wired', () => {
    expect(render(item({ id: 't1' }), false)).not.toContain('data-inbox-reply');
  });
});
