# nostr-first-api — Event-first API surface

Source pack: `repo-grab/out/extract-pack/nostr-first-api/` (buzz, rank 5, priority 77)
Stated target surface: "server event/bus layer (prefer additive message types over new REST)"
Written 2026-07-29 against `main-next` (Fly v126, daemon 0.1.44).

---

## 1. Verdict

**Reject the pack as stated. Adopt-modified two narrow ideas it surfaces.**

agensis already has the property this pack is selling, arrived at by a different
route, and the part it does not have is the part that does not transfer. Our
generic data surface is `/backend/db/select|insert|update|delete`
(`server/index.cjs:7216`, `:7232`, `:7336`, `:7489`) gated by a single
table allowlist (`shared/backend-core.cjs:31-89`, 31 tables) and a single
authorization function (`shared/backend-core.cjs:855`), paired with a generic
subscription surface (`db_changes` in `server/realtime.cjs:199-266`). Adding a
feature here already means **adding a table to three sets in one file**, not
adding REST paths — `thread_items`, `agent_permission_requests`,
`thread_harvests` and `orb_deliveries` are all recent features that got their
entire read plus live-update surface that way, with zero new read routes. That is
precisely buzz's "new features prefer new kinds over new paths", expressed as
rows in a gated table instead of signed events with a kind integer.

What buzz has that we do not is **cryptographic authorship**: a Nostr event
carries a pubkey and a signature over its content, the relay verifies it, and
therefore nobody can publish as somebody else. Our equivalent property does not
exist and is not free — identity is a session cookie, authorization is a
role in `workspace_members`, and durability is Postgres. Rebuilding the API
around signed events would mean re-litigating all three. That is the "re-litigate
identity, auth and persistence" cost the task framing predicted, and I agree with
it: the work is large, the security model gets weaker before it gets stronger,
and the delivered capability at the end is what we have today.

There is also a hard architectural blocker the pack does not know about. agensis
runs **two backends over one database**: the long-running Fly server owns
WebSockets, and the Netlify serverless functions have **no WebSockets at all**
(`AGENTS.md:11-15`, `:383`). "Primary API is events over WebSocket, HTTP reserved
for media and health" would make the Netlify backend structurally incapable of
serving the primary API. Today both backends serve the same generic HTTP data
surface through the same shared core, which is what makes that split work.

So: no migration plan. What I do recommend is three items, in priority order, all
of which are things this pack's underlying insight is genuinely right about:

- **A. Bind message authorship server-side.** `messages.sender_kind` /
  `sender_id` / `sender_name` are client-supplied and unvalidated on a route that
  needs only the `write` capability. Any workspace editor can post a message that
  renders as a named agent or another human. This is the one real gap
  "signed events" closes, restated in our model. Highest value item here.
- **B. Re-authorize live subscriptions continuously, not only at bind time.** The
  H4 fix (`server/realtime.cjs:134-158`) established the pattern but wired it to
  exactly one trigger. Two verified holes remain: a signed-out session's open
  socket keeps streaming, and re-parenting a workspace silently keeps inherited
  subscribers connected.
- **C. Document and pin the socket envelope.** Cheap, low value, do it last or not
  at all. Value is documentation and one regression test, not capability.

If the intent is strictly API-surface work, only B and C qualify. A is a security
fix that this pack surfaced; I am including it because it is the only place where
buzz's model buys something we actually lack.

### What already exists today (citations)

| Property the pack asks for | Where it already lives |
| --- | --- |
| Generic, non-per-feature data reads | `server/index.cjs:7216` + `shared/backend-core.cjs:855` |
| One allowlist controlling the whole surface | `shared/backend-core.cjs:31-89` (`ALLOWED_TABLES`, 31 tables), enforced by `ensureTable` in `server/lib/db-sql.cjs:35` |
| Per-table, per-verb capability mapping | `shared/backend-core.cjs:187-254` (`DB_TABLE_ACCESS`) |
| Column-level stripping on write | `shared/backend-core.cjs:258-281` (`PRIVILEGED_DB_COLUMNS_BY_TABLE`), `:293-299` (`MANAGE_ONLY_DB_COLUMNS_BY_TABLE`) |
| Column-level stripping on read | `shared/backend-core.cjs:327-348` (`SELECTABLE_COLUMNS_BY_TABLE`, `safeSelectColumns`) |
| Generic pub/sub over one socket | `server/realtime.cjs:199-278`, client half `src/lib/backendClient.ts:459-653` |
| Field stripping on the fanout | `server/realtime.cjs:175-197` (`sanitizeRealtimeRow`) |
| Additive message types, old clients unharmed | Server ignores unknown `action` (`server/realtime.cjs:449-543` falls through); daemon ignores unknown `type` (`packages/agensis-cli/src/agensis.mjs:414-600` falls through) |
| Agent-facing capability API | `server/mcp.cjs` — 30 tools, one JSON-RPC endpoint, no per-feature REST |

