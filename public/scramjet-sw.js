/**
 * Scramjet's fetch handler for the web browser panel.
 *
 * This is NOT registered as its own service worker. It is pulled into the app's
 * existing root-scope Workbox worker via `workbox.importScripts` in vite.config.ts,
 * and only registered directly as a fallback in dev, where VitePWA generates no
 * worker at all.
 *
 * WHY NOT A SCOPED WORKER. That was tried and measured, and it does not work. A
 * proxied page issues requests at the ORIGIN ROOT that the rewriter never saw in
 * the HTML — a Next.js site builds its chunk URLs at runtime from
 * `__webpack_public_path__` and asks for `/_next/static/...`. A worker scoped to
 * the proxy prefix never sees those, so they escape to the CDN, come back as
 * HTML, and the browser refuses every one for a MIME mismatch. Same page, same
 * build, only the scope changed: prefix-scoped → unreachable; root → renders.
 *
 * WHY NOT A SECOND ROOT-SCOPE WORKER. Only one worker controls a client, so it
 * would simply fight the PWA worker. One worker, both jobs.
 *
 * LOAD ORDER. Workbox places its importScripts at the TOP of the generated
 * worker, so this fetch listener is registered before Workbox's own. For proxy
 * URLs ours therefore calls respondWith first. Workbox would not answer these
 * anyway — they are neither precached nor in navigateFallbackAllowlist — but
 * being first removes the ambiguity.
 */

importScripts('/scramjet-runtime/scramjet.all.js');

/** Proxied URLs live under this path. Must match PROXY_PREFIX in BrowserPanel.tsx. */
const SCRAMJET_PREFIX = '/browse/';

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjetWorker = new ScramjetServiceWorker();

// Harmless duplicates when imported into Workbox (which sets both itself); the
// point of having them is that this file also works standalone in dev.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  let path;
  try {
    path = new URL(event.request.url).pathname;
  } catch {
    return;
  }

  // Everything outside the prefix belongs to the app. Do not intercept it at all
  // — not even to pass it through. Beyond fighting Workbox, touching it deadlocks
  // the transport: `loadConfig()` blocks until the controller writes the config,
  // the controller cannot start until bare-mux's worker script loads, and that
  // load would queue behind this handler. It presents as a page that never loads,
  // with no error anywhere.
  if (!path.startsWith(SCRAMJET_PREFIX)) return;

  event.respondWith(
    (async () => {
      await scramjetWorker.loadConfig();
      if (scramjetWorker.route(event)) return scramjetWorker.fetch(event);
      return fetch(event.request);
    })(),
  );
});
