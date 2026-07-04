import { defineConfig } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// A build identity baked into the bundle (`__BUILD_ID__`) AND emitted as a
// static `version.json`. The running client compares its baked id against the
// freshly-fetched version.json to detect that a newer frontend has published —
// the "check versions on relaunch" half of the update flow. Both come from the
// same value here so they always agree within a single build. On Netlify,
// COMMIT_REF is the deployed commit SHA; locally it falls back to a timestamp.
const commitRef = process.env.COMMIT_REF || process.env.VITE_COMMIT_REF || '';
const BUILD_ID = commitRef || `dev-${Date.now()}`;
const BUILT_AT = new Date().toISOString();

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

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  // Use relative asset URLs so the same bundle works when served from a web
  // root and when loaded from disk inside the Electron desktop wrapper.
  base: './',
  build: {
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
      // 'prompt' (not 'autoUpdate') so a new frontend WAITS for the user to click
      // our themed update dialog instead of silently self-reloading — that's what
      // lets the "what's new" surface exist and lets us bust the cache on demand.
      registerType: 'prompt',
      includeAssets: ['icon-192.svg', 'icon-512.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'agensis — AI Workspace',
        short_name: 'agensis',
        description: 'AI-powered workspace for documents, chat, and memory',
        theme_color: '#0c0c0c',
        background_color: '#0c0c0c',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
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
        globPatterns: ['index.html', 'assets/{index,vendor-react,vendor-ui}-*.{js,css}', '**/*.{svg,png,woff2}'],
        // Never precache the version manifest or release notes — they must be
        // fetched fresh so the update check reflects the true latest deploy.
        globIgnores: ['**/version.json', '**/release-notes.json', '**/agent-avatars/**', '**/*cyrillic*.woff2', '**/*greek*.woff2', '**/*vietnamese*.woff2'],
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
            handler: 'CacheFirst',
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
