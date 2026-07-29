# AGENTS.md

Operational guide for AI agents working in this repo. Complements `README.md`
(which covers product + local setup) with the non-obvious conventions you must
follow to avoid breaking things. Read this before editing.

## Architecture in one breath

- **Frontend**: React 19 + TypeScript + Vite, deployed to **Netlify**.
- **Two backends over ONE Neon Postgres DB**:
  - `server/index.cjs` — the long-running Node/Express/**WebSocket** server. Owns
    realtime (`/backend/ws`), agent daemon orchestration, and the runtime schema
    bootstrap (`ensureRuntimeSchema`). Deployed to **Fly** (`fly deploy`).
  - `netlify/functions/backend.mjs` — the serverless HTTP mirror. Same DB, same
    routes, **no WebSockets**, **no independent DDL**.
  - `shared/backend-core.cjs` — logic both backends import (auth, RBAC table
    access, rate limiters, param binding). Put shared helpers here, not in one
    backend.
- Frontend talks to the backend through `src/lib/backendClient.ts` (a
  Supabase-shaped query builder: `.from(table).select/insert/update/delete/eq`).
  The builder supports `eq`/`not` filters only — no `in`, no `lt`/`gt`.

## Schema changes: update THREE places (the #1 footgun)

A schema change is only correct when all three agree, or a fresh DB drifts:

1. **Runtime bootstrap** — `server/index.cjs` `ensureRuntimeSchema`: idempotent
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.
2. **Canonical schema** — `database/neon-schema.sql` (what `npm run db:neon:push`
   applies to a fresh Neon DB).
3. **Migration** — a new `supabase/migrations/<UTC-timestamp>_name.sql`.

If a column is workspace-scoped, also confirm the table is in the access
allowlists in `shared/backend-core.cjs` (`ALLOWED_TABLES`,
`WORKSPACE_SCOPED_TABLES`, `DB_TABLE_ACCESS`). Array columns (e.g. `uuid[]`) need
`ARRAY_COLUMNS_BY_TABLE` + the `toPgArrayLiteral` bind path in BOTH backends —
postgres.js will not array-serialize a raw JS array bound via `.unsafe`.

## Realtime

Clients receive live updates via `notifyDbSubscribers(table, eventType, rows)` in
`server/index.cjs`, which fans DB-change events to subscribed WebSocket clients.
Streaming agent output works by inserting a `Thinking …` placeholder message,
then `UPDATE`-ing its content (each update broadcasts). Heavy fields are stripped
from the fanout by `sanitizeRealtimeRow` — add to it, don't broadcast large bodies.

### Presence: two transports, merged only at the view layer

There are two independent lanes and they must not be joined upstream of the UI.

- **Durable rows fanned out as `db_changes`** — everything that has to survive a
  reload.
- **Ephemeral `broadcast` frames** (`relayBroadcast`, `server/realtime.cjs`) —
  presence, cursors, typing. These touch no storage at all. Do not add a
  `workspace_presence` table: a value with a six-second lifetime does not belong
  in Postgres, and a new table would need `ALLOWED_TABLES` + `DB_TABLE_ACCESS`
  entries kept in sync by hand across two runtimes.

**Every ephemeral signal expires at the RECEIVER.** There is no server-side
roster, so "the sender went quiet" is the only stop signal you can rely on — a
force-quit tab, a dead socket and a polite goodbye are indistinguishable. Each
lane therefore owns a TTL, and the UI's answer to silence is always "the thing
disappears", never "the last value sticks".

| Signal | Source | Refresh | TTL | On silence |
|---|---|---|---|---|
| Human item/window presence | browser broadcast | 2s with peers / 10s alone | 7s | avatar leaves the sidebar row |
| Human cursor | browser broadcast | <=80ms while moving, off with no peers | 5s | cursor vanishes |
| Human typing | browser broadcast | <=1 per 4s per target | 6s, sent as a relative `ttlMs` | indicator clears itself; no stop frame is required for correctness |
| Huddle participant | HTTP heartbeat | 30s | 150s | `reaped_at` set, roster row removed |
| Agent daemon liveness | WS heartbeat + pings | 15s | ~120s of missed pongs | `status='offline'`, filtered out of the roster |
| Agent activity chip | placeholder message content | ~1/s | 60s (`ACTIVITY_STALE_MS`) | chip stops claiming the run is live |

Two rules that are easy to get wrong and expensive to get wrong:

1. **Typing frames carry a relative `ttlMs`, never an absolute deadline.** The
   receiver computes `now + ttlMs` on arrival and clamps it to its own ceiling.
   `src/lib/activityStatus.ts` had to buy 60s of slack purely to absorb
   server-vs-browser clock skew; a 6s TTL has no room for that, and sending a
   duration removes the whole skew class instead of budgeting for it.
2. **Agents never emit typing, and should not be given it.** A human's typing is
   a 2-8 second prediction; an agent's equivalent is a multi-minute tool run, and
   a three-dot animation running for six minutes reads as a hang. Agents already
   have the right surface with a clock on it — `activityChipLabel()` ->
   `"Thinking 1m 56s"`, `src/lib/activityStatus.ts`. There is also a hard
   blocker: an agent-token socket has no `ws.userId`, so
   `authorizeRealtimeBroadcast` rejects it. Adding agent typing would mean
   opening a new authorization path for daemon-originated broadcasts to ship a
   worse version of something that already exists.

`item-presence:<workspaceId>` is workspace-wide and its frames carry item ids,
so typing is **not** emitted for direct messages. The sidebar's presence
filtering is a UI convenience, not an access boundary — do not describe it as
one, and do not widen what rides that channel until the channel grammar can
carry an item scope (`workspaceIdFromRealtimeChannel` rejects a second colon).

Cost matters on this path: see `plans/012-cut-idle-realtime-chatter.md`. Typing
is a ~150-byte frame throttled to one per 4s **specifically** so it does not
undo that work — `setTyping` must never call `sendSnapshot()`, which is a ~2 KB
window payload. `tests/unit/itemPresenceTyping.test.ts` fails if it does.

## Recent cross-cutting features (2026-07)

- **The audit log** (`audit_log`) — a durable, SERVER-AUTHORED record of the
  privileged actions that previously left no trace anywhere: role changes, member
  removal, invites, `permission_mode` flips (including `yolo`), permanent tool
  grants, connect-token mints and vault writes. Written only by
  `recordAuditEntry` in `shared/backend-core.cjs`; read only through the
  `manage`-gated `GET /backend/workspaces/:id/audit`
  (`server/audit-routes.cjs`). Things to know before touching it:
  - **`audit_log` is deliberately ABSENT from `ALLOWED_TABLES`.** That is the
    control, not a role check: `ensureTable` rejects it before any
    `/backend/db/*` handler and before `authorizeRealtimeBinding` consults a
    capability, so there is no generic read, write or subscribe path to it at
    all. Do NOT add it "so the panel can use `backendClient.from()`" — the read
    route does not need it, and adding it silently restores generic INSERT and
    DELETE on the audit trail. `tests/audit-log-append-only.test.cjs` fails on
    exactly that mutation.
  - **`activity_events` is NOT an audit record and must not be promoted into
    one.** It is client-authored (`src/hooks/useActivity.ts:70` inserts straight
    from the browser through the generic route, picking its own `event_type`,
    `title` and `user_id`) and it is `write`-capability insert/update/delete. It
    is forgeable and erasable by design. That is fine for a feed.
  - **A row must be strictly less sensitive than the thing it describes.** Vault
    writes record the key NAME and a `configured` boolean, never the value or the
    ciphertext. Token mints record the agent and the resulting mode, never the
    token OR its hash. Invites record the email DOMAIN, never the local-part
    (400-day retention, different erasure path from the user record).
    `sanitizeAuditDetail` drops nested objects structurally so `detail: someRow`
    cannot smuggle a column, and the writer tests assert over the whole param
    array so a nested key cannot slip through.
  - **The writer never rejects.** An audit write that threw inside a role-change
    handler would turn a working privileged action into a 500. It is
    fire-and-forget with an internal try/catch, matching
    `logProviderCallActivity`.
  - **v1 has NO hash chain, on purpose.** Each row carries an `entry_hash`
    (SHA-256 over its canonical content) and a `bigserial seq` — that detects
    edits and flags gaps with no lock. A `prev_hash` chain would make every write
    read the tail under a lock, on paths that must never stall, and would prove
    nothing while the only available anchor is the same Postgres the operator
    controls. Revisit only when an anchor exists that the `DATABASE_URL` holder
    cannot write.
  - **Say what it is worth.** Tamper-EVIDENT against application-level actors; it
    is not tamper-PROOF, because the app connects as a role that can drop the
    immutability trigger. The panel says so in its own copy. Do not let anyone
    describe it otherwise.
  - **`workspace_id` is `ON DELETE SET NULL`, not `CASCADE`** — deleting a
    workspace is the most audit-worthy action there is, and `CASCADE` would erase
    the evidence of it as a side effect. Those rows become DB-only.

- **Interactive tool approvals** — a daemon agent that hits a tool it isn't
  cleared for now ASKS, in the conversation it is working in, instead of erroring.
  `server/agent-permissions.cjs` owns the table (`agent_permission_requests`),
  the `agent_permission_request` socket handler, and the decide route; the daemon
  half is `packages/agensis-cli/src/permissions.mjs` + a `canUseTool` callback in
  `connectionExecutors.mjs`. Things to know before touching it:
  - **Settings files are NOT the grant store, and never were.** The daemon runs
    Claude with `settingSources: []` (lean mode, on by default) and `--safe-mode`
    on the subprocess lane, so `~/.claude/settings.local.json` on the daemon host
    is read by nothing. An operator editing one sees no effect and no error. The
    allowlist is ours: `workspace_agents.metadata.permission_rules`, a jsonb
    write with no DDL — the same no-migration route `host_folders` took.
  - **Rule identity is the SDK's own suggestion, compared verbatim.** Claude
    hands `canUseTool` the exact rules its "always allow" would write; a stored
    rule matches when it is byte-identical to one being offered right now. We
    never reimplement `Bash(git clone:*)` matching, so we cannot drift from it,
    and a rule we fail to match costs one extra prompt rather than an ungranted
    tool call.
  - **RBAC split**: once/session and every denial need `write`; `always` needs
    `manage`, because it writes `workspace_agents.metadata`, which is MANAGE_ONLY
    in `shared/backend-core.cjs`. Refusing must never wait for an admin.
  - **A decision is delivered before it is recorded**, to the EXACT connection
    that raised it. A reconnected daemon is a new process with no memory of the
    request id, so "any live socket for this agent" would record an approval that
    nothing acted on and show "Approved" over a tool call that never ran.
  - **A permission rule cannot reach a folder.** Working-directory access is a
    separate gate that no rule and not even `--dangerously-skip-permissions`
    lifts — only `--add-dir` / `additionalDirectories`, i.e. host folders. If an
    agent "still can't write there" after a grant, it is a host-folder problem.
  - Codex agents get once/session only: the app-server has no per-rule grant, so
    an "always" would have to mean "any command, forever".
- **Sessions scoped to a project (canvas layer)** — `chat_sessions.canvas_id`
  (nullable text, mirrors `canvas_objects.layer_id`; **null = unassigned, shown
  in every project**). New channels stamp the active `activeLayerId`; splits
  inherit the parent's. DMs stay global (null). The sidebar filters **channels +
  threads** by `activeCanvasId` but keeps DMs/archive global. The bootstrap
  sessions select (`server/index.cjs`) lists columns explicitly — add new
  session columns there or they load blank.
- **Silo (daemon agent) host folders** — stored on
  `workspace_agents.metadata.host_folders` (no schema change; `metadata` jsonb
  already exists). Edited per-agent in the Agents window (daemon agents only).
  Dispatch forwards them via `agentRuntimePayload`; the daemon
  (`buildAgentCommand`) injects `--add-dir <path>` per folder for Claude, and a
  repeatable `--host-folder` CLI flag persists in the connect profile. **The
  bootstrap + `/agents` selects and `sanitizeRealtimeRow` now include
  `metadata`** — needed so host_folders survive a realtime update.
- **Sandbox Agent + provider skills** — sandboxes are no longer a server feature.
  The `sandbox` agent template (`src/lib/agentTemplates.ts`, `runMode: 'daemon'`)
  is a provisioner, and a provider is a **skill**: `workspace_agents.skills` holds
  skill **ids** (it stays `string[]` — the Agents window round-trips it through a
  comma-separated input, so an object in there is destroyed by the next edit), and
  `server/sandbox-skills.cjs` resolves them against bundled definitions plus
  per-agent ones in `workspace_agents.metadata.sandbox_skills` (the same no-DDL
  route `metadata.host_folders` took). **Adding a provider is one jsonb write — no
  migration, no `fly deploy`, no daemon release.** The resolved layer is rendered
  into the prompt in all THREE lanes (builtin system prompt + both
  `buildDaemonPrompt` call sites) and deliberately NOT into `agentRuntimePayload`,
  which the browser edit form saves back. Provider API keys live in the workspace
  vault under `sandbox:<provider>:<key>`, write-only via
  `/backend/workspaces/:id/sandbox-credentials` (manage role, Fly-only): no route
  returns one, not even masked, and the per-turn path only reads whether the
  cipher column is non-empty. A requester asks through the normal doors —
  `@sandbox spin up a node sandbox` in a channel, or the existing `dispatch_agent`
  MCP tool.
- **Credential proxy (`call_provider`)** — how a provider credential is *used*.
  **An agent never receives a secret; it receives a capability.** It names a
  provider skill id + an operation name; the server resolves `baseUrl` + the
  endpoint's path from the **skill definition**, attaches the vault credential,
  fetches, and returns the response fenced as untrusted data. The rules that make
  this a security feature rather than an exfiltration primitive, all enforced in
  code and asserted in tests:
  - **A caller may name FOUR things**: `skill_id`, `operation`, `path_params`,
    `body`. `unknownProviderCallArgs` REFUSES anything else by name — a `url`,
    `host`, `headers` or `authorization` argument is a rejection, not a dropped
    key. `additionalProperties: false` on the tool schema is documentation only:
    the MCP dispatcher never validates arguments against `inputSchema`.
  - **Path params are the only caller input in the URL**, restricted to
    `[A-Za-z0-9._-]` so a value cannot leave its segment. The resolved URL is
    re-checked against the base origin and re-run through `isSafeProviderBaseUrl`.
    An `operation` that fails its own charset check is never echoed back either.
  - **Redirects are refused, not re-validated** (`redirect: 'manual'`, `Location`
    never read): a public host redirecting to another public host passes every
    per-hop check and gets the Authorization header.
  - **SSRF on the resolved URL is `assertSafeOutboundUrl`** — the same guard the
    gateway `base_url` path uses, deliberately not a second implementation.
    `isBlockedAddress` now compares IPv6 numerically (`::ffff:a9fe:a9fe` and
    `0:0:0:0:0:0:0:1` used to pass its string tests and reach a fetch).
  - **`describeProviderCall` is the only shape allowed out** of a call, into both
    the tool result and the audit row. It has no field that could hold a secret —
    absent, not redacted. `applyProviderCredential` is the single place a secret
    enters a request, and a wiring test asserts there is exactly one.
  - **Audit** → an `activity_events` row per call (`event_type='provider_call'`,
    family `agents` in the Activity window): provider, operation, method, resolved
    URL, status, duration. Never a body, a header, or the vault key name.
  - **RBAC**: `kinds: ['agent']` only, and the skill must be one the *calling
    agent* carries. Workspace/agent ids come from the token; an invite bearer (a
    transient join secret) cannot spend a provider key. Per-agent
    `providerCallRateLimiter` at 20/min on top of `mcpRateLimiter`.
  No schema change — `activity_events` already existed in all three places.
- **The workspace vault** — `workspace_secrets` is the home of every credential a
  workspace holds, in three namespaces: the platform-managed keys
  (`MANAGED_SECRET_KEYS`), `sandbox:<provider>:<credential>` for a provider skill's
  API key, and anything else as a user-defined shared secret. `classifyVaultKey`
  in `shared/backend-core.cjs` is the single classification both backends use; it
  also decides the **write lane** (`managed` → `/settings/secrets`, `provider` →
  `/sandbox-credentials`, `shared` → `/vault/:key`). Surfaced in Settings → Vault,
  grouped by owner.
  - **WRITE-ONLY.** No route returns a value, in full or masked. The list route
    neither decrypts nor selects the secret columns — `VAULT_META_SELECT` asks
    Postgres for `configured` and `legacy_plaintext` as booleans, so there is
    nothing to redact. `maskSecret` is gone from both backends.
  - **Encrypted at rest**, always, on both lanes (`setWorkspaceSecretValue` in the
    shared core writes ciphertext to `secret_cipher` and `''` to `value`). Legacy
    plaintext rows are re-encrypted on boot by `reencryptLegacyPlaintextSecrets`.
  - **Not in the backendClient allowlists** — the dedicated manage-role routes are
    the only doors, and the generic `/vault/:key` charset (`[A-Za-z0-9_.-]`, no
    colon) means it cannot address a namespaced entry. `sanitizeRealtimeRow` strips
    `value` + `secret_cipher` as a third layer.
  - **Vault beats env.** `callProviderOperation` reads the vault first; a host env
    var is a fallback for a locally-run server, and the env NAME comes from the
    BUNDLED skill definition (`bundledCredentialEnvVar`), never from an
    agent-authored one — otherwise an agent that can write its own metadata could
    name `AUTH_SECRET` and have the server attach it as a Bearer token.
- **Skill content (agents can USE a skill, not just be listed as having one)** —
  `agent_connections.capabilities.skills` is a list of NAMES, so a skill was
  unusable unless an agent happened to run on the machine that had it. Bodies now
  live in the workspace: **push-and-store**, not fetch-on-demand.
  - **Transport**: a daemon pushes `{ action: 'agent_skill_sync', hash, skills:
    [{ skill, path, summary, content }] }`, mirrored into `agent_skill_documents`
    (UPSERT by `UNIQUE(agent_id, skill)`, then prune) — the same shape
    `agent_memory_sync` → `agent_memory_files` already uses. **Hash-gated**: the
    heartbeat carries `skillsHash`, `capabilitiesDriftNudges` compares it against
    the stored reference and nudges `agent_skills_refresh` on drift only.
    `handleAgentSkillSync` advances the stored hash itself, so drift resolves in
    one round-trip. A daemon that sends no `skillsHash` is **never nudged and
    never blocked** — its skills simply have no body yet.
  - **Reachable from a turn**: `list_skills` + `read_skill` in `server/mcp.cjs`,
    so one agent can read another agent's skill **while that agent is offline** —
    the reason this is stored rather than RPC'd to a live daemon. Both doors share
    `listWorkspaceSkills` / `loadSkillContent` in `server/skill-content.cjs` with
    the browser route, so a human and an agent can never see different text.
  - **A body is UNTRUSTED DATA.** It is a file from someone's laptop entering
    another agent's context, so `read_skill` returns it inside
    `fenceSkillContent` — a nonce fence built exactly like `fenceProviderOutput`.
    Truncation is always marked, never silent (64 KiB stored, 8000 chars per prompt).
  - **Never invent a body.** A closed set of reasons (`not-synced`,
    `host-fs-disabled`, `not-found`, `unreadable`) is reported to both the pane and
    the agent. Skills that agensis itself holds — sandbox/provider definitions —
    render `renderSkillBlock` verbatim, so a reader sees the agent's own text.
  - **Host libraries** (`detectSkillLibraries`) scan the **backend host**, not a
    daemon; reading their files is gated on `AGENSIS_ALLOW_PROJECT_FS` and confined
    to `skills`/`agents`/`commands` types — `config` is excluded because
    `~/.gemini/settings.json` holds API keys.
- **The join link (ONE invite URL, for a human OR an agent)** — `workspace_join_links`
  + `server/join-page.cjs` + the `/join/*` routes in `server/index.cjs`. Exists to
  remove a premise, not to add a feature: the MCP connect surface handed out a
  long-lived bearer token inside a convenience string with a copy button, it
  leaked into a transcript, and the same mistake was then found in a second
  place. The defect is not *where* a credential is rendered — it is that a
  long-lived credential has to be rendered at all.
  - **`https://agensis.io/join/<token>`**, one URL for both audiences.
    Server-rendered by Fly and PROXIED through Netlify (`netlify.toml`,
    `/join/*`, above the `/*` 404 catch-all) — the SPA is a JS shell, so an agent
    fetching it would get an empty `<div id="root">`. Requires **`AGENSIS_APP_URL`**
    on Fly, or minted links carry the fly.dev host instead of the app host.
  - **15-minute TTL, single use, hash at rest.** `AGENSIS_JOIN_LINK_TTL_MS`
    overrides, clamped to [1m, 24h]. The single-use rule IS the conditional
    `UPDATE ... where status='pending' and expires_at > now() and audience in
    ('both',$2)` — one statement, so two concurrent redemptions cannot both win.
    Consume-before-provision is deliberate: a failure leaves the link dead rather
    than replayable.
  - **A join link is NOT a credential.** It is absent from `verifyMcpToken`,
    `requireAuth` and every other `verify*`. Contrast `workspace_invites`, which
    IS accepted as an MCP bearer for its full 14 days (`verifyInviteToken`) —
    exactly the shape being retired. Don't merge the two tables.
  - **No User-Agent sniffing, anywhere.** An agent succeeds via `Accept:
    application/json` / `?format=json`, or via the HTML itself, which carries the
    contract four ways (JSON-LD, a *visible* fenced machine block, plain prose
    addressed to an agent, and the same steps in the redemption response).
    `tests/join-link.test.cjs` asserts the page is byte-identical across five
    User-Agents and that no join code reads the header.
  - **No oracle.** Unknown, malformed, expired, revoked, spent and wrong-audience
    all return an identical 410 body, and the refusal page never names the
    workspace. Rate-limited 10/min per IP, in-memory + DB-backed.
  - **Preview**: `GET /join/preview` renders the same template with invented data
    through a handler that contains no `getDb`, no `crypto`, and no minter — a
    dedicated path rather than `?preview=1` so there is no branch inside the
    handler that talks to the database.
  - **One secret per response.** The redemption response carries the agent's
    bearer token in exactly one field (`data.credential.token`); the config block
    beside it uses `TOKEN_PLACEHOLDER`, like `server/skills.cjs`. A test asserts
    the token appears exactly once. The same rule was applied retroactively to
    `/backend/workspaces/:id/mcp-token`, which was still passing the live token
    into `configBlock`.
- **Inference gateways** — `gateway_configs` table (workspace-scoped; API key
  stored AES-256-GCM-encrypted in `api_key_cipher` via the workspace vault, NEVER
  returned to the client — only `has_key`). Managed in Settings → AI. Selecting a
  `gateway:<id>` model in chat routes that turn through `/backend/ai-chat`'s
  gateway branch, which streams the external OpenAI-compatible endpoint's SSE
  straight through. NOT in the backendClient allowlists — reached only via the
  dedicated `/backend/workspaces/:id/gateways` routes (Fly server only).

## Tests (two runners)

- `npm test` — Node's built-in runner over `tests/*.test.cjs` (backend/integration,
  mock DBs). 334 tests. Note the glob is **top-level only** — a `.test.cjs` in a
  subdirectory is never run (`visual-editor/test/` is invisible to both runners).
- `npm run test:unit` — Vitest over `tests/unit/**/*.test.ts` (frontend/pure). 205.
- `npm run smoke` — Vitest over `tests/smoke/**/*.smoke.ts` (jsdom, its own
  config). Mounts each main surface with data in it and fails if an **empty
  state is showing while data exists**, plus a trap-state layer proving a
  persisted filter cannot hide the control that clears it. See
  [tests/smoke/README.md](tests/smoke/README.md). ~10 s.
- Keep all three green. `tests/cursorbuddy-manifest.test.cjs` asserts guided-tour
- **A test process never sees your `.env`.** `tests/helpers/test-env.cjs` is
  preloaded by both runners (`--require` in the `test` script, `setupFiles` in
  `vitest.config.ts`): it sets `AGENSIS_TEST=1`, which makes `loadEnvFile()` in
  `server/index.cjs` inert, and deletes every credential-bearing name plus
  everything a local `.env` declares. Without it the suite's result depended on
  the machine — three vault tests that `delete process.env.BOX_API_KEY` to
  exercise the "credential not configured" refusal had it handed back by
  `loadEnvFile()` and went red the day someone added a real Box key. `DATABASE_URL`
  stays unset on purpose: `getWorkspaceSecretValue`/`setWorkspaceSecretValue` take
  no db argument and always use the module-level `dbUnsafe`, so a missing
  `setTestDb` used to build a live **production** Neon client inside a test run
  (six per run, via `notifyDbSubscribers` → `enqueueFlowWebhookEvents`, swallowed
  by a fire-and-forget `.catch`). Unset, `getDb()` throws where somebody sees it.
  Use the shared `withEnv(name, value, fn)` from that helper to pin a variable —
  it asserts the pin held on both sides of the call, and never puts a value in a
  failure message (node's reporter prints `actual`). `tests/env-isolation.test.cjs`
  fails loudly if any of this comes undone.
- Keep both green. `tests/cursorbuddy-manifest.test.cjs` asserts guided-tour
  selectors exist in source — if you remove/rename a selector it references,
  update the tour JSON (`public/.well-known/cursorbuddy.json`) + that test.
- `npm run lint` is now clean and exits 0. The 6 previously-documented
  `_`-prefixed unused-var errors are fixed by an `argsIgnorePattern: '^_'` rule
  on the backend block in `eslint.config.js`. **A red lint is now a real
  regression — don't wave it through.**
- `tests/lint-coverage.test.cjs` asserts that every security-critical backend
  file is actually matched by an eslint config block. It exists because
  `shared/backend-core.cjs` — auth, RBAC allowlists, both rate limiters — had
  **zero rules applied** for months: the config globbed `shared/**/*.mjs` and the
  file is `.cjs`. eslint reports nothing for a file it doesn't match, so "green"
  and "never looked" are indistinguishable unless you ask. If you add a backend
  entry point, add it to `MUST_BE_LINTED` in that test.
- Onboarding testing: `npm run reset:test-account` wipes `testing@bouncingfish.com`
  (user + all their workspaces) so the onboarding tour can be re-run from scratch;
  also clear the `agensis_tour_complete` / `agensis_getstarted_*` localStorage keys
  (or use incognito) — onboarding state is client-side only.

## Release notes (user-visible changes)

`public/release-notes.json` is **hand-maintained** — nothing generates it. It feeds
the "A new version is available" panel, so if you ship a user-visible change and
don't add an entry, users are shown stale notes for a build that no longer exists
(this went six days and a dozen deploys unnoticed). Newest entry first; keep the
language plain and user-facing — what changed for them, not the commit subject.
`tests/release-notes.test.cjs` only guards the file's shape and ordering; it cannot
tell that you forgot to write one.

## Verify before you ship (every change)

```bash
npm run ci                   # typecheck + both suites + smoke + lint, in that order
node --check server/index.cjs                # if you touched the server
node --check netlify/functions/backend.mjs   # if you touched netlify
npm run build                                # if you touched the frontend
```

**`npm run smoke` is in that chain, and is not optional.** It exists because on
2026-07-27 a workspace holding 8 agents rendered "No agents match — You haven't
created any agents yet" over the full list, with no control on screen to undo
it: `ownerFilter` is persisted, and the Mine/All toggle only rendered when the
filter had matches. typecheck, eslint, both suites and the build were all green,
because **none of them renders the app**. The smoke gate does, and asserts the
one thing they structurally cannot: an empty state must not be showing while
data exists, and a persisted filter must never hide the control that clears it.
Dropping it means that class of bug is unguarded again — it was verified failing
against the pre-fix code before it was added.

`npm run ci` is the single gate. Run it locally — **do not infer "tests passed"
from GitHub Actions.** Actions is not currently a working gate on this repo: runs
finish in seconds with zero steps executed, which means no runner is being
assigned (an Actions minutes / spending-limit problem, not a workflow bug).
Confirm with `gh run view <id> --json jobs` — `steps: []` is the signature.

### Optional pre-push hook

`.githooks/pre-push` runs typecheck + both suites + the smoke gate before a
push. Enable it with:

```bash
npm run hooks:install        # git config core.hooksPath .githooks
```

**If you are an automated pusher, you must set `AGENSIS_SKIP_HOOKS=1`** for WIP
checkpoint pushes — a red hook would otherwise wedge an unattended loop with
nobody watching. Do NOT set it when merging to main. Humans can use
`git push --no-verify` for a one-off. `core.hooksPath` is repo-level config, so
enabling it affects every worktree including the shared checkout.

## Deploy targets

- **Frontend / netlify routes** → `netlify deploy --build --prod`.
- **WebSocket server / daemon orchestration** (`server/index.cjs`) → `fly deploy`.
- A change to `server/index.cjs` needs **Fly**; a frontend-only change needs
  **Netlify**; a change touching both (e.g. a shared-core edit) needs both.
- After deploying, confirm `git rev-parse HEAD` matches the pushed `main`.

## Deploy environment variables (split Netlify + Fly)

The static frontend + serverless HTTP routes run on **Netlify**; the long-running
WebSocket/daemon backend (`server/index.cjs`) runs on **Fly**. Both point at the
**same Neon DB**. The HMAC token secret MUST match across hosts or Netlify-signed
tokens fail to verify on Fly.

Local dev reads a `.env` (see README). For the deployed split:

| Var | Netlify | Fly (server) | Purpose |
|---|:--:|:--:|---|
| `DATABASE_URL` (or `NETLIFY_DATABASE_URL`) | ✓ | ✓ | Neon connection — same DB on both |
| `AUTH_SECRET` (a.k.a. `AGENSIS_AUTH_SECRET`) | ✓ | ✓ | **Must be identical** — HMAC session-token secret. Fly fails closed in prod without it |
| `ANTHROPIC_API_KEY` | ✓ | ✓ | AI chat / built-in agents (per-workspace key overrides it if set) |
| `AGENSIS_DAEMON_BASE_URL` | ✓ | — | Netlify → the Fly backend's public URL, so generated `agensis connect` commands + farm enrolment point at the WS host, not Netlify (which has no WS) |
| `COMMIT_REF` | ✓ (build) | — | Netlify sets this automatically; baked into `__BUILD_ID__` + `version.json` for the update check |
| `SECRETS_ENCRYPTION_KEY` | (see note) | ✓ | Dedicated key for the per-workspace secret vault (else derived from `AUTH_SECRET`). **If set on one host it must be set to the same value on the other**, or a secret written on one is undecryptable on the other. Netlify REFUSES vault writes while it is unset (503) rather than write a row Fly cannot read — reads are unaffected |
| `WORKSPACE_STORAGE_QUOTA_BYTES` | — | ✓ | Per-workspace upload quota (default 2 GB) |
| `AGENSIS_CAPABILITIES_TTL_MS` | — | ✓ | TTL for the `/system/capabilities` cache (default 30 s) |
| `AGENSIS_RUNTIME_SCHEMA` | — | ✓ | Set `false` to disable runtime DDL bootstrap (migrations become the sole schema source) |
| `AGENSIS_PUBLIC_URL` / `AGENSIS_APP_URL` | — | ✓ | Public origin for links the server emits. **`AGENSIS_APP_URL` must be `https://agensis.io` for join links** — unset, a minted `/join/<token>` URL carries the fly.dev host, which works but is not the one URL people are meant to be handed |
| `AGENSIS_JOIN_LINK_TTL_MS` | — | ✓ | Join-link lifetime (default 15 min; clamped to 1 min – 24 h) |
| `NETLIFY_WEBHOOK_JWS_SECRET` | — | ✓ | Verifies Netlify deploy webhooks that trigger the update banner |
| `AGENSIS_DEFAULT_AI_MODEL` | — | ✓ | Override the default model (`claude-opus-4-8`) |
| `CARTESIA_API_KEY` | ✓ | ✓ | Huddle text-to-speech (sonic-3.5). **Never sent to the browser** — exchanged for a 120s `tts`-only access token by `/voice/tts-token`. Unset ⇒ huddles fall back to `speechSynthesis` and say so |
| `DEEPGRAM_API_KEY` | — | ✓ | Huddle speech-to-text (Flux). **Never sent to the browser** — the Fly server relays the audio itself over `/backend/ws`, so this key is useless on Netlify (no websockets). Unset ⇒ fallback to `SpeechRecognition` |


## Agent daemon (separate open-source repository)

The host-side daemon is deliberately outside this closed app/backend repo. Its
source, tests, release workflow, and published bundle live at
`../agensis-agent` locally and
[`jasonkneen/agensis-agent`](https://github.com/jasonkneen/agensis-agent).
The npm package remains `@agensis/agensis-agent`; changes to the server/daemon
wire contract must be coordinated across both repositories.

## Conventions

- Match the surrounding file's style: 2-space indent, its semicolon convention,
  `cn()` for class merging, shadcn/ui primitives already imported in the file.
- No new npm dependencies without a strong reason. Drag-and-drop is native HTML5
  (`draggable` + `onDragStart/onDragOver/onDrop`) or pointer events — see
  `src/components/windows/ThreadWidgetRail.tsx` and `TasksWindowContent.tsx`.
- The root package is the closed Agensis app. Do not copy app, backend, database,
  or deployment code into the public daemon repository.
- User-facing rich text is sanitized through `src/lib/sanitize.ts` (DOMPurify) at
  every render/paste boundary.
