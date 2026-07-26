import {
  BarChart3, BookOpen, Bug, Calendar, Coffee, FlaskConical, Globe, Hash, Heart,
  Megaphone, Music, Palette, Rocket, Shield, Sparkles, Wrench, type LucideIcon,
} from 'lucide-react';
import { normalizeConversationMode, type ConversationMode } from './channelMentions';

// ---------------------------------------------------------------------------
// A channel's presentable profile: its icon, its description, its INTENT.
//
// The icon KEY is what persists — never a component and never a glyph. Storing
// a key means the visual set can be re-drawn, renamed or swapped for a different
// icon family without a data migration, and it keeps the column readable in
// psql. Unknown keys fall back to the hash rather than throwing: a channel saved
// by a newer client must still open in an older one.
//
// The normalizers below are DUPLICATED from shared/channelIntent.cjs, which the
// server uses when it injects the intent into an agent turn. They cannot be
// imported: shared/*.cjs is server code (CommonJS, both backends) and nothing
// under src/ may pull it into the browser bundle. Instead
// tests/channel-intent-parity.test.cjs runs both implementations over the same
// inputs and fails if they ever disagree — the same tactic as the /agents
// projection parity test. If you change a rule here, change it there.
// ---------------------------------------------------------------------------

/** Long enough for a paragraph of house style; short enough not to crowd a turn. */
export const MAX_INTENT_CHARS = 2000;
export const MAX_DESCRIPTION_CHARS = 500;

/** Icons a channel may wear. These keys are what the database stores. */
export const CHANNEL_ICONS = [
  'hash', 'megaphone', 'sparkles', 'wrench', 'bug', 'rocket',
  'flask', 'book', 'coffee', 'music', 'palette', 'shield',
  'chart', 'calendar', 'globe', 'heart',
] as const;

export function normalizeChannelIcon(value: unknown): string {
  const icon = String(value ?? '').trim().toLowerCase();
  return (CHANNEL_ICONS as readonly string[]).includes(icon) ? icon : '';
}

function normalizeChannelText(value: unknown, limit: number): string {
  if (value == null) return '';
  // Collapse the runs of blank lines a paste leaves behind, but keep single
  // newlines: an intent is often a short list, and flattening it to one line
  // would change how it reads to both humans and agents.
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

export const normalizeChannelIntent = (value: unknown): string =>
  normalizeChannelText(value, MAX_INTENT_CHARS);
export const normalizeChannelDescription = (value: unknown): string =>
  normalizeChannelText(value, MAX_DESCRIPTION_CHARS);

/** Key -> glyph. Keys not in here cannot be stored (normalizeChannelIcon drops them). */
const ICON_GLYPHS: Record<string, LucideIcon> = {
  hash: Hash,
  megaphone: Megaphone,
  sparkles: Sparkles,
  wrench: Wrench,
  bug: Bug,
  rocket: Rocket,
  flask: FlaskConical,
  book: BookOpen,
  coffee: Coffee,
  music: Music,
  palette: Palette,
  shield: Shield,
  chart: BarChart3,
  calendar: Calendar,
  globe: Globe,
  heart: Heart,
};

/** The glyph for a stored key. Hash for '' or anything unrecognised. */
export function channelIconGlyph(icon: string | null | undefined): LucideIcon {
  return ICON_GLYPHS[normalizeChannelIcon(icon)] ?? Hash;
}

/** The pickable set, in display order, as [key, glyph] pairs. */
export function channelIconChoices(): Array<[string, LucideIcon]> {
  return CHANNEL_ICONS.map(key => [key, ICON_GLYPHS[key] ?? Hash]);
}

export interface ChannelProfileDraft {
  title: string;
  description: string;
  icon: string;
  intent: string;
  /**
   * chat_sessions.conversation_mode — whether a post nobody addressed still
   * expects an answer now. Normalized by src/lib/channelMentions.ts, which the
   * server shares, so a channel set to 'mention' here really does stop
   * dispatching there.
   */
  conversation_mode: ConversationMode;
}

/**
 * What Save should write, or null when nothing changed.
 *
 * A SPARSE diff, for the same reason the agent detail form sends one: writing
 * every field on every save means a save that only renamed the channel also
 * rewrites its intent, and two people editing different fields would clobber
 * each other. An empty title falls back to the baseline — a channel with no
 * name is unreachable in the sidebar, so it is refused rather than saved.
 */
export function channelProfileDiff(
  draft: ChannelProfileDraft,
  baseline: ChannelProfileDraft,
): Partial<ChannelProfileDraft> | null {
  const next: Partial<ChannelProfileDraft> = {};
  const title = String(draft.title ?? '').trim().slice(0, 200);
  if (title && title !== baseline.title) next.title = title;

  const description = normalizeChannelDescription(draft.description);
  if (description !== normalizeChannelDescription(baseline.description)) next.description = description;

  const icon = normalizeChannelIcon(draft.icon);
  if (icon !== normalizeChannelIcon(baseline.icon)) next.icon = icon;

  const intent = normalizeChannelIntent(draft.intent);
  if (intent !== normalizeChannelIntent(baseline.intent)) next.intent = intent;

  const mode = normalizeConversationMode(draft.conversation_mode);
  if (mode !== normalizeConversationMode(baseline.conversation_mode)) next.conversation_mode = mode;

  return Object.keys(next).length > 0 ? next : null;
}
