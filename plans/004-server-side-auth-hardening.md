# Plan 004: Enforce password policy and add rate-limiting server-side (both backends)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2e41d3..HEAD -- server/index.cjs netlify/functions/backend.mjs src/components/auth/AuthPage.tsx src/components/account/AccountDialog.tsx`
> If any of these changed since this plan was written, re-read them against the excerpts below
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

This plan merges three angles on one root cause, all independently confirmed against the live
code: (1) `AuthPage.tsx` implements a real password-complexity policy (min 10 chars, 3-of-4
character classes) and a signin lockout, but both are pure client-side state — the actual server
routes (`/backend/auth/signup`, `/backend/auth/signin`, `/backend/users/me/change-password`, on
**both** the Express and Netlify backends) enforce only a 6-character minimum and no rate limiting
at all; (2) the newer `AccountDialog.tsx` change-password UI re-implements its *own*, even weaker,
6-character-only check from scratch, so the app now has the policy defined in three places and
enforced nowhere but the signup screen's client-side hint; (3) there is no throttling anywhere on
signin, so an unlimited-attempt password-guessing script against `/backend/auth/signin` is not
slowed down at all, despite the client UI showing a fake "locked out" state. `AuthPage.tsx` itself
already contains a code comment explicitly calling out that server-side re-validation "MUST"
happen — this plan is that follow-through.

## Current state

**`src/components/auth/AuthPage.tsx:16-30,42-49`** — the real policy, client-side only:

```js
/*
 * SECURITY NOTE — these are CLIENT-SIDE UX guards only and are trivially
 * bypassable (devtools, direct API calls, disabling JS). They reduce casual
 * misuse and guide users toward strong credentials, but the real enforcement
 * MUST live on the server:
 *   - Password complexity must be re-validated server-side on signup.
 *   - Failed-login rate limiting / lockout must be enforced server-side
 *     (per-account and per-IP); the back-off below only throttles this client.
 *   - Password reset and email verification are NOT implemented server-side,
 *     so they are intentionally absent here (we do not fake a reset flow).
 */

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MIN_CLASSES = 3; // at least 3 of: lowercase, uppercase, digit, symbol

function evaluatePassword(password) {
  const classesMet =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0);
  const longEnough = password.length >= PASSWORD_MIN_LENGTH;
  const valid = longEnough && classesMet >= PASSWORD_MIN_CLASSES;
  ...
}
```

`evaluatePassword` is **not exported** from `AuthPage.tsx` — it's a private, file-local function.

**`server/index.cjs:4274-4294`** (`/backend/auth/signup`) and **`:4371-4389`**
(`/backend/users/me/change-password`) — only a 6-char length check, no rate limiting:

```js
app.post('/backend/auth/signup', async (req, res) => {
  ...
  if (password.length < 6) return jsonError(res, 400, new Error('Password must be at least 6 characters'));
  ...
});

app.post('/backend/auth/signin', async (req, res) => {
  // no rate limiting, no lockout — just email/password lookup
  ...
});

app.post('/backend/users/me/change-password', requireAuth, async (req, res) => {
  ...
  if (newPassword.length < 6) return jsonError(res, 400, new Error('New password must be at least 6 characters'));
  ...
});
```

**`netlify/functions/backend.mjs:804`** (signup) and **`:878`** (change-password) — the identical
6-char-only checks, confirmed present on the Netlify path too. `handleAuth` (line 796) covers both
`/backend/auth/signup` and `/backend/auth/signin` (dispatched at line 1262-1263); neither applies a
rate limiter.

**`src/components/account/AccountDialog.tsx:62`** — a third, independent, weaker re-implementation:

```js
if (newPassword.length < 6) {
  // (component-local check, no character-class requirement at all)
```

**`server/index.cjs:875-899`** — the existing rate-limiter utility already used elsewhere (reuse
this, do not write a new one):

```js
function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map();
  function check(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    const allowed = entry.count <= max;
    return { allowed, retryAfterMs: allowed ? 0 : Math.max(0, entry.resetAt - now) };
  }
  return { check };
}

const aiChatRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
// ... dispatchRateLimiter, webhookRateLimiter, mcpRateLimiter, skillRateLimiter follow the same pattern

function rateLimitBlocked(res, limiter, key) {
  const result = limiter.check(String(key || 'unknown'));
  if (result.allowed) return false;
  // writes 429 + Retry-After, returns true
  ...
}
```

