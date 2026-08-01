// Builds the Electron desktop app as a THIN SHELL over the hosted backend.
//
// The one thing that makes the desktop app point at the real service instead of
// a (nonexistent) local backend is VITE_BACKEND_BASE_URL, baked into the bundle
// here. It is set ONLY for this Electron build — the web build (`npm run build`,
// what Netlify runs) never sees it, so the web bundle stays byte-for-byte the
// same-origin build it has always been. That's the "do NOT compromise web"
// guarantee: web safety is structural, not a promise.
//
// Cross-platform (no `cross-env` dependency, works on the Windows target too):
// we set process.env and spawn each step directly.
//
// Usage:
//   node scripts/electron-build.mjs                 → dmg/zip/nsis (default)
//   node scripts/electron-build.mjs --publish never → build, don't publish
// Override the backend for staging: VITE_BACKEND_BASE_URL=... node scripts/electron-build.mjs
// Thin wrapper kept for `npm run electron:*` aliases — same path as desktop-build.
import './desktop-build.mjs';
