# Code Review Update: agensis (delta vs `code-review.md`)

**Date**: 2026-06-29
**Base review**: `code-review.md` (commit `4fce9bb`, "Update code-review.md")
**Scope**: Re-review of the **current working tree** against the prior review. The tree is
mid-refactor — `git status`: **43 modified, 14 untracked** — and the untracked files map
directly onto the prior review's recommendations (`shared/backend-core.mjs`,
`src/lib/realtimeManager.ts`, `src/hooks/useTableSubscription.ts`, `src/lib/sanitize.ts`,
`src/providers/`, the activity-idempotency migration, and three new backend test suites).
This document records what those in-progress changes actually resolve, what is partial, and
what is unchanged. **No source code was modified by this review.**

---

## Verification (re-run at this review time)

| Check | `code-review.md` result | **Now** | Δ |
|---|---|---|---|
| `npm run typecheck` | PASS | **PASS** (clean) | = |
| `npm run lint` | 1 error, 23 warnings | **0 errors, 22 warnings** | error fixed |
| `npm test` (`node --test tests/*.test.cjs`) | 16/16 (1 suite) | **61 pass / 0 fail (5 suites)** | +45 tests |
| `npm run test:unit` (vitest) | (did not exist) | **3 files, 26 pass** | new harness |

Notes:
- The `_onUpdateAgent` unused-function **lint error is gone**. Remaining 22 are warnings only:
  `react-refresh/only-export-components` across `ui/`, a few `react-hooks/exhaustive-deps`
  (`CanvasObjectRenderer`, `DocWindowContent`, `FloatingWindowShell`, `WindowManagerProvider`),
  and one stale `no-constant-condition` eslint-disable in `server/index.cjs:1550`.
- The `logMessageActivityIdempotent failed` / `activity_events idempotency index migration
  failed: Unexpected SQL in test` lines in `npm test` output are **intentional negative-path
  test logging** (the suite asserts the logger swallows DB failures). Final tally is
  `pass 61 / fail 0`.

---

## Status matrix

| ID | Finding | Prior severity | **Now** |
|---|---|---|---|
| C1 | Netlify backend unauthenticated | Critical | **RESOLVED** |
| C2 | HTML sanitization gaps | Critical | **RESOLVED** (sanitize-on-read; see residual) |
| C3 | Non-idempotent Activity logging | Critical | **RESOLVED** |
| H1 | App.tsx monolith / module state | High | **PARTIAL** |
| H2 | Realtime subscription duplication | High | **PARTIAL** (substantial) |
| H3 | Token in WS query string | High | **RESOLVED** (residuals) |
| H4 | No rate limiting | High | **RESOLVED** (scaffold; in-memory) |
| H5 | Four overlapping UI ecosystems | High | **UNCHANGED** |
| H6 | Runtime schema ALTER on startup | High | **RESOLVED** (flag-gated) |
| M1 | Backend duplication server↔netlify | Medium | **PARTIAL** (netlify→core; server still parallel) |
| M2 | UI hygiene (use client, dead files, dedupe, shell) | Medium | **MOSTLY RESOLVED** |
| M3 | Lockfiles / React skew / PWA cache | Medium | **PARTIAL** |
| M6 | AuthPage hardening | Medium | **PARTIAL** |
| M7 | FileUpload hardening | Medium | **PARTIAL** (client done; server cap missing) |

---

## Critical findings — all three resolved

### C1 — Netlify backend now authenticated + RBAC-enforced ✅
`netlify/functions/backend.mjs` now imports the new shared security core and gates every
flagged route:

- `import { verifyAuthToken, enforceDbOperationAccess, assertWorkspaceRole, appendWorkspaceAccessClause, logMessageActivityIdempotent, createRateLimiter } from '../../shared/backend-core.mjs'` (`backend.mjs:7-14`).
- `requireUserId(req)` (`backend.mjs:299-304`) verifies the Bearer token and throws a `.status=401`.
- Route guards (all previously unauthenticated):
  - `/backend/db/*` → `requireUserId` + `enforceDbOperationAccess` on select/insert/update/delete (`backend.mjs:1147`, `895/909/947/976`).
  - `/backend/settings/secrets` GET & POST → `requireUserId` + `assertWorkspaceRole(..., capability:'manage')` (`backend.mjs:1149-1162`).
  - `/backend/ai-chat` → `requireUserId` + rate limit (`backend.mjs:1177-1181`).
  - `/backend/agents/dispatch` → `requireUserId` + rate limit (`1120-1124`); `/backend/agent-webhooks` (`1126-1127`); `/backend/agents/:id/connection-command` (`1129-1131`); `/backend/agents/connections` (`1117-1118`); `/backend/rpc/lookup_user_by_email` (`1139-1140`).
