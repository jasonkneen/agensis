'use strict';

/**
 * Server-side egress for the WEB browser panel.
 *
 * The desktop shell renders `<webview>`, a real top-level browsing context, so
 * `X-Frame-Options` / CSP `frame-ancestors` never apply and it needs none of
 * this. A browser tab has only `<iframe>`, which those headers do block — so on
 * web the page is fetched HERE and rewritten client-side by scramjet, then
 * served back same-origin.
 *
 * Why this is not a "CORS proxy": stripping framing headers alone leaves every
 * relative URL in the document resolving against OUR origin and every absolute
 * URL going direct (and blocked again). Rewriting is scramjet's job in the
 * service worker. This module's only job is to be the thing that dials out — and
 * to refuse to dial anywhere dangerous.
 *
 * SECURITY. This fetches a URL chosen by the client from inside the Fly machine,
 * which holds DATABASE_URL, AUTH_SECRET, SECRETS_ENCRYPTION_KEY and every
 * provider key. The address predicate is NOT re-derived here on purpose: it is
 * `isBlockedAddress` in server/lib/net-guard.cjs, single-sourced, and a second
 * implementation is a second thing to get wrong (this repo has already shipped
 * one SSRF from an unvalidated base URL).
 */

const { assertSafeBrowsingUrl, guardedFetchAgent } = require('./lib/net-guard.cjs');

// Hop-by-hop headers are per-connection and must not be forwarded either way.
// content-encoding/content-length are dropped on the way BACK because fetch has
// already decoded the body; leaving them makes the client try to gunzip plaintext.
const STRIP_FROM_TARGET = new Set([
 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate',
 'proxy-authorization', 'te', 'trailer', 'content-encoding', 'content-length',
]);
// `cookie` is NOT stripped: scramjet keeps its own cookie jar per proxied site and
// sends it explicitly. `host` must go — undici sets it from the target URL.
const STRIP_FROM_CLIENT = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

const MAX_BODY_BYTES = 25 * 1024 * 1024;
// The RESPONSE cap. The request body has been capped since this shipped; the
// response was not, and it is the dangerous direction — the request body is
// bounded by what a logged-in client can be bothered to upload, whereas the
// response is whatever URL they name. `await upstream.arrayBuffer()` on a
// 4GB asset is an OOM of a 2GB Fly machine (fly.toml [[vm]] memory = "2gb")
// triggered by one POST, and the rate limiter allows 900 a minute.
//
// Same number as the request cap: this relay exists to fetch PAGES for the web
// browser panel, and 25MB is already generous for one.
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
// Wall-clock ceiling for one upstream fetch. Without it a slow-loris target
// holds a Node request, an undici connection and this handler's buffers open
// indefinitely — no timeout exists anywhere else on this path.
const UPSTREAM_TIMEOUT_MS = 30_000;

// Read a fetch Response with a hard byte ceiling, without ever materialising
// more than the ceiling. `arrayBuffer()` cannot do this: it commits to the whole
// body before returning, so by the time you could check a length you have
// already allocated it. Content-Length is checked first as a cheap early out,
// but it is client-controlled data from a foreign server and is NOT trusted as
// the enforcement point — the streaming tally below is.
async function readCapped(upstream, limit) {
 const declared = Number(upstream.headers.get('content-length') || 0);
 if (declared > limit) {
  const error = new Error(`upstream response too large (${declared} bytes)`);
  error.code = 'ERELAYTOOLARGE';
  throw error;
 }
 if (!upstream.body) return Buffer.alloc(0);
 const chunks = [];
 let total = 0;
 for await (const chunk of upstream.body) {
  total += chunk.length;
  if (total > limit) {
   // Stop pulling. Cancelling the body is what actually releases the socket
   // back to undici rather than leaving it draining in the background.
   await upstream.body.cancel().catch(() => { });
   const error = new Error('upstream response too large');
   error.code = 'ERELAYTOOLARGE';
   throw error;
  }
  chunks.push(Buffer.from(chunk));
 }
 return Buffer.concat(chunks, total);
}

function packHeaders(value) {
 return encodeURIComponent(JSON.stringify(value));
}

function unpackHeaders(raw) {
 if (!raw) return {};
 try {
  const parsed = JSON.parse(decodeURIComponent(raw));
  return parsed && typeof parsed === 'object' ? parsed : {};
 } catch {
  return {};
 }
}

