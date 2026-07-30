// Width rules for the task editor panel in the Tasks window.
//
// This lives in lib/ rather than beside the component for two reasons: the
// clamp is the part that, when it drifts, puts the panel off-screen again, so
// it should be testable without mounting a window; and exporting non-components
// from a component file breaks React fast refresh.
//
// The bug this replaces: the panel was a hard `w-80 shrink-0`. In a floating
// window that is doubly bad — it cannot give ground when the window is narrow,
// so it pushes itself past the right edge and its content becomes unreachable,
// and 320px is far too cramped for a task whose description is a spec.

export const TASK_PANEL_MIN_WIDTH = 280;
export const TASK_PANEL_MAX_WIDTH = 720;
export const TASK_PANEL_DEFAULT_WIDTH = 380;
/** Board width kept clear beside the editor, in px. */
export const TASK_PANEL_BOARD_RESERVE = 240;
export const TASK_PANEL_WIDTH_KEY = 'agensis:taskPanelWidth';

/**
 * Clamp a desired width against the hard limits AND the room actually
 * available, so the panel can never exceed its container.
 *
 * `containerWidth` null means "not measured yet" — fall back to the hard max
 * rather than collapsing to the minimum, so the first paint is not a jump.
 * The minimum always wins over the available room: in a very narrow window we
 * would rather the board scroll than render an unusable sliver of an editor.
 */
export function clampTaskPanelWidth(next: number, containerWidth: number | null): number {
  const room = containerWidth === null
    ? TASK_PANEL_MAX_WIDTH
    : Math.max(TASK_PANEL_MIN_WIDTH, containerWidth - TASK_PANEL_BOARD_RESERVE);
  const ceiling = Math.min(TASK_PANEL_MAX_WIDTH, room);
  return Math.round(Math.min(Math.max(next, TASK_PANEL_MIN_WIDTH), ceiling));
}

export function readStoredTaskPanelWidth(): number {
  if (typeof window === 'undefined') return TASK_PANEL_DEFAULT_WIDTH;
  const raw = Number.parseInt(window.localStorage.getItem(TASK_PANEL_WIDTH_KEY) || '', 10);
  return Number.isFinite(raw) ? raw : TASK_PANEL_DEFAULT_WIDTH;
}