- The catastrophic empty-filter `update`/`delete` vector is rejected `400` **before** per-table
  logic, in shared core (`backend-core.mjs:262-316`), so it covers every table including
  `workspaces`/`app_users`.
- **Tested against the real handler**: `tests/netlify-parity.test.cjs` asserts every protected
  route returns `401` for missing / garbage / tampered-signature tokens; `tests/backend-rbac.test.cjs`
  asserts unauth `401`, no-access `403`, viewer-write `403`, editor-delete-workspace `403`, and
  the empty-filter wipe-guard `400` on both normal and `workspaces` tables — all calling the
  **real** `shared/backend-core.mjs`, not a reimplementation.

**Residual**: `server/index.cjs` keeps its **own** copy of the security helpers and does NOT
import the shared core (see M1) — parity is currently guaranteed by tests, not by code reuse.

### C2 — HTML sanitization centralized via DOMPurify ✅
- New `src/lib/sanitize.ts` wraps DOMPurify with a rich-text allowlist (`sanitizeHtml`,
  `sanitizeClipboardHtml`, `sanitizeMarkdownHtml`), forbids `script/style/iframe/object/embed/form/select/link/meta/base`, and pins `target=_blank` + `rel=noopener noreferrer nofollow` on links.
- `dompurify ^3.4.11` added to `package.json` dependencies.
- Wired at the document innerHTML sites: `DocWindowContent.tsx` render/hydrate (`134/136/344/353`)
  and **paste** (`execCommand('insertHTML', false, sanitizeClipboardHtml(html))`, `552`);
  `DocumentVersionHistory.tsx` preview (`33`) and restore (`94`).
- **Tested**: `tests/unit/sanitize.test.ts` (jsdom) covers XSS payloads.
- `canvasApps.ts` applet HTML is **intentionally excluded** and documented as such
  (`canvasApps.ts:286-291`) — applets run sandboxed in an iframe with a postMessage allowlist.
- The C2 "markdown allows raw HTML" concern is **moot**: `MarkdownContent.tsx` parses markdown
  into React elements and renders text via `{block.content}` (no `innerHTML` /
  `dangerouslySetInnerHTML` anywhere). `sanitizeMarkdownHtml` is currently **unused/defensive**.

**Residual (note, not a blocker)**: the model is **sanitize-on-read**, not sanitize-on-write.
Autosave persists the raw `contentRef.current.innerHTML` (`DocWindowContent.tsx:324`); cleaning
happens on every render/restore path. Safe as long as *every* read path sanitizes (both current
ones do), but the DB stores dirty-at-rest HTML — any future reader that bypasses `sanitizeHtml`
reintroduces the XSS. Consider sanitizing on save as defence-in-depth.

### C3 — Activity logging is idempotent ✅
- New migration `supabase/migrations/20260629120000_activity_events_message_idempotency.sql`:
  dedup cleanup + partial unique index `uq_activity_events_message_sent (entity_id) WHERE
  event_type='message_sent' AND entity_type='message'`. Mirrored at runtime in
  `server/index.cjs:617-630` and `netlify` `ensureActivityEventsIndex`.
- `server/index.cjs:logMessageActivity` (`2392-2434`) skips `"Thinking 0s"` placeholders
  (`isAgentPlaceholder`, `2397`), inserts with `on conflict do nothing` (`2423`), and fires
  `notifyDbSubscribers('activity_events','INSERT', …)` **only when a row was actually inserted**
  (`2427-2429`) — so a retried daemon finalization is a no-op and the realtime event fires once.
- Netlify uses the shared `logMessageActivityIdempotent` (`backend-core.mjs:355-392`, called at
  `backend.mjs:791`). The `ON CONFLICT` target is intentionally omitted so the statement degrades
  to a plain insert when the index is absent (documented `backend-core.mjs:344-348`).