Current surface, counted today: 150 HTTP route registrations across `server/*.cjs`,
24 client-to-server socket actions, 22 server-to-client socket message types,
30 MCP tools, 31 allowlisted tables.

### One correction to the task framing

The brief states `shared/backend-core.cjs` is unlinted because eslint globs
`shared/**/*.mjs`. That has since been fixed — `eslint.config.js:37` now globs
`shared/**/*.{cjs,mjs}`, and the comment at `:30-33` plus a `lint-coverage` test
guard the regression. Growing that file is no longer a lint-coverage concern.

---

## 2. What the pack actually proposes

From `pack.json` and `PROMPT.md`: make signed events over a WebSocket relay the
primary API. HTTP is reserved for media upload, health, metadata, and generic
event/query bridges. A new feature is a new `kind` integer, not a new REST path;
clients that do not understand a kind ignore it, so the wire protocol only ever
grows. `ARCHITECTURE.md` (quoted in the anchors) states the relay is the single
source of truth for all reads and writes, that it verifies signatures, persists,
fans out, indexes for search, and triggers automation, and that the tenant
boundary (`community`) is resolved from the request host **before** AUTH, EVENT,
REQ, REST, media, git, search, workflow or pub/sub handling, failing closed on an
unknown host.

The pack contains no source excerpts — `anchors.json` has a directory listing for
`crates/buzz-relay` and two truncated markdown headers. There is no code to
reason about, only the stated architecture. That is worth saying plainly: this is
a thin pack, and the recommendation to transfer it appears to be derived from the
concept description rather than from anything observed in the code.

### Where buzz's assumptions do not transfer

1. **Identity.** Nostr identity is a keypair; the pubkey in the event *is* the
   author, and the signature makes it unforgeable without any server state.
   agensis identity is an HMAC session token carrying `userId` and
   `token_version` (`shared/backend-core.cjs:405-430`), or an `aga_…` agent
   connect token. There is no client-held signing key, no key distribution, no
   revocation story for a key, and no UI concept of "your key". Introducing one
   is a product decision about account recovery and device trust, not an API
   refactor.

2. **Authorization.** buzz authorizes by relay policy over event kinds and
   community membership. agensis authorizes by capability
   (`read | write | comment | run_agents | manage`) resolved per workspace with
   **downward inheritance through the workspace tree**
   (`shared/backend-core.cjs:651-667`). A per-event-kind policy table would have
   to reproduce `enforceDbOperationAccess` (`:855-958`) — including the C1
   unfiltered-write refusal, cross-tenant parent-reference checks
   (`assertUpdateKeepsTenancy`, `:824`), and the manage-only column elevation —
   or become a second, divergent authorization path. A second authorization path
   is the specific failure this codebase has spent effort eliminating: the whole
   header of `shared/backend-core.cjs` exists because the Netlify backend once
   had its own (absent) one.

3. **Durability and fanout are the same thing in buzz, and are not here.** The
   buzz relay persists the event and fans it out. Our WS fanout is a **broadcast
   mechanism only**: `notifyDbSubscribers` is called *after* a successful DB
   write by whichever route did the write, and drops sends on a slow or closed
   socket without retry (`server/realtime.cjs:107-119`, note the 4 MB
   `bufferedAmount` drop). No client may treat a socket message as the write
   receipt. An event-first API would make the socket the write path, which means
   inventing at-least-once delivery, ordering, and replay — none of which exist.

4. **Two backends, one of which cannot hold a socket.** Covered in the verdict.
   `AGENTS.md:383` is explicit that Netlify has no websockets.

5. **Host-derived tenancy.** buzz resolves the community from the request host
   before anything else. agensis serves every workspace from one host and
   resolves the workspace from the row being touched
   (`resolveOperationWorkspace`, `shared/backend-core.cjs:547-581`). Nothing to
   transfer.

