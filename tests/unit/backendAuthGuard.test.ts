import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wiring, not the decisions (those are tests/unit/authSession.test.ts).
//
// What this proves is the part that is easy to get wrong by inspection: that a
// 401 from a raw `fetch(apiUrl(...), { headers: apiAuthHeaders() })` — the call
// shape used in ~60 places across 32 files that never touch `postJson` — still
// reaches the sign-out choke point, and that a 401 from a sign-in attempt does
// not.
//
// The global fetch interceptor is installed when backendClient is first
// imported, so the mock has to be in place BEFORE the import.

const AUTH_STORAGE_KEY = 'agensis_local_session';
const USER_ID = '3f0b1a4e-5c2d-4a91-9f37-2c1de4b8a0f5';
const SIG = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123x';

type FetchReply = { status: number; body?: unknown };

let nextReply: FetchReply = { status: 200, body: { data: null, error: null } };
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

// A stable function identity that delegates to the current reply, installed
// before backendClient is imported so the interceptor wraps this.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(input), init });
  const { status, body } = nextReply;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body ?? {}),
  } as unknown as Response);
}) as typeof fetch;

const { apiAuthHeaders, apiUrl, backendClient } = await import('../../src/lib/backendClient');
const { getAuthNotice, setAuthNotice } = await import('../../src/lib/authNotice');
const { SESSION_EXPIRED_MESSAGE, SESSION_INVALID_MESSAGE } = await import('../../src/lib/authSession');

function token(ageSec = 0) {
  const issuedAt = Math.floor(Date.now() / 1000) - ageSec;
  return `${USER_ID}.1.${issuedAt}.${SIG}`;
}

function storeSession(accessToken: string) {
  localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ access_token: accessToken, user: { id: USER_ID, email: 'a@b.co' } }),
  );
}

beforeEach(() => {
  localStorage.clear();
  setAuthNotice(null);
  fetchCalls.length = 0;
  nextReply = { status: 200, body: { data: null, error: null } };
});

