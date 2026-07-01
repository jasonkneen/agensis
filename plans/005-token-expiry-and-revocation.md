# Plan 005: Add token expiry and a real logout/revocation path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2e41d3..HEAD -- server/index.cjs netlify/functions/backend.mjs`
> If either file changed since this plan was written, re-read `issueToken`/`verifyToken` against
> the excerpts below before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (independent of plans 001-004, though it directly reduces the blast radius
  of plan 002's file-upload XSS finding if a token is ever stolen through that or any other vector)
- **Category**: security
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

The session token is a pure, deterministic function of `userId` and one global server secret, with
no expiry, no session identifier, and no way to invalidate a single token. A leaked token (from an
XSS payload, a compromised device, a log leak, anything) grants **permanent** account access with
no remediation path — a user "changing their password" after a suspected compromise does nothing
to an attacker who already holds the token, since `change-password` never touches anything the
token verification checks. The only way to invalidate any token today is to rotate the global
`AUTH_SECRET`, which logs out **every user in the system simultaneously** — not a viable incident
response for a single compromised account. This is standard, expected behavior for any
authenticated web app (a session that survives a password change is a well-known anti-pattern) and
has no dependency on the other findings in this review.

## Current state

**`server/index.cjs:217-235`** — token issuance and verification, in full:

```js
async function issueToken(userId) {
  const secret = await getAuthSecret();
  const sig = crypto.createHmac('sha256', secret).update(String(userId)).digest('base64url');
  return `${userId}.${sig}`;
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const secret = await getAuthSecret();
  const expected = crypto.createHmac('sha256', secret).update(userId).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return userId;
}
```

There is no expiry claim in the token, no session/jti, and no binding to the user's password hash
or any other per-user mutable value. Repo-wide grep at planning time for
`logout|signout|sign-out|revoke|session_id|jti|tokenVersion` in `server/index.cjs` returns no
matches — there is no revocation endpoint of any kind.

**`server/index.cjs:4371-4389`** (`/backend/users/me/change-password`) updates only
`password_hash`; it never touches anything `verifyToken` checks, confirming a token captured before
a password change remains valid after it.

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Typecheck        | `npm run typecheck`               | exit 0, no errors                |
| Lint             | `npm run lint`                    | 0 errors                          |
| Node test suite  | `npm test`                        | all pass (baseline 119)          |
| Vitest suite     | `npm run test:unit`               | all pass (baseline 46)           |

## Scope

**In scope** (the only files you should modify):
- `server/index.cjs` (`issueToken`, `verifyToken`, `requireAuth`, change-password route, new
  sign-out route)
- `netlify/functions/backend.mjs` (its own `verifyToken`/`issueToken`-equivalent and change-password
  handler — check whether it reuses `server/index.cjs`'s token functions or has its own copy;
  per the known M1 residual, expect a parallel implementation)
- `shared/backend-core.mjs` if you find the token verification logic is more naturally
  single-sourced there (only `verifyAuthToken` currently lives there per line 112 — check whether
  it's the same mechanism before assuming)
- A new migration file under `supabase/migrations/` for the schema change (a `token_version`
  column, or a `sessions` table — see Step 1 for the decision)
- `tests/backend-auth.test.cjs` and/or a new test file (see Test plan)

**Out of scope** (do NOT touch, even though they look related):
- Any change to `requireAuth`'s existing role/RBAC logic beyond adding the version/session check —
  this plan does not change *who* can access *what*, only how long a token remains valid.
- Password reset/email verification — still intentionally unimplemented per `AuthPage.tsx`'s own
  comment; out of scope here too.
- Migrating the whole auth scheme to JWTs with embedded claims, OAuth session stores, or any other
  larger redesign — the fix sketch below is deliberately the smallest change that closes the gap
  (a version counter), not a rewrite.

## Steps

### Step 1: Choose and add the invalidation mechanism

**Recommended: a `token_version` integer column on `app_users`.** Simpler than a sessions table,
sufficient to satisfy "changing your password invalidates old tokens" and "a real sign-out
invalidates the current token" (by bumping the version, which invalidates *all* of that user's
tokens — acceptable for a first pass; a per-device sessions table would allow single-device
sign-out but is a larger change, only do that instead if explicitly asked to).

Add a migration `supabase/migrations/<timestamp>_add_token_version.sql`:

```sql
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;
```

Given this repo's own recently-discovered migration-drift problem (a separate finding, tracked
elsewhere: the canonical `supabase/migrations/` path was found missing a column two other schema
sources already had), make sure this migration is added to **all three** schema-of-truth locations
consistently if your executor environment's convention requires it — at minimum, confirm with
`grep -rn "token_version" database/neon-schema.sql supabase/migrations/ netlify/database/migrations/`
after this step that at least `supabase/migrations/` (the canonical path per `scripts/migrate.mjs`)
has it, and add it to `database/neon-schema.sql`'s `app_users` table definition too so a fresh
`db:neon:push` bootstrap includes it from day one.

