/**
 * Scramjet's service worker, deliberately scoped to `/browse/`.
 *
 * SCOPE IS THE WHOLE DESIGN HERE. The app already ships a Workbox PWA worker at
 * `/sw.js` with scope `/` (see VitePWA in vite.config.ts). Two workers can coexist
 * on one origin as long as the more specific scope wins for its own URLs, which is
 * why this file lives at `/browse/sw.js` — a worker's default scope is its own
 * directory, so this one owns `/browse/*` and nothing else. The PWA worker keeps
 * everything else, untouched.
 *
 * It also happens to be safe from the other direction: the PWA worker's
 * `navigateFallbackAllowlist` is `[/^\/app/, /^\/integrations/]`, so it never
 * hands the SPA shell to a `/browse/` navigation.
 *
 * The runtime bundle is loaded from `/scramjet-runtime/`, OUTSIDE this scope, so
 * a proxied URL can never collide with it.
 */

importScripts('/scramjet-runtime/scramjet.all.js');

const PREFIX = '/browse/';

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/**
 * Two things this handler has to get right, both of which cost a debug cycle:
 *
 * 1. `respondWith` must be called SYNCHRONOUSLY. Scramjet's own documented
 *    example awaits `loadConfig()` first, which throws in a real worker.
 * 2. Requests outside the prefix must not be intercepted AT ALL — not even to
 *    pass through. `loadConfig()` blocks until the controller has written config,
 *    but the controller cannot start until bare-mux's worker script has loaded,
 *    and that load would queue behind this handler. Deadlock, and it presents as
 *    the transport hanging forever with no error anywhere.
 */
self.addEventListener('fetch', (event) => {
  let path;
  try {
    path = new URL(event.request.url).pathname;
  } catch {
    return;
  }
  if (!path.startsWith(PREFIX)) return;

  event.respondWith(
    (async () => {
      await scramjet.loadConfig();
      if (scramjet.route(event)) return scramjet.fetch(event);
      return fetch(event.request);
    })(),
  );
});
