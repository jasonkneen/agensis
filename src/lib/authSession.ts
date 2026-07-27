// Pure auth-session decisions. No React, no DOM, no fetch — everything here is
// a function of its arguments so it can be unit-tested without a browser.
//
// Two questions live here, and they are the two the client used to answer
// wrongly:
//
//   1. "Is this thing in localStorage a session I should render the app with?"
//      The old client answered "yes, always" — it JSON.parsed the blob and
//      handed it back. Any stale or corrupt token rendered a fully logged-in
//      shell whose every request then 401'd.
//
//   2. "Does this 401 mean my session is dead, or just that this one request
//      failed?" The old client never asked at all.
//
// IMPORTANT — what the checks here can and cannot prove. The token is
// `${userId}.${tokenVersion}.${issuedAt}.${base64url(HMAC_SHA256(secret,payload))}`
// (see `issueAuthToken` in shared/backend-core.cjs). The browser does NOT have
// the signing secret and must never have it, so it CANNOT verify the signature.
// It can only check that the token is structurally well-formed and that
// `issuedAt` is inside the TTL. That catches expiry and corruption. It does
// NOT catch revocation (a bumped `token_version`) or a forged/wrong signature —
// those are only ever detectable by the server, which is why the 401 handling
// below exists as the second line of defence.

// Mirrors DEFAULT_TOKEN_TTL_SEC in shared/backend-core.cjs. The server can
// override its own TTL via AGENSIS_TOKEN_TTL_SEC, which the client cannot see;
// the mismatch is benign in both directions. A server TTL shorter than this
// means the client keeps a token the server rejects — the 401 path then cleans
// it up. A longer server TTL means the client discards a token that would still
// have worked, and the user signs in again.
//
// The expiry check uses the CLIENT clock, so a machine whose clock is more than
// 14 days fast will discard a freshly issued token. That is the one way this
// check can be wrong about a good session; the cost is a re-login, and the
// alternative (trusting storage unconditionally) is the bug being fixed.
export const AUTH_TOKEN_TTL_SEC = 14 * 24 * 60 * 60; // 14 days

export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';
export const SESSION_INVALID_MESSAGE = 'Your saved sign-in is no longer valid. Please sign in again.';

export type ParsedAuthToken = {
  userId: string;
  tokenVersion: string;
  issuedAtSec: number;
};

export type SessionValidity = 'valid' | 'missing' | 'malformed' | 'expired';

export type AuthResponseDecision = 'ignore' | 'end-session';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const DIGITS_RE = /^\d+$/;

/**
 * Structural parse of a session token. Returns null for anything that could not
 * have been produced by `issueAuthToken` — wrong shape, non-numeric fields, a
 * signature segment outside the base64url alphabet.
 *
 * A non-null result is NOT proof the token is authentic; see the file header.
 */
export function parseAuthToken(token: unknown): ParsedAuthToken | null {
  if (typeof token !== 'string') return null;
  // No trimming: a token with surrounding whitespace was corrupted in transit
  // or storage and would fail server-side anyway.
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [userId, tokenVersion, issuedAtStr, signature] = parts;
  if (!userId || !tokenVersion || !issuedAtStr || !signature) return null;
  // `token_version` is an integer column on app_users; `issuedAt` is unix seconds.
  if (!DIGITS_RE.test(tokenVersion)) return null;
  if (!DIGITS_RE.test(issuedAtStr)) return null;
  if (!BASE64URL_RE.test(signature)) return null;
  const issuedAtSec = Number(issuedAtStr);
  if (!Number.isSafeInteger(issuedAtSec)) return null;
  return { userId, tokenVersion, issuedAtSec };
}

/**
 * Classify whatever came out of localStorage. `'valid'` is the only answer that
 * justifies rendering a logged-in shell.
 */
export function sessionValidity(
  session: unknown,
  nowMs: number = Date.now(),
  ttlSec: number = AUTH_TOKEN_TTL_SEC,
): SessionValidity {
  if (session === null || session === undefined) return 'missing';
  if (typeof session !== 'object') return 'malformed';
  const candidate = session as { access_token?: unknown; user?: unknown };
  const user = candidate.user as { id?: unknown } | undefined;
  if (!user || typeof user !== 'object') return 'malformed';
  if (typeof user.id !== 'string' || !user.id) return 'malformed';
  const parsed = parseAuthToken(candidate.access_token);
  if (!parsed) return 'malformed';
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec - parsed.issuedAtSec > ttlSec) return 'expired';
  return 'valid';
}

/** Convenience predicate over {@link sessionValidity}. */
export function isUsableStoredSession(
  session: unknown,
  nowMs?: number,
  ttlSec?: number,
): boolean {
  return sessionValidity(session, nowMs, ttlSec) === 'valid';
}

/** The user-facing reason a stored session was thrown away. */
export function sessionDiscardMessage(validity: SessionValidity): string {
  return validity === 'expired' ? SESSION_EXPIRED_MESSAGE : SESSION_INVALID_MESSAGE;
}

/**
 * Reduce a URL or path to a bare, comparable backend path: no origin, no query,
 * no hash, no trailing slash. Deliberately regex-based rather than `new URL` so
 * it behaves identically with a relative path and an absolute one, with no
 * dependency on a base origin.
 */
export function normalizeBackendPath(input: unknown): string {
  if (typeof input !== 'string') return '';
  let path = input.trim();
  if (!path) return '';
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(path);
  if (scheme) {
    const afterScheme = path.slice(scheme[0].length);
    const slash = afterScheme.indexOf('/');
    path = slash === -1 ? '/' : afterScheme.slice(slash);
  }
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

export function isBackendPath(input: unknown): boolean {
  return normalizeBackendPath(input).startsWith('/backend/');
}

// Endpoints that MINT a session rather than consume one. A 401 from any of
// these means "wrong password" / "social login was not completed" — it says
// nothing about the token already in localStorage. Signing the user out here
// would destroy a perfectly good session because someone fat-fingered a
// password on a second account.
export const SESSION_ENTRY_PATHS: readonly string[] = [
  '/backend/auth/signin',
  '/backend/auth/signup',
  '/backend/auth/oauth',
];

export function isSessionEntryPath(input: unknown): boolean {
  const path = normalizeBackendPath(input);
  return SESSION_ENTRY_PATHS.includes(path);
}

/**
 * The single question every backend response is asked: does this kill the
 * session?
 *
 * `hasStoredSession` is what makes this idempotent under a burst of concurrent
 * 401s — the first one clears storage, and every later one in the same burst
 * sees nothing left to clear and answers `'ignore'`, so no redirect/sign-out
 * loop is possible.
 */
export function decideAuthResponse(input: {
  path: unknown;
  status: number;
  hadAuthHeader: boolean;
  hasStoredSession: boolean;
}): AuthResponseDecision {
  const { path, status, hadAuthHeader, hasStoredSession } = input;
  if (status !== 401) return 'ignore';
  if (!hasStoredSession) return 'ignore';
  // A request we sent unauthenticated getting a 401 tells us nothing about the
  // token we're holding.
  if (!hadAuthHeader) return 'ignore';
  if (!isBackendPath(path)) return 'ignore';
  if (isSessionEntryPath(path)) return 'ignore';
  return 'end-session';
}
