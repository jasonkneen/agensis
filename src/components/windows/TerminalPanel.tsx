import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  nextTerminalFontSize,
  shouldResizePty,
  type ZoomCommand,
} from '@/lib/zoom';
import { registerZoomHandler } from '@/lib/zoomRouter';

/**
 * A real shell in an ordinary floating window.
 *
 * xterm.js renders into plain DOM, so this is React all the way down: window
 * chrome, dropdowns and dialogs compose over it normally, and it works in the
 * browser build too — only the TRANSPORT is desktop-specific.
 *
 * Desktop: node-pty in the Electron main process, over the four IPC verbs the
 * preload exposes. That is this machine's shell — your files, your tools.
 * Web: no transport yet, so the panel says so rather than rendering a terminal
 * that silently does nothing.
 */

interface PtyBridge {
  spawn: (options: { cols: number; rows: number; cwd?: string }) => Promise<{
    ok: boolean;
    id?: string;
    shell?: string;
    error?: string;
  }>;
  write: (id: string, data: string) => Promise<void>;
  resize: (id: string, cols: number, rows: number) => Promise<void>;
  kill: (id: string) => Promise<void>;
  onData: (id: string, callback: (chunk: string) => void) => () => void;
  onExit: (id: string, callback: (code: number) => void) => () => void;
}

function ptyBridge(): PtyBridge | null {
  const api = (window as unknown as { electronAPI?: { pty?: PtyBridge } }).electronAPI;
  return api?.pty ?? null;
}

/**
 * Resolve a CSS custom property to something xterm can actually parse.
 *
 * The app's tokens are `oklch(...)` (see index.css). xterm's colour parser only
 * understands hex and rgb/rgba, and on a value it cannot parse it does not throw
 * — it falls back to BLACK. That is why the terminal was a black slab in every
 * theme. Painting the value onto a throwaway element and reading it back makes
 * the browser do the conversion, and `getComputedStyle().backgroundColor` is
 * always returned as `rgb()`/`rgba()`.
 */