/**
 * @param app               express app
 * @param requireAuth       the app's auth middleware — never mount this unauthenticated
 * @param rateLimiter       a createRateLimiter() instance. NOT express middleware:
 *                          limiters in this codebase are objects with .check(key),
 *                          applied through rateLimitBlocked. Passing one straight
 *                          into app.post throws "argument handler must be a
 *                          function" at mount time, which takes down createApp and
 *                          therefore the whole backend.
 * @param rateLimitBlocked  the shared limiter applier
 * @param clientIpFromReq   resolves the caller's IP behind the proxy
 */
function installBrowserProxy(app, { requireAuth, rateLimiter, rateLimitBlocked, clientIpFromReq }) {
 app.post('/backend/browser/fetch', requireAuth, async (req, res) => {
  // Without a limit this is an open relay that happens to require a login.
  if (rateLimitBlocked(res, rateLimiter, clientIpFromReq(req))) return;
  let url;
  try {
   url = await assertSafeBrowsingUrl(decodeURIComponent(req.get('x-relay-url') || ''));
  } catch (error) {
   res.set('x-relay-error', encodeURIComponent(error.message));
   return res.status(403).end();
  }

  const method = String(req.get('x-relay-method') || 'GET').toUpperCase();
  const incoming = unpackHeaders(req.get('x-relay-headers'));
  const headers = {};
  for (const [key, value] of Object.entries(incoming)) {
   if (STRIP_FROM_CLIENT.has(key.toLowerCase())) continue;
   headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  const chunks = [];
  let received = 0;
  try {
   for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
     res.set('x-relay-error', encodeURIComponent('request body too large'));
     return res.status(413).end();
    }
    chunks.push(chunk);
   }
  } catch {
   res.set('x-relay-error', encodeURIComponent('request body read failed'));
   return res.status(400).end();
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  // Cleared in `finally` — an abort timer that outlives its request is a leak on
  // a path that runs up to 900 times a minute.
  const abort = new AbortController();
  const abortTimer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  try {
   const upstream = await fetch(url.href, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    dispatcher: guardedFetchAgent(),
    signal: abort.signal,
    // The CALLER follows redirects: scramjet must see the 3xx so it can rewrite
    // Location into a proxied URL. Following here would also mean re-validating
    // every hop, and the guarded dispatcher only covers what we ask it to dial.
    redirect: 'manual',
   });

   const outHeaders = {};
   for (const [key, value] of upstream.headers) {
    if (STRIP_FROM_TARGET.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === 'set-cookie') {
     // The one header that legitimately repeats — collapsing it loses sessions.
     outHeaders[key] = typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [value];
     continue;
    }
    outHeaders[key] = value;
   }

   const buffer = await readCapped(upstream, MAX_RESPONSE_BYTES);
   res.set('x-relay-status', String(upstream.status));
   res.set('x-relay-statustext', encodeURIComponent(upstream.statusText || ''));
   res.set('x-relay-headers', packHeaders(outHeaders));
   res.set('content-length', String(buffer.length));
   return res.status(200).end(buffer);
  } catch (error) {
   const cause = error && error.cause;
   const blocked = cause && cause.code === 'ESSRFBLOCKED';
   if (error && error.code === 'ERELAYTOOLARGE') {
    res.set('x-relay-error', encodeURIComponent(error.message));
    return res.status(502).end();
   }
   // An abort here is OUR deadline firing, not the target refusing. Say so —
   // "The operation was aborted" in a relay error tells the caller nothing.
   if (error && error.name === 'AbortError') {
    res.set('x-relay-error', encodeURIComponent(`upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms`));
    return res.status(504).end();
   }
   const message = blocked
    ? `blocked at connect: ${cause.message}`
    : String((error && error.message) || error);
   res.set('x-relay-error', encodeURIComponent(message));
   return res.status(502).end();
  } finally {
   clearTimeout(abortTimer);
  }
 });
}

module.exports = {
 installBrowserProxy,
 // Test seam. The route itself cannot be driven from a test: assertSafeBrowsingUrl
 // blocks 127.0.0.0/8, so there is no upstream a test is allowed to point it at —
 // and adding an escape hatch to the SSRF guard to make a test convenient would
 // trade the thing that matters for the thing that is easy. The cap is the part
 // with logic in it, so the cap is what is exported.
 __test: { readCapped, MAX_RESPONSE_BYTES, UPSTREAM_TIMEOUT_MS },
};