Call sites follow the pattern `if (rateLimitBlocked(res, someLimiter, someKey)) return;` at the top
of a route handler (e.g. `server/index.cjs:4759` for `ai-chat`).

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Typecheck        | `npm run typecheck`               | exit 0, no errors                |
| Lint             | `npm run lint`                    | 0 errors                          |
| Node test suite  | `npm test`                        | all pass (baseline 119)          |

## Scope

**In scope** (the only files you should modify):
- `src/lib/passwordPolicy.ts` (new file — the single source of truth for the policy)
- `src/components/auth/AuthPage.tsx` (import from the new shared module instead of defining locally)
- `src/components/account/AccountDialog.tsx` (use the shared policy instead of its own 6-char check)
- `server/index.cjs` (signup, signin, change-password routes)
- `netlify/functions/backend.mjs` (the same three routes)
- `shared/backend-core.mjs` (recommended location for the server-side policy check + a new rate
  limiter factory, so both backends import one copy — matches the existing pattern where this file
  already holds `enforceDbOperationAccess` for the Netlify path)
- `tests/backend-auth.test.cjs` and/or `tests/netlify-parity.test.cjs` (extend with new cases)

**Out of scope** (do NOT touch, even though they look related):
- Password reset / email verification flows — `AuthPage.tsx`'s own comment states these are
  intentionally absent (not implemented server-side at all); do not add them as part of this plan.
- The MCP invite-role gap and the stored-XSS file-upload gap — tracked as separate plans; do not
  fix them here even if you notice related code while in these files.
- Signin itself should **not** gain a complexity check (only signup and change-password create/set
  a password) — do not reject an existing user's *login* attempt for not meeting the new policy;
  only gate password *creation*.

## Steps

### Step 1: Extract the shared password policy

Create `src/lib/passwordPolicy.ts` containing `PASSWORD_MIN_LENGTH`, `PASSWORD_MIN_CLASSES`, and an
exported `evaluatePassword(password: string)` function — move the existing logic from
`AuthPage.tsx` verbatim (do not change its behavior, only its location and export visibility).
Update `AuthPage.tsx` to `import { evaluatePassword, PASSWORD_MIN_LENGTH, PASSWORD_MIN_CLASSES }
from '../../lib/passwordPolicy'` and delete its local copy.

**Verify**: `npm run typecheck` passes; `AuthPage.tsx`'s existing signup UX (strength label,
inline error message) renders unchanged — no behavior change, pure extraction.

### Step 2: Point `AccountDialog.tsx`'s change-password check at the shared policy

Replace `AccountDialog.tsx`'s local `newPassword.length < 6` check with a call to the same
`evaluatePassword` from Step 1, showing the same "Too short" / "Weak" / "Fair" / "Strong" messaging
`AuthPage.tsx` already has (reuse its inline-error rendering pattern rather than inventing new
copy).

**Verify**: manually confirm `AccountDialog.tsx` now rejects a password like `abc123` (fails the
class-count check) with the same message style as signup.

### Step 3: Port the policy check into both servers, plus one rate limiter each

Confirmed at planning time: `shared/backend-core.mjs` **already exports** `createRateLimiter`
(line 402) and `roleHasWorkspaceCapability` (line 215) — it does not yet export a password-policy
function. Add one export there: `evaluatePasswordServerSide(password)`, a plain-JS re-implementation
of Step 1's rule (character-class counting + length check; no framework dependency needed, so it
works from both the ESM Netlify path and can be ported inline to `server/index.cjs`'s CJS style).

For the rate limiter: `server/index.cjs` is documented (comment at line 866-874) as deliberately
**not** importing `shared/backend-core.mjs` for its existing limiters, to keep that file
self-contained — stay consistent with that and add a fourth in-process limiter directly in
`server/index.cjs` using its own existing `createRateLimiter({...})` factory (~line 875), the same
way `aiChatRateLimiter`/`dispatchRateLimiter`/etc. are already declared. For
**`netlify/functions/backend.mjs`**, import and use the `createRateLimiter` that already exists in
`shared/backend-core.mjs` (line 402) — do not write a third copy.

In **`server/index.cjs`**:
- `/backend/auth/signup` (~4274): after the existing `!email || !password` check, call
  `evaluatePassword(password)` (or its server equivalent) and reject with 400 + the same class of
  message if invalid, replacing the bare `password.length < 6` check.