- **Tested**: `tests/activity-idempotency.test.cjs` — same id twice → exactly one row, distinct
  ids → own rows, orphan session skipped, DB failure never throws to caller. Runs against the
  **real** shared core.

---

## High priority

### H1 — App.tsx monolith → PARTIAL ✅/⚠️
- **Done**: extracted and **wired** three of the suggested seams:
  - `WindowManagerProvider` wraps the tree (`App.tsx:61`, render `263-265`); window lifecycle /
    z-order now lives in `useWindows` behind the provider.
  - `useWorkspacePresence` (`App.tsx:72`, used `344`) and `useWorkspaceKnowledge`
    (`App.tsx:73`, used `444`) extract presence + context-counts.
  - **Module-level mutable state eliminated**: `useWindows.ts` now uses
    `const nextZIndexRef = useRef(100)` (`335`) instead of `let nextZIndex = 100`;
    `useCanvasObjects.ts` uses hook-scoped `useRef` for `nextZRef`/timer maps (`21`). This was a
    specific prior blocker (non-SSR-safe, untestable) — now hook-scoped.
- **Still open**: `App.tsx` is **2103 LOC** (was 2247 — only ~145 removed); the suggested
  `ChatOrchestrationProvider` was not created and `ChatWindowContent.tsx` **grew to 2787 LOC**
  (was 2760). The **12 `as unknown as` casts persist**.

### H2 — Realtime duplication → PARTIAL (substantial) ✅/⚠️
- **Done**: `src/lib/realtimeManager.ts` introduces a `TableRealtimeManager` singleton
  (`(schema,table,event,filter) → listeners`, reference-counted channels, `34-60`) and a
  **version-aware** `createDeduper()` keyed on `(id, version|updated_at)` (`108`) — exactly the
  prior recommendation. `src/hooks/useTableSubscription.ts` exposes it with a per-mount deduper.
- **Still open**: **7 of 10** realtime hooks adopt `useTableSubscription`; **3 still open their
  own channels** — `useCanvasObjects` (`backendClient.channel`, ~`65`), `useItemPresence`,
  `useMultiplayerCursors`. The triple-fire dedupe is therefore correct only on the migrated hooks.

### H3 — Token no longer in WS query string → RESOLVED ✅
- `getWsUrl()` returns a clean `…/backend/ws` URL with no token (`backendClient.ts:135-137`).
- Client authenticates with a **first frame** `{type:'auth', token}` on `open`, and defers
  channel (re)subscription until the server acks `{type:'system', event:'authenticated'}`
  (`backendClient.ts:344-368, 406-415`).
- **Server enforces it**: `attachRealtime` (`server/index.cjs:2636-2714`) requires the first
  message to be `auth`, runs `verifyToken` / `verifyAgentConnectToken`, **closes 1008 on
  failure**, gates every subsequent action on `await authReady`, and runs
  `authorizeRealtimeBinding` per subscribe.

**Residuals**: (1) the legacy `token=` query-string path is **still accepted server-side**
(`2642-2644`) for the daemon CLI / browser-compat window — the browser client no longer uses it,
but the vector still exists until that path is retired. (2) The session token still lives in
`localStorage` (no `HttpOnly`); unchanged from the prior review.

### H4 — Rate limiting → RESOLVED as scaffold ✅/⚠️
- `createRateLimiter` (in-memory fixed window) applied in **both** backends:
  - server: `aiChat`/`dispatch`/`webhook` limiters (`index.cjs:775-777`) at `ai-chat` (`3383`),
    `dispatch` (`3052`), `webhook-trigger` (`3098`).
  - netlify: `aiChat`/`dispatch` (`backend.mjs:20-21`) at `ai-chat` (`1179`), `dispatch` (`1122`).
- **Residual (documented in code)**: state is per-process/in-memory — on serverless it only
  limits within a warm instance, so it is a first abuse layer, **not** a hard quota. A shared
  store (Redis/etc.) is still needed for a real per-user/per-workspace budget.

