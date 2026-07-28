'use strict';

// ============================================================================
// server/link-preview.cjs — link preview cards: the fetch security boundary.
// ----------------------------------------------------------------------------
// NO DB, NO EXPRESS. Network only through an INJECTED `fetchImpl` and `lookup`,
// which is what makes the interesting half testable: the redirect chain, the
// byte cap and the post-redirect re-validation are all exercised in
// tests/link-preview.test.cjs with no live host and no DNS.
//
// Why the unfurl happens here at all, rather than in the browser:
//
//   1. CORS. A browser cannot read a cross-origin HTML document.
//   2. Privacy. A client-side unfurl means every reader's IP is handed to every
//      host anybody links to. One server-side fetch, cached, is one request per
//      URL for the whole install.
//
// Three things this module owns:
//
//   1. THE SSRF GATE. This server sits inside Fly's network with no egress
//      restrictions, so "fetch a URL a user typed" is a request-forgery
//      primitive unless every one of these holds:
//        - http/https only, no credentials in the URL, no split-horizon names;
//        - EVERY resolved address is public — one private answer among several
//          is a rebinding attempt, not a misconfiguration;
//        - the check is re-run at EVERY HOP. `redirect: 'manual'` plus an
//          explicit loop exists for exactly this: a public URL that 302s to
//          169.254.169.254 is the classic bypass, and `redirect: 'follow'`
//          would take it without asking us.
//
//   2. THE BUDGET. A link to a 2GB file must not hold a worker: one deadline
//      for the whole chain (redirects included), a hard byte cap enforced while
//      streaming (not from Content-Length, which a hostile server lies about),
//      a redirect cap, and a content-type allowlist.
//
//   3. THE UNTRUSTED-TEXT CLAMP. og:title and og:description are a stranger's
//      text. Everything leaving here has been stripped of control characters,
//      zero-width and bidi-override codepoints (visual spoofing), collapsed to
//      a single line and cut to a fixed length. The client then renders these
//      as React text children — never HTML, never as an href.
//
// LIMITS — what this does NOT catch:
//   * DNS rebinding inside the request. We re-resolve immediately before each
//     hop, but Node's fetch gives no hook to pin the resolved address for the
//     connection itself, so a hostname whose TTL expires in between can still
//     move. Closing that needs a custom dispatcher. Same known gap as
//     assertSafeOutboundUrl in server/index.cjs; every direct-address and
//     every redirect-to-private attack is blocked.
//   * A public host that is itself an open proxy. Out of scope for any URL
//     validator.
// ============================================================================

const crypto = require('node:crypto');
const net = require('node:net');
const dnsPromises = require('node:dns').promises;

// How many URLs one message may unfurl. Slack shows one or two; the cap is here
// because a message pasting forty links would otherwise be forty outbound
// fetches and forty cards.
const LINK_PREVIEW_MAX_PER_MESSAGE = 2;
// Ceiling on one batched request from the client (several messages' worth).
const LINK_PREVIEW_MAX_PER_REQUEST = 8;
// Response body cap, enforced while streaming.
const LINK_PREVIEW_MAX_BYTES = 512 * 1024;
// Only this much of the body is scanned for metadata. og tags belong in <head>.
const LINK_PREVIEW_MAX_PARSE_CHARS = 256 * 1024;
// One deadline for the whole chain, redirects included.
const LINK_PREVIEW_TIMEOUT_MS = 6_000;
const LINK_PREVIEW_MAX_REDIRECTS = 4;
const LINK_PREVIEW_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const LINK_PREVIEW_IMAGE_TIMEOUT_MS = 8_000;
const LINK_PREVIEW_MAX_URL_CHARS = 2_048;
const LINK_PREVIEW_MAX_TITLE_CHARS = 200;
const LINK_PREVIEW_MAX_DESCRIPTION_CHARS = 400;
const LINK_PREVIEW_MAX_SITE_CHARS = 80;
// A successful unfurl is cached for a week; a failure for an hour, so a host
// that was down for a minute is not un-previewable until next Tuesday.
const LINK_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_PREVIEW_FAILURE_TTL_MS = 60 * 60 * 1000;

// Identify honestly. A bot string that lies about being a browser is how you
// end up in someone's abuse report, and several sites serve better OG tags to a
// declared crawler than to a fake Chrome.
const LINK_PREVIEW_USER_AGENT = 'agensis-linkpreview/1.0 (+https://agensis.io)';

