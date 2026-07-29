import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiAuthHeaders, apiBaseUrl } from '@/lib/backendClient';

/**
 * A browsing pane inside an ordinary floating window.
 *
 * Three engines, picked at RUNTIME — nothing here imports Electron:
 *
 *   desktop  <webview>  a Chromium guest composited INSIDE the page. It obeys
 *                       CSS z-index (window chrome, dropdowns and dialogs draw
 *                       over it) and it is a top-level browsing context, so
 *                       `X-Frame-Options` / CSP `frame-ancestors` do not apply.
 *                       Google, GitHub and the rest just load. Unchanged.
 *   web      scramjet   the page is fetched by OUR backend
 *                       (server/browser-proxy.cjs), rewritten in a service
 *                       worker, and served back same-origin — so the framing
 *                       headers never reach the browser. This is a rewriting
 *                       proxy, not a CORS proxy: stripping the headers alone
 *                       would leave every relative URL in the document
 *                       resolving against our origin and every absolute one
 *                       going direct, and blocked again.
 *   web      <iframe>   fallback when scramjet cannot boot (no service worker —
 *                       private windows, locked-down enterprise policy). Sites
 *                       that send framing headers refuse to render, so we say
 *                       so plainly rather than showing an empty box.
 *
 * A native child webview (the Native SDK shell) is deliberately NOT used: it is
 * an AppKit view composited outside the page, so it paints over ALL app chrome
 * or is invisible — measured, no middle state.
 */

/** Proxied URLs live under this path; `public/browse/sw.js` is scoped to it. */
const PROXY_PREFIX = '/browse/';
const RUNTIME = '/scramjet-runtime';

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

interface ScramjetFrameLike {
  frame: HTMLIFrameElement;
  go: (url: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  addEventListener: (type: string, listener: (event: { url?: string }) => void) => void;
}

interface ScramjetControllerLike {
  init: () => Promise<void>;
  createFrame: () => ScramjetFrameLike;
  decodeUrl: (url: string) => string;
}

interface BareMuxGlobal {
  BareMuxConnection: new (workerPath: string) => {
    setTransport: (path: string, options: unknown[]) => Promise<void>;
  };
}

// Provided by /scramjet-runtime/*.js, loaded as classic scripts because the
// service worker `importScripts` the same bundle.
declare const $scramjetLoadController: () => {
  ScramjetController: new (config: Record<string, unknown>) => ScramjetControllerLike;
};

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

const scriptCache = new Map<string, Promise<void>>();

/** Classic <script> load, memoised — the panel can mount more than once. */
function loadScriptOnce(src: string): Promise<void> {
  const existing = scriptCache.get(src);
  if (existing) return existing;
  const pending = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
  scriptCache.set(src, pending);
  return pending;
}

/**
 * `navigator.serviceWorker.ready` is the WRONG wait here: it resolves for the
 * worker controlling THIS page, which is the app's Workbox PWA worker at scope
 * `/`. It would resolve immediately and we would race the proxy worker's
 * activation. Wait on the registration we actually made.
 */
async function waitForActive(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active) return;
  const worker = registration.installing || registration.waiting;
  if (!worker) return;
  await new Promise<void>(resolve => {
    const check = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        worker.removeEventListener('statechange', check);
        resolve();
      }
    };
    worker.addEventListener('statechange', check);
    check();
  });
}

export interface BrowserPanelProps {
  initialUrl?: string;
  /**
   * Cookie jar for the guest. A stable value keeps logins across restarts;
   * separate values isolate accounts. Desktop only.
   */
  partition?: string;
}

type Engine = 'desktop' | 'proxy' | 'iframe';

