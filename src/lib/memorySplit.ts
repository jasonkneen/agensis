// Layout rules for the Memory window's Agent-files browser: how wide the file
// list is allowed to be, and at what width a preview pane stops fitting beside
// it at all.
//
// In lib/ rather than beside the component for the two reasons taskPanelWidth
// gives: the numbers that decide whether a pane can disappear should be
// testable without mounting a window, and exporting non-components from a
// component file breaks React fast refresh.

import type { PaneSplitBounds } from './paneSplit';

/**
 * Below this container width the preview REPLACES the list (with a back arrow)
 * instead of sitting beside it. Under it there is not enough width to divide
 * into a readable file list and a readable document.
 */
export const MEMORY_SPLIT_WIDE_PX = 960;

/**
 * Floors for the two panes, and the list's share before anyone has dragged.
 *
 * 260 is where a file row stops being readable — the name, the size and the
 * sync time all truncate away below it.
 *
 * 440 is the preview's floor, and it is set by its HEADER rather than by the
 * document: that row carries a Preview/Source toggle, an Editable/Read-only
 * badge and a comments button, which together take ~330px before the file name
 * gets anything. Measured in a browser at the candidate floors, the name is
 * allotted 27px at 360 and 107px at 440 — the first is a truncation ellipsis
 * with no name in front of it, the second is about twelve characters. A floor
 * that leaves the pane's own header illegible is not a floor.
 *
 * 0.34 is the 340px the list was hard-coded to, expressed as a share so a wider
 * window gives the list proportionally more rather than pinning it forever at a
 * number chosen for one screen.
 *
 * Both floors sum to 700, under MEMORY_SPLIT_WIDE_PX — so whenever the split is
 * shown at all there is room for both panes at their minimum, and the
 * proportional-shrink branch of `clampPaneSplit` is a safety net rather than
 * the normal case.
 */
export const MEMORY_SPLIT_BOUNDS: PaneSplitBounds = {
  minLeading: 260,
  minTrailing: 440,
  defaultRatio: 0.34,
};