describe('getSession validates what came out of localStorage', () => {
  it('returns a fresh, well-formed session', async () => {
    storeSession(token());
    const { data: { session } } = await backendClient.auth.getSession();
    expect(session?.user.id).toBe(USER_ID);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
  });

  it('discards an expired session instead of rendering a logged-in shell', async () => {
    storeSession(token(30 * 24 * 60 * 60)); // 30 days old, TTL is 14
    const { data: { session } } = await backendClient.auth.getSession();
    expect(session).toBeNull();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(getAuthNotice()).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('discards a structurally broken session and says so differently', async () => {
    storeSession('not-a-real-token');
    const { data: { session } } = await backendClient.auth.getSession();
    expect(session).toBeNull();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(getAuthNotice()).toBe(SESSION_INVALID_MESSAGE);
  });

  it('never attaches an expired token to an outgoing request', async () => {
    storeSession(token(30 * 24 * 60 * 60));
    expect(apiAuthHeaders()).toEqual({});
  });
});

describe('401 choke point', () => {
  it('signs the user out when a raw apiAuthHeaders() fetch 401s', async () => {
    storeSession(token());
    const events: string[] = [];
    const { data: { subscription } } = backendClient.auth.onAuthStateChange((event) => events.push(event));

    nextReply = { status: 401, body: { error: { message: 'Authentication required' } } };
    // Exactly how src/hooks/useChat.ts and friends call the backend — no
    // postJson, no query builder, nothing that knows about auth.
    await fetch(apiUrl('/backend/ai-chat'), { headers: apiAuthHeaders() });

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(events).toEqual(['SIGNED_OUT']);
    expect(getAuthNotice()).toBe(SESSION_EXPIRED_MESSAGE);
    subscription.unsubscribe();
  });

  it('signs the user out when a query-builder call 401s', async () => {
    storeSession(token());
    nextReply = { status: 401, body: { error: { message: 'Authentication required' } } };
    const result = await backendClient.from('workspaces').select('*');

    expect(result.error?.message).toBeTruthy();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(getAuthNotice()).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('does NOT sign the user out when a sign-in attempt 401s', async () => {
    storeSession(token());
    const events: string[] = [];
    const { data: { subscription } } = backendClient.auth.onAuthStateChange((event) => events.push(event));

    nextReply = { status: 401, body: { error: { message: 'Invalid email or password' } } };
    const result = await backendClient.auth.signInWithPassword({ email: 'a@b.co', password: 'wrong' });

    expect(result.error?.message).toBe('Invalid email or password');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
    expect(events).toEqual([]);
    expect(getAuthNotice()).toBeNull();
    subscription.unsubscribe();
  });

  it('fires the sign-out exactly once for a burst of concurrent 401s', async () => {
    storeSession(token());
    const events: string[] = [];
    const { data: { subscription } } = backendClient.auth.onAuthStateChange((event) => events.push(event));

    nextReply = { status: 401, body: { error: { message: 'Authentication required' } } };
    await Promise.all([
      fetch(apiUrl('/backend/workspaces'), { headers: apiAuthHeaders() }),
      fetch(apiUrl('/backend/agents'), { headers: apiAuthHeaders() }),
      fetch(apiUrl('/backend/users/me'), { headers: apiAuthHeaders() }),
      backendClient.from('chat_sessions').select('*'),
    ]);

    expect(events).toEqual(['SIGNED_OUT']);
    subscription.unsubscribe();
  });

  it('leaves non-backend 401s alone', async () => {
    storeSession(token());
    nextReply = { status: 401, body: {} };
    await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer gh_x' } });
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
  });

  it('leaves an unauthenticated 401 alone', async () => {
    storeSession(token());
    nextReply = { status: 401, body: {} };
    await fetch(apiUrl('/backend/workspaces'));
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
  });
});

describe('sign-in refuses to store a session it cannot use', () => {
  it('rejects a response carrying a user but no token', async () => {
    nextReply = { status: 200, body: { data: { user: { id: USER_ID, email: 'a@b.co' } }, error: null } };
    const result = await backendClient.auth.signInWithPassword({ email: 'a@b.co', password: 'x' });

    expect(result.data.session).toBeNull();
    expect(result.error?.message).toMatch(/usable session/i);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('stores a session when both user and token are present', async () => {
    nextReply = { status: 200, body: { data: { user: { id: USER_ID, email: 'a@b.co' }, token: token() }, error: null } };
    const result = await backendClient.auth.signInWithPassword({ email: 'a@b.co', password: 'x' });

    expect(result.error).toBeNull();
    expect(result.data.session?.access_token).toBeTruthy();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
  });

  it('clears a pending notice once a sign-in succeeds', async () => {
    setAuthNotice(SESSION_EXPIRED_MESSAGE);
    nextReply = { status: 200, body: { data: { user: { id: USER_ID, email: 'a@b.co' }, token: token() }, error: null } };
    await backendClient.auth.signInWithPassword({ email: 'a@b.co', password: 'x' });
    expect(getAuthNotice()).toBeNull();
  });
});

describe('the interceptor is inert on everything else', () => {
  it('passes successful responses straight through and installs only once', async () => {
    const spy = vi.fn();
    const { data: { subscription } } = backendClient.auth.onAuthStateChange(spy);
    storeSession(token());

    nextReply = { status: 200, body: { data: [{ id: 'w1' }], error: null } };
    const result = await backendClient.from('workspaces').select('*');
    expect(result.data).toEqual([{ id: 'w1' }]);

    nextReply = { status: 500, body: { error: { message: 'boom' } } };
    await fetch(apiUrl('/backend/workspaces'), { headers: apiAuthHeaders() });

    expect(spy).not.toHaveBeenCalled();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
    subscription.unsubscribe();
  });
});
