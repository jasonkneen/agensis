// Link preview cards — the client's pure half.
//
// URL extraction is MIRRORED from server/link-preview.cjs (extractLinkUrls,
// normalizeUnfurlUrl) rather than shared, because that file is CommonJS running
// on Node and this one is bundled for the browser. The duplication is safe by
// construction: the server re-validates every URL it is handed, so a drift
// between the two can only change WHICH cards appear, never what the server is
// willing to fetch. Anything this misses simply never gets a card; anything it
// wrongly passes is refused server-side.
//
// Nothing here fetches. The browser cannot unfurl a cross-origin page (CORS) and
// should not want to — a client-side unfurl hands every reader's IP to every host
// anybody links to. See useLinkPreviews for the request side.

export const LINK_PREVIEW_MAX_PER_MESSAGE = 2;
const MAX_URL_CHARS = 2048;

export type LinkPreviewStatus = 'ok' | 'empty' | 'failed' | 'blocked';

/** One cache row as the server hands it over. */
export interface LinkPreview {
  /** The URL as it was requested — this, never `finalUrl`, is what a card links to. */
  url: string;
  finalUrl: string;
  status: LinkPreviewStatus;
  /** UNTRUSTED: a stranger's page wrote this. Render as text, never as HTML. */
  title: string;
  /** UNTRUSTED, same as above. */
  description: string;
  /** UNTRUSTED, same as above. */
  siteName: string;
  /** A path on OUR origin, or ''. The remote image URL is never sent here. */
  imagePath: string;
  /** Our own vocabulary for why: 'timeout', 'http_404', 'blocked_address'. */
  detail: string;
  fetchedAt: string | null;
}

/** What a card is showing right now. `pending` has no row yet. */
export type LinkPreviewEntry =
  | { url: string; state: 'pending'; preview: null }
  | { url: string; state: 'ready'; preview: LinkPreview };

const CODE_FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
// `)` is deliberately INSIDE the class; trimUrlTail gives back the ones that do
// not balance, so `.../Foo_(bar)` and `(see https://example.com/a)` are both
// right. Excluding it would cut every Wikipedia-style URL at the opening paren.
const URL_RE = /https?:\/\/[^\s<>"'`\]}]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?'"”’\]}>]+$/;

const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home.arpa'];
const BLOCKED_HOST_NAMES = ['localhost'];

/**
 * The shape checks that need no DNS, mirroring the server's normalizeUnfurlUrl.
 * Returns the normalized URL, or '' when it must not be unfurled.
 *
 * The fragment is dropped so `#reply` and the bare URL share one cache entry;
 * query params are kept, because guessing which ones are tracking noise can
 * change the page.
 */
export function normalizeLinkUrl(rawUrl: string | null | undefined): string {
  const text = String(rawUrl ?? '').trim();
  if (!text || text.length > MAX_URL_CHARS) return '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return '';
  if (BLOCKED_HOST_NAMES.includes(host) || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return '';
  // Private/loopback/metadata literals. The server owns the authoritative range
  // table; this is the cheap subset that stops a card being queued for a request
  // that can only come back refused.
  if (isPrivateHostLiteral(host)) return '';
  url.hash = '';
  return url.toString();
}

function isPrivateHostLiteral(host: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  // Any IPv6 literal reaching here is a bare address in a chat message, which is
  // never a link worth unfurling — and ::1/fc00::/fe80:: must not slip through.
  if (host.includes(':')) return true;
  return false;
}

/**
 * Every distinct unfurlable URL in a message, in order, capped.
 *
 * URLs inside a code fence or an inline code span are excluded: those are being
 * shown, not shared, and a half-typed fence mid-stream should not flash a card.
 */
export function extractLinkUrls(text: string | null | undefined, max = LINK_PREVIEW_MAX_PER_MESSAGE): string[] {
  const limit = Math.max(0, Number(max) || 0);
  if (limit === 0) return [];
  const body = String(text ?? '').replace(CODE_FENCE_RE, ' ').replace(INLINE_CODE_RE, ' ');
  const found: string[] = [];
  const seen = new Set<string>();
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(body))) {
    const normalized = normalizeLinkUrl(trimUrlTail(match[0]));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    found.push(normalized);
    if (found.length >= limit) break;
  }
  return found;
}

// `(see https://example.com/a)` should not keep the sentence's `)`, but
// `.../Foo_(bar)` should keep its own. Mirrors trimUrlTail in
// server/link-preview.cjs.
function trimUrlTail(rawUrl: string): string {
  let value = rawUrl;
  for (;;) {
    const trimmed = value.replace(TRAILING_PUNCTUATION_RE, '');
    const withParens = trimmed.endsWith(')')
      && (trimmed.match(/\)/g) || []).length > (trimmed.match(/\(/g) || []).length
      ? trimmed.slice(0, -1)
      : trimmed;
    if (withParens === value) return value;
    value = withParens;
  }
}

/** `www.`-stripped hostname, for the one-line states and the card's eyebrow. */
export function linkHostLabel(rawUrl: string | null | undefined): string {
  try {
    return new URL(String(rawUrl ?? '')).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * The sentence a non-card state shows.
 *
 * Each one has to read as a decision rather than a bug, so they share a shape:
 * host, a separator, and a plain statement of what happened. Returns '' for a
 * preview that should be drawn as a card instead.
 */
export function linkPreviewStateLabel(entry: LinkPreviewEntry): string {
  const host = linkHostLabel(entry.url) || 'link';
  if (entry.state === 'pending') return `${host} · loading preview`;
  if (entry.preview.status === 'empty') return `${host} · no preview available`;
  if (entry.preview.status === 'failed' || entry.preview.status === 'blocked') {
    return `${host} · preview unavailable`;
  }
  return '';
}

/** Does this row have enough to draw the card, rather than a one-line state? */
export function hasCardContent(preview: LinkPreview | null): boolean {
  if (!preview || preview.status !== 'ok') return false;
  return Boolean(preview.title || preview.description || preview.imagePath);
}