const LINK_PREVIEW_STATUSES = ['ok', 'empty', 'failed', 'blocked'];

// Same table as assertSafeOutboundUrl's in server/index.cjs. Kept as a literal
// here rather than imported so this module stays standalone and testable with
// no server bootstrap; tests/link-preview.test.cjs asserts the two agree, so a
// range added to one and not the other fails the suite.
const BLOCKED_IPV4_RANGES = [
 ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
 ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
 ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

// Hostname suffixes that are split-horizon by convention: they can resolve to
// something else on the server than they do anywhere we could check. Refused by
// name, before DNS is consulted at all.
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home.arpa'];
const BLOCKED_HOST_NAMES = ['localhost'];

function ipv4ToInt(address) {
 return address.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

/**
 * Is this resolved address one we refuse to connect to?
 *
 * Unparseable input returns TRUE. "I could not tell what this is" and "this is
 * safe" must not be the same answer.
 */
function isBlockedAddress(address) {
 const value = String(address == null ? '' : address).trim();
 if (net.isIPv4(value)) {
  const asInt = ipv4ToInt(value);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
   const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
   return (asInt & mask) === (ipv4ToInt(base) & mask);
  });
 }
 if (!net.isIPv6(value)) return true; // unparseable — refuse rather than guess
 const lower = value.toLowerCase();
 // IPv4-mapped (::ffff:a.b.c.d) must be judged on the embedded v4 address, or
 // ::ffff:169.254.169.254 walks straight through the v6 branch.
 const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
 if (mapped) return isBlockedAddress(mapped[1]);
 if (lower === '::' || lower === '::1') return true;
 if (/^f[cd]/.test(lower)) return true;    // fc00::/7 unique-local
 if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
 if (lower.startsWith('ff')) return true;  // ff00::/8 multicast
 return false;
}

/**
 * Scheme/shape validation with no DNS. Returns
 * `{ ok, reason, url, host }` — never throws, because a bad URL in a chat
 * message is ordinary data, not an exception.
 *
 * The fragment is dropped: it never reaches the server, so keeping it would
 * only split the cache between two spellings of one page. This is what makes
 * `?s=20`-style tracking params the ONLY remaining noise, and those are kept —
 * stripping query params guesses at which ones matter and can change the page.
 */
function normalizeUnfurlUrl(rawUrl) {
 const text = String(rawUrl == null ? '' : rawUrl).trim();
 if (!text) return { ok: false, reason: 'empty', url: '', host: '' };
 if (text.length > LINK_PREVIEW_MAX_URL_CHARS) {
  return { ok: false, reason: 'url_too_long', url: '', host: '' };
 }
 let url;
 try { url = new URL(text); } catch { return { ok: false, reason: 'not_a_url', url: '', host: '' }; }
 if (url.protocol !== 'http:' && url.protocol !== 'https:') {
  return { ok: false, reason: 'scheme_not_allowed', url: '', host: '' };
 }
 // `https://user:pass@internal-host/` both leaks a credential to whoever we
 // resolve to and is a known way to confuse URL parsers about the real host.
 if (url.username || url.password) {
  return { ok: false, reason: 'credentials_in_url', url: '', host: '' };
 }
 const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
 if (!host) return { ok: false, reason: 'no_host', url: '', host: '' };
 if (BLOCKED_HOST_NAMES.includes(host) || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
  return { ok: false, reason: 'private_host', url: '', host: '' };
 }
 // An address LITERAL needs no DNS to judge, so judge it here rather than one
 // layer down. Doing it in the shape check means the client-side extractor and
 // the og:image resolver — neither of which resolves anything — refuse
 // http://169.254.169.254/ too, instead of queuing a card that can only fail.
 if (net.isIP(host) && isBlockedAddress(host)) {
  return { ok: false, reason: 'blocked_address', url: '', host };
 }
 url.hash = '';
 return { ok: true, reason: '', url: url.toString(), host };
}

/**
 * Shape validation PLUS resolution. Returns `{ ok, reason, url, host,
 * addresses }`. Called once per hop, which is the entire point of the manual
 * redirect loop below.
 */