function resolveCssColor(token: string, fallback: string): string {
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;background-color:var(${token})`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  // An unset variable computes to a fully transparent colour, not the token.
  if (!resolved || resolved === 'rgba(0, 0, 0, 0)' || resolved === 'transparent') return fallback;
  return resolved;
}

/**
 * The terminal face: BlexMono Nerd Font Mono, which IS IBM Plex Mono with the
 * Nerd Fonts glyph sets patched in. This is not a cosmetic swap — it is the
 * only way to get Nerd glyphs in a terminal that lays out on a cell grid:
 *
 *   - The app's own Plex Mono declares no Nerd codepoints at all, so every
 *     Powerline separator, Devicon, Octicon, Font Awesome and Material icon a
 *     prompt or TUI emits rendered as tofu (an empty box).
 *   - A symbol-only fallback face cannot fix it either. xterm sizes its cell
 *     from the primary face (Plex: 0.6em) and then draws each glyph at its own
 *     advance, so 1em-wide icons from a fallback face overflow into the next
 *     cell and a powerline prompt stops being contiguous. Measured, not assumed.
 *   - BlexMono keeps Plex's exact 0.6em advance and near-identical Latin
 *     outlines, so this changed the glyph coverage without reflowing a single
 *     line of existing output. Its Powerline glyphs are also full-row height
 *     (~1.31em vs Plex's 0.7em cap height), which is what makes a separator
 *     actually join the row above/below instead of floating in it.
 *
 * The family is bundled at src/fonts/blex-nerd-font-mono, loaded by
 * @font-face in index.css. Both names are listed: the upstream family plus the
 * system-installed "BlexMono Nerd Font Mono" a user may already have.
 */
// Named through the shared --font-mono token (see index.css) so the terminal
// tracks the app's mono face, with the Nerd-patched Plex in front of it.
const TERMINAL_FONT_FAMILY = "'BlexMono Nerd Font Mono', 'BlexMono NFM', var(--font-mono)";

/** The app's own surface colours, so the terminal tracks the active theme. */
function themeFromCss() {
  return {
    background: resolveCssColor('--card', '#0c0c0c'),
    foreground: resolveCssColor('--foreground', '#e4e4e7'),
    cursor: resolveCssColor('--primary', '#22c55e'),
    cursorAccent: resolveCssColor('--card', '#0c0c0c'),
    selectionBackground: resolveCssColor('--accent', '#3f3f46'),
  };
}

const FONT_SIZE_KEY = 'agensis.terminal.fontSize';

/**
 * The terminal's zoom level, remembered per install. Validated on read: a stored
 * size from a future build (or a hand-edited value) must not become a terminal
 * nobody can read, so anything off the ladder falls back to the default.
 */
function readStoredFontSize(): number {
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_KEY);
    // Number('') is 0 and Number(null) is 0, so guard the empty cases first.
    if (raw === null || raw.trim() === '') return DEFAULT_TERMINAL_FONT_SIZE;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= MIN_TERMINAL_FONT_SIZE && parsed <= MAX_TERMINAL_FONT_SIZE) {
      return parsed;
    }
  } catch {
    // Private mode / disabled storage — a default size is fine.
  }
  return DEFAULT_TERMINAL_FONT_SIZE;
}

function writeStoredFontSize(size: number) {
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, String(size));
  } catch {
    // Not being able to remember the size must not break zooming.
  }
}

export function TerminalPanel() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'starting' | 'ready' | 'unavailable' | 'exited'>('starting');
  const [detail, setDetail] = useState('');
  // Zoom is a font size here, remembered across window close/open the way a
  // browser remembers a page's zoom.
  const [fontSize, setFontSize] = useState(() => readStoredFontSize());

  // The live session, reachable from the zoom handler without re-running the
  // effect (which would kill and respawn the shell).
  const sessionRef = useRef<{ term: Terminal; fit: FitAddon; ptyId: string | null } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const bridge = ptyBridge();
    if (!host) return;
    if (!bridge) {
      setStatus('unavailable');
      setDetail('The terminal needs the desktop app — a browser tab cannot open a shell.');
      return;
    }

    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: readStoredFontSize(),
      cursorBlink: true,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let sessionId: string | null = null;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    sessionRef.current = { term, fit, ptyId: null };

    void bridge.spawn({ cols: term.cols, rows: term.rows }).then(result => {
      // Unmounted while spawning — kill it rather than leak a live shell.
      if (disposed) {
        if (result.ok && result.id) void bridge.kill(result.id);
        return;
      }
      if (!result.ok || !result.id) {
        setStatus('unavailable');
        setDetail(result.error ?? 'Could not start a shell.');
        return;
      }
      sessionId = result.id;
      if (sessionRef.current) sessionRef.current.ptyId = result.id;
      setStatus('ready');
      setDetail(result.shell ?? '');
      cleanups.push(bridge.onData(result.id, chunk => term.write(chunk)));
      cleanups.push(
        bridge.onExit(result.id, code => {
          setStatus('exited');
          setDetail(`Shell exited (${code})`);
        }),
      );
      term.focus();
    }).catch((error: unknown) => {
      // The main process THROWS when the shell cannot be started (node-pty's
      // "posix_spawnp failed." when spawn-helper lost its exec bit). Without
      // this the promise rejected silently and the panel sat on "starting"
      // forever — a terminal that never loads, with no reason given.
      if (disposed) return;
      setStatus('unavailable');
      setDetail(error instanceof Error ? error.message : String(error));
    });

    const typed = term.onData(data => {
      if (sessionId) void bridge.write(sessionId, data);
    });

    // The pty must be told the new grid or the shell keeps wrapping to the old
    // width — ResizeObserver catches window resize, tiling and full-expand alike.
    const observer = new ResizeObserver(() => {
      if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      if (sessionId) void bridge.resize(sessionId, term.cols, term.rows);
    });
    observer.observe(host);

    // The theme token values are swapped by toggling a class / data attribute on
    // <html>, which fires no event — watch the attribute and re-resolve, or the
    // terminal keeps the colours it was born with after a light/dark switch.
    const themeWatcher = new MutationObserver(() => {
      term.options.theme = themeFromCss();
    });
    themeWatcher.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-theme-seed', 'style'],
    });

    return () => {
      disposed = true;
      themeWatcher.disconnect();
      observer.disconnect();
      typed.dispose();
      cleanups.forEach(fn => fn());
      if (sessionId) void bridge.kill(sessionId);
      sessionRef.current = null;
      term.dispose();
    };
  }, []);

  /**
   * Apply one zoom command to THIS terminal.
   *
   * xterm measures the cell from the face, so a font-size change reflows the
   * grid: cols/rows change and the pty must be told, or the shell keeps
   * wrapping to the old width. `fit` is what turns the new size into the actual
   * dimensions; the resize is sent only when the grid really changed, so a zoom
   * that rounds to the same cols does not churn the pty.
   *
   * Returns whether anything was zoomed — the caller (the app-level router)
   * uses a `false` to let the whole-application zoom handle the chord instead.
   */
  const applyZoom = useCallback((command: ZoomCommand): boolean => {
    const live = sessionRef.current;
    if (!live) return false;
    const previous = { cols: live.term.cols, rows: live.term.rows };
    const next = nextTerminalFontSize(live.term.options.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE, command);
    if (next === live.term.options.fontSize) {
      // Already at the end of the ladder — still claimed, so Cmd+= at 48px does
      // not silently start scaling the entire application.
      return true;
    }
    live.term.options.fontSize = next;
    setFontSize(next);
    writeStoredFontSize(next);
    live.fit.fit();
    if (live.ptyId && shouldResizePty(previous, { cols: live.term.cols, rows: live.term.rows })) {
      void ptyBridge()?.resize(live.ptyId, live.term.cols, live.term.rows);
    }
    return true;
  }, []);

  // Register the pane with the app-level router. `data-zoom-pane` marks the node
  // and the handler decides whether this pane owns the chord right now: zooming
  // applies only when the terminal itself has focus (or the pointer is inside
  // it), so Cmd+= in a chat window still zooms the app.
  useEffect(() => {
    return registerZoomHandler('terminal', applyZoom);
  }, [applyZoom]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-card">
      {/* The padding ring must be the SAME colour xterm paints its background, or
          the terminal reads as a black slab inset in a differently-coloured panel. */}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden bg-card p-2" />

      {(status === 'unavailable' || status === 'exited') && (
        <div className="absolute inset-0 grid place-items-center bg-background/95 p-6 text-center">
          <div className="max-w-sm space-y-1">
            <p className="text-sm font-medium">
              {status === 'exited' ? 'Session ended' : 'Terminal unavailable'}
            </p>
            <p className="text-xs text-muted-foreground">{detail}</p>
          </div>
        </div>
      )}

      {status === 'ready' && detail && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-2 py-1 text-3xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{detail}</span>
          {/* Cmd+= zooms this shell's text, not the app. Shown once it is off the
              default, and clicking it resets — the terminal equivalent of the
              browser pane's zoom chip. */}
          {fontSize !== DEFAULT_TERMINAL_FONT_SIZE && (
            <button
              type="button"
              onClick={() => applyZoom('reset')}
              title="Reset terminal zoom"
              className="shrink-0 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            >
              {fontSize}px
            </button>
          )}
        </div>
      )}
    </div>
  );
}
