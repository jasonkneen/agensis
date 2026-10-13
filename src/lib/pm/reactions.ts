// Emoji reactions on a task comment, stored as { emoji: [user ids] }. Pure helpers, so the
// rules (one reaction per person per emoji, empty entries disappear, bad data is ignored)
// are tested on their own.

export type Reactions = Record<string, string[]>;

/** The emoji offered in the picker, in order. */
export const REACTION_EMOJIS = ['👍', '✅', '👀', '🎉'] as const;

/** Turns whatever was stored into a clean map: strings only, no duplicates, no empty entries. */
export function normalizeReactions(raw: unknown): Reactions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Reactions = {};
  for (const [emoji, users] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(users)) continue;
    const ids = Array.from(new Set(users.filter((id): id is string => typeof id === 'string' && id.length > 0)));
    if (ids.length) result[emoji] = ids;
  }
  return result;
}

/** The map after `userId` adds or removes `emoji`. Never mutates the input. */
export function toggleReaction(raw: unknown, emoji: string, userId: string): Reactions {
  const reactions = normalizeReactions(raw);
  const users = reactions[emoji] ?? [];
  const next = users.includes(userId) ? users.filter(id => id !== userId) : [...users, userId];
  const result: Reactions = { ...reactions };
  if (next.length) result[emoji] = next;
  else delete result[emoji];
  return result;
}

/** The chips to show: emoji, how many people, and whether `userId` is one of them. */
export function reactionChips(raw: unknown, userId: string | undefined): Array<{ emoji: string; count: number; mine: boolean }> {
  return Object.entries(normalizeReactions(raw)).map(([emoji, users]) => ({
    emoji,
    count: users.length,
    mine: Boolean(userId) && users.includes(userId as string),
  }));
}
