import { useEffect, useState } from 'react';
import { backendClient } from '../lib/backendClient';
import { announceActivityRedaction } from '../lib/activityRedaction';
import { canMutateOwnMessage } from '../lib/messageOwnership';
import { DELETED_MESSAGE_CONTENT } from '../lib/messageTombstone';
import type { Message } from '../types';

/**
 * Ownership-scoped edit/delete behavior shared by the compact thread surfaces.
 * The backend repeats every check; this hook keeps those panels truthful while
 * realtime catches up, instead of making their buttons second-class versions
 * of the main transcript actions.
 */
export function useOwnMessageMutation(
  message: Message,
  currentUserId: string | null | undefined,
  initialContent: string,
) {
  const [content, setContent] = useState(initialContent);
  const [draft, setDraft] = useState(initialContent);
  const [editing, setEditing] = useState(false);
  const [deleted, setDeleted] = useState(Boolean(message.deleted_at));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editing) return;
    setContent(initialContent);
    setDraft(initialContent);
    setDeleted(Boolean(message.deleted_at));
  }, [editing, initialContent, message.deleted_at]);

  const mutable = canMutateOwnMessage(message, currentUserId) && !deleted;

  const startEdit = () => {
    if (!mutable || busy) return;
    setDraft(content);
    setEditing(true);
  };

  const cancelEdit = () => {
    setDraft(content);
    setEditing(false);
  };

  const saveEdit = async () => {
    const next = draft.trim();
    if (!mutable || busy || !next) return false;
    const previous = content;
    setContent(next);
    setEditing(false);
    setBusy(true);
    const { error } = await backendClient
      .from('messages')
      .update({ content: next })
      .eq('id', message.id)
      .eq('session_id', message.session_id);
    setBusy(false);
    if (error) {
      setContent(previous);
      setDraft(previous);
      return false;
    }
    announceActivityRedaction({ messageId: message.id, sessionId: message.session_id });
    return true;
  };

  const deleteMessage = async () => {
    if (!mutable || busy) return false;
    if (
      typeof window !== 'undefined'
      && typeof window.confirm === 'function'
      && !window.confirm('Delete this message? Replies and sub-threads will remain attached to a deleted-message marker.')
    ) return false;
    setBusy(true);
    const { error } = await backendClient
      .from('messages')
      .delete()
      .eq('id', message.id)
      .eq('session_id', message.session_id);
    setBusy(false);
    if (error) return false;
    setDeleted(true);
    setEditing(false);
    setContent(DELETED_MESSAGE_CONTENT);
    announceActivityRedaction({ messageId: message.id, sessionId: message.session_id });
    return true;
  };

  return {
    busy,
    cancelEdit,
    content: deleted ? DELETED_MESSAGE_CONTENT : content,
    deleteMessage,
    deleted,
    draft,
    editing,
    mutable,
    saveEdit,
    setDraft,
    startEdit,
  };
}