export function BrowserPanel({
  initialUrl = 'https://duckduckgo.com',
  partition = 'persist:agensis-browser',
}: BrowserPanelProps) {
  // WEB DEFAULTS TO 'iframe', NOT 'proxy' — the proxy engine is finished but not
  // yet usable, and the reason is worth recording because it is not obvious.
  //
  // `public/browse/sw.js` is scoped to `/browse/`, so it only sees requests under
  // that path. A proxied page emits plenty of requests that are NOT under it: a
  // Next.js site computes its chunk URLs at runtime from `__webpack_public_path__`
  // and asks for `/_next/static/...` at the ORIGIN ROOT, which the rewriter never
  // saw in the HTML and the scoped worker never sees on the wire. Those escape to
  // Netlify, which answers with its own HTML, and the browser refuses every one
  // for a MIME mismatch. Measured A/B on the same page, changing only the scope:
  // `/browse/` → unreachable; `/` → renders (1704 nodes, 72 images).
  //
  // The fix is a SINGLE root-scope worker doing both jobs — VitePWA switched from
  // generateSW to injectManifest, scramjet routing for `/browse/*` and Workbox for
  // the rest. That touches the update flow and the navigateFallbackAllowlist that
  // fixed the soft-404s, so it is its own change, not a tweak to this one.
  //
  // Until then web keeps the behaviour it has always had: a plain iframe that says
  // so plainly when a site refuses framing. Flip this to 'proxy' when the worker
  // lands — everything else here is ready.
  const [engine, setEngine] = useState<Engine>(() => (supportsWebviewTag() ? 'desktop' : 'iframe'));
  const [url, setUrl] = useState(initialUrl);
  const [address, setAddress] = useState(initialUrl);
  const [blocked, setBlocked] = useState(false);

  const webviewRef = useRef<WebviewElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const proxyHostRef = useRef<HTMLDivElement | null>(null);
  const proxyFrameRef = useRef<ScramjetFrameLike | null>(null);
  // Where the proxy engine should navigate once it finishes booting — a URL
  // typed during startup must not be dropped.
  const pendingUrlRef = useRef(initialUrl);

  const navigate = useCallback((next: string) => {
    const resolved = normalizeUrl(next);
    if (!resolved) return;
    setBlocked(false);
    setAddress(resolved);
    pendingUrlRef.current = resolved;
    if (proxyFrameRef.current) proxyFrameRef.current.go(resolved);
    else setUrl(resolved);
  }, []);

  // --- desktop -------------------------------------------------------------
  // Keep the address bar honest: the guest redirects, follows links, and lands
  // somewhere other than what was typed.
  useEffect(() => {
    const view = webviewRef.current;
    if (engine !== 'desktop' || !view) return;
    const sync = () => setAddress(view.getURL());
    view.addEventListener('did-navigate', sync);
    view.addEventListener('did-navigate-in-page', sync);
    return () => {
      view.removeEventListener('did-navigate', sync);
      view.removeEventListener('did-navigate-in-page', sync);
    };
  }, [engine]);

  // --- web: scramjet -------------------------------------------------------
  useEffect(() => {
    if (engine !== 'proxy') return;
    let disposed = false;

    void (async () => {
      try {
        if (!('serviceWorker' in navigator)) throw new Error('no service worker');

        await Promise.all([
          loadScriptOnce(`${RUNTIME}/scramjet.all.js`),
          loadScriptOnce(`${RUNTIME}/baremux.js`),
        ]);
        if (disposed) return;

        const bare = (window as unknown as { BareMux?: BareMuxGlobal }).BareMux;
        if (!bare) throw new Error('bare-mux unavailable');

        const connection = new bare.BareMuxConnection(`${RUNTIME}/baremux-worker.js`);
        // Auth headers are captured ONCE, here. A session that expires while the
        // panel is open makes subsequent fetches 401 and the panel must be
        // reopened. Acceptable for a first cut; refreshing means re-calling
        // setTransport, which is cheap but needs a token-change signal to hang off.
        await connection.setTransport(`${RUNTIME}/relay-transport.mjs`, [
          { base: apiBaseUrl(), headers: apiAuthHeaders() },
        ]);
        if (disposed) return;

        const { ScramjetController } = $scramjetLoadController();
        const controller = new ScramjetController({
          prefix: PROXY_PREFIX,
          files: {
            wasm: `${RUNTIME}/scramjet.wasm.wasm`,
            all: `${RUNTIME}/scramjet.all.js`,
            sync: `${RUNTIME}/scramjet.sync.js`,
          },
          // Source maps would pull two more multi-hundred-KB files per proxied
          // document for no user-visible benefit.
          flags: { sourcemaps: false },
        });

        // ORDER IS LOAD-BEARING. The service worker constructs a
        // ScramjetServiceWorker at import time, and that opens the `$scramjet`
        // IndexedDB WITHOUT an upgrade callback. If it wins the race it creates
        // the database empty at v1; the controller's own openDB(name, 1, …) then
        // sees a current version, never runs the upgrade, and every later
        // transaction dies with "object stores was not found". Init first.
        await controller.init();
        if (disposed) return;

        const registration = await navigator.serviceWorker.register(`${PROXY_PREFIX}sw.js`, {
          scope: PROXY_PREFIX,
        });
        await waitForActive(registration);
        if (disposed) return;

        const host = proxyHostRef.current;
        if (!host) return;

        const frame = controller.createFrame();
        frame.frame.className = 'absolute inset-0 h-full w-full border-0 bg-white';
        host.appendChild(frame.frame);
        proxyFrameRef.current = frame;

        // `urlchange` can hand back the PROXIED url. Echoing that into the
        // address bar would make the next navigation proxy an already-proxied
        // url, which scramjet rightly aborts ("the site has obtained a reference
        // to the real origin"). Decode back to the real one first.
        frame.addEventListener('urlchange', event => {
          if (!event.url || disposed) return;
          let real = event.url;
          for (let i = 0; i < 4 && real.startsWith(window.location.origin); i += 1) {
            try {
              const next = controller.decodeUrl(real);
              if (!next || next === real) break;
              real = next;
            } catch {
              break;
            }
          }
          setAddress(real);
        });

        frame.go(pendingUrlRef.current);
      } catch {
        // Nothing here is recoverable in place — fall back to the plain iframe,
        // which at least renders sites that permit framing.
        if (!disposed) setEngine('iframe');
      }
    })();

    return () => {
      disposed = true;
      proxyFrameRef.current?.frame.remove();
      proxyFrameRef.current = null;
    };
  }, [engine]);

  // --- web: plain iframe fallback -----------------------------------------
  /**
   * On web there is no load error to catch — a framing refusal fires no event
   * the parent can see. A load that never reports within the window is the only
   * available signal, so treat silence as "blocked" and say so.
   */
  useEffect(() => {
    if (engine !== 'iframe') return;
    setBlocked(false);
    const timer = window.setTimeout(() => setBlocked(true), 3500);
    const frame = iframeRef.current;
    const clear = () => window.clearTimeout(timer);
    frame?.addEventListener('load', clear);
    return () => {
      window.clearTimeout(timer);
      frame?.removeEventListener('load', clear);
    };
  }, [url, engine]);

  const goBack = () => {
    if (engine === 'desktop') webviewRef.current?.goBack();
    else proxyFrameRef.current?.back();
  };
  const goForward = () => {
    if (engine === 'desktop') webviewRef.current?.goForward();
    else proxyFrameRef.current?.forward();
  };
  const reload = () => {
    if (engine === 'desktop') webviewRef.current?.reload();
    else if (proxyFrameRef.current) proxyFrameRef.current.reload();
    else setUrl(current => `${current}`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Back"
          disabled={engine === 'iframe'}
          onClick={goBack}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Forward"
          disabled={engine === 'iframe'}
          onClick={goForward}
        >
          <ArrowRight />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Reload" onClick={reload}>
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
        {engine === 'desktop' && (
          <webview
            ref={webviewRef as unknown as React.Ref<HTMLWebViewElement>}
            src={url}
            partition={partition}
            useragent={CHROME_UA}
            allowpopups
            className="absolute inset-0 h-full w-full"
          />
        )}

        {engine === 'proxy' && <div ref={proxyHostRef} className="absolute inset-0" />}

        {engine === 'iframe' && (
          <iframe
            ref={iframeRef}
            src={url}
            title="Browser"
            className="absolute inset-0 h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}

        {blocked && engine === 'iframe' && (
          <div className="absolute inset-0 grid place-items-center bg-background/95 p-6 text-center">
            <div className="max-w-sm space-y-2">
              <TriangleAlert className="mx-auto size-6 text-muted-foreground" />
              <p className="text-sm font-medium">This site blocks embedding</p>
              <p className="text-xs text-muted-foreground">
                It sends <code>X-Frame-Options</code> or <code>frame-ancestors</code>, which browsers
                enforce. Getting around that needs a service worker, and one is not available here —
                a private window or a locked-down browser policy will do it.
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
