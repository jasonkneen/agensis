import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThreadBubble } from '../../src/components/chat/ChatThreadPanel';
import { SubThreadBubble } from '../../src/components/chat/SubThreadPanel';
import type { Message } from '../../src/types';

const OWNER = '11111111-1111-4111-8111-111111111111';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    role: 'user',
    sender_kind: 'user',
    sender_id: OWNER,
    sender_name: 'Alice',
    content: 'Owned message',
    created_at: '2026-07-31T12:00:00.000Z',
    ...overrides,
  };
}

describe('owned message actions in compact chat surfaces', () => {
  it('renders edit and delete for the exact human author in both panels', () => {
    const thread = renderToStaticMarkup(createElement(ThreadBubble, {
      msg: message(),
      currentUserId: OWNER,
    }));
    const subThread = renderToStaticMarkup(createElement(SubThreadBubble, {
      msg: message(),
      currentUserId: OWNER,
    }));

    for (const html of [thread, subThread]) {
      expect(html).toContain('aria-label="Edit post"');
      expect(html).toContain('aria-label="Delete post"');
    }
  });

  it('never renders mutation buttons for another author or an agent', () => {
    const anotherAuthor = renderToStaticMarkup(createElement(ThreadBubble, {
      msg: message(),
      currentUserId: '22222222-2222-4222-8222-222222222222',
    }));
    const agent = renderToStaticMarkup(createElement(SubThreadBubble, {
      msg: message({
        role: 'assistant',
        sender_kind: 'agent',
        sender_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
      currentUserId: OWNER,
    }));

    for (const html of [anotherAuthor, agent]) {
      expect(html).not.toContain('aria-label="Edit post"');
      expect(html).not.toContain('aria-label="Delete post"');
    }
  });

  it('keeps a deleted thread root visible as a body-free anchor', () => {
    const html = renderToStaticMarkup(createElement(ThreadBubble, {
      msg: message({
        content: 'This message was deleted.',
        deleted_at: '2026-07-31T12:05:00.000Z',
      }),
      currentUserId: OWNER,
      isParent: true,
    }));

    expect(html).toContain('This message was deleted.');
    expect(html).not.toContain('aria-label="Delete post"');
  });
});
