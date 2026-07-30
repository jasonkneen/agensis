// Presentation rules for tiled window groups.
//
// Windows tiled together (drag-to-split) share a `groupId`. Visually the group
// is ONE composite window: the panes are separated by a gutter rather than
// welded flush, and exactly one pane — the host — owns the title-bar control
// cluster and acts on every member. Member panes render their label only.
//
// This lives in lib/ rather than App.tsx so the rule is testable without
// mounting the application.

import type { FloatingWindow } from '../types';

export type WindowGroupRole = 'host' | 'member' | null;

/**
 * Which role a window plays in its tiled group.
 *
 * The host is the top-left-most VISIBLE member: lowest `y`, then lowest `x`,
 * then lowest `id` as a final deterministic tiebreak. It is deliberately a
 * purely geometric rule rather than "first opened" or "highest z", so:
 *   - the controls never hop between panes when focus or z-order changes, and
 *   - they sit where a single window's title bar would be anyway (top-left).
 *
 * Minimised members are excluded, so hiding a pane can never hand the chrome to
 * something invisible. If that leaves fewer than two visible members there is no
 * composite window to host, and every remaining window gets its own controls
 * back — which is also what makes closing or minimising the host self-healing.
 */
export function computeGroupRole(win: FloatingWindow, allWindows: FloatingWindow[]): WindowGroupRole {
  if (!win.groupId || win.minimized) return null;
  const members = allWindows.filter(w => w.groupId === win.groupId && !w.minimized);
  if (members.length < 2) return null;
  const host = members.reduce((best, w) => {
    if (w.y !== best.y) return w.y < best.y ? w : best;
    if (w.x !== best.x) return w.x < best.x ? w : best;
    return w.id < best.id ? w : best;
  });
  return host.id === win.id ? 'host' : 'member';
}

/** Height of the group frame's own title bar, in px. Matches the h-10 (40px)
 *  title bar a single window uses, so a group reads at the same rhythm. */
export const GROUP_HEADER_HEIGHT = 40;

/** Padding between the frame's border and the panes inside it, in px. */
export const GROUP_FRAME_PADDING = 6;

export type GroupBounds = { x: number; y: number; width: number; height: number };

/**
 * The union box of a group's visible members — the frame is drawn here.
 *
 * Returns null when there is no composite window to frame (unknown group, or
 * fewer than two visible members), which is the same threshold computeGroupRole
 * uses, so the frame and the host role can never disagree.
 */
export function computeGroupBounds(groupId: string, allWindows: FloatingWindow[]): GroupBounds | null {
  const members = allWindows.filter(w => w.groupId === groupId && !w.minimized);
  if (members.length < 2) return null;
  const left = Math.min(...members.map(w => w.x));
  const top = Math.min(...members.map(w => w.y));
  const right = Math.max(...members.map(w => w.x + w.width));
  const bottom = Math.max(...members.map(w => w.y + w.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Snap a group's members onto a clean grid so the frame cannot misrepresent
 * their sizes.
 *
 * Panes drift: they are snapped at different times, resized independently, and
 * clamped by different code paths, so a "tiled pair" routinely ends up with
 * mismatched heights and a ragged outer edge — which is exactly what makes a
 * group stop reading as one window. This collapses each member's edges onto the
 * nearest shared gridline (within `tolerance`) and then stretches the outermost
 * members to the union box, so every row shares a top and bottom and every
 * column shares a left and right.
 *
 * Pure geometry in, pure geometry out — callers decide when to commit it.
 */
export function normalizeGroupBounds(
  groupId: string,
  allWindows: FloatingWindow[],
  // 48px absorbs the drift seen in practice (~30px between a snapped pair's
  // bottom edges) while staying far below the smallest legitimate gap between
  // two distinct gridlines — panes cannot be narrower than MIN_WINDOW_WIDTH
  // (320) or shorter than MIN_WINDOW_HEIGHT (260), so real lines are hundreds
  // of px apart and cannot be merged by accident.
  tolerance = 48,
): Map<string, GroupBounds> {
  const out = new Map<string, GroupBounds>();
  const bounds = computeGroupBounds(groupId, allWindows);
  if (!bounds) return out;
  const members = allWindows.filter(w => w.groupId === groupId && !w.minimized);

  // Collect the distinct gridlines on each axis, merging any that sit within
  // `tolerance` of each other — those are "the same" line that has drifted.
  const cluster = (values: number[]): number[] => {
    const sorted = [...values].sort((a, b) => a - b);
    const lines: number[] = [];
    for (const value of sorted) {
      const last = lines[lines.length - 1];
      if (last !== undefined && Math.abs(value - last) <= tolerance) continue;
      lines.push(value);
    }
    return lines;
  };
  const xLines = cluster(members.flatMap(w => [w.x, w.x + w.width]));
  const yLines = cluster(members.flatMap(w => [w.y, w.y + w.height]));
  // Seed with the first LINE, not `value` — seeding with the value itself makes
  // the distance-to-best start at 0, so nothing ever beats it and snap() becomes
  // an identity function that silently does nothing.
  const snap = (value: number, lines: number[]) =>
    (lines.length === 0
      ? value
      : lines.reduce((best, line) => (Math.abs(line - value) < Math.abs(best - value) ? line : best), lines[0]));

  for (const member of members) {
    let x = snap(member.x, xLines);
    let y = snap(member.y, yLines);
    let right = snap(member.x + member.width, xLines);
    let bottom = snap(member.y + member.height, yLines);
    // Stretch the outermost members to the union box so the group has a clean
    // rectangular outline even if one pane was short.
    if (Math.abs(x - bounds.x) <= tolerance) x = bounds.x;
    if (Math.abs(y - bounds.y) <= tolerance) y = bounds.y;
    if (Math.abs(right - (bounds.x + bounds.width)) <= tolerance) right = bounds.x + bounds.width;
    if (Math.abs(bottom - (bounds.y + bounds.height)) <= tolerance) bottom = bounds.y + bounds.height;
    out.set(member.id, { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) });
  }
  return out;
}