### H5 — Four overlapping UI ecosystems → UNCHANGED ❌
`@base-ui/react`, `radix-ui`, `@shadcn/react`, and `shadcn` (CLI) are **all still installed**
(`package.json:28, 47, 33, 53`). Note `@shadcn/react` is now **actively imported** in
`src/components/ui/message-scroller.tsx:7`, so it cannot be removed without a code change. Still
worth a deliberate consolidation decision.

### H6 — Runtime schema mutation → RESOLVED (flag-gated) ✅
`ensureRuntimeSchema()` (broad `ALTER TABLE ADD COLUMN IF NOT EXISTS`) is now **gated behind the
`AGENSIS_RUNTIME_SCHEMA` env flag** (`server/index.cjs` ~`2771`), so production can disable it and
rely on `npm run migrate`. The concurrent-deploy race concern is mitigated when the flag is off.

---

## Medium / Low

### M1 — Backend duplication → PARTIAL ⚠️
The new `shared/backend-core.mjs` is the dependency-light security core, but **only the Netlify
function imports it**. `server/index.cjs` deliberately keeps its **own** copies
(`enforceDbOperationAccess` `413`, `createRateLimiter` `759`, `logMessageActivity` `2392`) — the
file header and the comment at `index.cjs:752-755` say the Express server will be "deduped onto
this later". So drift risk between the two backends is now mitigated by **tests** (parity + RBAC)
rather than by single-sourcing. Folding `server/index.cjs` onto the core remains the high-value
follow-up.

### M2 — UI hygiene → MOSTLY RESOLVED ✅
- `"use client"` directives in `src/components/ui/*`: **0 remaining** (was 20+). ✅
- `src/components/ui/direction.tsx` and `src/components/ui/sidebar.tsx`: **deleted** (git `D`); no
  imports remain. ✅
- `bubble.tsx` / `message.tsx` `BubbleGroup`/`MessageGroup`: **single definition each** now
  (`bubble.tsx:6`, `message.tsx:3`); duplication gone. ✅
- `<TooltipProvider>` + `<Toaster>` (sonner): **mounted** in the app shell (`App.tsx:52-53`
  imports; `907`, `1245-1246` render). ✅
- `select.tsx` vs `native-select.tsx`: **both still present, undocumented split** — UNCHANGED. ⚠️

### M3 — Build / ops hygiene → PARTIAL ⚠️
- **Root** dual lockfile: `bun.lock` **deleted** (git `D`); root now single-lockfile
  (`package-lock.json`). ✅
- **`landing/`** still ships **both** `landing/bun.lock` (40.9 KB) + `landing/package-lock.json`. ⚠️
- React skew **UNCHANGED**: root React `19` vs `landing/` React `18.3.1`
  (`package.json:48` / `landing/package.json:5`).
- VitePWA `images.pexels.com` cache **UNCHANGED** — still `CacheFirst` (`vite.config.ts:79`); the
  prior `StaleWhileRevalidate` recommendation was not applied.

### M6 — AuthPage hardening → PARTIAL ✅/⚠️
`src/components/auth/AuthPage.tsx`:
- Password policy **added**: min 10 chars, 3-of-4 character classes (`26-54`). ✅
- Signin lockout **added**: 5 attempts, exponential back-off to 300 s (`58-98`). ✅
- Password reset path: **absent** (appears intentional). ❌
- Email verification gate: **absent** (appears intentional). ❌

### M7 — FileUpload hardening → PARTIAL ⚠️
`src/components/files/FileUpload.tsx`:
- MIME/extension **allowlist added** (`31-72`) and **client size caps** (25 MB/file, 100 MB/batch,
  `25-26`, `93-95`). ✅
- **Server-side size cap still MISSING**: the upload handler `server/index.cjs:2867-2883` enforces
  no per-workspace byte limit (a comment acknowledges the handoff). Client-side caps are bypassable
  — this remains a real gap. ❌

---

## Test surface (prior: 1 suite / 16 tests → now: 8 suites / 87 tests)

New suites: `tests/backend-rbac.test.cjs`, `tests/netlify-parity.test.cjs`,
`tests/activity-idempotency.test.cjs` (node:test), and `tests/unit/{createDeduper,appletUpdateTaskAllowlist,sanitize}.test.ts` (vitest). Mapped to the prior "Recommended Minimum Test Plan":

