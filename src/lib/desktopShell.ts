/**
 * Is the app running inside a desktop shell rather than a browser tab?
 *
 * Two independent signals, either of which is sufficient, because the two shells
 * expose different things:
 *
 *   electronAPI   the Electron preload bridge. This is what the terminal needs —
 *                 `electronAPI.pty` is the only route to a real shell.
 *   <webview>     Chromium's guest tag, which only upgrades to a real element
 *                 when the shell enabled `webviewTag`. This is what the browser
 *                 panel needs to load sites that refuse framing.
 *
 * Both are runtime probes on purpose. Nothing here imports Electron, so the web
 * bundle is unaffected.
 */

interface WebviewProbe {
  getURL?: () => string;
}

export function hasElectronBridge(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { electronAPI?: unknown }).electronAPI);
}

export function hasWebviewTag(): boolean {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('webview') as WebviewProbe;
  return typeof probe.getURL === 'function';
}

/** True in the desktop shell, false in a browser tab. */
export function isDesktopShell(): boolean {
  return hasElectronBridge() || hasWebviewTag();
}