- `/backend/auth/signin` (~4296): add `if (rateLimitBlocked(res, signinRateLimiter,
  \`signin:${email}\`)) return;` right after the email is parsed, using a new
  `signinRateLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })` (matching `AuthPage.tsx`'s
  documented "5 attempts" intent) declared alongside the existing limiters (~line 895).
- `/backend/users/me/change-password` (~4371): replace `newPassword.length < 6` with the same
  policy check as signup.
- `/backend/auth/signup` should also get a rate limiter (looser than signin, e.g. `max: 10` per
  window) keyed by IP, to slow down bulk account creation.

In **`netlify/functions/backend.mjs`**: apply the identical three changes to `handleAuth`'s signup
branch (~line 804), the signin branch, and the change-password handler (~line 878), reusing
whatever policy/rate-limiter function you added to `shared/backend-core.mjs` in this step (the
Netlify backend already imports from `shared/backend-core.mjs` for other security logic — follow
that existing import pattern).

**Verify**: `curl -X POST .../backend/auth/signup -d '{"email":"a@b.com","password":"abc123"}'`
(via a test, not manually against a live server) now returns 400 with a complexity-related message
instead of succeeding; six rapid signin attempts with a wrong password against the same email
return 429 on the sixth.

## Test plan

Extend `tests/backend-auth.test.cjs` (Express) and `tests/netlify-parity.test.cjs` (Netlify) —
both already exercise these exact routes per the existing suite — with:

- Signup with a 6-11 character, single-character-class password (e.g. `"abcdefgh"`) is rejected
  with 400 on both backends.
- Signup with a policy-compliant password (e.g. `"Tr0ub4dor&3xyz"`) still succeeds on both backends
  (no regression).
- Change-password with a weak `newPassword` is rejected with 400 on both backends.
- Five failed signin attempts for the same email succeed (with 401, wrong password) but the sixth
  within the same window returns 429, on both backends.
- **Check existing fixtures first**: grep `tests/*.test.cjs` for any hardcoded short test passwords
  (e.g. `"password123"` or similar used to exercise unrelated routes) that would now fail the new
  policy — update those fixtures to a compliant password *before* running the suite, so this plan's
  change doesn't spuriously break unrelated tests.

Verification: `npm test` → all pass, including new cases, no regressions in the 119-test baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including new auth-hardening test cases on both backends
- [ ] `grep -rn "evaluatePassword" src/lib/passwordPolicy.ts src/components/auth/AuthPage.tsx src/components/account/AccountDialog.tsx` shows one definition and two imports (no duplicate logic)
- [ ] `grep -n "password.length < 6" server/index.cjs netlify/functions/backend.mjs` returns no
      matches (the weak inline check is fully replaced)
- [ ] A rate limiter is applied to signin (and ideally signup) on both backends
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Existing tests hardcode short passwords for unrelated fixtures in a way that's expensive to
  update safely (e.g. many call sites, or passwords baked into fixture JSON files) — report back
  rather than mass-editing test data you're not confident about.
- `shared/backend-core.mjs` turns out to already have divergent-but-similarly-named exports that
  would collide with what this plan adds — stop and reconcile naming rather than shadowing.
- The rate-limiter approach for signin conflicts with an existing, different lockout mechanism you
  discover while implementing (the plan assumes none exists server-side today, per the audit).

## Maintenance notes

- This plan does not address the deeper issue that stolen/leaked tokens never expire (tracked
  separately) — rate-limiting and password strength reduce how *easily* an account is compromised
  via guessing, not what happens after a token is otherwise obtained.
- The in-memory rate limiter (matching the existing `createRateLimiter` pattern) is per-process —
  on a multi-instance deploy it only limits within one warm instance, same documented caveat as the
  existing `aiChatRateLimiter`/`dispatchRateLimiter`. Backing it with a shared store (Redis, etc.)
  is a separate, larger, already-tracked follow-up (see `code-review-update.md`'s H4 residual) —
  do not attempt that as part of this plan.
- Any future third place that re-implements password validation (as `AccountDialog.tsx` did) should
  import `src/lib/passwordPolicy.ts` — there's no compiler-enforced guarantee of this, so a code
  reviewer should watch for `password.length` regex/comparison patterns appearing outside that file
  in future PRs.
