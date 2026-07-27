export const WORKSPACE_CHROME_GAP = 8;
export const WORKSPACE_TOP_RESERVE = 0;
export const WORKSPACE_BOTTOM_RESERVE = 56;
export const WORKSPACE_DOCK_HEIGHT = 42;
export const WORKSPACE_DOCK_BOTTOM_OFFSET = Math.max(
  0,
  Math.round((WORKSPACE_BOTTOM_RESERVE - WORKSPACE_DOCK_HEIGHT - WORKSPACE_CHROME_GAP) / 2),
);

// Floating panels align to the workspace viewport; the outer chrome supplies the visible gap.
export const WORKSPACE_PANEL_EDGE_INSET = 0;

// The workspace switcher rail (src/components/layout/WorkspaceRail.tsx), pinned
// to the far left OUTSIDE the sidebar. Anything computing the canvas viewport's
// left inset from the sidebar's width must add this — see Sidebar's
// `leadingInset` prop. (Measured rects already include it; only the arithmetic
// fallback needs telling.)
//
// The rail is RESIZABLE, so this is its COLLAPSED width, not its width. It is
// the storage default and the floor of `clampWorkspaceRailWidth`; the live
// width is App state and is what must be passed as `leadingInset`. Do not
// re-introduce this constant as the rail's width at a call site — a hardcoded
// 52 there puts every floating window one expanded rail too far left.
export const WORKSPACE_RAIL_WIDTH = 52;
