# agensis — Full Code Review, July 2026

**Date:** 2026-07-01
**Scope:** Ground-up review of the full repository (frontend `src/`, daemon `server/`, Netlify mirror `netlify/functions/`, shared core, CLI, schema/migrations, CI). All Critical/High/Medium findings below were adversarially verified against current source (a refutation pass was attempted on each; 1 finding was refuted and dropped). Items marked *unverified-low* are low-severity spot findings not put through refutation.

---

## 0. Remediation Status (updated 2026-07-01)

Every Critical/High/Medium finding has been fixed, plus 9 Low items. Test suite grew 154 → 163 node + 53 vitest with new coverage (RBAC cross-tenant, realtime revocation, merge divergence, signin lockout).

**Fixed & merged to `main`:** H1 (cross-tenant write), H2 (rate-limit keying), H3 (comment-mention gate), H5 (WS realtime), H7 (CI green), H8 (CLI packaging), M1/L1 (table access).

**Fixed on branch `fix/h4-realtime-revocation` (awaiting merge + `fly deploy`):** H4 (realtime revocation), M3 (MCP reaper), M4 (Netlify ai-chat auth), M6 (dispatch error surfacing), M7 (merge clock-skew), M9 (offline dead-letter), M12/M13 (SSE consumers), M14 (burst-job guard), M15 (active-job unique index across instances), M8 (offline cache coherence), L2 (pg error leak), L3 (signin lockout), L5 (non-active-window context), L7 (showcase code-split), L8 (unused dep), L10 (stray asset), L11/L13 (branding/URL), L12 (PWA/home-screen PNG icons).

**⚠️ Not live until deployed:** backend fixes run on fly.dev and require `fly deploy`; frontend fixes ship on the next Netlify push.

**Deferred — need an owner decision / infra:**
- **L4** (hash invite tokens) — the invites **list route returns the plaintext `token`** so the UI can re-display/copy the invite link. Hashing at rest requires changing that to a show-the-token-once UX (like agent tokens) — a product decision, not a safe storage-only change.
- **H6** (upload durability) — needs a Fly volume provisioned before `[[mounts]]` + `AGENSIS_UPLOAD_ROOT` can be wired (adding the mount for a non-existent volume would break deploys).
- **L4** (hash invite tokens) — needs a migration for existing plaintext tokens.
- **L6** (stale `netlify/database/migrations`) — confirmed NOT auto-applied by Netlify, but `plans/006` treats `0006` as canonical and defers the delete decision; left in place.
- **L12** (PWA PNG icons) — needs generated PNG assets.
- **H6** (upload durability) — needs a Fly volume provisioned before `[[mounts]]` can be added.

---

## 1. Executive Summary

The product is feature-rich and moving fast, but the safety net is gone and the multi-tenant boundary has real holes.

**The CI gate is permanently red.** All 30 most recent GitHub Actions runs on `main` failed — for two compounding reasons: `package-lock.json` is out of sync with `package.json` (`npm ci` fails on `esbuild@0.28.1`), and when install does succeed, 14 typecheck errors and 12 lint errors abort the job before tests run. The 200 passing tests (154 node + 46 vitest) never execute in CI. Effectively zero regression signal has shipped with recent commits, and at least one typecheck error is a genuine runtime bug (`App.tsx:1521` — a 3-arg handler assigned to a 2-arg prop, so `messageContent` is silently `undefined`).

**Top 3 risks:**

1. **Cross-tenant write via `/backend/db/update`** (`server/index.cjs:5111` and mirrored at `netlify/functions/backend.mjs:1132`). Any workspace editor can set `workspace_id` (or `created_by`/`user_id`) in an update's `values` and move/inject rows into a workspace they have no role in. Authorization only checks the *source* workspace derived from filters; `values` is never inspected. This breaks the multi-tenant boundary on both backends.
2. **Authorization gaps around agent execution and realtime.** A `commenter`-role user (explicitly denied `run_agents`) can trigger unlimited code-executing agent turns just by @mentioning an agent in a comment (`server/index.cjs:1822` — no capability check, no rate limit). Separately, a user removed from a workspace keeps receiving all live messages/canvas/tasks on their open WebSocket indefinitely, because subscriptions are only authorized at subscribe time (`server/index.cjs:3548`).
3. **Data-loss and availability traps in production infrastructure.** Uploaded file bytes live on Fly's ephemeral rootfs and are destroyed on every deploy (`server/index.cjs:2857`, no `[[mounts]]` in fly.toml); the frontend's WebSocket `error` handler permanently disables realtime for the whole session on any transient network blip (`src/lib/backendClient.ts:424`); and IP-based rate limiting keys on the attacker-controlled leftmost `X-Forwarded-For` segment, making signup/webhook limits bypassable and the limiter Map an unbounded-memory DoS vector (`server/index.cjs:1006`).

Also notable: the `agensis-cli` npm package as configured will ship 100% broken on its next publish (`files` whitelist omits `src/memory.mjs`, which is statically imported — even `--version` crashes; verified by packing and installing the tarball).