async function resolveUnfurlTarget(rawUrl, { lookup } = {}) {
 const normalized = normalizeUnfurlUrl(rawUrl);
 if (!normalized.ok) return { ...normalized, addresses: [] };
 const resolver = typeof lookup === 'function' ? lookup : defaultLookup;
 let addresses;
 if (net.isIP(normalized.host)) {
  addresses = [normalized.host];
 } else {
  try {
   addresses = await resolver(normalized.host);
  } catch {
   return { ok: false, reason: 'dns_failed', url: '', host: normalized.host, addresses: [] };
  }
 }
 const list = (Array.isArray(addresses) ? addresses : [])
  .map(entry => String(typeof entry === 'string' ? entry : entry?.address || '').trim())
  .filter(Boolean);
 if (!list.length) {
  return { ok: false, reason: 'dns_failed', url: '', host: normalized.host, addresses: [] };
 }
 // ALL of them. A host answering with one public and one private address is a
 // rebinding attempt; picking the public one and proceeding is the bug.
 if (list.some(isBlockedAddress)) {
  return { ok: false, reason: 'blocked_address', url: '', host: normalized.host, addresses: list };
 }
 return { ok: true, reason: '', url: normalized.url, host: normalized.host, addresses: list };
}

async function defaultLookup(host) {
 const entries = await dnsPromises.lookup(host, { all: true, verbatim: true });
 return entries.map(entry => entry.address);
}

/** Stable cache key: sha256 of the normalized URL. */
function linkPreviewCacheKey(url) {
 return crypto.createHash('sha256').update(String(url == null ? '' : url)).digest('hex');
}

/**
 * Clamp a string that came off someone else's web page.
 *
 * Control characters, zero-width joiners/spaces and the bidi overrides are all
 * removed: they carry no meaning in a one-line card title and they are the
 * standard tools for making text render as something other than what it says.
 * Newlines collapse to spaces — a card title is one line by construction, so a
 * title with forty newlines cannot push the message below it off the screen.
 */
// Both classes are written as \u escapes, never literal bytes: a literal C0 or
// zero-width character in source is invisible in a diff and in review, which is
// exactly the property that makes it worth stripping from a card in the first
// place.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]+/g;
// Zero-width space/joiner, the LTR/RTL marks, the bidi embeddings and overrides,
// the line/paragraph separators, the invisible maths operators and the BOM. None
// of them mean anything in a one-line card title; all of them are standard tools
// for making text render as something other than what it says.
const INVISIBLE_CHARS_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g;

function clampPreviewText(value, max) {
 return String(value == null ? '' : value)
  .replace(CONTROL_CHARS_RE, ' ')
  .replace(INVISIBLE_CHARS_RE, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, Math.max(0, Number(max) || 0));
}

const HTML_ENTITIES = {
 amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#039': "'",
};

function decodeHtmlEntities(value) {
 return String(value == null ? '' : value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
  const key = entity.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key)) return HTML_ENTITIES[key];
  if (key.startsWith('#x')) {
   const code = Number.parseInt(key.slice(2), 16);
   return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : match;
  }
  if (key.startsWith('#')) {
   const code = Number.parseInt(key.slice(1), 10);
   return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : match;
  }
  return match;
 });
}

function safeFromCodePoint(code) {
 try { return String.fromCodePoint(code); } catch { return ''; }
}

const HTML_ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

function parseTagAttributes(tag) {
 const attributes = Object.create(null);
 HTML_ATTRIBUTE_RE.lastIndex = 0;
 let match;
 while ((match = HTML_ATTRIBUTE_RE.exec(tag))) {
  const name = match[1].toLowerCase();
  const value = match[2] ?? match[3] ?? match[4] ?? '';
  if (!(name in attributes)) attributes[name] = value;
 }
 return attributes;
}

/**
 * Pull OpenGraph / Twitter-card / plain-HTML metadata out of a document.
 *
 * Deliberately generic: there is no x.com branch, no per-site API, no oEmbed
 * round trip. Every site is read the same way, so a site that publishes correct
 * tags works on the first try and a site that publishes none degrades to the
 * same honest "no metadata" state as any other.
 *
 * Precedence per field is og: -> twitter: -> the plain HTML equivalent, which
 * is the de-facto order every other unfurler uses.
 */
