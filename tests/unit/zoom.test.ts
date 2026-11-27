import { describe, expect, it } from 'vitest';
import {
  BROWSER_ZOOM_STEPS,
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_BROWSER_ZOOM,
  MAX_TERMINAL_FONT_SIZE,
  MIN_BROWSER_ZOOM,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZES,
  formatZoom,
  nextBrowserZoom,
  nextTerminalFontSize,
  resolveZoomCommand,
  shouldResizePty,
} from '@/lib/zoom';

// Zoom belongs to the pane, so these are the decisions that keep it there:
// which chord counts, where the ladder stops, and when the pty has to be told
// the grid changed. Each of these was a real way to get it wrong — Cmd+Shift+=
// arrives as '+', Ctrl+= must stay with the shell, and a font-size bump silently
// reflows xterm's grid.

describe('which chord is a zoom', () => {
  it('accepts Cmd with =, +, - and 0', () => {
    expect(resolveZoomCommand({ key: '=', metaKey: true })).toBe('in');
    // Cmd+Shift+= reports '+' on a US layout; that must still be zoom-in.
    expect(resolveZoomCommand({ key: '+', metaKey: true })).toBe('in');
    expect(resolveZoomCommand({ key: '-', metaKey: true })).toBe('out');
    expect(resolveZoomCommand({ key: '0', metaKey: true })).toBe('reset');
  });

  it('keeps Ctrl chords for the shell unless the caller opts in', () => {
    // Ctrl+= and Ctrl+- are ordinary readline/TUI chords in a terminal. Stealing
    // them would break the shell, so the terminal passes allowCtrl: false.
    expect(resolveZoomCommand({ key: '=', ctrlKey: true })).toBeNull();
    expect(resolveZoomCommand({ key: '=', ctrlKey: true }, { allowCtrl: true })).toBe('in');
  });

  it('never claims Alt/Option combinations', () => {
    // Option+= types "≠" on macOS; a zoom handler that swallowed it would make
    // the character untypeable inside the browser pane.
    expect(resolveZoomCommand({ key: '=', metaKey: true, altKey: true })).toBeNull();
  });

  it('ignores unmodified keys and unrelated chords', () => {
    expect(resolveZoomCommand({ key: '=' })).toBeNull();
    expect(resolveZoomCommand({ key: 'a', metaKey: true })).toBeNull();
  });
});

describe('the terminal font ladder', () => {
  it('steps one rung and clamps at both ends', () => {
    expect(nextTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE, 'in')).toBe(13);
    expect(nextTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE, 'out')).toBe(11);
    // Past the ends it reports the end, so the caller can claim the chord and
    // stop it from scaling the whole application instead.
    expect(nextTerminalFontSize(MAX_TERMINAL_FONT_SIZE, 'in')).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(nextTerminalFontSize(MIN_TERMINAL_FONT_SIZE, 'out')).toBe(MIN_TERMINAL_FONT_SIZE);
  });

  it('resets to the default size the terminal shipped with', () => {
    expect(nextTerminalFontSize(42, 'reset')).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(DEFAULT_TERMINAL_FONT_SIZE).toBe(12);
  });

  it('snaps an off-ladder value onto the ladder', () => {
    // A hand-edited or future stored size must not produce an unusable terminal.
    expect(TERMINAL_FONT_SIZES).toContain(nextTerminalFontSize(12.5, 'in'));
    expect(nextTerminalFontSize(9999, 'out')).toBe(TERMINAL_FONT_SIZES[TERMINAL_FONT_SIZES.length - 2]);
  });
});

describe('the browser page ladder', () => {
  it('walks the ratio ladder and clamps to Chrome’s range', () => {
    expect(nextBrowserZoom(1, 'in')).toBe(1.1);
    expect(nextBrowserZoom(1.1, 'in')).toBe(1.25);
    expect(nextBrowserZoom(1, 'out')).toBe(0.9);
    expect(nextBrowserZoom(MAX_BROWSER_ZOOM, 'in')).toBe(MAX_BROWSER_ZOOM);
    expect(nextBrowserZoom(MIN_BROWSER_ZOOM, 'out')).toBe(MIN_BROWSER_ZOOM);
  });

  it('resets to exactly 100%, even from an off-ladder factor', () => {
    expect(nextBrowserZoom(1.73, 'reset')).toBe(1);
    expect(BROWSER_ZOOM_STEPS).toContain(1);
  });

  it('is monotonic: no step ever goes backwards in either direction', () => {
    for (let i = 1; i < BROWSER_ZOOM_STEPS.length; i += 1) {
      expect(BROWSER_ZOOM_STEPS[i]).toBeGreaterThan(BROWSER_ZOOM_STEPS[i - 1]);
    }
    let size = MIN_TERMINAL_FONT_SIZE;
    for (let i = 0; i < 40; i += 1) {
      const next = nextTerminalFontSize(size, 'in');
      expect(next).toBeGreaterThanOrEqual(size);
      size = next;
    }
    expect(size).toBe(MAX_TERMINAL_FONT_SIZE);
  });
});

describe('the pty grid', () => {
  it('resizes only when cols or rows actually changed', () => {
    // A zoom that rounds back to the same grid must not churn the pty.
    expect(shouldResizePty({ cols: 120, rows: 40 }, { cols: 120, rows: 40 })).toBe(false);
    expect(shouldResizePty({ cols: 120, rows: 40 }, { cols: 96, rows: 40 })).toBe(true);
    expect(shouldResizePty({ cols: 120, rows: 40 }, { cols: 120, rows: 33 })).toBe(true);
  });
});

describe('labels', () => {
  it('reports a zoom factor as a whole percentage', () => {
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(1.25)).toBe('125%');
    expect(formatZoom(0.67)).toBe('67%');
  });
});
