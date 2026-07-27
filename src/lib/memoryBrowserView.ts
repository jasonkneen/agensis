// How the Memory window's "Agent files" tab is looked at, split out of the
// component so the decisions are testable without a DOM: where the divider
// between the file list and the preview is allowed to sit, and what the preview
// offers when nothing is selected yet.

import { clampSplitPrimary, type SplitBounds } from './splitPane';
import { pixelPreference, type PreferenceCodec } from './viewPreferences';
import { tipsForSurface, type PageTip } from './pageTips';
import type { AgentMemoryFile } from '../types';

// ---------------------------------------------------------------------------
// The list / preview split
//
// Same shape as the Agents "Both" view, turned on its side: the stored number is
// a REQUEST, `memorySplitListWidth` is the answer, and it is recomputed from the
// measured container on every render. A width chosen in a wide window cannot
// squeeze the preview out of a narrow one, and because nothing is written back,
// widening the window again returns the width that was actually chosen.
// ---------------------------------------------------------------------------

/** Floor for the file list, px. Below this a path stops being readable at all. */
export const MEMORY_SPLIT_MIN_LIST_PX = 240;

/**
 * Ceiling for the file list, px. The list holds file names and a size — past
 * this it is only wasting the room the file's CONTENT needs.
 */
export const MEMORY_SPLIT_MAX_LIST_PX = 560;

/** Floor for the preview, px. Under this, prose and code both wrap to noise. */
export const MEMORY_SPLIT_MIN_PREVIEW_PX = 360;

/** The list's share of the width before anyone has touched the divider. */
export const MEMORY_SPLIT_DEFAULT_LIST_RATIO = 0.34;

/**
 * Below this the two panes cannot both be useful, so the browser falls back to
 * its original full-swap behaviour: the list, then the file replacing it. The
 * divider is not rendered at all there — a control that cannot move is worse
 * than no control.
 */
export const MEMORY_SPLIT_MIN_CONTAINER_PX = 720;

export const MEMORY_SPLIT_BOUNDS: SplitBounds = {
  minPrimaryPx: MEMORY_SPLIT_MIN_LIST_PX,
  minSecondaryPx: MEMORY_SPLIT_MIN_PREVIEW_PX,
  defaultRatio: MEMORY_SPLIT_DEFAULT_LIST_RATIO,
  maxPrimaryPx: MEMORY_SPLIT_MAX_LIST_PX,
};

/** Sanity ceiling on the stored width; the real clamp is the container. */
export const MEMORY_SPLIT_PREF: PreferenceCodec<number> = pixelPreference(4000);

/**
 * The width the file list gets, in px, from what was stored and the width the
 * two panes have to share. See `clampSplitPrimary` for the rules.
 */
export function memorySplitListWidth(stored: number | null, containerPx: number): number {
  return clampSplitPrimary(stored, containerPx, MEMORY_SPLIT_BOUNDS);
}

// ---------------------------------------------------------------------------
// The empty preview
//
// The preview pane is now mounted from load rather than appearing on the first
// click, so it needs something to say. Two kinds of chip, and BOTH DO SOMETHING
// — a chip that only looks like an action is worse than no chip:
//
//   - a file chip SELECTS that file, exactly as clicking its row would;
//   - a tip chip OPENS that tip in the pane.
//
// There is deliberately no "generate a memory" chip. Agent memory here is a
// READ-ONLY MIRROR: the daemon pushes its palace up (handleAgentMemorySync) and
// the browser's only write is a comment. LLM-mediated summarisation is listed as
// deferred phase-2 work in docs/agent-memory-plan.md, so a generate button would
// be a control with nothing behind it.
// ---------------------------------------------------------------------------

/** How many file chips the empty state offers before it is just the list again. */
export const MEMORY_SUGGESTION_LIMIT = 3;

/** Names that are an index over the rest of the palace rather than one memory. */
const INDEX_FILENAMES = new Set(['memory.md', 'index.md', 'readme.md', 'claude.md', 'agents.md']);

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Sort key: an index file first, then whatever the daemon synced most recently. */
function syncedAt(file: AgentMemoryFile): number {
  const stamp = Date.parse(file.last_synced ?? '');
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * The files worth offering as a starting point, best first.
 *
 * An index (`MEMORY.md` and friends) comes first because it is the one file that
 * explains the others — this repo's own palace is exactly that shape. After
 * that it is most-recently-synced, which is the closest honest thing to "what
 * the agent has been thinking about", since nothing in the mirror ranks files by
 * relevance and inventing a ranking would be a lie about the data.
 *
 * Returns at most `limit`, and never more than the list already holds — with two
 * files on screen, three chips pointing at them is noise.
 */
export function suggestedMemoryFiles(
  files: readonly AgentMemoryFile[],
  limit: number = MEMORY_SUGGESTION_LIMIT,
): AgentMemoryFile[] {
  if (limit <= 0 || files.length <= 1) return [];
  return [...files]
    .sort((a, b) => {
      const indexA = INDEX_FILENAMES.has(baseName(a.path).toLowerCase()) ? 1 : 0;
      const indexB = INDEX_FILENAMES.has(baseName(b.path).toLowerCase()) ? 1 : 0;
      if (indexA !== indexB) return indexB - indexA;
      const syncedDelta = syncedAt(b) - syncedAt(a);
      if (syncedDelta !== 0) return syncedDelta;
      // Stable last resort so two files synced in the same second do not swap
      // places between renders and make the chips flicker.
      return a.path.localeCompare(b.path);
    })
    .slice(0, Math.min(limit, files.length));
}

/**
 * The tips the empty preview offers. Straight from `PAGE_TIPS` — the same text
 * the sidebar tip panel shows for this surface, so there is one place a claim
 * about memory is written and no second copy to drift out of true.
 */
export function memoryBrowserTips(): PageTip[] {
  return tipsForSurface('memory');
}
