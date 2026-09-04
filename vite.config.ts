import { defineConfig, type Plugin, defaultClientConditions, defaultServerConditions } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { nitro } from 'nitro/vite';
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
// Typed as `Plugin` rather than inferred: without it TypeScript types `this`
// inside generateBundle from the object literal, which has no `emitFile`, and
// the call below is an error. It works at runtime — Rollup binds the plugin
// context — so this was latent, and invisible because `npm run typecheck` only
// covered tsconfig.app.json. See the typecheck script in package.json.
function emitVersionJson(): Plugin {
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

// The web browser panel's runtime: scramjet's rewriter plus bare-mux. Both are
// permissively licensed at the pinned versions, and this project is AGPL-3.0
// anyway, so neither constrains us — see NOTICE for the full picture, including
// why scramjet is pinned exactly rather than with a caret.
// These are prebuilt bundles that must be fetched by URL at runtime — the service
// worker `importScripts` them and bare-mux imports its SharedWorker by path — so
// they cannot go through Rollup. They are emitted verbatim instead.
//
// They live at /scramjet-runtime/, deliberately OUTSIDE the `/browse/` scope the
// proxy service worker owns, so a proxied URL can never collide with a runtime file.
//
// Desktop skips all of it: the Electron shell renders <webview>, which is a real
// top-level browsing context and needs no proxy — so ~1.6MB stays out of that build.
const BROWSER_RUNTIME_FILES: Array<[string, string]> = [
  ['@mercuryworkshop/scramjet/dist/scramjet.all.js', 'scramjet.all.js'],
  ['@mercuryworkshop/scramjet/dist/scramjet.sync.js', 'scramjet.sync.js'],
  ['@mercuryworkshop/scramjet/dist/scramjet.wasm.wasm', 'scramjet.wasm.wasm'],
  ['@mercuryworkshop/bare-mux/dist/index.js', 'baremux.js'],
  ['@mercuryworkshop/bare-mux/dist/worker.js', 'baremux-worker.js'],
];

// Typed as `Plugin` for the same reason emitVersionJson is: without it the hand
// written parameter types below are checked against Vite's real hook signatures
// and lose — `configureServer` receives a full ViteDevServer, whose
// `middlewares.use` is Connect's four-overload signature, not `(fn: unknown) =>
// void`. Declaring the return type lets Vite's types flow into the hooks so the
// parameters can be inferred instead of guessed.
//
// This surfaced only once `npm run typecheck` began covering tsconfig.node.json;
// before that nothing checked this file at all.
function browserRuntimeAssets(): Plugin {
  // Resolved by PATH, not by `require.resolve`. Neither package lists
  // "./package.json" in its exports map, so the usual
  // `dirname(require.resolve(pkg + '/package.json'))` trick throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED — and inside generateBundle that produced a
  // build with the runtime assets simply missing, which is far worse than a
  // failure. Hence the explicit existsSync check below.
  const fs = require('node:fs') as typeof import('node:fs');
  const resolve = (spec: string) => {
    const full = path.resolve(import.meta.dirname, 'node_modules', spec);
    if (!fs.existsSync(full)) {
      throw new Error(
        `browser runtime asset missing: ${spec}. Run npm install — the web browser panel cannot work without it.`,
      );
    }
    return full;
  };

  return {
    name: 'agensis-browser-runtime-assets',
    // Dev has no build step, so serve them straight off disk.
    // No parameter annotations: with the return typed as `Plugin`, Vite infers
    // `server` as ViteDevServer and the middleware args from Connect. Annotating
    // them by hand is what broke — a narrower hand-written shape is not
    // assignable to the real hook signature.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = BROWSER_RUNTIME_FILES.find(([, out]) => req.url === `/scramjet-runtime/${out}`);
        if (!match) return next();
        try {
          res.setHeader('Content-Type', match[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
          fs.createReadStream(resolve(match[0])).pipe(res);
        } catch {
          next();
        }
      });
    },
    // Same again: `this` is Rollup's PluginContext, inferred from the Plugin
    // return type. The hand-written shape narrowed it and did not assign.
    generateBundle() {
      if (isDesktopBuild) return;
      for (const [spec, out] of BROWSER_RUNTIME_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: `scramjet-runtime/${out}`,
          source: fs.readFileSync(resolve(spec)),
        });
      }
    },
  };
}

/** Keep output-producing browser plugins out of Nitro's server environment. */
function clientOnly(plugins: Plugin[]): Plugin[] {
  for (const plugin of plugins) {
    const applies = plugin.applyToEnvironment;
    plugin.applyToEnvironment = (environment) => {
      if (environment.config.consumer !== 'client') return false;
      return applies ? applies(environment) : true;
    };
  }
  return plugins;
}