**Verify**: `npm run migrate` (against a scratch/test database, not production) applies cleanly and
`select token_version from app_users limit 1` returns `1` for existing rows.

### Step 2: Embed and check the version in the token

Change `issueToken`/`verifyToken` in `server/index.cjs` to include the version:

```js
async function issueToken(userId, tokenVersion) {
  const secret = await getAuthSecret();
  const payload = `${userId}.${tokenVersion}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const [userId, tokenVersionStr] = payload.split('.');
  if (!userId || !tokenVersionStr) return null;
  const secret = await getAuthSecret();
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  // Check the signed version still matches the user's CURRENT version in the DB.
  const rows = await getDb().unsafe('select token_version from app_users where id = $1 limit 1', [userId]);
  if (!rows[0] || String(rows[0].token_version) !== tokenVersionStr) return null;
  return userId;
}
```

Update every call site of `issueToken(user.id)` (signup, signin) to
`issueToken(user.id, user.token_version)` — you will need to select `token_version` alongside the
other user columns at those call sites (`/backend/auth/signup` and `/backend/auth/signin`).

**Verify**: a freshly issued token still authenticates (no regression); a token crafted with a
stale/wrong `tokenVersion` segment fails `verifyToken` (returns `null` → 401).

**Performance note — read before implementing**: today's `verifyToken` is pure in-process HMAC
computation with **zero I/O**. `requireAuth` (the Express middleware) calls `verifyToken` on
*every* authenticated HTTP request, and the WebSocket first-frame auth path calls the equivalent
check on every connection — both are hot paths for this realtime app. The version above adds a
`select token_version from app_users where id = $1` **inside** `verifyToken`, turning a zero-I/O
check into a DB round-trip on every single authenticated request. That is a real latency/load
change, not a detail — do not ship it unmitigated. Add a short-lived in-process cache keyed by
`userId`, following the same simple module-level-cache style already used for the auth secret
itself (`cachedAuthSecret`/`cachedAuthSecretSource`, `server/index.cjs:188-214`):

```js
const tokenVersionCache = new Map(); // userId -> { version, expiresAt }
const TOKEN_VERSION_CACHE_TTL_MS = 10_000; // 10s: bounds staleness of revocation, bounds DB load

async function getCachedTokenVersion(userId) {
  const now = Date.now();
  const cached = tokenVersionCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.version;
  const rows = await getDb().unsafe('select token_version from app_users where id = $1 limit 1', [userId]);
  const version = rows[0] ? String(rows[0].token_version) : null;
  tokenVersionCache.set(userId, { version, expiresAt: now + TOKEN_VERSION_CACHE_TTL_MS });
  return version;
}
```

Use `getCachedTokenVersion(userId)` in `verifyToken` instead of querying directly. This bounds the
worst case to one DB query per user per 10 seconds (tune the TTL if the plan's reviewer wants a
different staleness/load trade-off) rather than one per request, while still making sign-out/
password-change take effect within a bounded, short window instead of "never" (today) or
"immediately at unbounded DB cost" (the unmitigated version above). This cache has no eviction —
for a very large, long-running user base this is an unbounded-growth Map; if that's a concern for
this deployment's scale, evict on a timer or cap the Map size, but do not skip the cache entirely
to avoid that complexity, since an uncached per-request DB query is the worse trade-off.

### Step 3: Bump the version on password change; add a sign-out endpoint

In `/backend/users/me/change-password` (~line 4371), after updating `password_hash`, also run
`update app_users set token_version = token_version + 1 where id = $1`. This invalidates every
existing token for that user, including any stolen one — the user's *own* current session will
need to re-authenticate too (acceptable and expected: return a fresh token in the response so the
client doesn't have to force a full re-login if you want a smoother UX, or simply have the client
call `/backend/auth/signin` again — check with whoever reviews this plan's PR which UX is
preferred, but either is a valid implementation of the security fix itself).

Add a new route, `POST /backend/auth/signout` (`requireAuth`), that runs the same
`token_version + 1` bump for `req.userId` and returns `{ data: { ok: true }, error: null }`. Wire
the client (`src/lib/backendClient.ts` or wherever sign-out is currently just a local
`localStorage.removeItem` — check `src/providers/` or `src/App.tsx` for the current sign-out
handler) to call this new endpoint before clearing local state, so sign-out actually revokes the
token server-side instead of just forgetting it client-side.

**Verify**: after calling `/backend/auth/signout` with token A, a subsequent request using token A
returns 401; a fresh signin issues token B, which works.

### Step 4: Apply the same change to the Netlify backend

Locate `netlify/functions/backend.mjs`'s equivalent of `issueToken`/`verifyToken` (search for
`createHmac` or `issueToken`) and `change-password` handler (~line 878, per the recon). Apply the
identical `token_version` check and bump. If this logic is meaningfully shared with
`shared/backend-core.mjs`'s `verifyAuthToken` (line 112), prefer extending that shared function
over duplicating the version check a third time — check its current signature first.

**Verify**: repeat Step 2/3's verification against the Netlify path (via
`tests/netlify-parity.test.cjs`'s existing pattern of calling the real handler).

## Test plan

Extend `tests/backend-auth.test.cjs` and `tests/netlify-parity.test.cjs`:

- A freshly issued token authenticates successfully.
- After calling change-password, the *old* token (issued before the change) is rejected (401) on
  the next request.
- After calling the new sign-out endpoint, the token used to call it is rejected (401) on a
  subsequent request.
- A token with a tampered `tokenVersion` segment (but a validly-recomputed signature for that
  tampered payload — i.e. simulating what happens if an attacker tries to roll back their own
  captured token's version) is rejected because the DB's current version won't match.
- Existing RBAC/auth tests in `tests/backend-rbac.test.cjs` still pass unmodified (confirms the
  version check doesn't break the existing 401/403 test matrix for other reasons).
- The `tokenVersionCache` actually caches: bump a user's `token_version` directly in the DB (bypass
  the app, simulate an out-of-band change), then confirm a request within the TTL window still
  authenticates against the *old* cached version (proves the cache is real, not a no-op), and a
  request after the TTL expires picks up the new version and rejects the old token.

Verification: `npm test` → all pass, including new cases, no regressions in the 119-test baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run migrate` (or equivalent) applies the `token_version` column cleanly
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including the new token-invalidation test cases on both backends
- [ ] A token issued before a password change is rejected after that change (verified by test, not
      just by inspection)
