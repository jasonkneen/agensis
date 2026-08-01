export interface MessageOwnershipFields {
  role?: string | null;
  sender_kind?: string | null;
  sender_id?: string | null;
  deleted_at?: string | null;
}

/**
 * The UI is only a hint; the backend repeats this check against the stored row.
 * Fail closed for legacy rows with no sender_id because their author cannot be
 * proven from a display name.
 */
export function canMutateOwnMessage(
  message: MessageOwnershipFields | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (!message || !currentUserId || message.deleted_at) return false;
  return message.role === 'user'
    && message.sender_kind === 'user'
    && String(message.sender_id || '') === String(currentUserId);
}
