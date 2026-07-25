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
