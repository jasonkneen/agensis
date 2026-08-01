import { describe, expect, it } from 'vitest';
import {
  DELETED_MESSAGE_CONTENT,
  redactDeletedMessage,
  toDeletedMessageTombstone,
} from '../../src/lib/messageTombstone';
import type { Message } from '../../src/types';

const message: Message = {
  id: 'message-1',
  session_id: 'session-1',
  role: 'user',
  content: 'private deleted content',
  attachments: [{ id: 'file-1', name: 'private.txt', type: 'text/plain', size: 10 }],
  message_kind: 'tool_step',
  tool_name: 'Read',
  tool_detail: '/private/path',
  reactions: { fire: ['user-1'] },
  pinned: true,
  source_task_id: 'task-1',
  thread_parent_id: 'parent-1',
  sender_kind: 'user',
  sender_id: 'user-1',
  sender_name: 'Alice',
  deleted_at: '2026-07-31T12:00:00.000Z',
  created_at: '2026-07-31T11:00:00.000Z',
};

describe('deleted message tombstones', () => {
  it('removes authored payload fields and retains thread identity', () => {
    const tombstone = redactDeletedMessage(message);
    expect(tombstone.content).toBe(DELETED_MESSAGE_CONTENT);
    expect(tombstone.attachments).toEqual([]);
    expect(tombstone.message_kind).toBe('');
    expect(tombstone.tool_name).toBe('');
    expect(tombstone.tool_detail).toBe('');
    expect(tombstone.reactions).toEqual({});
    expect(tombstone.pinned).toBe(false);
    expect(tombstone.source_task_id).toBeNull();
    expect(tombstone.id).toBe(message.id);
    expect(tombstone.thread_parent_id).toBe(message.thread_parent_id);
    expect(tombstone.sender_id).toBe(message.sender_id);
  });

  it('creates the same tombstone immediately for an optimistic delete', () => {
    const live = { ...message, deleted_at: null };
    const tombstone = toDeletedMessageTombstone(live, '2026-07-31T13:00:00.000Z');
    expect(tombstone.deleted_at).toBe('2026-07-31T13:00:00.000Z');
    expect(tombstone.content).toBe(DELETED_MESSAGE_CONTENT);
  });
});