---

## 3. Impact on our system

If we adopted the pack as stated, the blast radius is: `server/realtime.cjs`
(auth model), `shared/backend-core.cjs` (a parallel policy table),
`server/index.cjs` (every write route becomes an event handler),
`netlify/functions/backend.mjs` (cannot participate), `src/lib/backendClient.ts`
and every hook under `src/hooks/` (the query API changes shape),
`packages/agensis-cli/src/agensis.mjs` (a new signing identity per agent), and
the 30 MCP tools (which would be re-expressed as event kinds and lose their
schema-validated tool contract). It would force a migration of the session token
model and would break every daemon older than the cutover, since there is no
protocol negotiation to fall back on. I am not planning that.

The three items I *am* proposing have this impact:

**A (authorship binding)** touches `server/index.cjs` (the insert route's row
mapper at `:7237-7262`), `shared/backend-core.cjs` (a new stamping helper so both
backends share it), `netlify/functions/backend.mjs` (parity),
`src/hooks/useChat.ts` (the built-in chat lane, see below), and adds one
`tests/*.test.cjs` file. It does **not** need DDL. It respects RBAC by
construction: it removes a client's ability to choose an attribution field, and
adds no new capability.

The complication, and the reason this is not a one-line strip: the browser
*legitimately* writes an agent-attributed message today. The built-in (non-daemon)
chat lane streams from the server and then persists the assistant turn from the
client, setting `sender_kind: 'agent'`, `sender_id`, `sender_name`
(`src/hooks/useChat.ts:752-762`). A naive "always stamp from the session user"
would relabel every built-in agent reply as the human who triggered it. So A has
to either move that persist server-side into `server/ai-chat-routes.cjs`, or
validate the claimed agent instead of trusting it. I recommend validating, as the
smaller change (see the work breakdown).

**B (continuous re-authorization)** touches `server/realtime.cjs` only, plus its
call sites in `server/index.cjs`. No DDL, no frontend change, no daemon change.
It strictly *reduces* what a socket can see, so it cannot grant access.

**C (envelope + registry)** touches `server/realtime.cjs`, adds a doc, adds one
test. No behaviour change.

Interaction with work in flight: none of the three collides with
`self-update-supervise` (daemon-side, already shipped in 0.1.43/0.1.44), the
permission-request reconnect work, `thread_harvests`, or
`server/channel-bridges.cjs`. B1 does interact with bridges in one way worth
noting: bridge daemons authenticate with an agent connect token, not a session
token, so the `token_version` re-check must skip agent sockets (they have
`ws.agentAuth`, not `ws.userId`) or it will disconnect every daemon.

---

## 4. Work breakdown

Ordered. Item B is the genuine vertical slice: smallest, self-contained,
independently shippable, and closes a live hole.

### B1 — an open socket must stop streaming when its session is revoked

Today `verifyToken` runs exactly once, at connect (`server/realtime.cjs:389` for
the query-param path, `:430` for the auth-frame path). Signing out bumps
`app_users.token_version` (`server/auth-routes.cjs:199`), which invalidates every
HTTP request — but nothing revisits the open socket, so a signed-out browser tab
keeps receiving `db_changes` for every workspace it was subscribed to until the
socket drops. The same is true of the 14-day token TTL: an open socket outlives
its own token.

Files:

- `server/realtime.cjs` — add `sweepSessionValidity()`: for each client in
  `websocketClients` where `ws.userId` is set (skip agent sockets, which have
  `ws.agentAuth` and no `userId`), re-run the *same* `verifyToken` against the
  token captured at authentication; on failure send
  `{ type: 'system', event: 'unsubscribed', reason: 'session_revoked' }` then
  `ws.close(1008, 'Session revoked')`. Store the token on the socket at
  `finalizeAuthenticated` (`:379-384`) — it is already in memory, this adds no
  new exposure. Call the sweep from the existing liveness interval
  (`:580`) rather than adding a second timer, but gate it to run every Nth tick
  (suggest every 4th, so ~60s) since it does a DB read per distinct user.
- `server/realtime.cjs` — export `sweepSessionValidity` for the test seam,
  alongside `sweepLiveness` (`:617`).
- `server/index.cjs` — re-export on `__test` next to `revokeRealtimeAccessForMember`
  (`:7641`).

Required role: none — this only removes access.
New routes: none. New message types: none (reuses the existing `system` /
`unsubscribed` shape the client already handles, `src/lib/backendClient.ts:516`).
DDL: none.

