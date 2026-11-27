// Zoom belongs to the PANE you are looking at, not to the whole application.
//
// Cmd+= used to reach Electron's stock `zoomIn` menu role, which calls
// webContents.setZoomFactor and therefore scales every window at once: zooming
// a shell to read a build log also blew up the chat transcript, the sidebar and
// the window chrome. Browsers behave the other way round — Cmd+= inside a page
// zooms that page — and that is the contract this module encodes.
//
// The routing itself lives in the components (a terminal zooms text, a browser
// zooms its guest); what lives here is the part worth testing without a DOM:
// which chord is which command, what the clamped next factor is, and which
// lines have to pass through to the shell instead of being swallowed.

/** A single zoom action, resolved from a keyboard event. */
export type ZoomCommand = 'in' | 'out' | 'reset';

/**
 * The zoom ladder. Steps are deliberately small and uneven in *ratio* terms so
 * each press is a visible change at every size: ~10% near 1.0 where a pixel or
 * two is the whole difference between comfortable and cramped, ~25% at the
 * extremes where a proportional step would otherwise crawl.
 */
export const TERMINAL_FONT_SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48] as const;

/** Default and bounds for the terminal face — Plex at 12 is what the shell had. */
export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const MIN_TERMINAL_FONT_SIZE = TERMINAL_FONT_SIZES[0];
export const MAX_TERMINAL_FONT_SIZE = TERMINAL_FONT_SIZES[TERMINAL_FONT_SIZES.length - 1];

/** Bounds for a browser guest, mirroring Chrome's own 25%–500% range. */
export const MIN_BROWSER_ZOOM = 0.25;
export const MAX_BROWSER_ZOOM = 5;

/**
 * The browser guest zoom ladder, in the same spirit as Chrome's: 100% → 110% →
 * 125% → … so repeated presses stay predictable, and reset always returns to 1.
 */
export const BROWSER_ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

/**
 * Resolve a keydown into a zoom command.
 *
 * Cmd on macOS, Ctrl elsewhere — but Cmd/Ctrl+Shift+= is also what a US layout
 * produces for Cmd+"+", and browsers report the shifted `+` (not `=`) there, so
 * both key values count. Cmd+0 resets, as it does in every browser.
 *
 * `allowCtrl` exists because a terminal cannot spend Ctrl: Ctrl+= and Ctrl+-
 * are ordinary shell chords, and stealing them would break readline and every
 * TUI. So the terminal routes Cmd only, while the browser pane takes both.
 */
export function resolveZoomCommand(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
  options: { allowCtrl?: boolean } = {},
): ZoomCommand | null {
  // Alt/Option combinations belong to the focused app (Option is a modifier for
  // typing on macOS: Option+= is "≠"), so never claim them.
  if (event.altKey) return null;
  const plainModifier = event.metaKey === true || (options.allowCtrl === true && event.ctrlKey === true);
  if (!plainModifier) return null;
  switch (event.key) {
    case '=':
    case '+':
    case 'Add':
      return 'in';
    case '-':
    case '_':
    case 'Subtract':
      return 'out';
    case '0':
      return 'reset';
    default:
      return null;
  }
}

/** The next step up/down a ladder, never leaving its bounds. */
function stepThrough(ladder: readonly number[], current: number, direction: 1 | -1): number {
  if (direction === 1) {
    for (const step of ladder) {
      if (step > current + 1e-9) return step;
    }
    return ladder[ladder.length - 1];
  }
  for (let i = ladder.length - 1; i >= 0; i -= 1) {
    if (ladder[i] < current - 1e-9) return ladder[i];
  }
  return ladder[0];
}

/** Terminal font size after a command. A zoom never changes the grid, only the face. */
export function nextTerminalFontSize(current: number, command: ZoomCommand): number {
  const clamped = Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(current)));
  if (command === 'reset') return DEFAULT_TERMINAL_FONT_SIZE;
  return stepThrough(TERMINAL_FONT_SIZES, clamped, command === 'in' ? 1 : -1);
}

/** Browser guest zoom factor after a command, clamped to Chrome's range. */
export function nextBrowserZoom(current: number, command: ZoomCommand): number {
  const bounded = Math.min(MAX_BROWSER_ZOOM, Math.max(MIN_BROWSER_ZOOM, current));
  if (command === 'reset') return 1;
  const next = stepThrough(BROWSER_ZOOM_STEPS, bounded, command === 'in' ? 1 : -1);
  return Math.min(MAX_BROWSER_ZOOM, Math.max(MIN_BROWSER_ZOOM, next));
}

/**
 * A terminal's zoom is a FONT SIZE, and xterm measures the cell from the face,
 * so a new size silently changes cols/rows. The pty has to be told, or the shell
 * keeps wrapping to the old grid and every prompt after the first long line is
 * misplaced. Exposed as a pure function because getting this wrong is invisible
 * until someone actually resizes.
 */
export function shouldResizePty(
  previous: { cols: number; rows: number },
  next: { cols: number; rows: number },
): boolean {
  return previous.cols !== next.cols || previous.rows !== next.rows;
}

/** Human-readable zoom label, so every surface reports it the same way. */
export function formatZoom(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}
