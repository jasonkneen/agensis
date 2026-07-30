// The reactions bar's logic, with no React, so it can be tested at all.
//
// `tests/unit/**/*.test.ts` is the only glob the frontend runner sees and
// `.test.tsx` is outside it, so anything left inside the component is untestable
// in this repo. That is why the pill ordering, the own-reaction check, the
// tooltip wording and the frequently-used ranking live here rather than inline.
//
// EMOJI POLICY. The project rule is that there is no decorative emoji in UI
// chrome. Reactions are the deliberate exception, and the line is precise: the
// PILL GLYPH and the PICKER CONTENTS are user-selected content, so they are
// emoji. Everything around them — the add-reaction trigger, the counts, the
// tooltips, the aria labels, the read indicator — is chrome, so it is text or a
// lucide SVG. REACTION_PICKER_GROUPS below is content; nothing else in this file
// renders a glyph.

export type ReactionMap = Record<string, string[]>;

/** One rendered pill. */
export interface ReactionPill {
  reaction: string;
  count: number;
  /** True when the current user is one of the holders — drives aria-pressed. */
  mine: boolean;
  /** The holders, in stored order, for the tooltip. */
  userIds: string[];
}

/**
 * Pills in a stable order: most-held first, then alphabetically by the reaction
 * itself.
 *
 * Object key order would otherwise decide it, which is insertion order in
 * practice — so the row silently re-ordered whenever a reaction was removed and
 * re-added, and two people looking at the same message could see different
 * orders. A tiebreak on the reaction string makes it the same everywhere.
 *
 * A reaction nobody holds is dropped rather than rendered as a zero: the stored
 * map is supposed to delete the key when the last holder leaves, and a row
 * written before that invariant existed must not draw an empty pill.
 */
export function reactionPills(reactions: ReactionMap | null | undefined, currentUserId: string | null): ReactionPill[] {
  const entries: ReactionPill[] = [];
  for (const [reaction, users] of Object.entries(reactions || {})) {
    if (!Array.isArray(users) || users.length === 0) continue;
    const userIds = users.map(String);
    entries.push({
      reaction,
      count: userIds.length,
      mine: currentUserId ? userIds.includes(String(currentUserId)) : false,
      userIds,
    });
  }
  entries.sort((a, b) => (b.count - a.count) || a.reaction.localeCompare(b.reaction));
  return entries;
}

/**
 * The operation a click should send.
 *
 * The client decides this from what it can see, and a wrong guess is safe: the
 * server's statement is a no-op when the world already matches, and the response
 * carries the map that actually holds, so the view self-corrects. It is NOT a
 * server-side toggle, because deciding "add or remove" on the server would need
 * a read before the write — which is the race this whole change removes.
 */
export function reactionToggleOp(pill: ReactionPill | undefined, currentUserId: string | null): 'add' | 'remove' {
  if (!pill || !currentUserId) return 'add';
  return pill.mine ? 'remove' : 'add';
}

/**
 * The tooltip. Names, never uuids — an id that will not resolve renders as
 * "Someone", because a uuid in a tooltip is useless to the reader and a small
 * identifier leak into any screenshot of it.
 *
 * Truncates at five names plus "and N others"; a message with forty reactors
 * would otherwise produce a tooltip taller than the window.
 */
export function describeReactors(
  pill: ReactionPill,
  resolveName: (userId: string) => string | null,
  currentUserId: string | null,
  maxNames = 5,
): string {
  const names = pill.userIds.map(id => (
    currentUserId && id === String(currentUserId) ? 'You' : (resolveName(id) || 'Someone')
  ));
  const head = names.slice(0, maxNames);
  const rest = names.length - head.length;
  const list = rest > 0
    ? `${head.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`
    : head.length > 1
      ? `${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`
      : head[0] || '';
  return `${list} reacted with ${pill.reaction}`;
}

/**
 * The accessible name for a pill.
 *
 * A screen reader gets none of the visual story: not the glyph, not the tint
 * that means "you reacted", not the count's meaning. `aria-pressed` carries the
 * toggle state and this carries the rest in words.
 */
export function reactionPillLabel(pill: ReactionPill): string {
  const people = pill.count === 1 ? '1 reaction' : `${pill.count} reactions`;
  return pill.mine
    ? `${pill.reaction}, ${people}, you reacted`
    : `${pill.reaction}, ${people}`;
}

// The picker's contents. Grouped rather than one flat grid so search has
// something to fall back to and the common set stays at the top. These sixteen
// were the whole picker before and they are a good set, so they stay first and
// seed "frequently used" for someone who has never reacted.
export const REACTION_PICKER_GROUPS: ReadonlyArray<{ name: string; reactions: readonly string[] }> = [
  {
    name: 'Common',
    reactions: ['👍', '👎', '❤️', '😂', '🎉', '🔥', '👀', '✅', '🙏', '💯', '😮', '😢', '🤔', '🚀', '⭐', '🐛'],
  },
  {
    name: 'Reactions',
    reactions: ['😀', '😅', '😊', '😍', '🤩', '😎', '🥳', '😴', '😳', '🤯', '😱', '🙃', '😤', '😭', '🤝', '👏'],
  },
  {
    name: 'Hands',
    reactions: ['👋', '🤚', '✌️', '🤞', '👌', '🤙', '💪', '🫡', '🫶', '🙌', '👐', '☝️'],
  },
  {
    name: 'Work',
    reactions: ['✏️', '📝', '📌', '📎', '📊', '📈', '📉', '🗓️', '⏰', '⏳', '🔔', '🔒', '🔑', '🧪', '🛠️', '⚙️'],
  },
  {
    name: 'Status',
    reactions: ['🟢', '🟡', '🔴', '⚪', '❗', '❓', '⚠️', '🚧', '🆗', '🆕', '💤', '♻️'],
  },
  {
    name: 'Objects',
    reactions: ['💡', '📦', '🎯', '🧩', '🏆', '🎁', '☕', '🍕', '🌱', '🌈', '⚡', '❄️'],
  },
];

