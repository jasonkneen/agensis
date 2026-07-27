// How the Agents window is looked at, split out of the component so the
// decisions are testable without a DOM: which layout views exist (and which
// stored value is still valid), what clicking a card does to the selection,
// and at what width the detail pane stops fitting beside the grid.

import { clampSplitPrimary, type SplitBounds } from './splitPane';
import { oneOf, pixelPreference, type PreferenceCodec } from './viewPreferences';

/**
 * The three ways the roster can be drawn: the card grid, the drillable network
 * map, or both stacked (grid above, map below). Persisted per workspace — a
 * mode removed from this list reads back as invalid and falls to the caller's
 * default, so retiring one can never render a blank window.
 */
export const AGENT_LAYOUT_VIEWS = ['grid', 'network', 'both'] as const;
export type AgentLayoutView = (typeof AGENT_LAYOUT_VIEWS)[number];
export const AGENT_LAYOUT_VIEW_PREF: PreferenceCodec<AgentLayoutView> = oneOf(AGENT_LAYOUT_VIEWS);

// ---------------------------------------------------------------------------
// The Both view's horizontal split
//
// `both` stacks the card grid over the network map with a draggable divider
// between them, and where that divider sits is remembered per workspace. That
// is precisely how a stored preference turns into a trap: a split chosen in a
// tall window and restored in a short one can leave a pane at zero height,
// showing nothing and saying nothing about why.
//
// So the stored number is never used as the layout. It is a REQUEST, and
// `agentSplitGridHeight` is the answer, recomputed from the live container
// height on every render. A ResizeObserver keeps that height current, which is
// what makes a window resize re-clamp — and because the clamp is derived rather
// than written back, shrinking the window and growing it again returns the
// split the user actually chose.
//
// The arithmetic itself is `clampSplitPrimary` in lib/splitPane.ts, shared with
// the Memory browser's divider. What stays here is what is specific to THIS
// split: how short a card grid may get, and how short the mesh may get.
// ---------------------------------------------------------------------------

/**
 * Floor for the card grid, px. About one row of cards: below this the grid has
 * stopped being a grid, and seeing both is the entire point of the mode.
 */
export const AGENT_SPLIT_MIN_GRID_PX = 132;

/** Floor for the map, px. Under this the mesh has no legible ring left. */
export const AGENT_SPLIT_MIN_MAP_PX = 176;

/** The grid's share of the height before anyone has touched the divider. */
export const AGENT_SPLIT_DEFAULT_GRID_RATIO = 0.45;

/** Sanity ceiling on the stored height; the real clamp is the container. */
export const AGENT_SPLIT_PREF: PreferenceCodec<number> = pixelPreference(4000);

/** This split's floors and untouched ratio, handed to the shared clamp. */
export const AGENT_SPLIT_BOUNDS: SplitBounds = {
  minPrimaryPx: AGENT_SPLIT_MIN_GRID_PX,
  minSecondaryPx: AGENT_SPLIT_MIN_MAP_PX,
  defaultRatio: AGENT_SPLIT_DEFAULT_GRID_RATIO,
};

/**
 * The height the card grid gets, in px, from what was stored and the height the
 * two panes have to share (`containerPx` — the grid pane plus the map pane, so
 * the map simply takes the remainder). See `clampSplitPrimary` for the rules.
 */
export function agentSplitGridHeight(stored: number | null, containerPx: number): number {
  return clampSplitPrimary(stored, containerPx, AGENT_SPLIT_BOUNDS);
}

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

/**
 * How far down the pane's scrollable distance the action bar hands over from
 * the top edge to the bottom one. Halfway: the reader is nearer the end of the
 * form than the start, so the buttons should be where they are looking.
 */
export const AGENT_FORM_BAR_SWAP_RATIO = 0.5;

/**
 * Which of the agent form's two action bars is the mounted one, from the edit
 * pane's scroll geometry. Exactly one is ever returned, so the form can never
 * show two Save buttons or none.
 *
 * A pane with nothing to scroll answers `'top'`. That is the case this function
 * exists for: with a zero scrollable distance "past halfway" is never reached,
 * and a naive `scrollTop / scrollHeight` ratio would hide the top bar without
 * ever revealing the bottom one — a short window would have no buttons at all.
 * Unusable numbers (NaN from an unmeasured node) take the same safe answer.
 */
export function agentFormBarPlacement(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): 'top' | 'bottom' {
  const scrollable = scrollHeight - clientHeight;
  if (!Number.isFinite(scrollable) || scrollable <= 0) return 'top';
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return 'top';
  return scrollTop / scrollable >= AGENT_FORM_BAR_SWAP_RATIO ? 'bottom' : 'top';
}