Deliberate non-goal for B1: **do not** make this a per-message check. A DB read
per broadcast on a workspace's message firehose is exactly the kind of cost the
`token_version` in-process cache (`shared/backend-core.cjs:483-506`) exists to
avoid. A ~60s revocation window on an open socket is the right trade.

### B2 — re-parenting a workspace must revoke inherited subscribers

`revokeRealtimeAccessForMember` is wired to one trigger: `workspace_members`
DELETE or UPDATE (`server/realtime.cjs:238-242`). But access is the union of the
direct role and every role inherited from an ancestor
(`shared/backend-core.cjs:661-667`). Moving a workspace out of a group changes
`workspaces.parent_id` and nothing else — no `workspace_members` row is touched —
so a user whose only access was inherited keeps their live subscription to the
moved workspace's `tasks`, `messages` and `canvas_objects`.

Files:

- `server/realtime.cjs` — add `revokeRealtimeAccessForWorkspace(workspaceId)`:
  iterate `websocketClients`, and for any socket holding a subscription whose
  resolved workspace is `workspaceId` (or a descendant), re-run
  `authorizeRealtimeBinding` and drop what no longer passes. Reuse the existing
  per-subscription loop from `revokeRealtimeAccessForMember` (`:140-158`) —
  factor the inner loop into a shared `pruneSubscriptions(ws)` so there is one
  implementation of "re-check this socket's bindings".
- `server/realtime.cjs` — in `notifyDbSubscribers`, extend the existing
  `workspace_members` hook (`:238-242`) with:
  `if (table === 'workspaces' && eventType === 'UPDATE')` → for each row, call
  `revokeRealtimeAccessForWorkspace(row.id)`. Cheap: it only re-checks sockets
  that actually hold a binding for that workspace.

Note the simplification available here: because `pruneSubscriptions` re-runs
`authorizeRealtimeBinding`, which resolves the workspace through the same
`enforceDbOperationAccess` path as a fresh subscribe, it is correct to be
*over-inclusive* about when to prune. Pruning on every `workspaces` UPDATE is
fine and is simpler than diffing `parent_id`.

Required role: none. DDL: none. Frontend: none.

### A — bind message authorship server-side

The gap: `messages` has no author column at all
(`database/neon-schema.sql:210-219`); attribution is entirely
`sender_kind` / `sender_id` / `sender_name`, all added as nullable text with `''`
defaults (`:241-243`). `DB_TABLE_ACCESS.messages` is `DEFAULT_TABLE_ACCESS`
(`shared/backend-core.cjs:190`), so insert requires only `write`.
`PRIVILEGED_DB_COLUMNS_BY_TABLE` has no `messages` entry (`:258-281`), so
`stripPrivilegedDbValues` is a no-op, and the insert route's row mapper
(`server/index.cjs:7237-7262`) applies its stamping only to `workspaces`,
`tasks` and `workspace_agents`. Net effect: any member with `write` can POST
`/backend/db/insert` with `{table:'messages', values:{session_id, role:'assistant',
sender_kind:'agent', sender_id:'<a real agent uuid>', sender_name:'Coder',
content:'…'}}` and the transcript will render it as that agent, with that agent's
avatar and accent (`src/components/windows/ChatWindowContent.tsx:2823-2847`).

It is not only cosmetic. A forged `sender_kind:'agent'` row drives the sidebar
agent-status broadcast (`server/realtime.cjs:215-226`) and is read by the burst
and dispatch logic (`server/index.cjs:3835`, `:4809-4817`, `:5068-5072`).

Scope: within-workspace impersonation only. It requires `write` in the workspace,
so it is not a cross-tenant issue. Rank it as moderate, not critical.

Files:

