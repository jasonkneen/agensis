import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * A browsing pane inside an ordinary floating window.
 *
 * Two engines, picked at RUNTIME so the web bundle is byte-identical to what it
 * was — nothing here imports Electron:
 *
 *   desktop  <webview>  a Chromium guest composited INSIDE the page. It obeys
 *                       CSS z-index (window chrome, dropdowns and dialogs draw
 *                       over it) and it is a top-level browsing context, so
 *                       `X-Frame-Options` / CSP `frame-ancestors` do not apply.
 *                       Google, GitHub and the rest just load.
 *   web      <iframe>   the only option a browser has. Sites that send those
 *                       headers refuse to render, so we say so plainly rather
 *                       than showing an empty box.
 *
 * A native child webview (the Native SDK shell) is deliberately NOT used: it is
 * an AppKit view composited outside the page, so it paints over ALL app chrome
 * or is invisible — measured, no middle state.
 */

/** `<webview>` only exists when the Electron shell enabled `webviewTag`. */
interface WebviewElement extends HTMLElement {
  src: string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  getURL: () => string;
}

/**
 * True only in the Electron shell. `webviewTag` is off by default, so the tag
 * upgrades to a custom element and gains `getURL` — absent in a browser, where
 * `document.createElement('webview')` is an inert HTMLUnknownElement.
 */
function supportsWebviewTag(): boolean {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('webview') as Partial<WebviewElement>;
  return typeof probe.getURL === 'function';
}

/**
 * Chrome's UA. Sites gate features (and sometimes refuse outright) on seeing
 * "Electron" in the UA string, so present as the browser we actually are.
 */
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // A bare host or path gets https; anything with a space is a search.
  if (/\s/.test(trimmed) || !trimmed.includes('.')) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  }
  return `https://${trimmed}`;
}

export interface BrowserPanelProps {
  initialUrl?: string;
  /**
   * Cookie jar for the guest. A stable value keeps logins across restarts;
   * separate values isolate accounts. Desktop only.
   */
  partition?: string;
}

export function BrowserPanel({
  initialUrl = 'https://duckduckgo.com',
  partition = 'persist:agensis-browser',
}: BrowserPanelProps) {
  const [native] = useState(supportsWebviewTag);
  const [url, setUrl] = useState(initialUrl);
  const [address, setAddress] = useState(initialUrl);
  const [blocked, setBlocked] = useState(false);

  const webviewRef = useRef<WebviewElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const navigate = useCallback((next: string) => {
    const resolved = normalizeUrl(next);
    if (!resolved) return;
    setBlocked(false);
    setUrl(resolved);
    setAddress(resolved);
  }, []);

  // Keep the address bar honest: the guest redirects, follows links, and lands
  // somewhere other than what was typed.
  useEffect(() => {
    const view = webviewRef.current;
    if (!native || !view) return;
    const sync = () => setAddress(view.getURL());
    view.addEventListener('did-navigate', sync);
    view.addEventListener('did-navigate-in-page', sync);
    return () => {
      view.removeEventListener('did-navigate', sync);
      view.removeEventListener('did-navigate-in-page', sync);
    };
  }, [native]);

  /**
   * On web there is no load error to catch — a framing refusal fires no event
   * the parent can see. A load that never reports within the window is the only
   * available signal, so treat silence as "blocked" and say so.
   */
  useEffect(() => {
    if (native) return;
    setBlocked(false);
    const timer = window.setTimeout(() => setBlocked(true), 3500);
    const frame = iframeRef.current;
    const clear = () => window.clearTimeout(timer);
    frame?.addEventListener('load', clear);
    return () => {
      window.clearTimeout(timer);
      frame?.removeEventListener('load', clear);
    };
  }, [url, native]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Back"
          disabled={!native}
          onClick={() => webviewRef.current?.goBack()}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Forward"
          disabled={!native}
          onClick={() => webviewRef.current?.goForward()}
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reload"
          onClick={() => (native ? webviewRef.current?.reload() : setUrl(u => `${u}`))}
        >
          <RotateCw />
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={event => {
            event.preventDefault();
            navigate(address);
          }}
        >
          <Input
            value={address}
            onChange={event => setAddress(event.target.value)}
            spellCheck={false}
            aria-label="Address"
            className="h-7 text-xs"
          />
        </form>
      </div>

      <div className="relative min-h-0 flex-1">
        {native ? (
          <webview
            ref={webviewRef as unknown as React.Ref<HTMLWebViewElement>}
            src={url}
            partition={partition}
            useragent={CHROME_UA}
            allowpopups
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <iframe
            ref={iframeRef}
            src={url}
            title="Browser"
            className="absolute inset-0 h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}

        {blocked && !native && (
          <div className="absolute inset-0 grid place-items-center bg-background/95 p-6 text-center">
            <div className="max-w-sm space-y-2">
              <TriangleAlert className="mx-auto size-6 text-muted-foreground" />
              <p className="text-sm font-medium">This site blocks embedding</p>
              <p className="text-xs text-muted-foreground">
                It sends <code>X-Frame-Options</code> or <code>frame-ancestors</code>, which browsers
                enforce. Open it in the desktop app, where it loads normally.
              </p>
              <Button variant="outline" size="sm" onClick={() => window.open(url, '_blank', 'noopener')}>
                Open in a new tab
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
