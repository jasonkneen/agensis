import { clearAuthNotice, setAuthNotice } from './authNotice';
import {
  decideAuthResponse,
  isUsableStoredSession,
  SESSION_EXPIRED_MESSAGE,
  sessionDiscardMessage,
  sessionValidity,
} from './authSession';

const HOSTED_AGENSIS_BACKEND_BASE = 'https://agensis-backend.fly.dev';
const LOCAL_DEMO_BACKEND_BASE = 'http://127.0.0.1:3142';

const BACKEND_BASE = (() => {
  const demo = localDemoBackendBase();
  if (demo) return demo;
  const explicit = normalizeBackendBase(import.meta.env.VITE_BACKEND_BASE_URL);
  if (explicit) return explicit;
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return 'http://127.0.0.1:3142';
  }
  return hostedAgensisBackendBase();
})();

const AUTH_STORAGE_KEY = 'agensis_local_session';
const authListeners = new Set<(event: string, session: SessionLike | null) => void>();

type SessionLike = {
  access_token: string;
  user: {
    id: string;
    email: string;
  };
};

type Filter = {
  column: string;
  operator: 'eq' | 'not';
  value: unknown;
  subOperator?: string;
};

type LooseJson = ReturnType<typeof JSON.parse>;

type DbChangePayload<T = LooseJson> = {
  eventType?: string;
  new?: T;
  old?: T;
};

type DbChangeBinding<T = LooseJson> = {
  type: 'db_changes';
  config: {
    event: string;
    schema?: string;
    table?: string;
    filter?: string;
  };
  callback: (payload: DbChangePayload<T>) => void;
};

type BroadcastBinding<T = LooseJson> = {
  type: 'broadcast';
  config: {
    event: string;
  };
  callback: (payload: { payload: T }) => void;
};

type ChannelBinding = DbChangeBinding | BroadcastBinding;

type RealtimeInboundMessage = {
  type?: string;
  channel?: string;
  event?: string;
  schema?: string;
  table?: string;
  payload?: unknown;
};

type BroadcastSendMessage = {
  type: 'broadcast';
  event: string;
  payload: unknown;
};

function stringifyRealtimeMessage(message: Record<string, unknown>): string | null {
  try {
    return JSON.stringify(toRealtimeJson(message));
  } catch (error) {
    console.warn('Dropping realtime message with non-serializable payload', {
      action: message.action,
      channel: message.channel,
      event: message.event,
      error,
    });
    return null;
  }
}

function toRealtimeJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof Element !== 'undefined' && value instanceof Element) return undefined;
  if (typeof Event !== 'undefined' && value instanceof Event) return undefined;
  if (Array.isArray(value)) {
    return value
      .map(item => toRealtimeJson(item, seen))
      .filter(item => item !== undefined);
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('__react')) continue;
    const next = toRealtimeJson(item, seen);
    if (next !== undefined) output[key] = next;
  }
  return output;
}

type BackendClient = {
  from<T = LooseJson>(table: string): QueryBuilder<T>;
  rpc<T = unknown>(name: string, params: Record<string, unknown>): Promise<{ data: T | null; error: { message: string; code?: string | null } | null }>;
  channel(name: string): LocalChannel;
  removeChannel(channel: LocalChannel): Promise<unknown>;
  auth: {
    getSession(): Promise<{ data: { session: SessionLike | null } }>;
    onAuthStateChange(callback: (event: string, session: SessionLike | null) => void): { data: { subscription: { unsubscribe(): void } } };
    signUp(input: { email: string; password: string }): Promise<{ data: { user: SessionLike['user'] | null; session: SessionLike | null }; error: { message: string; code?: string | null } | null }>;
    signInWithPassword(input: { email: string; password: string }): Promise<{ data: { user: SessionLike['user'] | null; session: SessionLike | null }; error: { message: string; code?: string | null } | null }>;
    signInWithOAuthSession(): Promise<{ data: { user: SessionLike['user'] | null; session: SessionLike | null }; error: { message: string; code?: string | null } | null }>;
    signOut(): Promise<{ error: null }>;
  };
};

function normalizeBackendBase(value: unknown) {
  if (typeof value !== 'string') return '';
  const base = value.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (typeof window === 'undefined' || window.location.protocol === 'file:') return base;
  if (isLoopbackHost(window.location.hostname)) return base;
  return isLoopbackBackendBase(base) ? '' : base;
}

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '::1'
    || hostname === '[::1]';
}

function isLoopbackBackendBase(base: string) {
  if (typeof window === 'undefined') return false;
  try {
    return isLoopbackHost(new URL(base, window.location.origin).hostname);
  } catch {
    return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(base);
  }
}

function localDemoBackendBase() {
  if (typeof window === 'undefined') return '';
  if (!isLoopbackHost(window.location.hostname)) return '';
  return new URLSearchParams(window.location.search).get('demo') === '1'
    ? LOCAL_DEMO_BACKEND_BASE
    : '';
}

