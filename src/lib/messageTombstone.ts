import type { Message } from '../types';

export const DELETED_MESSAGE_CONTENT = 'This message was deleted.';

/**
 * Preserve ids, parent links, sender, and timestamps so replies/sub-threads
 * keep a usable anchor. Authored payload fields are replaced even if an older
 * backend accidentally sends the raw soft-deleted row over realtime.
 */
export function redactDeletedMessage(message: Message): Message {
  if (!message.deleted_at) return message;
  return {
    ...message,
    content: DELETED_MESSAGE_CONTENT,
    attachments: [],
    message_kind: '',
    tool_name: '',
    tool_detail: '',
    reactions: {},
    pinned: false,
    source_task_id: null,
    huddle_id: null,
    permission_request_id: null,
  };
}

export function toDeletedMessageTombstone(
  message: Message,
  deletedAt = new Date().toISOString(),
): Message {
  return redactDeletedMessage({ ...message, deleted_at: message.deleted_at || deletedAt });
}
