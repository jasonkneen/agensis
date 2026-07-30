import { describe, expect, it } from 'vitest';
import {
  AUTH_TOKEN_TTL_SEC,
  decideAuthResponse,
  isBackendPath,
  isSessionEntryPath,
  isUsableStoredSession,
  normalizeBackendPath,
  parseAuthToken,
  SESSION_EXPIRED_MESSAGE,
  SESSION_INVALID_MESSAGE,
  sessionDiscardMessage,
  sessionValidity,
} from '../../src/lib/authSession';

// The client-side auth decisions, without a browser.
//
// Both of these used to be answered wrongly and SILENTLY. `getSession()`
// returned whatever was in localStorage with zero validation, so a stale token
// rendered a fully logged-in workspace where every request 401'd; and nothing
// anywhere handled a 401, so the app just sat there dropping actions.
//
// The cases that matter most here are the REFUSALS: a 401 on a sign-in attempt
// must not sign the user out (that's a wrong password, not an expired session),
// and a second 401 from a burst must not re-fire the sign-out.

const NOW_MS = Date.parse('2026-07-25T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW_MS / 1000);
const USER_ID = '3f0b1a4e-5c2d-4a91-9f37-2c1de4b8a0f5';
// 43-char base64url, the shape of a real HMAC-SHA256 digest.
const SIG = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123x';

function token(issuedAtSec: number, overrides: { userId?: string; version?: string; sig?: string } = {}) {
  const { userId = USER_ID, version = '1', sig = SIG } = overrides;
  return `${userId}.${version}.${issuedAtSec}.${sig}`;
}

function session(accessToken: unknown, userId: string = USER_ID) {
  return { access_token: accessToken, user: { id: userId, email: 'a@b.co' } };
}

describe('parseAuthToken', () => {
  it('parses a well-formed token into its three signed fields', () => {
    expect(parseAuthToken(token(NOW_SEC, { version: '7' }))).toEqual({
      userId: USER_ID,
      tokenVersion: '7',
      issuedAtSec: NOW_SEC,
    });
  });

  it('rejects the empty string', () => {
    expect(parseAuthToken('')).toBeNull();
  });

  it('rejects a token with the wrong number of segments', () => {
    // Legacy 2-part payload + signature (3 segments) — the server stopped
    // verifying these too.
    expect(parseAuthToken(`${USER_ID}.1.${SIG}`)).toBeNull();
    // One segment too many.
    expect(parseAuthToken(`${USER_ID}.1.${NOW_SEC}.${SIG}.extra`)).toBeNull();
    // No separators at all.
    expect(parseAuthToken('not-a-token')).toBeNull();
  });

  it('rejects malformed field contents', () => {
    expect(parseAuthToken(token(NOW_SEC, { version: 'v1' }))).toBeNull();
    expect(parseAuthToken(`${USER_ID}.1.not-a-number.${SIG}`)).toBeNull();
    expect(parseAuthToken(`${USER_ID}.1.${NOW_SEC}.sig with spaces`)).toBeNull();
    expect(parseAuthToken(`.1.${NOW_SEC}.${SIG}`)).toBeNull();
  });

  it('rejects non-strings, including the undefined an absent token produces', () => {
    expect(parseAuthToken(undefined)).toBeNull();
    expect(parseAuthToken(null)).toBeNull();
    expect(parseAuthToken(12345)).toBeNull();
    expect(parseAuthToken({ access_token: token(NOW_SEC) })).toBeNull();
  });
});

describe('sessionValidity', () => {
  it('accepts a well-formed, freshly issued session', () => {
    expect(sessionValidity(session(token(NOW_SEC)), NOW_MS)).toBe('valid');
    expect(isUsableStoredSession(session(token(NOW_SEC)), NOW_MS)).toBe(true);
  });

  it('accepts a token one second inside the TTL and rejects one second past it', () => {
    const justInside = NOW_SEC - AUTH_TOKEN_TTL_SEC;
    const justOutside = NOW_SEC - AUTH_TOKEN_TTL_SEC - 1;
    expect(sessionValidity(session(token(justInside)), NOW_MS)).toBe('valid');
    expect(sessionValidity(session(token(justOutside)), NOW_MS)).toBe('expired');
  });

  it('reports an old token as expired, not merely malformed', () => {
    const old = NOW_SEC - 30 * 24 * 60 * 60; // 30 days
    expect(sessionValidity(session(token(old)), NOW_MS)).toBe('expired');
    expect(isUsableStoredSession(session(token(old)), NOW_MS)).toBe(false);
  });

  it('rejects a session whose token is malformed or empty', () => {
    expect(sessionValidity(session('garbage'), NOW_MS)).toBe('malformed');
    expect(sessionValidity(session(''), NOW_MS)).toBe('malformed');
    expect(sessionValidity(session(`${USER_ID}.1.${SIG}`), NOW_MS)).toBe('malformed');
  });

  it('rejects the exact shape the OAuth token bug produced: a user and no token', () => {
    // `access_token: payload.data.token` where the response carried no token.
    expect(sessionValidity(session(undefined), NOW_MS)).toBe('malformed');
    expect(isUsableStoredSession(session(undefined), NOW_MS)).toBe(false);
  });

  it('rejects a session with no usable user', () => {
    expect(sessionValidity({ access_token: token(NOW_SEC) }, NOW_MS)).toBe('malformed');
    expect(sessionValidity({ access_token: token(NOW_SEC), user: { id: '' } }, NOW_MS)).toBe('malformed');
    expect(sessionValidity({ access_token: token(NOW_SEC), user: null }, NOW_MS)).toBe('malformed');
  });

  it('distinguishes "nothing stored" from "stored something broken"', () => {
    expect(sessionValidity(null, NOW_MS)).toBe('missing');
    expect(sessionValidity(undefined, NOW_MS)).toBe('missing');
    expect(sessionValidity('a string', NOW_MS)).toBe('malformed');
  });

  it('honours a caller-supplied TTL', () => {
    const oneHourOld = NOW_SEC - 3600;
    expect(sessionValidity(session(token(oneHourOld)), NOW_MS, 60)).toBe('expired');
    expect(sessionValidity(session(token(oneHourOld)), NOW_MS, 7200)).toBe('valid');
  });
});

describe('sessionDiscardMessage', () => {
  it('says "expired" only when it actually expired', () => {
    expect(sessionDiscardMessage('expired')).toBe(SESSION_EXPIRED_MESSAGE);
    expect(sessionDiscardMessage('malformed')).toBe(SESSION_INVALID_MESSAGE);
    expect(sessionDiscardMessage('missing')).toBe(SESSION_INVALID_MESSAGE);
  });
});

describe('normalizeBackendPath', () => {
  it('reduces absolute URLs, query strings and trailing slashes to a bare path', () => {
    expect(normalizeBackendPath('https://agensis-backend.fly.dev/backend/db/select')).toBe('/backend/db/select');
    expect(normalizeBackendPath('/backend/auth/signin?next=%2F')).toBe('/backend/auth/signin');
    expect(normalizeBackendPath('/backend/auth/signin/')).toBe('/backend/auth/signin');
    expect(normalizeBackendPath('http://127.0.0.1:3142/backend/workspaces#frag')).toBe('/backend/workspaces');
    expect(normalizeBackendPath('https://agensis-backend.fly.dev')).toBe('/');
  });

  it('returns an empty path for non-strings', () => {
    expect(normalizeBackendPath(undefined)).toBe('');
    expect(normalizeBackendPath(null)).toBe('');
    expect(normalizeBackendPath(new URL('https://x.test/backend/y') as unknown)).toBe('');
  });

  it('identifies backend paths', () => {
    expect(isBackendPath('https://agensis-backend.fly.dev/backend/db/select')).toBe(true);
    expect(isBackendPath('/backend/ai-chat')).toBe(true);
    expect(isBackendPath('/assets/index-abc.js')).toBe(false);
    expect(isBackendPath('https://api.stripe.com/v1/charges')).toBe(false);
  });

  it('identifies the endpoints that mint a session', () => {
    expect(isSessionEntryPath('/backend/auth/signin')).toBe(true);
    expect(isSessionEntryPath('/backend/auth/signup')).toBe(true);
    expect(isSessionEntryPath('/backend/auth/oauth')).toBe(true);
    expect(isSessionEntryPath('https://agensis-backend.fly.dev/backend/auth/signin')).toBe(true);
    expect(isSessionEntryPath('/backend/auth/signout')).toBe(false);
    expect(isSessionEntryPath('/backend/db/select')).toBe(false);
  });
});

describe('decideAuthResponse', () => {
  const authed = { hadAuthHeader: true, hasStoredSession: true };

  it('ends the session on a 401 from an authenticated backend request', () => {
    expect(decideAuthResponse({ path: '/backend/workspaces', status: 401, ...authed })).toBe('end-session');
    expect(decideAuthResponse({ path: '/backend/db/select', status: 401, ...authed })).toBe('end-session');
    expect(
      decideAuthResponse({ path: 'https://agensis-backend.fly.dev/backend/ai-chat', status: 401, ...authed }),
    ).toBe('end-session');
  });

  it('does NOT sign the user out on a 401 from a login attempt', () => {
    // Wrong password while another (valid) session is already stored.
    expect(decideAuthResponse({ path: '/backend/auth/signin', status: 401, ...authed })).toBe('ignore');
    expect(decideAuthResponse({ path: '/backend/auth/signup', status: 401, ...authed })).toBe('ignore');
    // "Social login was not completed" is a 401 from the OAuth exchange.
    expect(decideAuthResponse({ path: '/backend/auth/oauth', status: 401, ...authed })).toBe('ignore');
  });

  it('ignores every status that is not 401', () => {
    for (const status of [200, 204, 400, 403, 404, 429, 500, 502]) {
      expect(decideAuthResponse({ path: '/backend/workspaces', status, ...authed })).toBe('ignore');
    }
  });

  it('is idempotent under a burst: once storage is empty there is nothing left to end', () => {
    const first = decideAuthResponse({ path: '/backend/workspaces', status: 401, hadAuthHeader: true, hasStoredSession: true });
    const rest = decideAuthResponse({ path: '/backend/workspaces', status: 401, hadAuthHeader: true, hasStoredSession: false });
    expect(first).toBe('end-session');
    expect(rest).toBe('ignore');
  });

  it('ignores a 401 on a request we never authenticated', () => {
    expect(
      decideAuthResponse({ path: '/backend/workspaces', status: 401, hadAuthHeader: false, hasStoredSession: true }),
    ).toBe('ignore');
  });

  it('ignores a 401 from somewhere that is not our backend', () => {
    expect(decideAuthResponse({ path: 'https://api.github.com/user', status: 401, ...authed })).toBe('ignore');
    expect(decideAuthResponse({ path: '/version.json', status: 401, ...authed })).toBe('ignore');
    expect(decideAuthResponse({ path: undefined, status: 401, ...authed })).toBe('ignore');
  });
});
