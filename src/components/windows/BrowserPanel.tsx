import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, MonitorDown, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hasWebviewTag } from '@/lib/desktopShell';

/**
 * A browsing pane inside an ordinary floating window. Desktop only.
 *
 * DESKTOP renders `<webview>`, a Chromium guest composited INSIDE the page. It
 * obeys CSS z-index (window chrome, dropdowns and dialogs draw over it) and it
 * is a top-level browsing context, so `X-Frame-Options` / CSP `frame-ancestors`
 * do not apply. Google, GitHub and the rest just load. Nothing here imports
 * Electron — the tag is probed at runtime.
 *
 * WEB gets an explicit "open the desktop app" state instead of a browsing
 * surface. A browser tab has only `<iframe>`, which the framing headers above
 * do block, so the tab build previously carried a rewriting proxy
 * (@mercuryworkshop/scramjet in a service worker, egressing through
 * server/browser-proxy.cjs). That proxy was removed: scramjet ships no usable
 * licence grant — the upstream repo has no LICENSE, npm metadata claims MIT and
 * the tarball contains AGPL-3.0 text — so it cannot be redistributed in our
 * build output. A plain `<iframe>` was not kept as a consolation engine: the
 * sites people reach for here are exactly the ones that refuse framing, so it
 * would be a surface that looks alive and is blank in practice.
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
  // Probed once per mount, not per render: a per-render probe would create a
  // throwaway <webview> element every time.
  const [supported] = useState(hasWebviewTag);
  const [url, setUrl] = useState(initialUrl);
  const [address, setAddress] = useState(initialUrl);

  const webviewRef = useRef<WebviewElement | null>(null);

  const navigate = useCallback((next: string) => {
    const resolved = normalizeUrl(next);
    if (!resolved) return;
    setAddress(resolved);
    setUrl(resolved);
  }, []);

  // Keep the address bar honest: the guest redirects, follows links, and lands
  // somewhere other than what was typed.
  useEffect(() => {
    const view = webviewRef.current;
    if (!supported || !view) return;
    const sync = () => setAddress(view.getURL());
    view.addEventListener('did-navigate', sync);
    view.addEventListener('did-navigate-in-page', sync);
    return () => {
      view.removeEventListener('did-navigate', sync);
      view.removeEventListener('did-navigate-in-page', sync);
    };
  }, [supported]);

  // The sidebar withholds its open-browser handler outside the desktop shell
  // (App.tsx), so a browser tab has no way to reach this. Rendering the reason
  // anyway keeps any future entry point honest instead of blank.
  if (!supported) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm space-y-2">
          <MonitorDown className="mx-auto size-6 text-muted-foreground" />
          <p className="text-sm font-medium">Browsing is available in the desktop app</p>
          <p className="text-xs text-muted-foreground">
            A browser tab can only embed other sites in an <code>&lt;iframe&gt;</code>, and most
            sites refuse that with <code>X-Frame-Options</code> or <code>frame-ancestors</code>. The
            desktop app renders pages in a real browser view, so they load normally.
          </p>
          <Button variant="outline" size="sm" onClick={() => window.open(url, '_blank', 'noopener')}>
            Open in a new tab
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Back"
          onClick={() => webviewRef.current?.goBack()}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Forward"
          onClick={() => webviewRef.current?.goForward()}
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reload"
          onClick={() => webviewRef.current?.reload()}
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
        <webview
          ref={webviewRef as unknown as React.Ref<HTMLWebViewElement>}
          src={url}
          partition={partition}
          useragent={CHROME_UA}
          allowpopups
          className="absolute inset-0 h-full w-full"
        />
      </div>
    </div>
  );
}
