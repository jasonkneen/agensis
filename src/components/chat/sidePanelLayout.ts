/** Which side panel is open beside the transcript. */
export type ChatSidePanel = 'thread' | 'files' | 'pins' | 'profile' | 'sub-thread' | 'sub-threads';

/**
 * Narrowest the message column may get before the side panel takes the window
 * instead of sitting beside it.
 *
 * A chat row is a 32px avatar, a gutter, and the text. Below roughly this the
 * text wraps to two or three words a line and the transcript stops being
 * readable at all — which is exactly what a side panel opened in a floating
 * window on the agents view produced.
 */
export const MIN_MESSAGE_COLUMN_PX = 320;

/** Fallback share for a thread panel that has never been dragged (`width: '45%'`). */
const THREAD_DEFAULT_SHARE = 0.45;

export interface SidePanelLayoutInput {
  /** Measured width of the whole chat shell. 0 before the first measurement. */
  shellWidth: number;
  /** Which panel is open, or null. */
  sidePanel: ChatSidePanel | null;
  /** Width of the non-thread panels, in px. */
  panelWidth: number;
  /** Thread panel width in px, or null while it is still on its `45%` default. */
  threadPanelWidth: number | null;
}

/** The px the panel would occupy if it sat beside the messages. */
export function resolvePanelPx(input: SidePanelLayoutInput): number {
  const { shellWidth, sidePanel, panelWidth, threadPanelWidth } = input;
  if (sidePanel !== 'thread') return panelWidth;
  return threadPanelWidth ?? Math.round(shellWidth * THREAD_DEFAULT_SHARE);
}

/**
 * Should the panel take the whole shell rather than split it?
 *
 * Deliberately derived from what the MESSAGES would be left with, not from a
 * viewport breakpoint. `useIsMobile` reads `window.innerWidth`, which is the
 * wrong question here: on the agents view the chat is a floating window inside
 * a large viewport, so the viewport is wide while the window is not. Measuring
 * the shell also means one rule covers both causes of a crushed transcript —
 * a small window, and a panel the user dragged too wide in a big one.
 *
 * Returns false until the shell has been measured, so the first paint is the
 * normal split rather than a full-width panel that jumps back a frame later.
 */
export function shouldOverlaySidePanel(input: SidePanelLayoutInput): boolean {
  const { shellWidth, sidePanel } = input;
  if (!sidePanel || shellWidth <= 0) return false;
  return shellWidth - resolvePanelPx(input) < MIN_MESSAGE_COLUMN_PX;
}