- `shared/backend-core.cjs` — new exported
  `resolveMessageAttribution({ userId, values, db })`, returning the
  `sender_kind` / `sender_id` / `sender_name` triple the server will actually
  write. Rules:
  - `sender_kind` absent or `''` → human message: force
    `sender_id = userId`, and `sender_name` = the caller's `display_name` read
    from `app_users` (not the client's string).
  - `sender_kind === 'agent'` → look up `workspace_agents` by
    `values.sender_id` and assert the agent belongs to the session's workspace
    (resolve via `chat_sessions.workspace_id`, the same lookup
    `resolveOperationWorkspace` already does at `:551-554`). Force `sender_name`
    from the agent row. Reject a `sender_id` that is not a real agent in this
    workspace with a 403.
  - Any other `sender_kind` (`'integration'` is used at `server/index.cjs:6425`)
    → reject from the generic route; those rows are written by dedicated paths.
  Put it in the shared core, not in `server/index.cjs`, so Netlify gets the same
  rule for free — this is exactly the class of divergence the file exists to
  prevent.
- `server/index.cjs:7237-7262` — call it from the insert row mapper, alongside
  the existing `synthesizeHumanIdentityInsert` call. Same place, same shape.
- `netlify/functions/backend.mjs` — call it from that backend's insert path.
  `tests/netlify-parity.test.cjs` is the guard that this happened.
- `src/hooks/useChat.ts:752-762` — no change required if the validating form is
  chosen: the browser already passes a real `agent.id` from the workspace, so it
  will pass validation, and `sender_name` will simply be overwritten with the
  canonical agent name. Verify the direct-DM branch
  (`directParticipant?.handle` as `sender_id`, `:758`) — a **handle** is not a
  uuid, so that call will fail the agent lookup. Either make the lookup accept
  handle-or-id, or fix the hook to send the id. Decide this before writing the
  helper; it is the one place this change can break a live flow.

Required role: unchanged (`write`). New routes: none. DDL: none — deliberately.
Adding a real `author_user_id` column would be the better long-term shape, but it
means a backfill over every historical message and a change to every read
projection, and the security property is obtainable without it.

### C — document and pin the socket envelope

Only worth doing after A and B. The claim "additive message types do not break
old clients" is currently true by accident (both sides fall through on unknown
types) and is untested.

Files:

- `docs/realtime-protocol.md` (new) — one table of the 24 inbound actions and 22
  outbound types, each with its payload shape, the auth principal that may send it
  (session user vs agent connect token), and the required capability. State the
  additive rule explicitly: never change the meaning of an existing type, never
  make an existing field required, add a new type instead. Reference it from
  `AGENTS.md` under `## Realtime` (`AGENTS.md:39-45`), which currently describes
  the fanout but not the protocol.
- `tests/realtime-envelope.test.cjs` (new) — see the test plan.

Explicitly **not** proposed: a `protocolVersion` handshake field. The daemon sends
`metadata.version` today (`packages/agensis-cli/src/agensis.mjs:380`) and the
server does not read it. Adding a negotiated version would create a second thing
to keep in sync across two independently-deployed artifacts (Fly and npm) and buys
nothing while the additive rule holds. If we ever need a breaking change, add the
version field *then*, in the same release as the change that needs it.

---

## 5. Test plan

Runner globs, from `package.json:test` and `vitest.config.ts:7`:
backend is `node --test tests/*.test.cjs` (flat, `.cjs` only — a `.mjs` there is
never run); frontend is `vitest run` over `tests/unit/**/*.test.ts` only.
Everything below is backend.

**`tests/realtime-session-revocation.test.cjs`** (B1)

- Invariant: a socket whose user's `token_version` has advanced is closed by the
  sweep. Mutation that must break it: make `sweepSessionValidity` compare against
  the version captured at connect instead of re-reading the DB — the test must
  fail.
- Invariant: an agent socket (`ws.agentAuth` set, `ws.userId` null) is never
  touched by the sweep. Mutation: drop the `ws.userId` guard — every daemon
  socket closes, test fails. This one matters more than the first; getting it
  wrong disconnects every daemon on the platform.
- Invariant: a still-valid session survives the sweep and receives no message.
  Guards against a sweep that closes everything.

Build the fake client the way `tests/realtime-revocation.test.cjs:33-42` does,
and register it via `__test.registerTestWebsocketClient`. Use `__test.setTestDb`
with a db that answers only `select token_version from app_users where id = $1`.

Vacuity warning specific to this file: do **not** write a mock whose `unsafe`
returns a version derived from what the caller passed. That tests the mock. The
mock must hold a fixed table (`{ 'u1': 3 }`) that the test mutates between the
connect and the sweep, so the assertion is about the code re-reading, not about
the mock agreeing with itself.

**`tests/realtime-workspace-reparent.test.cjs`** (B2)