| # | Plan item | Status | Where |
|---|---|---|---|
| 1 | server RBAC denies | **COVERED** | `backend-rbac.test.cjs` (real shared core) |
| 2 | netlify parity 401 / role | **COVERED** | `netlify-parity.test.cjs` (real handler) |
| 3 | doc innerHTML XSS roundtrip | **COVERED** | `unit/sanitize.test.ts` |
| 4 | applet bridge allow/deny | **PARTIAL** | `unit/appletUpdateTaskAllowlist.test.ts` **reimplements** the allowlist rather than exercising the real handler |
| 5 | Activity idempotency (exactly one row) | **COVERED** | `activity-idempotency.test.cjs` |
| 6 | realtime dedupe (one callback) | **COVERED** | `unit/createDeduper.test.ts` |
| 7 | module-level state isolation | **MISSING** | — |
| 8 | strict-mode double-fire cleanup | **MISSING** | — |

Quality note: the backend suites bind to the **real** `shared/backend-core.mjs` and the real
Netlify `handler` with mock DBs — i.e. they test the shipped code path, not a copy. Two caveats:
(a) they do **not** cover `server/index.cjs`'s own parallel implementation directly (only the core
that Netlify uses), so the M1 parity guarantee rests on the two backends genuinely sharing the same
contract; (b) the applet test (#4) reimplements logic and therefore proves little.

---

## New / residual risks not in the original review

1. **Sanitize-on-read, not on-write** (C2 residual): dirty HTML is persisted; safety depends on
   every reader calling `sanitizeHtml`. Add sanitize-on-save as defence-in-depth.
2. **Server still parallel to the core** (M1): `server/index.cjs` re-implements
   `enforceDbOperationAccess` / `createRateLimiter` / activity logging. A capability-table or
   wipe-guard edit must be made in **two** places; only tests catch drift. Fold the Express server
   onto `shared/backend-core.mjs`.
3. **Legacy `token=` WS path still live** (H3 residual): the query-string auth path remains
   accepted server-side for the daemon CLI. Plan its retirement (or move the CLI to first-frame
   auth) to fully close the vector.
4. **Rate limiter is per-process/in-memory** (H4 residual): on Netlify it limits only within a warm
   instance. Not a real quota until backed by a shared store.
5. **Server-side upload cap absent** (M7): client caps are advisory; the server accepts any size.
6. **22 lint warnings** remain (incl. a stale `no-constant-condition` eslint-disable at
   `server/index.cjs:1550` and several `exhaustive-deps`). Down from 1 error + 23 warnings.

---

## Recommended next actions (priority order)

1. **Fold `server/index.cjs` onto `shared/backend-core.mjs`** — eliminate the parallel security
   implementation (closes M1; removes the only remaining single-source-of-truth gap behind C1).
2. **Add a server-side upload size/MIME cap** in `server/index.cjs:2867-2883` (M7).
3. **Sanitize document content on save** as well as on read (C2 defence-in-depth).
4. **Finish H2**: migrate `useCanvasObjects`, `useItemPresence`, `useMultiplayerCursors` onto
   `useTableSubscription`.
5. **Retire / migrate the legacy `token=` WS query path** (H3).
6. **Back the rate limiter with a shared store** for a real cross-instance quota (H4).
7. **Make the applet-bridge test exercise the real handler** (test plan #4) and add the two
   missing test classes — module-state isolation (#7) and strict-mode double-fire (#8).
8. **Decide the UI-ecosystem consolidation** (H5) now that `@shadcn/react` has a live import; and
   the `select` vs `native-select` split (M2), `landing/` dual lockfile + React 18/19 skew (M3),
   and the Pexels PWA cache strategy (M3).

---

## Bottom line

The single production-blocking issue from `code-review.md` — **C1, the unauthenticated Netlify
backend** — is **resolved and regression-tested**, as are **C2** and **C3**. The high-priority set
is mostly addressed (H3/H4/H6 done; H1/H2 meaningfully advanced; H5 untouched). The dominant
remaining structural risk is **M1**: two backends still carry parallel security code kept in lockstep
only by tests — single-sourcing `server/index.cjs` onto `shared/backend-core.mjs` is the highest-value
next step. The codebase moved from "**not safe to expose publicly**" to "**serverless path is
authenticated, RBAC-enforced, rate-limited, and covered by parity tests**," with the caveats above.
