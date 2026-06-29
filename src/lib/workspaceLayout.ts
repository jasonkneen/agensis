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