- Invariant: a user whose access to `ws-child` was inherited from `group-A` loses
  the `tasks:ws-child` subscription after `notifyDbSubscribers('workspaces',
  'UPDATE', [{id:'ws-child', parent_id:'group-B'}])`. Mutation: remove the
  `workspaces` branch from the `notifyDbSubscribers` hook — the subscription
  survives, test fails.
- Invariant: a user with a *direct* member row on `ws-child` keeps the
  subscription across the same re-parent. Guards against pruning too much.
- The db mock must implement the ancestor-roles query
  (`ANCESTOR_ROLES_SQL`, used by `shared/backend-core.cjs:653`) as a real lookup
  over a fixed parent map, so flipping the map is what changes the outcome.

**`tests/message-attribution.test.cjs`** (A)

- Invariant: `resolveMessageAttribution` overwrites a client-supplied
  `sender_name` for a human message with the value read from `app_users`.
  Mutation: pass the client value through — fails.
- Invariant: `sender_kind:'agent'` with a `sender_id` belonging to a *different*
  workspace's agent throws 403. Mutation: drop the workspace comparison — fails.
  This is the cross-tenant case and is the one worth being strict about.
- Invariant: `sender_kind:'agent'` with a valid in-workspace agent is accepted and
  `sender_name` comes from the agent row, not the payload.
- Invariant: `sender_kind:'integration'` from the generic route is rejected.
- Add an assertion to `tests/netlify-parity.test.cjs` that the Netlify insert path
  calls the same helper — this repo's history says a shared-core rule applied on
  one backend only is the default outcome, not the exception.

**`tests/realtime-envelope.test.cjs`** (C)

- Invariant: an authenticated socket that receives an unrecognised `action`
  neither throws nor closes, and the socket stays in `websocketClients`.
  Mutation: add a `throw` on the fall-through in `server/realtime.cjs:449-543` —
  fails. This is the test that makes "additive types are safe" a fact rather than
  an accident.
- Invariant: the documented action list in `docs/realtime-protocol.md` matches the
  set of `message.action ===` comparisons in `server/realtime.cjs`. A source-text
  assertion in the style of `tests/backend-client-contract.test.cjs`. It will need
  updating when an action is added — that is the point.

No frontend unit tests are needed for any of the three: none of them changes a
`src/` module's behaviour, except the possible `useChat.ts:758` `sender_id` fix,
which if made should be covered by an assertion in an existing
`tests/unit/**/*.test.ts` chat test rather than a new file.

---

## 6. Migration and rollout

**Data migration: none.** No new tables, no new columns, no backfill, in any of
the three items. This is deliberate — the security property in A is reachable
without a schema change, and a `messages` backfill would be irreversible in
practice given the table's size.

Historical rows keep whatever attribution they were written with. There is no way
to retroactively distinguish a forged historical message from a real one; that is
a consequence of not having recorded the authenticated principal, and it is not
fixable by this work. Say so rather than implying the fix is retroactive.

**Deploy lanes** (per `AGENTS.md:350-357` and the four-lane rule):

| Item | Lane | Notes |
| --- | --- | --- |
| B1, B2 | `fly deploy` only | `server/realtime.cjs` + `server/index.cjs`. No DDL, so no `ensureRuntimeSchema` concern. |
| A | `fly deploy` **and** Netlify | Shared-core change touching both backends. Fly first, then Netlify — the established order. |
| A, if `useChat.ts` needs the `sender_id` fix | + Netlify (frontend) | Frontend is Netlify auto-deploy on push to the deploy branch. |
| C | `fly deploy` (test/doc only, so effectively nothing) | The doc and test ride along; no runtime change. |

No npm publish of `@agensis/agensis-agent` and no daemon restart is needed for any
of the three. B1 is the one to double-check on this point: it changes socket
lifetime for *session* sockets only, and daemons hold *agent* sockets. If the
`ws.userId` guard is wrong, every daemon in the field disconnects on the first
sweep and there is no daemon-side change to roll back — the rollback is a Fly
deploy. That is why that guard has its own test above.

**Feature flags.** B1 is the only one worth flagging, because it is the only one
that can disconnect live users. Gate it on an env var read at boot
(`AGENSIS_REALTIME_SESSION_SWEEP`, default on, set to `0` to disable) so a
rollback is a `fly secrets set` plus a restart rather than a redeploy. B2 and A
need no flag: B2 can only prune a subscription that a fresh subscribe would
already refuse, and A can only reject a write that should not have been accepted.