The good news: prior-review fixes (auth on the Netlify function, DOMPurify sanitization, token revocation, symlink guards, etc.) held up under re-verification. The new problems are mostly *drift* — the daemon gets fixes/policies that the Netlify mirror, shared core, and migrations never receive. That drift pattern is the single biggest structural theme of this review.

---

## 2. Quality Gate Status

| Gate | Status | Numbers | Detail |
|---|---|---|---|
| Typecheck (`tsc --noEmit`) | ❌ FAIL | **14 errors** | Real bugs among them: `src/App.tsx:1521` TS2322 handler arity mismatch (3-arg async assigned to `(id, agent) => void` — `messageContent` is `undefined` at runtime) + 3× TS7006 implicit any at same site; `src/components/windows/ChatWindowContent.tsx:1610` TS2322 `'sub-thread'` not in tab union `'files'\|'thread'\|'pins'`; `src/providers/WindowManagerProvider.tsx:34` TS2741 missing `openSplitWindow`; `src/components/chat/ComposerAddContent.tsx:232` TS2304 `Command` undefined (while `CommandIcon` sits unused at line 2); unused imports in SubThreadPanel/ChatWindowContent; implicit-any params in `useChat.ts:176,178` |
| Lint (`eslint .`) | ❌ FAIL | **12 errors, 165 warnings** | 6 errors in main `src/` (4 unused-vars, 1 no-explicit-any at `SettingsDialog.tsx:191`); remaining errors are duplicates from **3 stale `.claude/worktrees/wf_cf51a248-*` copies eslint is scanning** — these inflate totals and should be excluded via ignore pattern or deleted. Warnings mostly `react-refresh/only-export-components` (ui/* barrels) and `exhaustive-deps`, duplicated 4× |
| Backend tests (node) | ✅ PASS | 154 passed, 0 failed | |
| Unit tests (vitest) | ✅ PASS | 46 passed, 0 failed | No React hook/component coverage at all (see §6) |
| CI (GitHub Actions) | ❌ FAIL | 30/30 recent runs red | Two independent causes: `npm ci` lockfile drift (`Missing: esbuild@0.28.1 from lock file`) blocks most runs; typecheck failures block the rest. Tests never run in CI |

---

## 3. Findings by Severity

### Critical

None. (The cross-tenant write was weighed for critical but held at high: it's a write/injection integrity break, not read access to a victim tenant's existing data.)

### High (8)

#### H1. `/backend/db/update` allows cross-tenant row reassignment — on both backends
**`server/index.cjs:5111`** and **`netlify/functions/backend.mjs:1132`** (shared logic: `shared/backend-core.mjs:322-369`)

The update route calls `enforceDbOperationAccess(userId, table, 'update', { filters })` — **`values` is never passed**. Enforcement resolves the workspace from the id filter (= the row's *current* workspace), checks write there, and then the SET clause applies every key in `values` unchecked — including `workspace_id`, `user_id`, `created_by`. An editor of workspace A can `POST /backend/db/update {table:'tasks', filters:[{column:'id',value:myTaskId}], values:{workspace_id:'<victim-ws>'}}` and inject the row into a workspace they have no role in, where it appears in all workspace-scoped queries/UI. The insert route does this correctly (passes `{values}`, authorizes the target workspace) — update is an asymmetric oversight, identical on both runtimes. Applies to every WORKSPACE_SCOPED/VERSIONED table.

**Fix:** Pass `values` into `enforceDbOperationAccess` on update; when `values.workspace_id` differs from the resolved source, require the capability in the *target* workspace too. Simplest hardening: strip/reject ownership columns (`workspace_id`, `user_id`, `created_by`, `id`) from update `values` in both `server/index.cjs` and `shared/backend-core.mjs`. Add a test that an editor cannot move a row cross-workspace.

#### H2. Rate limiting keyed on spoofable leftmost X-Forwarded-For + unbounded limiter Map
**`server/index.cjs:1006`** (`clientIpFromReq`), **`:968`** (`createRateLimiter`)

`clientIpFromReq` takes `xff.split(',')[0]` — the *attacker-supplied* leftmost segment. Fly appends the real client IP on the right and exposes `Fly-Client-IP`; neither is used, and there's no `app.set('trust proxy')`. Consequences: (a) unauthenticated `POST /backend/auth/signup` (:4659), `POST /backend/webhooks/:token` (:4570 — triggers paid Anthropic completions), and skill routes have their IP limiters bypassed entirely by rotating the header; (b) `createRateLimiter`'s `hits` Map is never pruned (entries only reset on key recurrence), so every distinct spoofed value is a permanent Map entry → unauthenticated memory-exhaustion DoS.

**Fix:** Derive client IP from `Fly-Client-IP` (or rightmost XFF after configuring trust proxy hop count). Add periodic sweep of expired entries (`resetAt < now`) or LRU-cap the Map.

#### H3. Comment @mention executes agents, bypassing the `run_agents` gate and dispatch rate limiter
**`server/index.cjs:1822`** (`dispatchCommentMentions`), vs. the properly gated route at **:4471-4476**

A `commenter`-role user (capabilities: read, comment — no `run_agents`, lines 322-328) inserts a `document_comments` row containing `@coder do X`. The insert only requires the `comment` capability (:351), then the insert handler (:5082) fires `dispatchCommentMentions` → DM message → `continueConversation` → `runAgentTurn` → daemon/MCP agent executes. The dedicated `/backend/agents/dispatch` route enforces both `run_agents` and `dispatchRateLimiter`; the comment path enforces neither — privilege escalation to code-executing agents plus unlimited unthrottled dispatch.

**Fix:** In `dispatchCommentMentions`, check `enforceWorkspaceRole(authorUserId, workspaceId, 'run_agents')` (skip mention on failure) and apply the same per-user dispatch rate limiter.

#### H4. Realtime subscriptions never re-authorized — revoked members keep receiving workspace data
**`server/index.cjs:3548`** (`notifyDbSubscribers` fan-out); authorization only at subscribe time (**:3703/:3821**)

Removing a member (DELETE on `workspace_members`, :5134) never prunes that user's live WS subscriptions — the only mutations of `ws.subscriptions` are client-initiated subscribe/unsubscribe and socket close (:3822-3830, :3866). The fan-out matches rows purely by table/filter, never rechecking membership. A removed user silently keeps receiving every message, canvas edit, task, and cursor broadcast for the workspace until their socket happens to die. CWE-862 in a multi-tenant collab app.

**Fix:** On `workspace_members` delete/downgrade, iterate `websocketClients` and drop that user's subscriptions bound to that workspace (optionally close the socket). Or re-run `enforceWorkspaceRole` in the fan-out behind a short-TTL `(userId, workspaceId)` cache.

#### H5. WS `error` handler permanently kills realtime for the session; reconnect machinery is dead code
**`src/lib/backendClient.ts:424`**

The `error` listener calls `enterPermanentUnavailable()` → `permanentlyUnavailable = true`, `unavailableUntil = Infinity`, on a module-level singleton. The only reset is inside `onAuthenticated()`, which is unreachable because `ensureConnected()` early-returns at :373 when the flag is set; the `close` handler bails at :430, so exponential backoff (:433-446) and the 30s cooldown never run. Per spec, failed connects and 1006 abnormal closes (deploys, mobile drops) fire `error` before `close` — so the *most common* failure mode disables all realtime (chat, presence, tasks, db_changes; no polling fallback exists) until a full page reload.

**Fix:** Remove `enterPermanentUnavailable()` from the error listener (log, or at most `enterUnavailableCooldown()`); let `close` drive backoff + retry, which already resubscribes channels on reconnect.

#### H6. Uploaded file bytes live on Fly's ephemeral rootfs — lost on every deploy/restart
**`server/index.cjs:2857`** (`getUploadRoot` defaults to `<cwd>/.agensis_uploads`); `fly.toml` has no `[[mounts]]` and no `AGENSIS_UPLOAD_ROOT`

Upload writes bytes to local disk while the `uploaded_files` row goes to external Postgres. After any `fly deploy`, machine restart, or scale-out (second machine serving the GET), `GET /backend/files/:id/content` (:4036) returns 404 `File content is missing on disk` for files the UI still lists. Silent, unrecoverable data loss on the documented production deployment.

**Fix:** Provision a Fly volume + `[[mounts]]` + set `AGENSIS_UPLOAD_ROOT`, or move bytes to object storage (S3/R2) / Postgres so uploads survive redeploys and are shared across machines.

#### H7. CI gate permanently red — zero regression signal
**`.github/workflows/test.yml:31`** (sequential fail-fast job); plus `package-lock.json` drift

Verified in real CI history: 30/30 recent runs on `main` failed. Two independent causes: (1) `npm ci` fails with `Missing: esbuild@0.28.1 from lock file` (EUSAGE) on most recent runs; (2) when install succeeds, the Typecheck step fails on the 14 errors above and aborts before Lint/Tests. Merges have been happening against a red gate for the entire visible history. Note `App.tsx:1521` and `ChatWindowContent.tsx:1610` are genuine latent bugs, not just noise.

**Fix (ordered):** `npm install` to regenerate the lockfile and commit it; fix the 14 typecheck + 6 real lint errors (a few hours — mostly unused imports, one arity fix, one union extension, one provider property); add an eslint ignore for `.claude/worktrees/` (and delete the 3 stale worktree copies). Then the existing 200 tests start actually gating merges.

#### H8. `agensis-cli` npm package will ship 100% broken (missing `src/memory.mjs` in `files`)
**`agent/agensis-cli/package.json:28`**

The `files` whitelist lists `src/agensis.mjs`, `src/cli.mjs`, `src/queue.mjs` — not `src/memory.mjs`, which `src/agensis.mjs:6` statically imports. Reproduced end-to-end: packed the v0.1.15 tarball, installed it, ran `agensis --version` → `ERR_MODULE_NOT_FOUND` on every invocation. The prepack `--check` only syntax-checks each listed file individually, so it can't catch this. Mitigating fact: the package is **not yet on the registry** (`npm view` → E404), so no users are affected today — but the very next `npm publish` ships a fully non-functional CLI with no guard.

**Fix:** Add `"src/memory.mjs"` to `files`; extend the check script to `node --check src/memory.mjs`; ideally add a smoke test that runs `agensis --version` from a packed tarball.

### Medium (16, after merging)

#### M1. `agent_registrations` missing from `DB_TABLE_ACCESS` — editors bypass the manage-only approval flow
**`server/index.cjs:337`** (map), **:450-453** (default fallthrough), vs. manage-gated route at **:5031**

`agent_registrations` is in `ALLOWED_TABLES` and `WORKSPACE_SCOPED_TABLES` but has no `DB_TABLE_ACCESS` entry, so `capabilityForDbOperation` defaults update/delete to `write`. An editor can approve a pending external-agent registration (`values:{status:'approved', agent_id:X}`) or bulk-delete all pending registrations via the generic CRUD routes — actions the dedicated route restricts to `manage`. Combined with editors' default write on `workspace_agents.mcp_approved`, an editor can fully approve an external agent.
**Fix:** Add `agent_registrations: { select:'read', insert:'manage', update:'manage', delete:'manage' }` (matching `workspace_members`/`agent_webhooks`). Adopt the audit rule: every ALLOWED ∩ WORKSPACE_SCOPED table must have an explicit access entry — enforce with a test (see §6).

#### M2. `getAuthSecret` first-boot race → divergent per-instance HMAC secrets
**`server/index.cjs:202`** (cache), **:135-141** (upsert, last-writer-wins)

With no `AGENSIS_AUTH_SECRET`/`AUTH_SECRET` env and an empty `app_settings`, each instance generates its own random secret, upserts it, caches its *own* value forever, and never re-reads. Two instances → tokens signed on A fail verification on B → intermittent 401s. Also: a DB-stored secret means DB read access = token forgery. Only reachable when the documented `fly secrets set` step is skipped, hence medium.
**Fix:** In production, fail fast at startup if the env var is unset. If the dev fallback stays, take an advisory lock and re-read after write.

#### M3. MCP job reaper kills legitimate long turns by `created_at`, then rejects the real result
**`server/index.cjs:2677`** (reaper), **:2663** (`submitMcpJobResult` rejects), vs. daemon jobs correctly using `started_at` at **:2379**

Any MCP job older than 180s *since creation* (including queue wait) is force-failed with "the MCP client stopped responding"; the client's later `submit_job_result` then throws `Job is error, not awaiting a result` and the genuine reply is discarded. Coding/research turns routinely exceed 3 minutes. `touchMcpPresence` is in-memory-only and ignored by the reaper.
**Fix:** Reap on `started_at < now() - 240s` (mirroring daemon jobs), and let `submitMcpJobResult` accept a late result for a reaped job.

#### M4. Netlify `ai-chat` skips workspace authorization when `workspaceId` is omitted
**`netlify/functions/backend.mjs:1173`** vs. daemon at **`server/index.cjs:5195`**

The `if (workspaceId)` guard means a request without `workspaceId` never hits `assertWorkspaceRole`; `resolveSecret('ANTHROPIC_API_KEY', null)` falls back to the app-level/env key. Any self-service signup (no workspace membership at all) can stream paid completions at 30/min. The daemon correctly 400s on missing `workspaceId`.
**Fix:** Mirror the daemon: require `workspaceId`, unconditionally enforce `run_agents`.

#### M5. Netlify backend is missing core collaboration routes — silent 404s
**`netlify/functions/backend.mjs:1381`** (generic 404 fallthrough) vs. daemon **`server/index.cjs:4375-5037`**

No handlers exist for workspace members, invites (GET/POST/DELETE + accept), mcp-token, mcp-auto-approve, agent-registrations, memory-refresh, or DELETE agents/connections/:id — all of which the frontend calls (`useWorkspaceUsers`, `App.tsx` invite accept, `mcpConnect.ts`, `useAgentRegistrations`, `useAgentMemory`, `ChatWindowContent`). On a Netlify-served deployment, member lists render empty, inviting fails, MCP token generation fails — all as quiet `{error:'Backend route not found'}`. `tests/netlify-parity.test.cjs` only checks 401-on-missing-auth for a smaller route list.
**Fix:** Port the handlers (reusing `assertWorkspaceRole` with the daemon's capabilities), or proxy unhandled `/backend/*` to `daemonBaseUrl()` as `proxyAgentDispatchToDaemon` already does. Add route-existence parity tests.

#### M6. `dispatchToAgent` failure is silently swallowed — message vanishes with no reply, no error
**`src/hooks/useChat.ts:341`** (`.catch(() => null)`), **:561** (bare return)

On any dispatch failure (network, 429, 500), `dispatchToAgent` returns `false`; in auto/@mention channels `sendMessage` then hits `if (!agent && !directParticipant) return`. The optimistically-persisted user message sits looking sent; no toast, no retry, no fallback. `mergeSession` (:631) ignores the return value entirely — same class.
**Fix:** Return a discriminated result (or throw) from `dispatchToAgent`; surface a failed-state on the message with retry affordance.

#### M7. `mergeSession` compares client-clock `split_at` to server-clock `created_at` — skew soft-deletes real fork work
**`src/hooks/useChat.ts:607`** (comparison), **:158** (`split_at` from `new Date()`)

`split_at` is browser wall-clock; message `created_at` is Postgres `now()`. With the browser clock ahead (common), fork messages sent inside the skew window sort *before* `splitAt`, `forkDiverged` is empty, and the `=== 0` branch (:611) soft-deletes the fork and toasts "Nothing diverged" — discarding real work from the UI (recoverable only via DB). Same skew corrupts `parentDiverged`, producing wrong synthesis prompts. This is the newest shipped feature (commits 6753ed8/16257f3).
**Fix:** Keep the boundary in the server clock domain — DB default `now()` for `split_at`, or set it to `MAX(created_at)` of the copied rows; better, compute divergence by set-difference of copied-row markers rather than timestamps.

#### M8. Offline mutations never update the IndexedDB cache — offline reload loses queued changes from the UI
**`src/lib/offlineBackend.ts:4`** — `offlineInsert/Update/Delete` (:24, :42, :55) enqueue + update React state but never `cacheSet`; `cachedFetch`'s offline branch (:75) and catch fallback (:71) read only the stale cache

Create a task offline → reload while offline → the task is gone from the UI until reconnect+flush. Affects every hook using the pattern (`useTasks`, `useAgents`, `useDocuments`, `useThreadItems`, `useMemory`, comments hooks). Presents as data loss even though the queued write survives.
**Fix:** Update the relevant cached list inside the mutation helpers, or expose a cache-invalidate/merge the hooks call post-mutation.

#### M9. Poison sync-queue entries retried forever — permanent error banner, failing request every 30s
**`src/hooks/useNetworkStatus.ts:53`** (catch + `continue`, no dequeue), **:85** (30s interval)

A replay that can never succeed (duplicate PK, FK violation on a deleted parent) stays in the queue with no attempt cap, backoff, or dead-letter; `pendingCount` never reaches 0 and `syncError` stays on screen indefinitely. Mitigated only by the manual "Clear queue" button and the enqueue-time 5000-entry/30-day prune.
**Fix:** Per-entry attempt counter; after N failures move to a dead-letter state with a distinct terminal error.

#### M10. Schema-source drift: `supabase/migrations` (the `npm run migrate` source) is missing ~11 columns and 5 tables
**`server/index.cjs:549`** (`ensureRuntimeSchema` — sole definition site)

Verified only-in-runtime-schema: `chat_sessions.split_parent_id/split_at/deleted_at/parent_message_id`; `messages.sender_kind/sender_id/sender_name/pinned/reactions`; `workspaces.mcp_token_hash/mcp_auto_approve`; `workspace_agents.mcp_approved`; tables `thread_items`, `agent_registrations`, `workspace_invites`, `agent_connections`, `agent_jobs`. Zero hits in `supabase/migrations/*.sql`; `database/neon-schema.sql` also lacks most of them. `migrate.mjs`'s own header advertises the `AGENSIS_RUNTIME_SCHEMA=false` + `npm run migrate` production path — which would produce a DB where agent dispatch, thread widgets, split/merge, pins/reactions, and MCP register/invite all fail with "relation/column does not exist". Fly is healthy today only because the flag is never set. This is an **incomplete fix of the previously-"resolved" migration-drift work.**
**Fix:** Back-port every runtime-only object into migrations and regenerate `neon-schema.sql` — or declare `ensureRuntimeSchema` authoritative and delete the migrate/neon-push paths. Add the schema-diff CI test (§6).

#### M11. `db:neon:push` then `migrate` silently marks all 26 migrations applied without running them
**`scripts/migrate.mjs:88`** (backfill trap), **`scripts/neon-push.sh`**

If `workspaces` exists but `_schema_migrations` doesn't (exactly the state neon-push produces), migrate backfills everything as already-applied and prints "Up to date" — permanently locking in a schema missing `conversation_mode`, `max_agent_turns`, `auto_rounds`, etc. (columns queried unconditionally at `server/index.cjs:2212, 4478`). Latent (needs the non-default flag), but silent and permanent when hit.
**Fix:** Make the two bootstrap paths mutually exclusive, or have the backfill verify actual column presence instead of trusting `workspaces` exists.

#### M12. SSE consumers missing line buffering drop deltas / corrupt multibyte text (2 sites)
**`netlify/functions/backend.mjs:1217`** (ai-chat relay) and **`src/components/windows/DocWindowContent.tsx:181`** (`runDocAI`)

Both decode chunks with `decoder.decode(value)` (no `{stream:true}`) and split each chunk on `\n` with no buffer carried across `reader.read()` calls. Any `data:` frame spanning two network chunks is silently dropped (tail fails JSON.parse, head lacks the prefix), and multibyte chars straddling boundaries become U+FFFD. The daemon was already fixed for exactly this (`server/index.cjs:5228-5254`, with comments explaining why) — these two mirrors were not. `DocWindowContent` also swallows the server's mid-stream `{error:...}` frame (:5263) and shows "No response."
**Fix:** Reuse the daemon pattern / `extractSseDataLines` from `src/lib/chatStream.ts`: persistent buffer, `decode(value,{stream:true})`, retain trailing partial line, final flush.

#### M13. Sub-thread direct-AI fallback parses the wrong payload shape — blank replies, empty rows persisted
**`src/hooks/useSubThreads.ts:305`**

The consumer reads `parsed?.choices?.[0]?.delta?.content || parsed?.text`, but both ai-chat emitters send `{delta:{text}}` (`server/index.cjs:5248`, `backend.mjs:1228`). Whenever the dispatch call fails and the hook falls back to `streamDirect` (:276), the assistant bubble streams blank and an empty `content: ''` message row is permanently inserted (:325-330) — tokens spent, reply lost. The correct parser already exists (`src/lib/chatStream.ts:51`).
**Fix:** `import { parseAiStreamPayload } from '../lib/chatStream'` and use it.

#### M14. `hasActiveBurstJob` ignores `'queued'` MCP jobs — duplicate agent turns for one message
**`server/index.cjs:2033`** (guard: `status = 'running'` only) vs. MCP inserts at **:2069-2082** (`status='queued'`)

Two triggers for the same session before the MCP poller claims job 1 (two quick DMs, or dispatch + comment-mention) both pass the guard — the "Thinking" placeholder is filtered out of history (:1678-1680), there's no unique constraint on `agent_jobs`, and `claimMcpJob` (SKIP LOCKED) happily claims both — yielding duplicate responses/actions.
**Fix:** `status in ('queued','running')` in the guard, plus a partial unique index on `(session_id, agent_id) WHERE status IN ('queued','running')` to make it atomic.

#### M15. Multi-instance unsafety: in-process locks and connection registries
**`server/index.cjs:2206`** (`conversationLocks` Set, defined :1669); related: `connectedAgents` (:77), `mcpAgentPresence` (:1413), `websocketClients` — all per-process

With 2+ Fly machines (explicit scale, or the rolling-deploy overlap window): two instances can both acquire their local "lock" and double-drain the same session (duplicate turns, `max_agent_turns` budget exceeded — `hasActiveBurstJob` is a non-atomic check-then-insert, verified no advisory locks / FOR UPDATE / unique constraints anywhere in the file); and a dispatch routed to the instance that doesn't hold the daemon's WebSocket posts a false "no daemon is connected" reply. Code comments at :1524/:1413 admit "single-process only".
**Fix:** Either pin and document single-machine operation (cap Fly count at 1), or move lock/presence/routing state to Postgres (advisory lock around the burst drain; `agent_connections` liveness for routing). Do the advisory lock first — it also hardens M14.

#### M16. Applet mass-assignment allowlist test re-implements the guard instead of importing it
**`tests/unit/appletUpdateTaskAllowlist.test.ts:12`** vs. real guard inline at **`src/components/canvas/CanvasObjectRenderer.tsx:244-252`**

The only test protecting the untrusted-iframe→task-mutation boundary tests a hand-copied duplicate of the field list ("!!! KEEP IN SYNC !!!"). Adding `assignee_id` to the component's array, or breaking the filter, leaves all 4 tests green — false confidence on a real trust boundary.
**Fix:** Extract `APPLET_TASK_UPDATE_FIELDS` + `filterAppletTaskUpdates` into `src/lib/appletTaskFields.ts`; import from both the component and the test.

*(Also medium, ops-only:)* **M17. `scripts/neon-push.sh:15` hardcodes `/opt/homebrew/opt/libpq/bin/psql`** — the `db:neon:push` flow fails on Intel Mac/Linux/CI even with `psql` on PATH. Fix: resolve via `command -v psql`.

### Low (selected; brief)

| # | Finding | Location | Fix |
|---|---|---|---|
| L1 | Security-core drift: `shared/backend-core.mjs` lacks the daemon's newer table policies (`agent_memory_files` manage-only, `memory_file_comments`, `thread_items`, `agent_registrations`) — a latent M1-class hole for any consumer that exposes those tables | `shared/backend-core.mjs:71` | Port policies; add the superset test (§6) |
| L2 | `mapDbError` forwards raw Postgres `detail`/`code` to clients (constraint violations leak stored values, schema shape) | `server/index.cjs:947`, `backend.mjs:119` | Log full error, return whitelisted generic codes |
| L3 | Signin limiter keyed only per-email → targeted lockout DoS (5 failed attempts locks a victim) and per-IP-unthrottled credential stuffing | `server/index.cjs:4691` | Add per-IP dimension (after H2 fix); don't 429 correct-password requests |
| L4 | Invite tokens stored/compared in plaintext (agent + workspace tokens are hashed) and remain valid MCP bearer credentials after acceptance when `expires_at` is null | `server/index.cjs:1356` | Hash at rest; expire/invalidate on acceptance |
| L5 | Sending from a non-active/split window drops conversation context on the `streamDirectAI` path (stale `activeSession` closure → `contextMessages = []`) | `src/hooks/useChat.ts:538`, `src/App.tsx:2453-2455` | Pass the window's own messages / load target-session history explicitly |
| L6 | Orphaned stale `netlify/database/migrations/0001-0006` — wrong role CHECK (`owner/editor/viewer` only), no `token_version`, missing 4 newer tables; referenced by no runner but looks canonical | `netlify/database/migrations/0001_...sql:84` | Delete or replace with a pointer to the canonical source (coordinate with plans/006) |
| L7 | Dev-only showcase gallery (~2,458 LOC) statically imported at the entry point — ships in the single 1.9MB production chunk | `src/main.tsx:5` | `React.lazy` behind the `#showcase` hash |
| L8 | Unused/misclassified deps: `@open-pets/client` (zero imports) and `shadcn` CLI in runtime `dependencies` | `package.json:32,53` | Remove / move to devDependencies; also fixes part of the lockfile churn |
| L9 | Zero automated tests for the newest data-mutating code: `splitSession`/`mergeSession` (and no React hook coverage anywhere) | `src/hooks/useChat.ts:138,589` | See §6, item 2 |
| L10 | Repo cruft tracked in git: `widget_ab.png` (812KB), 3 stale review .md files, `.bolt/.grok/.qwen` dirs, `scripts/_*.cjs` one-offs | repo root | `git rm` + gitignore patterns |
| L11 | Production `og:image`/`twitter:image` still point at `https://bolt.new/static/og_default.png` — every social share of agensis.io shows Bolt branding | `index.html:23` | Host an agensis OG image |
| L12 | SVG-only apple-touch-icon + PWA manifest icons — iOS home-screen tile renders as a page screenshot instead of the logo | `index.html:9` | Generate 180/192/512 PNGs via `scripts/generate-icon.cjs` |
| L13 | Public skill doc links to invalid URL `https://agensis` (no TLD) | `server/skills.cjs:123` + `plugins/agensis/skills/agensis/SKILL.md` | `https://agensis.io` |

---

## 4. Resolved Since Last Review (do not re-litigate)

Verified as holding, per the prior-review ledger (`code-review.md`, `code-review-update.md`, `plans/README.md`):

- Unauthenticated Netlify function → guarded via `shared/backend-core.mjs` + parity tests
- HTML sanitization → DOMPurify (`src/lib/sanitize.ts`)
- Activity-log idempotency; WS token-in-query (first-frame auth added)
- In-memory rate limiter scaffold (though see H2 for the keying/eviction gaps)
- Runtime schema mutation now flag-gated (`AGENSIS_RUNTIME_SCHEMA`) — but see M10/M11: the flag's documented "off" path is broken
- `ws` dep DoS bump; file-upload stored-XSS hardening; MCP invite-role enforcement
- Server-side password policy; token expiry/revocation (`token_version`)
- Migration drift fix — **partially regressed**: M10 shows ~11 columns/5 tables added since exist only in `ensureRuntimeSchema`
- Symlink-safe path guard; loopback Host-header bypass; backend ESLint coverage

Known-open and already documented (not re-derived here): App.tsx monolith (~2,910 lines), ChatWindowContent.tsx (3,603 lines), self-subscribing hooks (`useCanvasObjects`/`useItemPresence`/`useMultiplayerCursors`), four overlapping UI libraries, intentional `server/index.cjs` ↔ `shared/backend-core.mjs` duplication (see roadmap — this duplication is now the root cause of H1/M4/M5/M12/L1 drift), red CI (quantified in §2).

---

## 5. Recommendations Roadmap

### (a) Immediate — this week (each ≤ half a day unless noted)

1. **Turn CI green (H7).** Regenerate + commit `package-lock.json`; fix the 14 typecheck errors (the `App.tsx:1521` arity fix and the `'sub-thread'` union are the two real bugs; the rest are unused imports/implicit anys); eslint-ignore `.claude/worktrees/`. ~1 day total. Everything else in this report is safer once the gate works.
2. **Close the cross-tenant write (H1).** Strip ownership columns from update `values` in both `server/index.cjs` and `shared/backend-core.mjs` + regression test. ~2 hours.
3. **Gate comment-mention dispatch (H3).** `run_agents` check + rate limiter in `dispatchCommentMentions`. ~1 hour.
4. **Fix the WS error handler (H5).** Delete one call. ~15 minutes, biggest reliability win per line in the report.
5. **Fix rate-limit keying (H2).** Switch to `Fly-Client-IP`; add limiter Map sweep. ~2 hours.
6. **Add `agent_registrations` to `DB_TABLE_ACCESS` (M1)** and mirror into backend-core (L1). ~1 hour.
7. **Add `src/memory.mjs` to the CLI `files` whitelist (H8)** before anyone publishes. ~10 minutes.

### (b) Near-term hardening — next 2–4 weeks

1. **Fly volume or object storage for uploads (H6).** Volume + `AGENSIS_UPLOAD_ROOT` is a one-evening fix; object storage is the right long-term answer if multi-machine is planned. Short–Medium.
2. **Realtime revocation (H4).** Prune subscriptions on membership delete/downgrade. Short.
3. **Netlify parity sweep (M4, M5, M12).** Require `workspaceId` in ai-chat; port or proxy the missing collaboration routes; port the SSE buffer fix. Medium (~2–3 days), plus the parity tests below so it can't drift again.
4. **Reliability fixes in the agent pipeline (M3, M14, M15-lite).** Reaper on `started_at`; tolerate late submits; widen `hasActiveBurstJob` + partial unique index; wrap burst drain in a pg advisory lock. Medium.
5. **Frontend failure surfacing (M6, M7, M13, M12-doc).** Dispatch error states with retry; server-clock `split_at`; shared SSE parser everywhere (`useSubThreads`, `DocWindowContent`). Medium.
6. **Offline layer coherence (M8, M9).** Cache updates from mutation helpers; dead-letter for poison entries. Medium.
7. **Auth polish (M2, L2, L3, L4).** Fail-fast on missing AUTH_SECRET in prod; generic DB error responses; per-IP signin dimension; hash invite tokens. Short each.

### (c) Structural — next quarter

1. **Kill the backend duplication.** Five findings in this review (H1×2 runtimes, M4, M5, M12, L1) are the *same bug shipped twice* or a fix applied once. Either make `shared/backend-core.mjs` the genuine single source (daemon imports it for access control, SSE relaying, error mapping) or explicitly deprecate the Netlify backend and proxy everything to the daemon. This decision eliminates an entire bug class. Large (1–2 weeks), highest structural ROI.
2. **One schema source of truth (M10, M11, L6).** Pick: migrations-authoritative (back-port everything, regenerate neon-schema, delete the backfill trap) or runtime-schema-authoritative (delete migrate/neon-push). Add the CI schema-diff test either way. Medium–Large. Coordinate with `plans/006-fix-canonical-migration-drift.md`.
3. **Decide single- vs multi-instance (M15, H6, M2).** If single: cap Fly at 1 machine and document it. If multi: shared uploads (object storage), pg advisory locks, DB-backed agent routing, and the WS-revocation work all become prerequisites. Make the decision explicitly rather than inheriting it from `min_machines_running`.
4. **Continue the already-documented decomposition** (App.tsx, ChatWindowContent.tsx) — note the current typecheck failures (arity mismatch, tab-union drift) are exactly the class of error these monoliths breed.

---

## 6. Suggested Test Additions (highest leverage first)

1. **Access-control matrix test (guards H1, H3, M1, L1).** For every table in `ALLOWED_TABLES ∩ WORKSPACE_SCOPED_TABLES` × every role × insert/update/delete: assert the expected allow/deny, assert `DB_TABLE_ACCESS` has an explicit entry (fail on default-fallthrough), and assert an update cannot change `workspace_id`/`created_by`/`user_id` cross-tenant. Run against both `server/index.cjs` and `shared/backend-core.mjs` policy tables so drift fails CI.
2. **`splitSession`/`mergeSession` hook tests (M7, L9).** vitest + renderHook with a mocked backend client: fork creation sets lineage; merge with diverged messages synthesizes and soft-deletes correctly; merge never soft-deletes a fork that has post-split messages (the clock-skew regression test — inject skewed timestamps).
3. **Netlify↔daemon route parity test (M5, M4).** Enumerate every `/backend/...` path the frontend calls (grep `apiUrl(`/`backendUrl(`) and assert each is handled (non-404) by both runtimes, with matching auth requirements. Extends the existing `tests/netlify-parity.test.cjs`.
4. **SSE chunk-boundary fuzz test (M12, M13).** Feed the shared parser and each consumer a fixture stream re-chunked at every byte offset (including mid-multibyte-char); assert reassembled text is identical. One fixture, three consumers, kills the whole bug class.
5. **Schema parity test (M10, M11).** In CI, provision two fresh Postgres schemas — one via `npm run migrate`, one via `ensureRuntimeSchema` — and diff `information_schema` tables/columns; fail on any difference.
6. **Packed-tarball smoke test for agensis-cli (H8).** `npm pack` → install into a temp dir → run `agensis --version`; fails on any future `files`-whitelist omission.
7. **Rate-limiter unit tests (H2).** Spoofed rotating XFF does not yield fresh keys; expired entries are evicted; Map size stays bounded under distinct-key flood.
8. **Realtime revocation test (H4).** Subscribe, remove membership, write a row, assert the removed user's socket receives nothing.
9. **Burst-dedup test (M14).** Two rapid dispatches to an MCP-presence agent produce exactly one queued job (asserts both the widened guard and the partial unique index).
10. **Applet allowlist real-import test (M16).** After extracting `appletTaskFields.ts`, assert the component's shipped filter drops a privileged field like `assignee_id`.

---

*Findings count: 8 High, 17 Medium (16 + ops), 13 Low. 1 candidate finding was refuted during verification and excluded. All High/Medium findings above passed adversarial re-verification against source at HEAD (16257f3).*