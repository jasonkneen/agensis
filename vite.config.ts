import { defineConfig } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkgVersion: string = require('./package.json').version || '0.0.0';
// A build identity baked into the bundle (`__BUILD_ID__`) AND emitted as a
// static `version.json`. The running client compares its baked id against the
// freshly-fetched version.json to detect that a newer frontend has published —
// the "check versions on relaunch" half of the update flow. Both come from the
// same value here so they always agree within a single build. On Netlify,
// COMMIT_REF is the deployed commit SHA; locally it falls back to a timestamp.
const commitRef = process.env.COMMIT_REF || process.env.VITE_COMMIT_REF || '';
const BUILD_ID = commitRef || `dev-${Date.now()}`;
const BUILT_AT = new Date().toISOString();

// Only the desktop shell loads dist/index.html off disk over file://, and only
// it needs relative asset URLs. scripts/desktop-build.mjs and
// scripts/electron-build.mjs are the sole callers that set
// VITE_BACKEND_BASE_URL when they invoke `vite build`; the web build (`npm run
// build`, what Netlify runs) never sets it (see the deploy env table in
// AGENTS.md). AGENSIS_DESKTOP_BUILD=1 is an explicit override for either.
// Only the desktop packager sets this (scripts/desktop-build.mjs). It is NOT
// keyed off VITE_BACKEND_BASE_URL: a web deploy may bake a backend URL too, and
// giving that build relative asset URLs breaks /app/ — the assets resolve under
// the sub-path, re-enter the SPA rewrite, and return text/html instead of JS.
const isDesktopBuild = process.env.AGENSIS_DESKTOP_BUILD === '1';

// Emits dist/version.json at build time (build only — absent in dev, where the
// client's fetch simply no-ops). Kept out of the Workbox precache because it's
// JSON (globPatterns below only precaches js/css/html/svg/png/woff2), so the
// version check always sees the true latest, never a cached copy.
function emitVersionJson() {
  return {
    name: 'agensis-emit-version-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId: BUILD_ID, commit: commitRef || null, builtAt: BUILT_AT }),
      });
    },
  };
}

// NOTE: the web build used to emit a proxy "browser runtime" here — a prebuilt
// rewriter plus bare-mux, copied verbatim out of node_modules into
// /scramjet-runtime/ so a browser tab could render sites that refuse framing.
// It was removed because we could not establish redistribution rights for
// @mercuryworkshop/scramjet: the upstream repo carries no LICENSE file and the
// GitHub API reports `license: null`, the npm metadata field claims MIT, and the
// published tarball contains AGPL-3.0 text. Three different answers, and none of
// them is a grant we could rely on for our own build output. Nothing here is a
// claim about that project's intent — only about what we could verify.
//
// The browser panel is now desktop-only, which is where it always worked best:
// the Electron shell renders <webview>, a real top-level browsing context that
// needs no proxy at all. See src/components/windows/BrowserPanel.tsx.

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  // Desktop gets relative asset URLs (file:// has no origin to resolve `/`
  // against). The web build MUST stay root-absolute: netlify.toml 200-rewrites
  // /app/* and /integrations/* to this same index.html, so a relative
  // "./assets/index-*.js" would resolve *under* the sub-path, re-enter the
  // catch-all rewrite and come back as text/html — the module script is then
  // rejected for a MIME mismatch and the page renders blank.
  base: isDesktopBuild ? './' : '/',
  build: {
    // The huddle microphone's AudioWorklet must stay a real file. Vite inlines
    // any asset under 4 KB as a `data:` URI, and worklet scripts are governed
    // by CSP's `script-src` — which netlify.toml sets to `'self' 'unsafe-inline'`
    // with neither `data:` nor `blob:`. Inlined, the microphone works today and
    // dies silently the day that policy is promoted out of Report-Only.
    assetsInlineLimit: (filePath) => (filePath.endsWith('.worklet.js') ? false : undefined),
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
            if (/node_modules\/(radix-ui|@radix-ui|cmdk|sonner|vaul|lucide-react)\//.test(id)) return 'vendor-ui';
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/backend': {
        target: 'http://127.0.0.1:3142',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    emitVersionJson(),
    VitePWA({
      // 'prompt' (not 'autoUpdate') so an open tab is never force-reloaded out
      // from under the user mid-session — the update surface is our themed
      // dialog/toast instead. Note the SW itself no longer WAITS for that
      // click: workbox skipWaiting below activates new workers immediately so
      // stale workers self-expire; the dialog is about when to reload the PAGE.
      registerType: 'prompt',
      includeAssets: ['icon-192.svg', 'icon-512.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'agensis — AI Workspace',
        short_name: 'agensis',
        description: 'A shared workspace where AI agents work with you, your team, and each other.',
        theme_color: '#0c0c0c',
        background_color: '#0c0c0c',
        display: 'standalone',
        orientation: 'any',
        // The marketing landing page owns `/`; the installed PWA should open
        // straight into the app at /app.
        start_url: '/app',
        scope: '/',
        icons: [
          // PNG icons first so platforms that don't rasterize SVG (notably iOS
          // home-screen) get a real logo instead of a page screenshot (L12).
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // Self-healing takeover: any stale SW still controlling a browser (e.g.
        // pre-landing-page ones that served the SPA shell at /) gets replaced
        // without user action — the browser's routine update check fetches the
        // new sw.js, and skipWaiting/clientsClaim activate + claim immediately.
        // The next navigation then follows THIS worker's rules (incl. the
        // allowlist below, which leaves `/` to the network → landing page). The
        // running tab keeps its already-loaded assets; AppUpdateManager's
        // version.json check still surfaces the "what's new" recap after the
        // swap.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['index.html', 'assets/{index,vendor-react,vendor-ui}-*.{js,css}', '**/*.{svg,png,woff2}'],
        // Allowlist, not denylist: Workbox matches these against
        // `url.pathname + url.search`, so a denylist entry like /^\/$/ misses
        // `/?utm_source=x` and the SW would hand a returning visitor the SPA
        // shell instead of the landing page. Naming only the routes the SPA
        // actually owns also stops unknown paths (/pricing, typos) falling back
        // to index.html, so they reach Netlify's real 404 instead of a
        // soft-404 app shell. Everything else — `/`, /landing, robots.txt,
        // sitemap.xml, llms.txt, og-image.png, 404.html — goes to the network.
        navigateFallbackAllowlist: [/^\/app(?:\/|$)/, /^\/integrations(?:\/|$)/],
        // Never precache the version manifest or release notes — they must be
        // fetched fresh so the update check reflects the true latest deploy.
        globIgnores: ['**/version.json', '**/release-notes.json', '**/agent-avatars/**', '**/og-image.png', '**/*cyrillic*.woff2', '**/*greek*.woff2', '**/*vietnamese*.woff2'],
        runtimeCaching: [
          {
            // Hashed lazy chunks (mermaid, diagrams, etc.) — cache on first use only.
            urlPattern: /\/assets\/.*\.(?:js|css)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'lazy-chunks',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Agent avatar images — not part of the app shell, cache on first use.
            urlPattern: /\/agent-avatars\/.*\.(?:png|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'agent-avatars',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/images\.pexels\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'pexels-images-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