**What rollback means concretely.** For all three: `fly deploy` of the previous
image. Nothing is persisted that a rollback would leave inconsistent, because
nothing writes new state. A's rejections are 403s at the API boundary; rolling
back simply starts accepting those payloads again.

---

## 7. Risks, effort, and non-goals

### Risk register, ranked

1. **B1 disconnects every daemon** (availability, no data loss). If the sweep
   does not skip sockets authenticated by agent connect token, every daemon drops
   on the first tick and every in-flight turn is failed by
   `markAgentConnectionOffline`. This is the same failure mode that motivated
   raising `LIVENESS_MAX_MISSED_PONGS` to 8 (`server/realtime.cjs:68-86`) — the
   repo has already paid for this lesson once. Mitigation: the explicit
   agent-socket test above, plus the env flag.
2. **A breaks the built-in chat lane** (functional). `useChat.ts:758` puts a
   *handle* in `sender_id` on the direct-DM branch; a uuid-only agent lookup
   rejects it and the assistant turn silently fails to persist. Mitigation:
   resolve handle-or-id in the helper, and check this branch before writing the
   code, not after. This is the single most likely way this plan produces a
   visible regression.
3. **A diverges between the two backends** (security regression). A rule applied
   on Fly but not on Netlify is a bypass, and this exact divergence is why
   `shared/backend-core.cjs` exists (see its header, `:1-16`). Mitigation: the
   helper lives in the shared core and `tests/netlify-parity.test.cjs` asserts
   both call it.
4. **B2 prunes too aggressively** (functional). Pruning on every `workspaces`
   UPDATE re-runs `authorizeRealtimeBinding` for affected sockets; if that check
   is ever made stricter than the subscribe-time check, users lose live updates
   on unrelated workspace edits (a rename). Mitigation: it calls the *same*
   function as subscribe, and the "direct member survives a re-parent" test pins
   it. Low severity — worst case is a client that must resubscribe.
5. **B1's DB read cost** (performance). One `token_version` read per distinct
   user per sweep. With the ~60s cadence and the existing short-TTL cache
   (`shared/backend-core.cjs:483-506`) this is negligible, but it is a new
   periodic query on the hot server. Mitigation: reuse the cache; do not add a
   second interval timer.

No item in this plan can cause data loss. Nothing deletes, nothing migrates,
nothing rewrites a row.

### Effort

| Item | Estimate | Confidence |
| --- | --- | --- |
| B1 | 1.0 day | High |
| B2 | 0.5 day | High |
| A | 2.0-3.0 days | Medium |
| C | 1.0 day | High |
| **Total if all four** | **4.5-5.5 days** | Medium |

Recommended slice: **B1 + B2 first (1.5 days)**. Self-contained, one file, no
frontend, no daemon, closes two verified holes, and establishes
`pruneSubscriptions` as the single re-authorization primitive that any future
trigger hangs off.

Biggest unknown: item A's blast radius through the direct-DM path in
`useChat.ts`. I read the hook but did not run the app, so I cannot state with
certainty which branch a DM to a daemon-backed agent takes at
`src/hooks/useChat.ts:757-759`, or whether `directParticipant.agent_id` is
populated in practice (it is preferred over `.handle` in the `||` chain, so the
handle may be dead in every real case — but "may be" is not "is"). Resolve that
by inspection before starting A, not during.

### Deliberately NOT built in v1

- **No signed events, no client keypairs, no signature verification.** Rejected in
  the verdict; restated here so it is unambiguous.
- **No `protocolVersion` negotiation.** Reasoned in item C.
- **No new event/kind registry table.** The table allowlist in
  `shared/backend-core.cjs:31-89` already is the registry, and it is code-reviewed
  rather than data — which is the right place for a security boundary.
- **No `author_user_id` column on `messages`.** The right long-term shape, but it
  needs a backfill over the largest table in the schema and a change to every read
  projection. A gets the security property without it; revisit separately.
- **No per-broadcast authorization check.** B1 is a periodic sweep on purpose. A
  check per fanned-out row would put a DB read in the hottest path on the server.
- **No change to the MCP tool surface.** `server/mcp.cjs` is already the
  agent-facing generic API the pack asks for, and re-expressing 30
  schema-validated tools as event kinds would lose the schema.
- **No move of any write off HTTP onto the socket.** The socket has no delivery
  guarantee and no receipt; making it a write path means building at-least-once
  delivery, ordering and replay first.
