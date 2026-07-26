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
export const WORKSPACE_RAIL_WIDTH = 52;
