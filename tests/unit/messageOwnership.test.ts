import { describe, expect, it } from 'vitest';
import { canMutateOwnMessage } from '../../src/lib/messageOwnership';

describe('canMutateOwnMessage', () => {
  const mine = {
    role: 'user',
    sender_kind: 'user',
    sender_id: 'user-1',
  };

  it('allows a proven human author to edit or delete their own message', () => {
    expect(canMutateOwnMessage(mine, 'user-1')).toBe(true);
  });

  it('fails closed for another user, an agent, or legacy unattributed rows', () => {
    expect(canMutateOwnMessage(mine, 'user-2')).toBe(false);
    expect(canMutateOwnMessage({ ...mine, role: 'assistant', sender_kind: 'agent' }, 'user-1')).toBe(false);
    expect(canMutateOwnMessage({ role: 'user', sender_kind: '', sender_id: '' }, 'user-1')).toBe(false);
    expect(canMutateOwnMessage(mine, null)).toBe(false);
  });

  it('does not offer mutation controls for an already deleted row', () => {
    expect(canMutateOwnMessage({ ...mine, deleted_at: '2026-07-31T00:00:00Z' }, 'user-1')).toBe(false);
  });
});