const ALL_REACTIONS: readonly string[] = REACTION_PICKER_GROUPS.flatMap(group => group.reactions);

// Search terms, so the field is useful without pulling in a full emoji dataset
// (~1 MB of names and keywords) that plans/013 exists to keep out of the bundle.
// Only the terms people actually type; an unlisted emoji is still reachable by
// scrolling, which is how the picker worked before search existed at all.
const REACTION_KEYWORDS: Record<string, string> = {
  '👍': 'thumbsup yes ok approve lgtm plus1 like',
  '👎': 'thumbsdown no reject nope',
  '❤️': 'heart love red',
  '😂': 'joy laugh lol funny',
  '🎉': 'tada party celebrate ship launch',
  '🔥': 'fire hot burn great',
  '👀': 'eyes look watching review seen',
  '✅': 'check tick done complete yes',
  '🙏': 'pray thanks please thankyou',
  '💯': 'hundred perfect score',
  '😮': 'wow surprised open mouth',
  '😢': 'sad cry tear',
  '🤔': 'thinking hmm consider unsure',
  '🚀': 'rocket ship launch deploy fast',
  '⭐': 'star favourite favorite',
  '🐛': 'bug defect issue insect',
  '👏': 'clap applause well done',
  '💪': 'muscle strong flex',
  '🫡': 'salute yes chief acknowledged',
  '🙌': 'raised hands celebrate praise',
  '📌': 'pin pinned important',
  '📈': 'chart up growth increase',
  '📉': 'chart down decline decrease',
  '⏰': 'alarm clock time deadline',
  '⏳': 'hourglass waiting slow pending',
  '🔒': 'lock locked secure private',
  '🔑': 'key access credential',
  '🧪': 'test experiment lab flask',
  '🛠️': 'tools fix build repair',
  '⚙️': 'gear settings config',
  '🟢': 'green go pass healthy',
  '🟡': 'yellow warning caution',
  '🔴': 'red fail broken down',
  '❗': 'exclamation important urgent',
  '❓': 'question ask unclear',
  '⚠️': 'warning caution careful',
  '🚧': 'construction wip in progress blocked',
  '🆕': 'new',
  '💡': 'idea bulb suggestion',
  '🎯': 'target goal focus bullseye',
  '🧩': 'puzzle piece part',
  '🏆': 'trophy win award',
  '☕': 'coffee break tea',
  '⚡': 'zap fast lightning quick',
};

/**
 * Search the picker. An empty query returns everything, so the field can be
 * rendered unconditionally without the grid disappearing.
 *
 * Matches the glyph itself as well as the keywords, so pasting an emoji finds it.
 */
export function searchReactions(query: string, pool: readonly string[] = ALL_REACTIONS): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...pool];
  return pool.filter(reaction => (
    reaction.includes(needle) || (REACTION_KEYWORDS[reaction] || '').includes(needle)
  ));
}

export interface ReactionUse {
  reaction: string;
  count: number;
  /** ms; breaks ties so a recent single use beats an old single use. */
  lastUsedAt: number;
}

export const FREQUENT_REACTION_LIMIT = 8;

/**
 * "Frequently used", ranked by count and then by recency.
 *
 * The recency tiebreak matters more than it looks: without it, a dozen
 * once-used reactions sit in whatever order the storage happened to hold, so the
 * row is stable but arbitrary and the one you used a minute ago is not in it.
 *
 * Seeded from the Common group so a new account gets a useful row rather than an
 * empty one — the same sixteen the picker shipped with.
 */
export function frequentReactions(uses: readonly ReactionUse[], limit = FREQUENT_REACTION_LIMIT): string[] {
  const ranked = [...uses]
    .filter(use => use.count > 0)
    .sort((a, b) => (b.count - a.count) || (b.lastUsedAt - a.lastUsedAt) || a.reaction.localeCompare(b.reaction))
    .map(use => use.reaction);
  const seeded = [...ranked];
  for (const reaction of REACTION_PICKER_GROUPS[0].reactions) {
    if (seeded.length >= limit) break;
    if (!seeded.includes(reaction)) seeded.push(reaction);
  }
  return seeded.slice(0, limit);
}

/** Record one use, for the ranking above. Pure: returns the next list. */
export function noteReactionUse(uses: readonly ReactionUse[], reaction: string, now: number): ReactionUse[] {
  const next = uses.map(use => ({ ...use }));
  const existing = next.find(use => use.reaction === reaction);
  if (existing) {
    existing.count += 1;
    existing.lastUsedAt = now;
  } else {
    next.push({ reaction, count: 1, lastUsedAt: now });
  }
  // Bounded: an unbounded list in localStorage grows for the life of the
  // account, and nothing below the top few is ever shown.
  return next
    .sort((a, b) => (b.count - a.count) || (b.lastUsedAt - a.lastUsedAt))
    .slice(0, 40);
}
