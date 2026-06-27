const BACKEND_BASE = (() => {
  const explicit = import.meta.env.VITE_BACKEND_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return 'http://127.0.0.1:3142';
  }
  return '';
})();

const AUTH_STORAGE_KEY = 'hatch_local_session';
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
  operator: 'eq';
  value: unknown;
};

type DbChangeBinding = {
  type: 'db_changes';
  config: {
    event: string;
    schema?: string;
    table?: string;
    filter?: string;
  };
  callback: (payload: any) => void;
};

type BroadcastBinding = {
  type: 'broadcast';
  config: {
    event: string;
  };
  callback: (payload: { payload: any }) => void;
};

type ChannelBinding = DbChangeBinding | BroadcastBinding;

function backendUrl(path: string) {
  return `${BACKEND_BASE}${path}`;
}

function getWsUrl() {
  if (BACKEND_BASE) {
    return `${BACKEND_BASE.replace(/^http/, 'ws')}/backend/ws`;
  }
  return 'ws://127.0.0.1:3142/backend/ws';
}

function getStoredSession(): SessionLike | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setStoredSession(session: SessionLike | null, event: string) {
  if (typeof localStorage !== 'undefined') {
    if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  }
  authListeners.forEach((listener) => listener(event, session));
}

function authHeaders(): Record<string, string> {
  const token = getStoredSession()?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<{ data: T | null; error: { message: string; code?: string | null } | null }> {
  try {
    const response = await fetch(backendUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body ?? {}),
    });

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

class QueryBuilder<T = unknown> {
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
  private socket: WebSocket | null = null;
  private channels = new Set<LocalChannel>();
  private pendingMessages: string[] = [];
  private reconnectTimer: number | null = null;

  ensureConnected() {
    if (typeof WebSocket === 'undefined') return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.socket = new WebSocket(getWsUrl());

    this.socket.addEventListener('open', () => {
      this.flushPending();
      for (const channel of this.channels) {
        channel.resubscribe();
        channel.notifyStatus('SUBSCRIBED');
      }
    });

    this.socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data || '{}'));
        for (const channel of this.channels) {
          channel.handleMessage(message);
        }
      } catch {
        // ignore malformed messages
      }
    });

    this.socket.addEventListener('close', () => {
      this.socket = null;
      if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.ensureConnected(), 800);
    });
  }

  register(channel: LocalChannel) {
    this.channels.add(channel);
    this.ensureConnected();
    if (this.socket?.readyState === WebSocket.OPEN) {
      channel.resubscribe();
      channel.notifyStatus('SUBSCRIBED');
    }
  }

  unregister(channel: LocalChannel) {
    this.channels.delete(channel);
    this.send({ action: 'unsubscribe', channel: channel.name });
  }

  send(message: Record<string, unknown>) {
    const encoded = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encoded);
      return;
    }
    this.pendingMessages.push(encoded);
    this.ensureConnected();
  }

  private flushPending() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    while (this.pendingMessages.length > 0) {
      const next = this.pendingMessages.shift();
      if (next) this.socket.send(next);
    }
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

  on(type: 'broadcast' | 'db_changes', config: any, callback: any) {
    this.bindings.push({ type, config, callback } as ChannelBinding);
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

  handleMessage(message: any) {
    if (message.type === 'broadcast' && message.channel === this.name) {
      for (const binding of this.bindings) {
        if (binding.type === 'broadcast' && binding.config.event === message.event) {
          binding.callback({ payload: message.payload });
        }
      }
      return;
    }

    if (message.type === 'db_changes') {
      for (const binding of this.bindings) {
        if (binding.type !== 'db_changes') continue;
        const matchesTable = !binding.config.table || binding.config.table === message.table;
        const matchesSchema = !binding.config.schema || binding.config.schema === message.schema;
        const matchesEvent = binding.config.event === '*' || binding.config.event === message.payload?.eventType;
        // Honor the per-subscription row filter (e.g. "task_id=eq.<id>"). The
        // single shared socket fans every row event for a table to every
        // channel bound to it, so without this a filtered consumer would
        // receive other rows' events (e.g. a comment on task A surfacing
        // under task B).
        if (matchesTable && matchesSchema && matchesEvent && this.matchesFilter(binding.config.filter, message.payload)) {
          binding.callback(message.payload);
        }
      }
    }
  }

  private matchesFilter(filter: string | undefined, payload: any): boolean {
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

  send(message: { type: string; event: string; payload: any }) {
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

export const backendClient: any = {
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
      const session: SessionLike = {
        access_token: result.data.token,
        user: result.data.user,
      };
      setStoredSession(session, 'SIGNED_IN');
      return {
        data: { user: session.user, session },
        error: null,
      };
    },
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      const result = await postJson<{ user: SessionLike['user']; token: string }>('/backend/auth/signin', { email, password });
      if (result.error || !result.data?.user) {
        return {
          data: { user: null, session: null },
          error: result.error,
        };
      }
      const session: SessionLike = {
        access_token: result.data.token,
        user: result.data.user,
      };
      setStoredSession(session, 'SIGNED_IN');
      return {
        data: { user: session.user, session },
        error: null,
      };
    },
    async signOut() {
      setStoredSession(null, 'SIGNED_OUT');
      return { error: null };
    },
  },
};

// Resolve a backend path against the active base URL (handles dev proxy,
// Electron file:// and explicit VITE_BACKEND_BASE_URL the same way the rest
// of the client does). Used by features that hit raw endpoints (e.g. settings).
export function apiUrl(path: string) {
  return backendUrl(path);
}

// Authorization header for raw fetch() calls to backend endpoints that don't go
// through the query builder (e.g. ai-chat, settings).
export function apiAuthHeaders(): Record<string, string> {
  return authHeaders();
}