export default defineConfig(({ command }) => ({
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
  // Nitro's Vite integration derives the client entry from its renderer. This
  // app deliberately keeps the renderer disabled because Netlify already owns
  // the route map (landing page, SPA paths, join proxy and real 404s), so name
  // the browser entry explicitly instead of letting a server environment fall
  // back to index.html.
  environments: {
    client: {
      build: {
        // The huddle microphone's AudioWorklet must stay a real file. Vite
        // inlines any asset under 4 KB as a `data:` URI, and worklet scripts
        // are governed by CSP's `script-src`, which excludes data/blob URLs.
        assetsInlineLimit: (filePath) => (filePath.endsWith('.worklet.js') ? false : undefined),
        rollupOptions: {
          input: path.resolve(import.meta.dirname, 'index.html'),
          output: {
            manualChunks(id) {
              if (id.includes('node_modules')) {
                if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
                // Streamdown's parser and Shiki bridge are substantial but
                // only needed by rich-text surfaces. Shiki languages/themes
                // remain their own on-demand chunks.
                if (/node_modules\/(?:@streamdown|streamdown|remark-|rehype-|remend|unified|mdast-util-|micromark|hast-util-|unist-util-)/.test(id)) return 'vendor-markdown';
                if (/node_modules\/(radix-ui|@radix-ui|cmdk|sonner|vaul|lucide-react)\//.test(id)) return 'vendor-ui';
              }
            },
          },
        },
      },
    },
  },
  resolve: {
    // `source` first: @agensis/ui is a workspace package whose exports map
    // points this condition at its TS source. Resolving library source (not a
    // built dist) keeps HMR/fast-refresh working on component edits and keeps
    // library module ids under /packages/ui/src, so they land in the `index`
    // chunk exactly as src/components/ui/* did — which is what keeps the
    // workbox globPatterns below (hard-coded chunk names) valid. Moving the
    // app to dist-resolution would need that precache list re-examined.
    // Note this applies to EVERY package, not just @agensis/ui: any dependency
    // exposing a "source" condition in its exports map would now be bundled
    // from raw TypeScript. Audited on 2026-09-01 — only eventsource and
    // eventsource-parser do, and both are reachable only through the shadcn
    // CLI's MCP SDK, never from browser code. Re-audit before adding a
    // front-end dependency that ships its own source.
    conditions: ['source', ...defaultClientConditions],
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  ssr: {
    // The workspace library exposes source TypeScript under the `source`
    // condition. Nitro's renderer and Vite's SSR transforms must resolve the
    // same module identity as the browser or hydration/build chunks can drift.
    noExternal: ['@agensis/ui'],
    resolve: { conditions: ['source', ...defaultServerConditions] },
  },
  optimizeDeps: {
    include: [
      // Pre-bundle the chat/session dependencies at startup. Discovering one
      // halfway through a live conversation forces Vite to re-optimise and can
      // strand open tabs on stale chunk hashes. Keep this to direct deps only.
      '@base-ui/react',
      '@streamdown/code',
      'blobatar',
      'class-variance-authority',
      'clsx',
      'cmdk',
      'date-fns',
      'lucide-react',
      'react-resizable-panels',
      'sonner',
      'streamdown',
      'tailwind-merge',
      'vaul',
    ],
  },
  server: {
    // Transform the conversation hot path while Vite is booting. Warming the
    // entire application would only move work into startup; these are the
    // modules reached by the first channel navigation and every stream tick.
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/components/windows/ChatWindowContent.tsx',
        './src/components/chat/ChatThreadPanel.tsx',
        './src/components/chat/MarkdownContent.tsx',
        './src/components/chat/ToolStepGroup.tsx',
        './src/components/chat/ComposerMentionUI.tsx',
      ],
    },
    // Parallel review/implementation worktrees live beneath this checkout.
    // Without explicit ignores, another agent's build rewrites thousands of
    // dist files and Vite treats every one as an application change, causing
    // reload storms in the browser being used for acceptance testing.
    watch: {
      ignored: ['**/.worktrees/**', '**/.claude/worktrees/**'],
    },
    proxy: {
      '/backend': {
        target: 'http://127.0.0.1:3142',
        changeOrigin: true,
        ws: true,
      },
      // Keep the single invite URL usable in local development as well as on
      // Netlify/Fly. Clean /join/<token> navigation must reach the server-rendered
      // join page; otherwise Vite serves the SPA shell and agents receive no
      // redemption contract.
      '/join': {
        target: 'http://127.0.0.1:3142',
        changeOrigin: true,
        ws: false,
        rewrite: (path) => `/backend${path}`,
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    ...clientOnly([
      emitVersionJson(),
      browserRuntimeAssets(),
      ...VitePWA({
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
        // The web browser panel's proxy handler, pulled into THIS worker rather
        // than registered as its own. A worker scoped to /browse/ was measured
        // and does not work: a proxied page requests things at the origin root
        // (Next.js chunk URLs built at runtime) that a scoped worker never sees,
        // so they escape to Netlify and come back as HTML. A second root-scope
        // worker is not an option either — only one worker controls a client.
        // Workbox emits these imports at the top of the generated worker, so the
        // proxy's fetch listener is registered before Workbox's own.
        importScripts: ['/scramjet-sw.js'],
        globPatterns: ['index.html', 'assets/{index,vendor-react,vendor-ui,vendor-markdown}-*.{js,css}', '**/*.{svg,png,woff2}'],
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
    ]),
    // Nitro owns the production static output pass, while the existing Fly
    // Express/WS server and Netlify HTTP mirror remain the two application
    // backends. Nitro v3 defaults serverDir to false; do not point it at
    // ./server, which is an Express service rather than Nitro route handlers.
    // Desktop still needs Vite's plain relative-asset dist for file://.
    ...(command === 'build' && !isDesktopBuild
      ? (nitro({
          preset: process.env.AGENSIS_NITRO_PRESET || 'netlify_static',
          // Agensis is client-rendered and Netlify's checked-in redirect map is
          // the routing authority. Disabling the catch-all renderer preserves
          // its landing page, join proxy and hard-404 behaviour.
          renderer: false,
          prerender: { crawlLinks: false, routes: [] },
          // The current Nitro 3 beta still asks Vite to build a server
          // environment for static presets. Give that environment a harmless
          // entry and keep its unused artifact outside the publish directory.
          entry: './scripts/nitro-static-entry.mjs',
          output: {
            serverDir: './node_modules/.nitro/agensis-static-server',
          },
        }) as unknown as Plugin[])
      : []),
  ],
}));
