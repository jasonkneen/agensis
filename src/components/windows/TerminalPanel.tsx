import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

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

export function TerminalPanel() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'starting' | 'ready' | 'unavailable' | 'exited'>('starting');
  const [detail, setDetail] = useState('');

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
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 12,
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
      attributeFilter: ['class', 'data-theme', 'style'],
    });

    return () => {
      disposed = true;
      themeWatcher.disconnect();
      observer.disconnect();
      typed.dispose();
      cleanups.forEach(fn => fn());
      if (sessionId) void bridge.kill(sessionId);
      term.dispose();
    };
  }, []);

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
        <div className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          {detail}
        </div>
      )}
    </div>
  );
}