function parseHtmlMetadata(html, finalUrl = '') {
 const source = String(html == null ? '' : html).slice(0, LINK_PREVIEW_MAX_PARSE_CHARS)
  // Script and comment bodies can contain <meta …> as a string; scanning them
  // would let a page's own JavaScript source decide the card.
  .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ');

 const meta = new Map();
 for (const tag of source.match(/<meta\b[^>]*>/gi) || []) {
  const attributes = parseTagAttributes(tag);
  const key = String(attributes.property || attributes.name || attributes.itemprop || '').trim().toLowerCase();
  if (!key || attributes.content === undefined) continue;
  // First occurrence wins, matching how browsers and other unfurlers read a
  // duplicated og:title.
  if (!meta.has(key)) meta.set(key, decodeHtmlEntities(attributes.content));
 }

 const titleTag = source.match(/<title\b[^>]*>([\s\S]{0,4000}?)<\/title\s*>/i);
 const documentTitle = titleTag ? decodeHtmlEntities(titleTag[1]) : '';

 const pick = (...keys) => {
  for (const key of keys) {
   const value = meta.get(key);
   if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
 };

 const title = clampPreviewText(
  pick('og:title', 'twitter:title') || documentTitle,
  LINK_PREVIEW_MAX_TITLE_CHARS,
 );
 const description = clampPreviewText(
  pick('og:description', 'twitter:description', 'description'),
  LINK_PREVIEW_MAX_DESCRIPTION_CHARS,
 );
 const siteName = clampPreviewText(
  pick('og:site_name', 'application-name') || hostLabel(finalUrl),
  LINK_PREVIEW_MAX_SITE_CHARS,
 );
 const imageUrl = resolvePreviewImageUrl(
  pick('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'),
  finalUrl,
 );

 return { title, description, siteName, imageUrl };
}

/** `www.` stripped hostname, the fallback when a page names no site. */
function hostLabel(rawUrl) {
 try {
  return new URL(String(rawUrl || '')).hostname.replace(/^www\./i, '');
 } catch {
  return '';
 }
}

/**
 * Resolve an og:image against the page it came from, and refuse anything that
 * is not an ordinary http(s) URL — `javascript:` and `data:` have no business
 * being handed back as an image source even though the proxy would re-check.
 * Two gates on the same value is the point.
 */
function resolvePreviewImageUrl(rawValue, finalUrl) {
 const value = String(rawValue == null ? '' : rawValue).trim();
 if (!value) return '';
 let absolute;
 try {
  absolute = finalUrl ? new URL(value, finalUrl).toString() : new URL(value).toString();
 } catch {
  return '';
 }
 const normalized = normalizeUnfurlUrl(absolute);
 return normalized.ok ? normalized.url : '';
}

// ---------------------------------------------------------------------------
// URL extraction from message text
// ---------------------------------------------------------------------------

// Bare URLs and markdown link targets both count — a link is a link. What does
// NOT count is a URL inside code, which is being shown, not shared.
const CODE_FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
// `)` is deliberately INSIDE the character class. Excluding it is the obvious
// choice and it quietly breaks every Wikipedia-style URL —
// .../wiki/Sonic_(hedgehog) would be cut at the opening paren. Instead the match
// runs long and trimUrlTail gives back the parens that do not balance, which is
// how `(see https://example.com/a)` and `.../Foo_(bar)` can both be right.
const URL_RE = /https?:\/\/[^\s<>"'`\]}]+/gi;
// Trailing punctuation that is almost always the sentence's, not the URL's.
// Note the absence of `)` — it is handled separately, by counting.
const TRAILING_PUNCTUATION_RE = /[.,;:!?'"”’\]}>]+$/;

/**
 * Every distinct http(s) URL in a message, in order, capped.
 *
 * Runs on the CLIENT (mirrored in src/lib/linkPreview.ts) to decide what to ask
 * for, and the server re-validates every URL it is given — so a mismatch
 * between the two extractors changes which cards appear and can never widen
 * what the server is willing to fetch.
 */
function extractLinkUrls(text, max = LINK_PREVIEW_MAX_PER_MESSAGE) {
 const body = String(text == null ? '' : text)
  .replace(CODE_FENCE_RE, ' ')
  .replace(INLINE_CODE_RE, ' ');
 const limit = Math.max(0, Number(max) || 0);
 if (limit === 0) return [];
 const found = [];
 const seen = new Set();
 URL_RE.lastIndex = 0;
 let match;
 while ((match = URL_RE.exec(body))) {
  const candidate = trimUrlTail(match[0]);
  const normalized = normalizeUnfurlUrl(candidate);
  if (!normalized.ok) continue;
  if (seen.has(normalized.url)) continue;
  seen.add(normalized.url);
  found.push(normalized.url);
  if (found.length >= limit) break;
 }
 return found;
}

// `(see https://example.com/a)` should not end up with a `)` on the URL, but
// `https://en.wikipedia.org/wiki/Foo_(bar)` should keep its balanced pair.
function trimUrlTail(rawUrl) {
 let value = String(rawUrl || '');
 for (;;) {
  const trimmed = value.replace(TRAILING_PUNCTUATION_RE, '');
  // A trailing `)` belongs to the URL only if an unclosed `(` is waiting for it.
  // `.../Foo_(bar)` keeps its pair; `(see .../a)` gives the paren back to the
  // sentence. Looped with the punctuation strip so `.../a).` unwinds both.
  const withParens = trimmed.endsWith(')')
    && (trimmed.match(/\)/g) || []).length > (trimmed.match(/\(/g) || []).length
   ? trimmed.slice(0, -1)
   : trimmed;
  if (withParens === value) return value;
  value = withParens;
 }
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

function isRedirectStatus(status) {
 return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function headerValue(response, name) {
 const headers = response?.headers;
 if (!headers) return '';
 if (typeof headers.get === 'function') return String(headers.get(name) ?? '');
 const direct = headers[name] ?? headers[String(name).toLowerCase()];
 return direct == null ? '' : String(direct);
}

/**
 * Read at most `maxBytes` and then STOP, cancelling the stream.
 *
 * Content-Length is not trusted for this — it is a claim by the server we are
 * defending against. It is still checked first as a cheap early exit for the
 * honest case.
 */
async function readCappedBody(response, maxBytes) {
 const body = response?.body;
 if (!body) {
  if (typeof response?.arrayBuffer === 'function') {
   const buffer = Buffer.from(await response.arrayBuffer());
   return { bytes: buffer.subarray(0, maxBytes), truncated: buffer.length > maxBytes };
  }
  return { bytes: Buffer.alloc(0), truncated: false };
 }
 if (typeof body.getReader !== 'function') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return { bytes: buffer.subarray(0, maxBytes), truncated: buffer.length > maxBytes };
 }
 const reader = body.getReader();
 const chunks = [];
 let total = 0;
 let truncated = false;
 try {
  for (;;) {
   const { done, value } = await reader.read();
   if (done) break;
   if (!value || !value.byteLength) continue;
   const chunk = Buffer.from(value.buffer ? value : Buffer.from(value));
   if (total + chunk.length > maxBytes) {
    chunks.push(chunk.subarray(0, Math.max(0, maxBytes - total)));
    total = maxBytes;
    truncated = true;
    break;
   }
   chunks.push(chunk);
   total += chunk.length;
  }
 } finally {
  // Cancel rather than let it drain: this is the half of the byte cap that
  // actually stops the transfer.
  try { await reader.cancel(); } catch { /* already closed */ }
 }
 return { bytes: Buffer.concat(chunks, total), truncated };
}

function decodeHtmlBody(bytes, contentType) {
 const charsetMatch = /charset\s*=\s*"?([a-zA-Z0-9_:.-]+)"?/i.exec(String(contentType || ''));
 const charset = (charsetMatch?.[1] || 'utf-8').toLowerCase();
 try {
  return new TextDecoder(charset, { fatal: false }).decode(bytes);
 } catch {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
 }
}

/**
 * Walk the redirect chain by hand, re-validating the target at every hop, and
 * hand back the final response.
 *
 * `redirect: 'manual'` is load-bearing. With `follow`, undici would chase a 302
 * into 169.254.169.254 before this module ever saw the Location header.
 *
 * Returns `{ ok, reason, response, url }`.
 */
async function followToFinalResponse(rawUrl, {
 lookup,
 fetchImpl,
 maxRedirects = LINK_PREVIEW_MAX_REDIRECTS,
 signal,
 accept,
} = {}) {
 const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
 if (typeof doFetch !== 'function') return { ok: false, reason: 'no_fetch', response: null, url: '' };
 let current = rawUrl;
 for (let hop = 0; hop <= maxRedirects; hop += 1) {
  const target = await resolveUnfurlTarget(current, { lookup });
  if (!target.ok) return { ok: false, reason: target.reason, response: null, url: '' };
  let response;
  try {
   response = await doFetch(target.url, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: {
     accept: accept || 'text/html,application/xhtml+xml',
     'accept-language': 'en',
     'user-agent': LINK_PREVIEW_USER_AGENT,
    },
   });
  } catch (error) {
   const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
   return { ok: false, reason: aborted ? 'timeout' : 'network_error', response: null, url: '' };
  }
  const status = Number(response?.status) || 0;
  if (!isRedirectStatus(status)) {
   return { ok: true, reason: '', response, url: target.url };
  }
  const location = headerValue(response, 'location');
  if (!location) return { ok: false, reason: 'redirect_without_location', response: null, url: '' };
  try {
   current = new URL(location, target.url).toString();
  } catch {
   return { ok: false, reason: 'bad_redirect_location', response: null, url: '' };
  }
 }
 return { ok: false, reason: 'too_many_redirects', response: null, url: '' };
}

// One AbortController for the whole operation, so the deadline covers the
// redirect chain and the body read together rather than resetting per hop.
function createDeadline(timeoutMs) {
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 0));
 timer.unref?.();
 return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Unfurl one URL. NEVER THROWS — a failure is a row, not an exception, because
 * "we tried and this is what happened" is what the card has to show.
 *
 * status: 'ok'      metadata found
 *         'empty'   fetched fine, the page publishes nothing to show
 *         'blocked' refused before or during the request (SSRF gate, bad type)
 *         'failed'  network, timeout, or an HTTP error status
 */
async function fetchLinkPreview(rawUrl, {
 lookup,
 fetchImpl,
 maxBytes = LINK_PREVIEW_MAX_BYTES,
 maxRedirects = LINK_PREVIEW_MAX_REDIRECTS,
 timeoutMs = LINK_PREVIEW_TIMEOUT_MS,
} = {}) {
 const normalized = normalizeUnfurlUrl(rawUrl);
 const requested = normalized.ok ? normalized.url : String(rawUrl == null ? '' : rawUrl).slice(0, LINK_PREVIEW_MAX_URL_CHARS);
 const base = { url: requested, finalUrl: '', title: '', description: '', siteName: '', imageUrl: '' };
 if (!normalized.ok) return { ...base, status: 'blocked', detail: normalized.reason };

 const deadline = createDeadline(timeoutMs);
 try {
  const walked = await followToFinalResponse(normalized.url, {
   lookup, fetchImpl, maxRedirects, signal: deadline.signal,
  });
  if (!walked.ok) {
   const blockedReasons = ['blocked_address', 'private_host', 'scheme_not_allowed', 'credentials_in_url', 'too_many_redirects'];
   return {
    ...base,
    status: blockedReasons.includes(walked.reason) ? 'blocked' : 'failed',
    detail: walked.reason,
   };
  }
  const response = walked.response;
  const status = Number(response?.status) || 0;
  if (status < 200 || status >= 300) {
   return { ...base, finalUrl: walked.url, status: 'failed', detail: `http_${status}` };
  }
  const contentType = headerValue(response, 'content-type');
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  if (mediaType && mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') {
   return { ...base, finalUrl: walked.url, status: 'blocked', detail: `content_type_${mediaType.slice(0, 60)}` };
  }
  const declaredLength = Number(headerValue(response, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
   return { ...base, finalUrl: walked.url, status: 'blocked', detail: 'too_large' };
  }
  let body;
  try {
   body = await readCappedBody(response, maxBytes);
  } catch (error) {
   const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
   return { ...base, finalUrl: walked.url, status: 'failed', detail: aborted ? 'timeout' : 'body_read_error' };
  }
  const html = decodeHtmlBody(body.bytes, contentType);
  const meta = parseHtmlMetadata(html, walked.url);
  const hasSomething = Boolean(meta.title || meta.description || meta.imageUrl);
  return {
   url: requested,
   finalUrl: walked.url,
   status: hasSomething ? 'ok' : 'empty',
   detail: body.truncated ? 'truncated' : '',
   ...meta,
  };
 } finally {
  deadline.clear();
 }
}

/**
 * Fetch one preview image's bytes for the proxy route.
 *
 * The proxy is a second SSRF surface and gets the same gate: same shape checks,
 * same all-addresses-public rule, same per-hop re-validation, plus an image-only
 * content-type allowlist and its own byte cap. What keeps it small is the CALLER
 * — the route never accepts a URL from the client, only the id of an
 * already-unfurled row, so the set of reachable URLs is exactly the set this
 * module already validated once.
 *
 * Returns `{ ok, reason, contentType, bytes }`. Never throws.
 */
async function fetchPreviewImage(rawUrl, {
 lookup,
 fetchImpl,
 maxBytes = LINK_PREVIEW_IMAGE_MAX_BYTES,
 maxRedirects = LINK_PREVIEW_MAX_REDIRECTS,
 timeoutMs = LINK_PREVIEW_IMAGE_TIMEOUT_MS,
} = {}) {
 const empty = { contentType: '', bytes: Buffer.alloc(0) };
 const normalized = normalizeUnfurlUrl(rawUrl);
 if (!normalized.ok) return { ok: false, reason: normalized.reason, ...empty };
 const deadline = createDeadline(timeoutMs);
 try {
  const walked = await followToFinalResponse(normalized.url, {
   lookup, fetchImpl, maxRedirects, signal: deadline.signal, accept: 'image/*',
  });
  if (!walked.ok) return { ok: false, reason: walked.reason, ...empty };
  const status = Number(walked.response?.status) || 0;
  if (status < 200 || status >= 300) return { ok: false, reason: `http_${status}`, ...empty };
  const contentType = headerValue(walked.response, 'content-type');
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  // SVG is an image that executes script when navigated to directly. It is not
  // worth the caveat for a 40x40 thumbnail.
  if (!/^image\/(png|jpeg|jpg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(mediaType)) {
   return { ok: false, reason: `content_type_${mediaType.slice(0, 60) || 'missing'}`, ...empty };
  }
  const declaredLength = Number(headerValue(walked.response, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
   return { ok: false, reason: 'too_large', ...empty };
  }
  let body;
  try {
   body = await readCappedBody(walked.response, maxBytes);
  } catch (error) {
   const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
   return { ok: false, reason: aborted ? 'timeout' : 'body_read_error', ...empty };
  }
  // A truncated image is a broken image; do not serve half of one.
  if (body.truncated) return { ok: false, reason: 'too_large', ...empty };
  if (!body.bytes.length) return { ok: false, reason: 'empty_body', ...empty };
  return { ok: true, reason: '', contentType: mediaType, bytes: body.bytes };
 } finally {
  deadline.clear();
 }
}

/** How long a result of this status stays cached. */
function linkPreviewTtlMs(status) {
 return status === 'ok' || status === 'empty' ? LINK_PREVIEW_TTL_MS : LINK_PREVIEW_FAILURE_TTL_MS;
}

module.exports = {
 BLOCKED_IPV4_RANGES,
 BLOCKED_HOST_NAMES,
 BLOCKED_HOST_SUFFIXES,
 LINK_PREVIEW_FAILURE_TTL_MS,
 LINK_PREVIEW_IMAGE_MAX_BYTES,
 LINK_PREVIEW_IMAGE_TIMEOUT_MS,
 LINK_PREVIEW_MAX_BYTES,
 LINK_PREVIEW_MAX_DESCRIPTION_CHARS,
 LINK_PREVIEW_MAX_PARSE_CHARS,
 LINK_PREVIEW_MAX_PER_MESSAGE,
 LINK_PREVIEW_MAX_PER_REQUEST,
 LINK_PREVIEW_MAX_REDIRECTS,
 LINK_PREVIEW_MAX_SITE_CHARS,
 LINK_PREVIEW_MAX_TITLE_CHARS,
 LINK_PREVIEW_MAX_URL_CHARS,
 LINK_PREVIEW_STATUSES,
 LINK_PREVIEW_TIMEOUT_MS,
 LINK_PREVIEW_TTL_MS,
 LINK_PREVIEW_USER_AGENT,
 clampPreviewText,
 decodeHtmlEntities,
 extractLinkUrls,
 fetchLinkPreview,
 fetchPreviewImage,
 isBlockedAddress,
 linkPreviewCacheKey,
 linkPreviewTtlMs,
 normalizeUnfurlUrl,
 parseHtmlMetadata,
 resolvePreviewImageUrl,
 resolveUnfurlTarget,
};
