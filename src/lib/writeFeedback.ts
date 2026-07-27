// Turning a failed write into something a user can act on.
//
// Every write path in this app reports failure differently and none of them
// carry an HTTP status: backendClient's postJson collapses a 403, a 500 and a
// dropped socket into the same `{ message, code }` with no status attached, and
// a proxy/gateway failure whose body isn't JSON arrives as the literal string
// 'Invalid JSON response'. Raw fetch call sites do have a Response.status, so
// this accepts one when the caller has it and falls back to parsing the message
// when it doesn't.
//
// It lives on its own — no React, no DOM — because "was this the user's fault,
// the server's, or the network's, and is retrying worth offering" is a decision
// worth testing directly instead of through a rendered toast.

export type WriteFailureKind =
  | 'offline'
  | 'network'
  | 'auth'
  | 'permission'
  | 'rate-limit'
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'server'
  | 'workspace-unavailable'
  | 'unknown';

export interface WriteFailure {
  kind: WriteFailureKind;
  /** Whether repeating the same action could plausibly succeed. */
  retryable: boolean;
  /** One plain sentence naming the cause. Never a raw internal string. */
  reason: string;
  /** The server's own wording, when it is fit to show a user. */
  detail: string | null;
}

/** Anything a write path in this app can hand back as a failure. */
export type WriteErrorLike =
  | { message?: unknown; code?: unknown; status?: unknown; error?: unknown }
  | Error
  | string
  | null
  | undefined;

export interface ClassifyOptions {
  /** navigator.onLine, passed in so this module never touches the browser. */
  online?: boolean;
  /** HTTP status, when the call site has a Response and doesn't have to guess. */
  status?: number | null;
}

// Messages that describe our own plumbing rather than anything the user did.
// Showing these ('Invalid JSON response') is barely better than showing nothing.
const INTERNAL_MESSAGES = [
  'invalid json response',
  'network error',
  'failed to fetch',
  'load failed',
  'fetch failed',
  'networkerror when attempting to fetch resource.',
  'something went wrong',
];

const TRANSPORT_PATTERN =
  /failed to fetch|network(?:error)? ?error|networkerror|load failed|fetch failed|connection (?:refused|reset|closed|failed)|err_(?:internet_disconnected|network|connection_)|socket hang up|econnrefused|etimedout/i;

const AUTH_PATTERN = /authentication required|not authenticated|unauthenti[ck]ated|unauthorized|invalid (?:token|signature|session)|session (?:expired|invalid)|sign in again|token expired/i;
const PERMISSION_PATTERN = /forbidden|do(?:es)? not have permission|not permitted|not allowed|no access|access denied|is not selectable|cannot (?:move|reassign|create a workspace for)/i;
const RATE_LIMIT_PATTERN = /rate limit|too many requests|rate_limited|slow down/i;
const NOT_FOUND_PATTERN = /not found|no longer exists|does not exist|unknown (?:table|workspace|agent|session)/i;
const CONFLICT_PATTERN = /conflict|already exists|duplicate|version mismatch/i;
const VALIDATION_PATTERN = /invalid|required|must be|missing|malformed|too long|too short|unsupported|validation/i;
const SERVER_PATTERN = /internal server error|server error|bad gateway|service unavailable|gateway timeout|upstream|database|timeout/i;

const REASONS: Record<WriteFailureKind, string> = {
  offline: "You're offline — this will need a connection.",
  network: "Couldn't reach the server. Check your connection and try again.",
  auth: 'Your session has expired. Sign in again.',
  permission: "You don't have permission to do that.",
  'rate-limit': 'Too many requests — wait a moment and try again.',
  validation: 'The server rejected those details.',
  'not-found': 'That no longer exists.',
  conflict: 'Something changed this first — reload and try again.',
  server: 'The server had a problem. Nothing was saved.',
  'workspace-unavailable': "This workspace hasn't loaded — reload the page and try again.",
  unknown: 'Something went wrong and nothing was saved.',
};

const RETRYABLE: WriteFailureKind[] = ['offline', 'network', 'rate-limit', 'server', 'workspace-unavailable', 'unknown'];

/**
 * The app rendered without a workspace id — the boot fetch failed, so a write
 * has nowhere to go. Distinct from a rejected write: nothing was even attempted.
 */
export const WORKSPACE_UNAVAILABLE: WriteFailure = Object.freeze({
  kind: 'workspace-unavailable',
  retryable: true,
  reason: REASONS['workspace-unavailable'],
  detail: null,
});

/** Pull the message string out of whatever shape the call site had. */
export function writeErrorText(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error.trim();
  if (error instanceof Error) return error.message.trim();
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message.trim();
    // `{ error: 'Invalid signature' }` and `{ error: { message } }` both occur.
    if (typeof record.error === 'string') return record.error.trim();
    if (record.error && typeof record.error === 'object') {
      const nested = (record.error as Record<string, unknown>).message;
      if (typeof nested === 'string') return nested.trim();
    }
    if (typeof record.code === 'string') return record.code.trim();
  }
  return '';
}