function hostedAgensisBackendBase() {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname.toLowerCase();
  if (host === 'agensis.io' || host === 'www.agensis.io' || host.endsWith('.netlify.app')) {
    return HOSTED_AGENSIS_BACKEND_BASE;
  }
  return '';
}

function backendUrl(path: string) {
  return `${BACKEND_BASE}${path}`;
}

function realtimeDisabledOnThisHost() {
  if (typeof window === 'undefined') return true;
  if (BACKEND_BASE) return false;
  const { protocol, hostname, port } = window.location;
  // Netlify/Vite dev on :8888 proxies HTTP functions but does not expose the
  // local websocket backend, so do not even attempt /backend/ws there.
  if (isLoopbackHost(hostname) && port === '8888') return true;
  if (protocol !== 'https:') return false;
  return !isLoopbackHost(hostname);
}

// H3: the auth token is NOT embedded in the WS URL (it would leak to browser
// history / proxy logs). It is sent as the first `{ type: 'auth', token }` frame
// once the socket opens — see RealtimeManager's open handler.
function getWsUrl() {
  if (BACKEND_BASE) {
    return `${BACKEND_BASE.replace(/^http/, 'ws')}/backend/ws`;
  }
  if (typeof window !== 'undefined') {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${window.location.host}/backend/ws`;
  }
  return '/backend/ws';
}

// The raw localStorage read, with NO validation. Only two callers should use
// it: the validating reader below, and the "is there anything to clear?" guard
// on the 401 path (which must not itself trigger a clear and recurse).
function readRawStoredSession(): SessionLike | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// The only session reader the app should use. A stored blob that is structurally
// broken or past its TTL is DISCARDED rather than returned — returning it is what
// produced the "zombie" state, where a fully-rendered workspace sat on top of a
// token every request would reject.
//
// This cannot detect revocation or a bad signature (no secret in the browser);
// those surface as a 401 and are handled by `noteBackendResponse` below.
function getStoredSession(): SessionLike | null {
  const stored = readRawStoredSession();
  if (!stored) return null;
  const validity = sessionValidity(stored);
  if (validity === 'valid') return stored;
  discardStoredSession(sessionDiscardMessage(validity));
  return null;
}

function setStoredSession(session: SessionLike | null, event: string) {
  if (typeof localStorage !== 'undefined') {
    if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  }
  // A new session supersedes whatever went wrong last time.
  if (session) clearAuthNotice();
  authListeners.forEach((listener) => listener(event, session));
}

// Throw the stored session away and tell the app why. Idempotent by
// construction: once storage is empty there is nothing to clear, so repeated
// calls (e.g. from a burst of concurrent 401s) return immediately and the
// notice/listener fan-out fires exactly once.
function discardStoredSession(message: string) {
  if (!readRawStoredSession()) return;
  setAuthNotice(message);
  setStoredSession(null, 'SIGNED_OUT');
}

// THE 401 choke point. Every backend response the client sees passes through
// here — the helpers in this file call it directly, and the global fetch
// interceptor installed at the bottom of this file covers the raw `fetch` +
// `apiAuthHeaders()` call sites scattered across hooks and components.
//
// The decision itself is pure and unit-tested (see lib/authSession.ts); this
// function only supplies the ambient facts and performs the effect.
function noteBackendResponse(path: unknown, status: number, hadAuthHeader: boolean) {
  if (status !== 401) return;
  const decision = decideAuthResponse({
    path,
    status,
    hadAuthHeader,
    hasStoredSession: Boolean(readRawStoredSession()),
  });
  if (decision !== 'end-session') return;
  discardStoredSession(SESSION_EXPIRED_MESSAGE);
}

function authHeaders(): Record<string, string> {
  const token = getStoredSession()?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Shared tail of every "we just signed in" path. A sign-in that returns a user
// but no usable token must FAIL, loudly — storing it would render a logged-in
// shell whose every request 401s, which is the exact bug this file is fixing.
// Applying the same predicate here as on the localStorage read keeps the two
// from disagreeing (which would otherwise show up as a sign-in that
// immediately bounces back to the login screen with no explanation).
function storeMintedSession(
  token: unknown,
  user: SessionLike['user'],
): { data: { user: SessionLike['user'] | null; session: SessionLike | null }; error: { message: string; code?: string | null } | null } {
  const session = { access_token: token as string, user } as SessionLike;
  if (!isUsableStoredSession(session)) {
    return {
      data: { user: null, session: null },
      error: { message: 'Sign-in did not return a usable session. Please try again.', code: null },
    };
  }
  setStoredSession(session, 'SIGNED_IN');
  return {
    data: { user: session.user, session },
    error: null,
  };
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<{ data: T | null; error: { message: string; code?: string | null } | null }> {
  try {
    const headers = authHeaders();
    const response = await fetch(backendUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
    noteBackendResponse(path, response.status, Boolean(headers.Authorization));

    const payload = await response.json().catch(() => ({ data: null, error: { message: 'Invalid JSON response' } }));
    if (!response.ok) {
      return {
        data: null,
        error: {
          message: payload?.error?.message || payload?.message || `Request failed (${response.status})`,
          code: payload?.error?.code || null,
        },
      };
    }
    return {
      data: payload?.data ?? null,
      error: payload?.error ?? null,
    };
  } catch (error) {
    return {
      data: null,
      error: {
        message: error instanceof Error ? error.message : 'Network error',
        code: null,
      },
    };
  }
}

class QueryBuilder<T = LooseJson> {
  private table: string;
  private action: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private readColumns = '*';
  private returningColumns = '*';
  private filters: Filter[] = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitCount: number | null = null;
  private payload: unknown = null;
  private singleMode: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(table: string) {
    this.table = table;
  }

  select(columns = '*') {
    if (this.action === 'select') {
      this.readColumns = columns;
    } else {
      this.returningColumns = columns;
    }
    return this;
  }

  insert(values: unknown) {
    this.action = 'insert';
    this.payload = values;
    return this;
  }

  update(values: unknown) {
    this.action = 'update';
    this.payload = values;
    return this;
  }

  delete() {
    this.action = 'delete';
    this.payload = null;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, operator: 'eq', value });
    return this;
  }

  not(column: string, subOperator: string, value: unknown) {
    this.filters.push({ column, operator: 'not', subOperator, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this.execute();
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this.execute();
  }

  then<TResult1 = { data: T | null; error: { message: string; code?: string | null } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: T | null; error: { message: string; code?: string | null } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<{ data: T | null; error: { message: string; code?: string | null } | null }> {
    if (this.action === 'select') {
      return postJson<T>('/backend/db/select', {
        table: this.table,
        columns: this.readColumns,
        filters: this.filters,
        orderBy: this.orderBy,
        limit: this.limitCount,
        single: this.singleMode !== 'many',
      });
    }

    if (this.action === 'insert') {
      return postJson<T>('/backend/db/insert', {
        table: this.table,
        values: this.payload,
        returning: this.returningColumns,
        single: this.singleMode !== 'many',
      });
    }

    if (this.action === 'update') {
      return postJson<T>('/backend/db/update', {
        table: this.table,
        values: this.payload,
        filters: this.filters,
        returning: this.returningColumns,
        single: this.singleMode !== 'many',
      });
    }

    return postJson<T>('/backend/db/delete', {
      table: this.table,
      filters: this.filters,
      single: this.singleMode !== 'many',
    });
  }
}

class RealtimeManager {
  private static readonly INITIAL_RECONNECT_DELAY_MS = 800;
  private static readonly MAX_RECONNECT_DELAY_MS = 8000;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly UNAVAILABLE_RETRY_DELAY_MS = 30000;
  private static readonly MAX_PENDING_MESSAGES = 50;

  private socket: WebSocket | null = null;
  private channels = new Set<LocalChannel>();
  // Workspace-agnostic server "system" events (e.g. a new frontend deploy going
  // live), keyed by event name. These ride the existing socket — no dedicated
  // connection — so delivery is best-effort while any channel keeps the socket open.
  private systemListeners = new Map<string, Set<(payload: unknown) => void>>();
  private pendingMessages: string[] = [];
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private unavailableUntil = 0;
  private permanentlyUnavailable = false;

  ensureConnected() {
    if (typeof WebSocket === 'undefined') return;
    if (realtimeDisabledOnThisHost() || this.permanentlyUnavailable) return;
    if (this.channels.size === 0) return;
    if (this.isUnavailableCoolingDown()) {
      this.scheduleUnavailableRetry();
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(getWsUrl());
    } catch {
      this.enterUnavailableCooldown();
      return;
    }
    this.socket = socket;

    // Every handler below is bound to `socket`, the socket it was registered on,
    // and no-ops once `this.socket` has moved on.
    //
    // Without that guard a SUPERSEDED socket's handlers still act on the manager.
    // The check above only skips reconnecting while the current socket is OPEN or
    // CONNECTING, so a socket in state CLOSING falls through and we build a
    // replacement while the old one is still alive enough to emit. When the old
    // one finally emits 'close' it ran `this.socket = null` — discarding the
    // REPLACEMENT — then scheduled yet another reconnect, so the healthy socket
    // was orphaned (still open, still delivering into this.channels, now
    // unreachable and never closed) and a third socket was built on top. Each
    // pass leaks one socket and doubles delivery of every realtime row.
    const isCurrent = () => this.socket === socket;

    socket.addEventListener('open', () => {
      if (!isCurrent()) {
        try { socket.close(); } catch { /* already closing */ }
        return;
      }
      // H3: authenticate via a first frame instead of a token in the URL. Channel
      // (re)subscription is deferred until the server acknowledges auth (see the
      // 'authenticated' branch in the message handler) so we never push
      // subscriptions onto an unauthenticated socket.
      const token = getStoredSession()?.access_token;
      if (token) {
        try {
          socket.send(JSON.stringify({ type: 'auth', token }));
        } catch {
          // socket went away between open and send — close will trigger reconnect
        }
        return;
      }
      // No token (e.g. signed-out): proceed without auth; the server will close
      // the socket if authentication is required.
      this.onAuthenticated();
    });

    socket.addEventListener('message', (event) => {
      if (!isCurrent()) return;
      try {
        const message = JSON.parse(String(event.data || '{}'));
        if (message?.type === 'system' && message?.event === 'authenticated') {
          this.onAuthenticated();
          return;
        }
        if (message?.type === 'system' && typeof message?.event === 'string') {
          // Most system frames carry a dedicated payload. Subscription
          // revocations predate that envelope and carry channel/reason at the
          // top level, so preserve both wire shapes for listeners.
          this.emitSystemEvent(message.event, message.payload ?? message);
          return;
        }
        for (const channel of this.channels) {
          channel.handleMessage(message);
        }
      } catch {
        // ignore malformed messages
      }
    });

    socket.addEventListener('error', () => {
      // A WS 'error' fires on transient failures (failed connect, 1006 abnormal
      // close from a deploy or a mobile network drop) and is always followed by
      // 'close'. Do NOT permanently disable realtime here — let the 'close'
      // handler drive exponential backoff + resubscribe. Permanently disabling
      // on the most common failure mode killed all realtime until a page reload.
    });

    socket.addEventListener('close', () => {
      // A superseded socket closing is bookkeeping for a socket nobody is using;
      // it must not null out the live one or schedule a reconnect on its behalf.
      if (!isCurrent()) return;
      this.socket = null;
      if (realtimeDisabledOnThisHost() || this.permanentlyUnavailable) return;
      if (this.channels.size === 0) return;
      if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
      if (this.reconnectAttempts >= RealtimeManager.MAX_RECONNECT_ATTEMPTS) {
        this.enterUnavailableCooldown();
        return;
      }
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureConnected();
      }, this.nextReconnectDelay());
    });
  }

  /**
   * Backoff delay for the next reconnect, with jitter, and consumes an attempt.
   *
   * The exponential curve was already here; the jitter is the new part, and it
   * is not a micro-optimisation. Every client of a given backend loses its socket
   * at the SAME INSTANT — that is what a deploy is, and the server now makes it
   * exactly simultaneous by closing every socket itself on SIGTERM. A purely
   * exponential delay is deterministic, so all of them then retry at the same
   * 800ms, the same 1600ms, the same 3200ms: a synchronised herd that hits the
   * new process hardest precisely while it is still warming up, and stays
   * synchronised because a failed reconnect advances every client identically.
   *
   * The jitter is ADDITIVE — `base + random(0, base)` — so a reconnect is never
   * scheduled SOONER than the delay this used to use. Spreading a herd only
   * requires the clients to differ from each other; nothing requires them to be
   * faster, and "faster" is not a free change — it shortens the window in which
   * the app is knowingly offline, which is the window other code races against.
   * The base ladder therefore tops out at half MAX_RECONNECT_DELAY_MS, so the
   * longest delay is still MAX_RECONNECT_DELAY_MS rather than twice it.
   */
  private nextReconnectDelay(): number {
    const base = Math.min(
      RealtimeManager.INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      RealtimeManager.MAX_RECONNECT_DELAY_MS / 2,
    );
    this.reconnectAttempts += 1;
    return Math.round(base + Math.random() * base);
  }

  // Runs once the socket is usable: either the server acknowledged the auth frame
  // ('authenticated' system message) or there is no token to send. Flushes queued
  // messages and (re)subscribes every channel.
  private onAuthenticated() {
    this.reconnectAttempts = 0;
    this.unavailableUntil = 0;
    this.permanentlyUnavailable = false;
    this.flushPending();
    for (const channel of this.channels) {
      channel.resubscribe();
      channel.notifyStatus('SUBSCRIBED');
    }
  }

  register(channel: LocalChannel) {
    this.channels.add(channel);
    if (realtimeDisabledOnThisHost() || this.permanentlyUnavailable) {
      channel.notifyStatus('UNAVAILABLE');
      return;
    }
    if (this.isUnavailableCoolingDown()) {
      channel.notifyStatus('UNAVAILABLE');
      this.scheduleUnavailableRetry();
      return;
    }
    this.ensureConnected();
    if (this.socket?.readyState === WebSocket.OPEN) {
      channel.resubscribe();
      channel.notifyStatus('SUBSCRIBED');
    }
  }

  unregister(channel: LocalChannel) {
    this.channels.delete(channel);
    if (realtimeDisabledOnThisHost()) return;
    if (this.channels.size === 0) {
      this.pendingMessages = [];
      this.reconnectAttempts = 0;
      this.unavailableUntil = 0;
      if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      if (this.socket) {
        this.socket.close();
        this.socket = null;
      }
      return;
    }
    this.send({ action: 'unsubscribe', channel: channel.name });
  }

  onSystemEvent(event: string, callback: (payload: unknown) => void): () => void {
    let listeners = this.systemListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.systemListeners.set(event, listeners);
    }
    listeners.add(callback);
    // A system listener piggybacks on the socket the app's channels already keep
    // open; it does not itself justify a dedicated connection.
    return () => {
      const set = this.systemListeners.get(event);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) this.systemListeners.delete(event);
    };
  }

  private emitSystemEvent(event: string, payload: unknown) {
    const listeners = this.systemListeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
        // a listener throwing must not break delivery to the others
      }
    }
  }

  send(message: Record<string, unknown>) {
    if (realtimeDisabledOnThisHost() || this.permanentlyUnavailable) return;
    if (this.isUnavailableCoolingDown()) {
      this.scheduleUnavailableRetry();
      return;
    }
    const encoded = stringifyRealtimeMessage(message);
    if (!encoded) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encoded);
      return;
    }
    if (this.pendingMessages.length >= RealtimeManager.MAX_PENDING_MESSAGES) {
      this.pendingMessages.shift();
    }
    this.pendingMessages.push(encoded);
    this.ensureConnected();
  }

  /**
   * Raw binary onto the realtime socket — microphone audio for the huddle
   * speech-to-text relay, and nothing else today.
   *
   * Deliberately NOT queued like `send`. A control frame is worth holding until
   * the socket comes back; a 50ms slice of audio from ten seconds ago is not,
   * and replaying a buffer of it into a live transcription would produce a
   * garbled utterance the agent then answers. Dropped is correct.
   */
  sendBinary(data: ArrayBufferLike): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  /** Is the socket usable right now? Voice needs to know before it opens a mic. */
  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private flushPending() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    while (this.pendingMessages.length > 0) {
      const next = this.pendingMessages.shift();
      if (next) this.socket.send(next);
    }
  }

  private markUnavailable() {
    this.pendingMessages = [];
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const channel of this.channels) {
      channel.notifyStatus('UNAVAILABLE');
    }
  }

  private enterUnavailableCooldown() {
    this.markUnavailable();
    this.reconnectAttempts = 0;
    this.unavailableUntil = Date.now() + RealtimeManager.UNAVAILABLE_RETRY_DELAY_MS;
    this.scheduleUnavailableRetry();
  }

  private isUnavailableCoolingDown() {
    if (this.unavailableUntil <= Date.now()) {
      this.unavailableUntil = 0;
      return false;
    }
    return true;
  }

  private scheduleUnavailableRetry() {
    if (this.channels.size === 0 || this.reconnectTimer || realtimeDisabledOnThisHost() || this.permanentlyUnavailable) return;
    const delay = Math.max(this.unavailableUntil - Date.now(), 0);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.unavailableUntil = 0;
      this.ensureConnected();
    }, delay);
  }
}

const realtimeManager = new RealtimeManager();

class LocalChannel {
  name: string;
  private bindings: ChannelBinding[] = [];
  private statusCallback?: (status: string) => void;

  constructor(name: string) {
    this.name = name;
  }

  on<T = LooseJson>(type: 'broadcast', config: BroadcastBinding<T>['config'], callback: BroadcastBinding<T>['callback']): LocalChannel;
  on<T = LooseJson>(type: 'db_changes', config: DbChangeBinding<T>['config'], callback: DbChangeBinding<T>['callback']): LocalChannel;
  on(type: 'broadcast' | 'db_changes', config: BroadcastBinding['config'] | DbChangeBinding['config'], callback: BroadcastBinding['callback'] | DbChangeBinding['callback']) {
    if (type === 'broadcast') {
      this.bindings.push({ type, config: config as BroadcastBinding['config'], callback: callback as BroadcastBinding['callback'] });
    } else {
      this.bindings.push({ type, config: config as DbChangeBinding['config'], callback: callback as DbChangeBinding['callback'] });
    }
    return this;
  }

  subscribe(callback?: (status: string) => void) {
    this.statusCallback = callback;
    realtimeManager.register(this);
    return this;
  }

  notifyStatus(status: string) {
    this.statusCallback?.(status);
  }

  resubscribe() {
    for (const binding of this.bindings) {
      realtimeManager.send({
        action: 'subscribe',
        channel: this.name,
        binding: {
          type: binding.type,
          ...binding.config,
        },
      });
    }
  }

  handleMessage(message: RealtimeInboundMessage) {
    if (message.type === 'broadcast' && message.channel === this.name) {
      for (const binding of this.bindings) {
        if (binding.type === 'broadcast' && binding.config.event === message.event) {
          binding.callback({ payload: message.payload });
        }
      }
      return;
    }

    if (message.type === 'db_changes') {
      const payload = this.normalizeDbPayload(message.payload);
      for (const binding of this.bindings) {
        if (binding.type !== 'db_changes') continue;
        const matchesTable = !binding.config.table || binding.config.table === message.table;
        const matchesSchema = !binding.config.schema || binding.config.schema === message.schema;
        const matchesEvent = binding.config.event === '*' || binding.config.event === payload.eventType;
        // Honor the per-subscription row filter (e.g. "task_id=eq.<id>"). The
        // single shared socket fans every row event for a table to every
        // channel bound to it, so without this a filtered consumer would
        // receive other rows' events (e.g. a comment on task A surfacing
        // under task B).
        if (matchesTable && matchesSchema && matchesEvent && this.matchesFilter(binding.config.filter, payload)) {
          binding.callback(payload);
        }
      }
    }
  }

  private normalizeDbPayload(payload: unknown): DbChangePayload {
    if (!payload || typeof payload !== 'object') return {};
    return payload as DbChangePayload;
  }

  private matchesFilter(filter: string | undefined, payload: DbChangePayload): boolean {
    if (!filter) return true;
    const match = /^([^=]+)=eq\.(.*)$/.exec(filter);
    if (!match) return true; // unrecognised filter form — don't over-filter
    const [, column, value] = match;
    const row = payload?.new ?? payload?.old;
    if (!row || row[column] === undefined) return true;
    return String(row[column]) === String(value);
  }

  unsubscribe() {
    realtimeManager.unregister(this);
    return Promise.resolve('ok');
  }

  send(message: BroadcastSendMessage) {
    realtimeManager.send({
      action: 'broadcast',
      channel: this.name,
      event: message.event,
      payload: message.payload,
    });
    return Promise.resolve('ok');
  }
}

export function getBackendBaseUrl() {
  return BACKEND_BASE;
}

export interface DeployPublishedPayload {
  commit: string | null;
  branch: string | null;
  site: string | null;
  url: string | null;
  at: string | null;
}

// Subscribe to the server's `deploy_published` system event — fired when Netlify
// finishes publishing a new frontend to the CDN (see the netlify-deploy-hook route).
// Returns an unsubscribe function. Best-effort: relies on the realtime socket the
// app's channels already keep open.
export function onDeployPublished(callback: (payload: DeployPublishedPayload) => void): () => void {
  return realtimeManager.onSystemEvent('deploy_published', (payload) => {
    callback((payload ?? {}) as DeployPublishedPayload);
  });
}

export interface RealtimeUnsubscribedPayload {
  channel: string;
  reason: string;
}

/**
 * Listen for a server-forced channel revocation. The server uses this when a
 * live capability disappears (for example, reciprocal read receipts are
 * switched off on another device), so consumers must discard state that was
 * valid only while that subscription was authorized.
 */
export function onRealtimeUnsubscribed(
  callback: (payload: RealtimeUnsubscribedPayload) => void,
): () => void {
  return realtimeManager.onSystemEvent('unsubscribed', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const value = payload as Partial<RealtimeUnsubscribedPayload>;
    if (typeof value.channel !== 'string' || typeof value.reason !== 'string') return;
    callback({ channel: value.channel, reason: value.reason });
  });
}

export interface ReadReceiptPreferencePayload {
  userId: string;
  enabled: boolean;
}

export function onReadReceiptPreference(
  callback: (payload: ReadReceiptPreferencePayload) => void,
): () => void {
  return realtimeManager.onSystemEvent('read_receipts_preference', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const value = payload as Partial<ReadReceiptPreferencePayload>;
    if (typeof value.userId !== 'string' || typeof value.enabled !== 'boolean') return;
    callback({ userId: value.userId, enabled: value.enabled });
  });
}

// Huddle voice rides the realtime socket rather than opening one of its own.
//
// The Deepgram key must never reach a browser and the account cannot mint a
// short-lived one (see shared/voice-core.cjs), so the server holds the key and
// relays the audio. This socket is already authenticated, already open for the
// length of the call, already pinged for liveness and already torn down on
// close — a second connection would have to re-earn all four.
export const voiceRealtime = {
  /** Ask the server to open a Deepgram stream for this socket. */
  start(sampleRate: number) {
    realtimeManager.send({ action: 'voice_stt_start', sampleRate });
  },
  stop() {
    realtimeManager.send({ action: 'voice_stt_stop' });
  },
  /** One slice of microphone PCM. Returns false when it was dropped. */
  sendAudio(data: ArrayBufferLike): boolean {
    return realtimeManager.sendBinary(data);
  },
  isOpen(): boolean {
    return realtimeManager.isOpen();
  },
  /** Server -> client transcription events. Returns an unsubscribe function. */
  onEvent(callback: (payload: unknown) => void): () => void {
    return realtimeManager.onSystemEvent('voice_stt', callback);
  },
};

export const backendClient: BackendClient = {
  from(table: string) {
    return new QueryBuilder(table);
  },
  rpc(name: string, params: Record<string, unknown>) {
    return postJson(`/backend/rpc/${name}`, params);
  },
  channel(name: string) {
    return new LocalChannel(name);
  },
  removeChannel(channel: LocalChannel) {
    return channel.unsubscribe();
  },
  auth: {
    async getSession() {
      return { data: { session: getStoredSession() } };
    },
    onAuthStateChange(callback: (event: string, session: SessionLike | null) => void) {
      authListeners.add(callback);
      return {
        data: {
          subscription: {
            unsubscribe() {
              authListeners.delete(callback);
            },
          },
        },
      };
    },
    async signUp({ email, password }: { email: string; password: string }) {
      const result = await postJson<{ user: SessionLike['user']; token: string }>('/backend/auth/signup', { email, password });
      if (result.error || !result.data?.user) {
        return {
          data: { user: null, session: null },
          error: result.error,
        };
      }
      return storeMintedSession(result.data.token, result.data.user);
    },
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      const result = await postJson<{ user: SessionLike['user']; token: string }>('/backend/auth/signin', { email, password });
      if (result.error || !result.data?.user) {
        return {
          data: { user: null, session: null },
          error: result.error,
        };
      }
      return storeMintedSession(result.data.token, result.data.user);
    },
    async signInWithOAuthSession() {
      // The OAuth callback must hit the Netlify function (same origin), not the
      // Fly API backend (BACKEND_BASE). It relies on @netlify/identity's getUser()
      // which reads Netlify's edge-injected identity context — only present on the
      // Netlify origin. Routing this through BACKEND_BASE (Fly) 404s and breaks
      // social login. In Electron (file://) there is no same-origin function, so
      // fall back to BACKEND_BASE (the local sidecar).
      const oauthUrl = (typeof window !== 'undefined' && window.location.protocol.startsWith('http'))
        ? '/backend/auth/oauth'
        : backendUrl('/backend/auth/oauth');
      const oauthHeaders = authHeaders();
      try {
        const response = await fetch(oauthUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...oauthHeaders },
          body: JSON.stringify({}),
        });
        noteBackendResponse(oauthUrl, response.status, Boolean(oauthHeaders.Authorization));
        const payload = await response.json().catch(() => null);
        // The success guard used to check only `payload.data.user`, then read
        // `payload.data.token` regardless — a response carrying a user and no
        // token stored `access_token: undefined` and reported success. Same
        // zombie state, different door. Both are required now.
        if (!response.ok || !payload?.data?.user) {
          return {
            data: { user: null, session: null },
            error: payload?.error || { message: 'OAuth sign-in failed', code: null },
          };
        }
        return storeMintedSession(payload.data.token, payload.data.user);
      } catch (error) {
        return {
          data: { user: null, session: null },
          error: {
            message: error instanceof Error ? error.message : 'Network error',
            code: null,
          },
        };
      }
    },
    async signOut() {
      // Best-effort server-side revocation (bumps token_version so the current
      // token is rejected on its next use, e.g. if it was ever leaked) BEFORE
      // clearing local state. postJson swallows network errors into its own
      // { error } shape rather than throwing, so a flaky connection never blocks
      // the local sign-out from completing.
      await postJson('/backend/auth/signout', {});
      // A deliberate sign-out is not a failure — drop any pending "session
      // expired" / "social login failed" notice so it can't resurface on the
      // login screen the user just asked for.
      clearAuthNotice();
      setStoredSession(null, 'SIGNED_OUT');
      return { error: null };
    },
  },
};

// Resolve a backend path against the active base URL (handles dev proxy,
// Electron file:// and explicit VITE_BACKEND_BASE_URL the same way the rest
// of the client does). Used by features that hit raw endpoints (e.g. settings).
export function apiUrl(path: string) {
  if (shouldUseLocalSidecar(path)) return `http://127.0.0.1:3142${path}`;
  return backendUrl(path);
}

function shouldUseLocalSidecar(path: string) {
  if (typeof window === 'undefined') return false;
  if (BACKEND_BASE) return false;
  const { hostname, port } = window.location;
  if (!isLoopbackHost(hostname) || port !== '8888') return false;
  return /^\/backend\/agents(?:\/|$)/.test(path)
    || /^\/backend\/files\//.test(path)
    || /^\/backend\/workspaces\/[^/]+\/project-files(?:\?|$)/.test(path)
    || path.startsWith('/backend/system/inspect-path');
}

export function apiBaseUrl() {
  if (BACKEND_BASE) return BACKEND_BASE;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

// Authorization header for raw fetch() calls to backend endpoints that don't go
// through the query builder (e.g. ai-chat, settings).
export function apiAuthHeaders(): Record<string, string> {
  return authHeaders();
}

export interface SystemCapabilities {
  checkedAt: string;
  workspacePath: string;
  /** Present when the desktop shell probed THIS machine (not the remote backend). */
  source?: string;
  clis: Array<{
    id: string;
    label: string;
    command: string;
    available: boolean;
    path: string | null;
    version: string | null;
    install_hint?: string | null;
    skill_dir?: string | null;
    adapter?: { command: string; path: string | null; version?: string | null } | null;
    underlying?: { command: string; available: boolean; path: string | null; version?: string | null } | null;
  }>;
  packages: Array<{ name: string; available: boolean; version: string | null; path: string | null }>;
  skills: Array<{ id: string; label: string; type: string; path: string; available: boolean; count: number }>;
  codexAppServer: { available: boolean; command: string; transports: string[] };
}

// Slash commands/skills the connected daemons expose on their machines (the composer
// can't see the user's filesystem directly). Returns [] on any failure — the `/` menu
// still has its client-side built-ins.
export async function getSlashCommands(workspaceId?: string): Promise<import('./slashCommands').SlashItem[]> {
  if (!workspaceId) return [];
  const path = `/backend/system/slash-commands?workspaceId=${encodeURIComponent(workspaceId)}`;
  const headers = apiAuthHeaders();
  try {
    const response = await fetch(apiUrl(path), { headers });
    noteBackendResponse(path, response.status, Boolean(headers.Authorization));
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error || !Array.isArray(payload?.data)) return [];
    return payload.data as import('./slashCommands').SlashItem[];
  } catch {
    return [];
  }
}

/**
 * System tool/CLI capabilities.
 *
 * In the Electron desktop shell this probes the USER'S machine via main-process
 * IPC (login-shell PATH, Homebrew, nvm, ~/.local/bin, ~/.grok/bin, …). Hitting
 * the remote backend would only report what is installed on Fly — useless for
 * local Claude/Codex/Amp/Grok. Browser tabs still use `/backend/system/capabilities`.
 */
export async function getSystemCapabilities(
  workspacePath?: string,
  options?: { refresh?: boolean },
): Promise<SystemCapabilities | null> {
  if (typeof window !== 'undefined') {
    const discover = window.electronAPI?.discoverLocalAgents;
    if (typeof discover === 'function') {
      try {
        const result = await discover({
          workspacePath: workspacePath || '',
          refresh: Boolean(options?.refresh),
        });
        if (result?.ok && result.data) return result.data as SystemCapabilities;
      } catch {
        // fall through to backend so a broken IPC bridge still degrades
      }
    }
  }

  const query = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : '';
  const path = `/backend/system/capabilities${query}`;
  const headers = apiAuthHeaders();
  try {
    const response = await fetch(apiUrl(path), { headers });
    noteBackendResponse(path, response.status, Boolean(headers.Authorization));
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error || !payload?.data) return null;
    return payload.data as SystemCapabilities;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Global fetch interceptor — the reason the 401 choke point is airtight.
//
// `postJson` covers the query builder and RPC, but ~60 raw `fetch(apiUrl(...),
// { headers: apiAuthHeaders() })` call sites live across 32 other files (chat
// streaming, settings, agents, inbox, vault, uploads…). `apiAuthHeaders()`
// builds the request and then never sees the response, so it cannot be the
// choke point. Rewriting every one of those call sites would be a large, easy-
// to-get-wrong diff that still would not catch the next one somebody adds.
//
// Wrapping `fetch` once, here, catches all of them and every future one, in
// ~25 lines. The wrapper is deliberately inert: it awaits the original, hands
// the response straight back, and only *observes* the status. Every decision
// about what a 401 means is delegated to the pure, unit-tested
// `decideAuthResponse`, which ignores anything that is not a 401 on an
// Authorization-bearing request to a non-login /backend/ path.
// ---------------------------------------------------------------------------

type InterceptedFetch = typeof fetch & { __agensisAuthInterceptor?: true };

function requestPathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return '';
}

function headersHaveAuth(headers: HeadersInit | undefined): boolean | null {
  if (!headers) return null;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.has('authorization');
  if (Array.isArray(headers)) return headers.some(([key]) => String(key).toLowerCase() === 'authorization');
  if (typeof headers === 'object') {
    return Object.keys(headers).some(key => key.toLowerCase() === 'authorization');
  }
  return null;
}

function requestHadAuthHeader(input: RequestInfo | URL, init?: RequestInit): boolean {
  // `init.headers` wins over a Request's own headers per the fetch spec, so
  // only fall back to the Request when init supplied none at all.
  const fromInit = headersHaveAuth(init?.headers);
  if (fromInit !== null) return fromInit;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.headers.has('authorization');
  return false;
}

function installAuthResponseInterceptor() {
  const current = globalThis.fetch as InterceptedFetch | undefined;
  // No fetch (SSR/older test env) or already wrapped (HMR re-evaluates modules).
  if (typeof current !== 'function' || current.__agensisAuthInterceptor) return;
  const original = current.bind(globalThis) as typeof fetch;
  const patched: InterceptedFetch = async (input, init) => {
    const response = await original(input, init);
    try {
      noteBackendResponse(requestPathOf(input), response.status, requestHadAuthHeader(input, init));
    } catch {
      // Observing a response must never break the request that produced it.
    }
    return response;
  };
  patched.__agensisAuthInterceptor = true;
  (globalThis as { fetch: typeof fetch }).fetch = patched;
}

installAuthResponseInterceptor();
