// ---------------------------------------------------------------------------
// Redaction for in-app feedback reports.
//
// A feedback report carries whatever was in the user's console at the time, and
// it lands in a workspace OTHER people can read. Console lines in this app
// routinely contain `Authorization: Bearer <session token>` (every fetch this
// client makes is authenticated) and agent `aga_` tokens, so shipping the
// buffer unfiltered would quietly move live credentials from one user's browser
// into a shared task list. That is a security incident wearing a feature's
// clothes, which is why redaction is a pure function with its own tests rather
// than an inline `.replace()` somewhere in a dialog.
//
// Design rules:
//   - Pattern-based, never allow-list based. We cannot enumerate every string a
//     log line might hold, so we enumerate the shapes of the secrets we know.
//   - Prefer over-redacting. A feedback report with `[redacted]` where a hash
//     used to be costs nothing; a leaked token costs an account.
//   - Deliberately NOT here: localStorage/sessionStorage contents and form
//     input values. Those are never captured in the first place (see
//     feedbackDiagnostics.ts and feedbackElement.ts) — redaction is the second
//     line of defence, not the first.
//
// shared/backend-core.cjs carries a CJS twin of PATTERNS (`redactSecretsText`)
// so the server redacts again on submit and a modified client cannot bypass
// this. tests/feedback-redaction-parity.test.cjs pins the two lists together.
// ---------------------------------------------------------------------------

export const REDACTED = '[redacted]';

interface RedactionPattern {
  /** Stable name — the parity test matches on these, not on the regex source. */
  name: string;
  pattern: RegExp;
  replacement: string;
}

// Order matters: specific credential shapes run before the generic
// `key = value` sweep, so a recognised token is replaced whole rather than
// leaving its prefix behind.
export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  {
    // This app's own session token: `<userId uuid>.<tokenVersion>.<issuedAt>.<base64url HMAC>`
    // (see issueAuthToken in shared/backend-core.cjs). The most important single
    // pattern in this file — it is the one credential guaranteed to exist in
    // this browser.
    name: 'agensis-session-token',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+\.\d+\.[A-Za-z0-9_-]{16,}/gi,
    replacement: REDACTED,
  },
  {
    // Every prefixed credential minted by agensis: agent/workspace/Flow/farm,
    // workspace controller, OAuth access token, and CursorBuddy connection key.
    name: 'agensis-agent-token',
    pattern: /\b(?:aga|agw|agx|agf|agc|ago|cbk)_[A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED,
  },
  {
    name: 'bearer-header',
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1 ${REDACTED}`,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED,
  },
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
    replacement: REDACTED,
  },
  {
    name: 'openai-style-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
    replacement: REDACTED,
  },
  {
    name: 'github-token',
    pattern: /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replacement: REDACTED,
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{20,}/g,
    replacement: REDACTED,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replacement: REDACTED,
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'google-api-key',
    // Open-ended, not the documented {35}: a fixed length plus \b fails to match
    // the moment a key is one character longer than the spec, which is exactly
    // the case a redactor must not miss.
    pattern: /\bAIza[0-9A-Za-z_-]{30,}/g,
    replacement: REDACTED,
  },
  {
    // Postgres/Redis/Mongo connection strings — the password is in the authority.
    name: 'connection-string-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replacement: `$1${REDACTED}@`,
  },
  {
    // The generic sweep: `secret: "value"`, `api_key=value`, `password: value`,
    // JSON or query-string shaped. Anchored on the KEY, so it does not need to
    // recognise the value's shape at all — this is what catches the credentials
    // whose format we have never seen.
    name: 'secret-assignment',
    pattern: /(["']?\b(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|session[-_]?token|connect[-_]?token|client[-_]?secret|private[-_]?key|secret|password|passwd|pwd|authorization|cookie|set-cookie)\b["']?\s*[:=]\s*)(["']?)([^\s"',;)}\]&]{3,})\2/gi,
    replacement: `$1$2${REDACTED}$2`,
  },
];

/**
 * Words that make an object key's VALUE sensitive, matched against the key with
 * separators stripped — so `accessToken`, `access_token` and `access-token` all
 * hit the same rule. Real payloads are camelCase far more often than
 * snake_case, and an earlier separator-anchored version of this missed
 * `accessToken` entirely.
 *
 * Deliberately NOT in the list: bare `auth` (it matches `author`, which this
 * app logs constantly) and bare `session` (it matches `sessionId`, which is not
 * a credential and is genuinely useful in a bug report). Both are covered by
 * their compound forms.
 */
export const SENSITIVE_KEY_WORDS =
  /token|secret|password|passwd|pwd|authorization|cookie|credential|apikey|privatekey/;

/** True when a key's value should be dropped wholesale by redactDeep. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_WORDS.test(String(key).replace(/[-_.\s]/g, '').toLowerCase());
}

/**
 * Redact known credential shapes from a single string. Pure; never throws.
 *
 * Non-string input is coerced, so callers can hand it a console argument
 * without pre-checking.
 */
export function redactSecrets(value: unknown): string {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    // Each pattern carries /g, so reset lastIndex — these RegExp objects are
    // module-level and shared across calls.
    pattern.lastIndex = 0;
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Redact a whole JSON-ish structure: every string leaf goes through
 * redactSecrets, and any value under a sensitive-looking KEY is dropped
 * entirely (a token under `authorization` does not need to match a pattern to
 * be a token).
 *
 * `depth` bounds recursion so a cyclic or pathological object cannot hang the
 * submit path.
 */
export function redactDeep<T>(value: T, depth = 6): T {
  if (depth <= 0) return REDACTED as unknown as T;
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(item => redactDeep(item, depth - 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactDeep(entry, depth - 1);
  }
  return out as unknown as T;
}

/** True when redaction changed anything — used to tell the user their report was scrubbed. */
export function containsRedactedSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
