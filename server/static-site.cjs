'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Serves the built frontend (dist/) from this same process.
//
// WHY THIS EXISTS
//
// The deployed split has no use for it: Netlify serves dist/ and this backend
// serves only /backend/*, on a different origin. It exists for the single
// container — Dockerfile / docker-compose.yml — where someone self-hosting gets
// the app, the API and the realtime websocket on ONE origin.
//
// That is not a cosmetic difference. src/lib/backendClient.ts computes its
// BACKEND_BASE as '' on any host that is not agensis.io or *.netlify.app, so
// every /backend/... fetch is already same-origin-relative and getWsUrl()
// already builds ws://<this host>/backend/ws. Serving the bundle from here is
// what makes that fallback resolve to a real server instead of nothing.
//
// OFF UNLESS ASKED FOR. index.cjs only calls this when AGENSIS_STATIC_ROOT is
// set, and fly.toml does not set it, so the Fly deploy is untouched.
//
// MOUNT ORDER IS THE SAFETY PROPERTY. This is called last in createApp(), after
// every /backend route is registered, so neither the static handler nor the SPA
// fallback below can shadow an API route. The fallback still refuses /backend
// explicitly: a request for a route that does not exist must come back as the
// API's own 404, never as 200 + index.html, or a client's "is this endpoint
// deployed?" probe reads a missing route as a working one.
function mountStaticSite(app, deps = {}) {
 const root = deps.root ? path.resolve(deps.root) : '';
 const indexHtml = root ? path.join(root, 'index.html') : '';
 // A missing bundle is a misconfiguration, not a reason to refuse to boot: the
 // API is still perfectly usable without it. Say so once and carry on.
 if (!indexHtml || !fs.existsSync(indexHtml)) {
  console.warn(`[static] no index.html under ${root || '(unset)'} — frontend not served`);
  return false;
 }

 app.use(express.static(root, {
  index: 'index.html',
  // Vite fingerprints the files it emits, so those can be cached forever. Every
  // other file — index.html, sw.js, version.json, the manifest — is fetched by a
  // name that never changes, and caching those is how a browser gets pinned to a
  // build that no longer exists.
  setHeaders(res, filePath) {
   const immutable = /[.-][0-9a-zA-Z_]{8,}\.(js|css|woff2)$/.test(path.basename(filePath));
   res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
 }));

 // Deep links (/app, /app/..., /integrations/...) are client-side routes with no
 // file behind them — the same 200-rewrite netlify.toml performs for the hosted
 // build. Scoped to GET/HEAD of something that wants HTML so a mistyped API call
 // or a stray POST still gets a real 404 rather than a page.
 app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path === '/backend' || req.path.startsWith('/backend/')) return next();
  if (!req.accepts('html')) return next();
  res.sendFile(indexHtml);
 });

 console.log(`[static] serving frontend from ${root}`);
 return true;
}

module.exports = { mountStaticSite };