- [ ] `POST /backend/auth/signout` exists, requires auth, and invalidates the calling token
      (verified by test)
- [ ] `verifyToken` uses a short-TTL in-process cache for `token_version` lookups, not an
      unconditional per-request DB query (`grep -n "tokenVersionCache" server/index.cjs` shows the
      cache in place) — do not mark this plan done with an uncached DB query on every request
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `netlify/functions/backend.mjs`'s token verification turns out to be structurally different
  enough from `server/index.cjs`'s (e.g. already delegates fully to `shared/backend-core.mjs` in a
  way this plan didn't anticipate) that the same patch doesn't apply cleanly — describe the
  difference rather than forcing a mismatched fix.
- Deploying this change would immediately invalidate all currently-issued tokens for all users
  (e.g. if `token_version` can't default existing rows to a value that matches what's already
  embedded in outstanding tokens) — since old tokens don't currently carry any version, this
  should NOT happen (any pre-existing token has no version segment at all, so
  `payload.split('.')` on an old two-part token yields `tokenVersionStr === undefined`, which the
  new `verifyToken` correctly rejects — meaning **every currently logged-in user will be signed out
  once this ships**, forcing a fresh signin). Confirm this is an acceptable one-time deploy
  consequence with whoever owns the release before shipping; it is NOT a bug in this plan, but it
  is a real, user-visible event worth flagging rather than silently shipping.

## Maintenance notes

- This plan intentionally chose a single `token_version` (invalidate-everything-on-bump) over a
  per-device sessions table (selective single-device sign-out) to keep the change small. If a
  future requirement needs "sign out of just this device," that's a larger follow-up plan (a real
  `sessions` table keyed by a random session id, not a version counter).
- Anyone adding a new place that issues a token in the future must remember to select and pass the
  user's current `token_version` — there's no compiler enforcement of this; a code reviewer should
  watch for new `issueToken(` call sites.
- Consider a shorter token TTL with a refresh mechanism as further hardening later — out of scope
  for this plan, which only closes the "no revocation at all" gap.
- The `tokenVersionCache`'s 10s TTL means sign-out/password-change revocation is bounded, not
  instant — a token could remain valid for up to ~10s after revocation on instances that had it
  cached. This is a deliberate trade-off (unbounded DB load vs. bounded revocation delay); revisit
  the TTL value if a future incident response need requires faster-than-10s revocation. The cache
  is also unbounded in size (no eviction beyond TTL expiry) — fine at this app's expected scale, but
  worth capping or adding an eviction sweep if the user base grows large enough for that to matter.
