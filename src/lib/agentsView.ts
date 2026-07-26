// How the Agents window is looked at, split out of the component so the
// decisions are testable without a DOM: which layout views exist (and which
// stored value is still valid), what clicking a card does to the selection,
// and at what width the detail pane stops fitting beside the grid.

import { oneOf, type PreferenceCodec } from './viewPreferences';

/**
 * The three ways the roster can be drawn: the card grid, the drillable network
 * map, or both stacked (grid above, map below). Persisted per workspace — a
 * mode removed from this list reads back as invalid and falls to the caller's
 * default, so retiring one can never render a blank window.
 */
export const AGENT_LAYOUT_VIEWS = ['grid', 'network', 'both'] as const;
export type AgentLayoutView = (typeof AGENT_LAYOUT_VIEWS)[number];
export const AGENT_LAYOUT_VIEW_PREF: PreferenceCodec<AgentLayoutView> = oneOf(AGENT_LAYOUT_VIEWS);

/**
 * ONE selection shared by every surface: the grid card, the map node and the
 * detail pane all key off the same agent id. Clicking the agent that is
 * already open closes it — the card is its own toggle, so deselecting never
 * depends on finding a separate control.
 */
export function toggleAgentSelection(current: string | null, agentId: string): string | null {
  return current === agentId ? null : agentId;
}

/**
 * Below this container width the detail pane REPLACES the grid (with a back
 * affordance) instead of sitting beside it — the same 42rem the inbox uses,
 * because it is the same judgement: under it there is no width left to divide
 * into two readable columns. In rem, not px: the app's root font size is a
 * user setting (12–18px), and a readability floor is a character count, so
 * the threshold has to move with it.
 */
export const AGENTS_SPLIT_MIN_REM = 42;

/**
 * Where the detail pane goes at container width `widthPx`. `remPx` is the root
 * font size; anything unusable (0, negative, NaN) falls back to the browser
 * default of 16 rather than letting garbage decide the layout. An unknown
 * width keeps the normal two-pane arrangement.
 *
 * The live layout enacts this via the container-query classes below — this
 * function is the same threshold stated somewhere a test can reach.
 */
export function agentDetailPlacement(widthPx: number, remPx = 16): 'beside' | 'replace' {
  const rem = Number.isFinite(remPx) && remPx > 0 ? remPx : 16;
  if (!Number.isFinite(widthPx)) return 'beside';
  return widthPx < AGENTS_SPLIT_MIN_REM * rem ? 'replace' : 'beside';
}

/**
 * The container-query classes that apply `agentDetailPlacement` in CSS (42rem
 * is the `2xl` container breakpoint; the named container is the split root in
 * AgentsWindowContent). Written out in full rather than composed, because
 * Tailwind scans source text for literal class names and never sees a
 * concatenated one.
 */
export const AGENTS_SPLIT_HIDE_BELOW = '@max-2xl/agentswin:hidden';
export const AGENTS_SPLIT_ONLY_BELOW = 'hidden @max-2xl/agentswin:inline-flex';