/** The server's message, or null when it only describes our own plumbing. */
export function presentableDetail(error: unknown): string | null {
  const text = writeErrorText(error);
  if (!text) return null;
  if (/^request failed \(\d{3}\)$/i.test(text)) return null;
  if (/^\w[\w ]* http \d{3}$/i.test(text)) return null;
  if (INTERNAL_MESSAGES.includes(text.toLowerCase())) return null;
  return text;
}

function readStatus(error: unknown, explicit?: number | null): number | null {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  if (error && typeof error === 'object' && !(error instanceof Error)) {
    const value = (error as Record<string, unknown>).status;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  if (error instanceof Error) {
    const value = (error as Error & { status?: unknown }).status;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const text = writeErrorText(error);
  // 'Request failed (403)' and 'Agents HTTP 500' — the two shapes this codebase
  // actually produces. Nothing looser: a status-like number inside a real
  // sentence ("expected 404 rows") must not be read as the status.
  const parenthesised = /\((\d{3})\)\s*$/.exec(text);
  if (parenthesised) return Number(parenthesised[1]);
  const httpPrefixed = /\bhttp\s+(\d{3})\b/i.exec(text);
  if (httpPrefixed) return Number(httpPrefixed[1]);
  return null;
}

function kindFromStatus(status: number): WriteFailureKind | null {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 422) return 'validation';
  if (status >= 500) return 'server';
  if (status >= 400) return 'validation';
  return null;
}

function kindFromCode(code: string): WriteFailureKind | null {
  const normalized = code.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'rate_limited') return 'rate-limit';
  if (normalized === 'unauthorized' || normalized === 'unauthenticated') return 'auth';
  if (normalized === 'forbidden') return 'permission';
  if (normalized === 'not_found') return 'not-found';
  if (normalized === 'conflict' || normalized === 'coding_route_unavailable') return 'conflict';
  if (normalized === 'agent_offline' || normalized === 'inference_failed') return 'server';
  return null;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as Record<string, unknown>).code;
  return typeof value === 'string' ? value : '';
}

/**
 * Decide what a failed write means. Order matters: an explicit status or code
 * beats message sniffing, and being offline beats everything (a request that
 * never left the machine says nothing about the server).
 */
export function classifyWriteFailure(error: unknown, options: ClassifyOptions = {}): WriteFailure {
  const online = options.online !== false;
  const detail = presentableDetail(error);

  if (!online) return build('offline', detail);

  const status = readStatus(error, options.status);
  if (status !== null) {
    const kind = kindFromStatus(status);
    if (kind) return build(kind, detail);
  }

  const codeKind = kindFromCode(errorCode(error));
  if (codeKind) return build(codeKind, detail);

  const text = writeErrorText(error);
  if (!text) return build('unknown', detail);
  if (TRANSPORT_PATTERN.test(text)) return build('network', null);
  // 'Invalid JSON response' is what postJson leaves behind when the body wasn't
  // JSON at all — a proxy or gateway answering with HTML. That is a server-side
  // problem, and it must be caught before the word "Invalid" reaches the
  // validation matcher and gets blamed on what the user typed.
  if (/^invalid json response$/i.test(text)) return build('server', null);
  if (AUTH_PATTERN.test(text)) return build('auth', detail);
  if (PERMISSION_PATTERN.test(text)) return build('permission', detail);
  if (RATE_LIMIT_PATTERN.test(text)) return build('rate-limit', detail);
  if (NOT_FOUND_PATTERN.test(text)) return build('not-found', detail);
  if (CONFLICT_PATTERN.test(text)) return build('conflict', detail);
  if (SERVER_PATTERN.test(text)) return build('server', detail);
  if (VALIDATION_PATTERN.test(text)) return build('validation', detail);
  return build('unknown', detail);
}

function build(kind: WriteFailureKind, detail: string | null): WriteFailure {
  // Prefer the server's own wording where it is both presentable and specific
  // to what the user did — a 403 says exactly which permission is missing, and
  // a 400 says which field is wrong. Transport and auth failures get our
  // wording: theirs is either absent or unhelpful.
  const usesDetail = detail !== null && (kind === 'permission' || kind === 'validation' || kind === 'conflict' || kind === 'not-found' || kind === 'unknown');
  return {
    kind,
    retryable: RETRYABLE.includes(kind),
    reason: usesDetail ? (detail as string) : REASONS[kind],
    detail,
  };
}

/**
 * All a composer needs to know about a send it kicked off: whether the user's
 * words are actually saved. Structural on purpose, so the composers depend on
 * this and not on useChat.
 */
export interface SendOutcome {
  delivered: boolean;
}

export interface WriteFailureNotice {
  title: string;
  description: string;
}

/**
 * Compose the toast. `action` is an infinitive phrase describing what the user
 * was trying to do — 'send your message', 'create the agent' — so the title
 * reads "Couldn't create the agent".
 */
export function writeFailureNotice(action: string, failure: WriteFailure): WriteFailureNotice {
  return {
    title: `Couldn't ${action}`,
    description: failure.reason,
  };
}

/** Classify and compose in one step, for the common call site. */
export function describeWriteFailure(
  action: string,
  error: unknown,
  options: ClassifyOptions = {},
): WriteFailureNotice {
  return writeFailureNotice(action, classifyWriteFailure(error, options));
}
