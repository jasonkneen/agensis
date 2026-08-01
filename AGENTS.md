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
`WORKSPACE_SCOPED_TABLES`, `DB_TABLE_ACCESS`). **That confirmation is no longer
on your honour** — if the table is broadcast, `tests/realtime-fanout-allowlist.test.cjs`
fails until it is allowlisted or declared; see "Fanout and the allowlist" below.
Array columns (e.g. `uuid[]`) need
`ARRAY_COLUMNS_BY_TABLE` + the `toPgArrayLiteral` bind path in BOTH backends —
postgres.js will not array-serialize a raw JS array bound via `.unsafe`.

## Read authorization has TWO granularities: workspace, then session

Every read path resolves a `workspace_id` and calls
`enforceWorkspaceRole(userId, workspaceId, 'read')`. That check is necessary and
unchanged. **It is no longer sufficient**: on the request/response read paths, a
session marked `chat_sessions.visibility = 'private'` is readable only by rows in
`chat_session_members`.

Realtime broadcast is a separate lane with different coverage — read
[What this section does NOT
cover](#what-this-section-does-not-cover-realtime-fanout) at the end before you
treat "private sessions are gated" as a property of the whole system.

The rule has exactly ONE spelling, in `shared/backend-core.cjs`:

| helper | use |
| --- | --- |
| `isPrivateSessionRow(row)` | is this session members-only? |
| `enforceSessionReadAccess({userId, sessionId, db})` | row-at-a-time gate; throws 403 |
| `sessionReadableSql(alias, '$n')` | SQL predicate, for queries spanning many sessions |
| `appendSessionAccessClause(where, userId, table)` | row filter for generic `chat_sessions`/`messages` selects |

**Add a read path, use one of those four.** Do not re-spell the predicate — a
second copy is how this drifts back open.

**A private session is a DM, or anything derived from one.** Sub-thread splits
(`parent_message_id`), forks (`split_parent_id`) and huddle transcripts
(`huddles.transcript_session_id`) inherit both `visibility` and the member list
at creation time. Scoping only `folder = 'Direct messages'` is a partial fix —
sub-thread sessions hang off DM messages and huddle sessions carry a DM roster
while sitting in neither folder, and both were found in real data before the
inheritance rule was added.

`isPrivateSessionRow` treats `visibility = 'private'` **OR**
`folder = 'Direct messages'` as private, on purpose. The folder half is the
fail-closed backstop: a new DM-creating path that forgets the column cannot
silently produce a world-readable DM.

**No implicit owner oversight.** A workspace owner is not a member of your DM
just for owning the workspace. They hold `manage`, so they can GRANT themselves
access — which writes a `chat_session.access_granted` audit row. Silent reads
would be the same power with no trace.

**Granting is manage-gated and authorized on the WORKSPACE ROLE, never on the
grant.** `server/session-access-routes.cjs`. A grant-holder without `manage`
cannot widen their own access or pass it on; otherwise one grant would compound
into the whole workspace. Revoke touches `source = 'grant'` rows only, so it can
never strip the person whose conversation it is.

**`chat_session_members` is deliberately absent from `ALLOWED_TABLES`**, like
`audit_log`. Reachable through `POST /backend/db/insert` it would be a self-grant
primitive and the whole feature would be theatre.

**An AGENT is scoped by participation, not membership** (`mcpSessionScopeSql` in
`server/mcp.cjs`). `chat_session_members` holds user ids and an agent is not a
user, so the agent branch asks whether the agent is in the session's roster. That
keeps an agent working in its own DM — the core product loop — without opening
every other agent's DM to it. A `workspace` MCP token is a control-plane
credential and sees workspace-visible sessions only; it never impersonates the
owner for private reads. Unpinned `integration` tokens get no private sessions
at all.

Pinned by `tests/dm-scope-assumption.test.cjs`. If you change any of the above,
that file goes red — update it and this section together.

What IS structurally guaranteed, and must stay that way: `messages` has no
`workspace_id` column, so a message is only reachable through
`session_id -> chat_sessions.workspace_id`. That makes cross-tenant scoping a
property of the schema rather than a convention a query can forget — an unscoped
`messages` select cannot even be expressed through the generic DB route. Keep
`messages` OUT of `WORKSPACE_SCOPED_TABLES` for the same reason.

### What this section does NOT cover: realtime fanout

Everything above describes the **request/response read paths** — REST routes,
the generic `/backend/db/*` handlers, and MCP. It does not describe realtime
broadcast, and the two are not equivalent. Be precise about this before you rely
on it:

- **`chat_sessions` is scoped.** `notifyDbSubscribers` splits private rows out of
  the synchronous fanout and sends them down an async lane that can consult
  membership. Without that split, opening a DM would push its title and roster to
  every socket in the workspace.
- **`agent_permission_requests` is independently session-scoped.** Requests
  attached to a session leave synchronous workspace fanout and use a live
  session-audience lookup before INSERT or UPDATE delivery. Unknown sessions and
  lookup failures fail closed. Public-session requests and legacy rows with no
  session remain workspace-visible.
- **`huddles` and `huddle_events` are scoped through the host session.** Huddle
  rows resolve `session_id`; event rows resolve `huddle_id -> session_id`. Both
  leave synchronous workspace fanout and use the same fail-closed live audience
  lookup. The generic database path is read-only for these tables and applies
  the corresponding session predicate to workspace-wide reads.
- **`thread_items`, `agent_jobs` and `agent_schedules` are session-scoped.**
  Each row carries or resolves one `session_id`, and its realtime event leaves
  synchronous workspace fanout for the fail-closed live audience lane. Generic
  job/schedule writes are server-owned and refused; thread mutations must prove
  one session and pass its access gate. Schedule execution re-checks both the
  creator's current workspace role and private-session membership at run time.
- **`messages` is covered by a different argument**, not by that split. An
  unfiltered `messages` subscription cannot be established at all, so a message
  only ever reaches a socket that named its session.
- **Every other allowlisted table is covered by none of those lanes.** A table that is
  subscribable on a `workspace_id` filter and that can hold DM-derived rows fans
  those rows to every socket in the workspace that holds `read`. The REST
  projection for those tables is not the control here, because the fanout does
  not go through it.

**So the session granularity is enforced broadly on the REST/MCP side but only
for the eight named table shapes above.** If you are adding a table that can carry
content derived from a private session, do not assume realtime will scope it.
Add an explicit session-audience lane and tests, or raise the gap rather than
allowlisting quietly.

## Realtime

Clients receive live updates via `notifyDbSubscribers(table, eventType, rows)` in
`server/index.cjs`, which fans DB-change events to subscribed WebSocket clients.
Streaming agent output works by inserting a `Thinking …` placeholder message,
then `UPDATE`-ing its content (each update broadcasts). Heavy fields are stripped
from the fanout by `sanitizeRealtimeRow` — add to it, don't broadcast large bodies.

### Fanout and the allowlist: the two halves that must agree

Broadcasting a table and being able to subscribe to it are separate decisions in
separate files, and **both failure directions are silent**. The server will
happily `notifyDbSubscribers('x', …)` for a table no client can subscribe to; the
client's subscribe is refused by `ensureTable` -> `ALLOWED_TABLES`, the server
replies `{type:'error'}`, and `src/lib/backendClient.ts` drops that frame. Neither
side logs anything. The surface just stays empty forever.

That is not hypothetical. An audit found **eight** tables broadcast but not
subscribable, two of them (`agent_schedules`, `gateway_configs`) with live client
subscriptions that had never once worked — through 1471 backend and 2434
frontend passing tests, because nothing asserted what the protocol is. Those two
are fixed and allowlisted; `tests/schedules-gateways-realtime.test.cjs` walks the
whole path (the hook's exact binding -> `authorizeRealtimeBinding` -> a real
fanout -> the frame the client receives) so the two halves can't drift apart
again silently. The other six are exemptions on purpose, `FANOUT_BROKEN` is empty,
and empty is the goal state rather than a disabled check.

So every table passed to `notifyDbSubscribers` must be exactly one of:

- in `ALLOWED_TABLES` — clients may subscribe; the normal case;
- declared in `FANOUT_EXEMPT` (`shared/realtime-fanout.cjs`) — deliberately not
  subscribable, **with a written reason**;
- declared in `FANOUT_BROKEN` — a known defect, with the concrete fix recorded.

`tests/realtime-fanout-allowlist.test.cjs` enforces it, and also enforces that
nothing in `src/` subscribes to an exempt table, that a `FANOUT_BROKEN` entry
really does have a subscriber, and that declarations for tables no longer
broadcast get pruned.

**Do not "fix" a failure by adding the table to `ALLOWED_TABLES` reflexively.**
That Set is a security boundary: adding a table also opens the generic
`/backend/db` path to it on **both** backends (Fly and
`netlify/functions/backend.mjs`), so it needs a `DB_TABLE_ACCESS` entry in the
same commit or it falls through to `DEFAULT_TABLE_ACCESS` (read/write). Some
tables are exempt precisely because they must never be subscribable —
`workspace_secrets` is one, and `bridge_qr` carries a live device-linking QR.
Read the reason in the declaration before changing a category.

Related: if a broadcast row carries anything secret, strip it in
`REALTIME_HEAVY_FIELDS` rather than relying on every call site to pass a
projection. `channel_bridges.config` is the cautionary tale. The REST routes
projected it away, but the fanout calls passed raw `returning *` rows and never
touched that projection — so a per-call-site projection was doing none of the
work anyone assumed it was doing. It is stripped centrally now, and the table is
also absent from `ALLOWED_TABLES`, which is two independent controls rather than
one. The lesson survives the fix: **a projection applied at some call sites is
not a control**, because the next call site will not have it.

Allowlisting `gateway_configs` is the worked example of what that costs, and all
four parts were needed in the one commit:

- `ALLOWED_TABLES` — otherwise the subscription is refused.
- `WORKSPACE_SCOPED_TABLES` — **load-bearing, not tidy.**
  `enforceDbOperationAccess` returns EARLY for any table outside that Set, so an
  `ALLOWED_TABLES` entry without it has *no row scoping at all* and one signed-in
  user reads every tenant's rows.
- `SELECTABLE_COLUMNS_BY_TABLE` — `columns: '*'` on the generic select would
  otherwise return `api_key_cipher`, which the dedicated route reduces to a
  `has_key` boolean on purpose. The rule of thumb: **the generic path must never
  return more than the dedicated route does at the same capability.**
- `PRIVILEGED_DB_COLUMNS_BY_TABLE` — a generic write must not set the columns the
  dedicated route exists to validate. `base_url` is checked by
  `assertSafeOutboundUrl` on POST/PATCH and nowhere else, so leaving it writable
  through `/backend/db/insert` would be a way around a live SSRF guard.

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

- **Agent templates / persona packs** (`workspace_agent_templates`) — the 15
  agent templates used to be CODE in a frontend array, changeable only by a
  deploy. A workspace can now author its own and save a tuned agent as a
  starting point. Validator: `shared/agentTemplates.cjs`. Routes:
  `server/agent-templates-routes.cjs`. Things to know before touching it:
  - **Purpose describes the job; it grants nothing.** `workspace_agents.purpose`
    is either `collaborator` or `resource`. A resource may carry one or more
    `resource_facets` (`context`, `knowledge`, `tooling`, `code`), while a
    collaborator must carry none. The database CHECK, shared normalizer, and
    frontend types enforce that shape. Neither field changes RBAC, token scope,
    sandbox access, permission mode, host folders, or tool grants.
  - **A resource is non-ambient by default.** It is a callable capability or
    steward, not another voice competing in every room. Creating an agent with
    `purpose = 'resource'` therefore defaults `ambient_replies` to false unless
    a manager explicitly changes it. Templates may carry purpose and facets
    because those are intent, but they still cannot carry authority.
  - **A template carries PROSE and REQUESTS, never AUTHORITY**, and that is
    enforced by the SHAPE rather than by a filter: `workspace_agent_templates`
    has no column for `permission_mode`, `metadata`, `sandbox_provider`,
    `sandbox_config`, `connect_token_hash`, `mcp_approved`, `memory_dir` or
    `identity`. You cannot import what the shape cannot hold. **Adding one of
    those columns is a security decision, not a schema tidy-up** —
    `tests/agent-template-schema.test.cjs` fails on exactly that, in all three
    schema places.
  - **`metadata` is the field that looks harmless and is not.** It carries
    `host_folders`, which the daemon turns into an `--add-dir` argument on
    somebody's actual machine, and `sandbox_skills`, whose definitions hold a
    `baseUrl` the SERVER fetches plus a workspace-vault credential name. It is
    MANAGE_ONLY on `workspace_agents` for those reasons.
  - **`normalizeAgentTemplate` REBUILDS its output** from a carried-field list
    rather than deleting keys from the input, so a field nobody anticipated
    cannot ride along. `agentToTemplateDraft` PICKS named fields and must never
    spread the agent row — spreading is the one-line change that would copy a
    `yolo` agent's permission mode into a shareable artifact.
  - **There is NO server-side create-agent route, and there must not be one.**
    A template prefills the existing Agents window form; the write still goes
    through the generic `/backend/db/insert` where `stripPrivilegedDbValues` and
    `setsManageOnlyDbColumn` apply. A convenience "create from template" that
    inserted server-side would step around every column guard at once.
  - **The bundled `AGENT_TEMPLATES` array must stay.** Onboarding reads it
    directly and must work before a workspace has authored anything, and it is
    the fallback that makes reverting the server a no-op for users. The hook
    falls back to `[]` on any fetch failure rather than rendering an error.
  - **`skills` must stay `string[]`** — the Agents window round-trips it through
    a comma-separated text input, so an object renders `[object Object]` and is
    saved back over the real definition on the next unrelated edit.
  - **`tools` is advisory and the UI must not imply otherwise.** It gates
    nothing: on the daemon lane it is interpolated as prompt text, and on the
    builtin lane the tool list comes from `toolSpecs`, not the column.

- **Workspace automations** (`automations`, `automation_runs`) — "when X happens
  inside agensis, do Y inside agensis", without a code change. Engine:
  `server/automations.cjs`. Evaluator (pure, no db):
  `shared/automation-rules.cjs`. **Behind `AGENSIS_AUTOMATIONS=1`; off by
  default.** Things to know before touching it:
  - **This is ONE CELL of a matrix, not a fourth engine.** Three automation
    systems already exist and each hardcodes one axis: `agent_schedules` is
    time -> wake an agent, `agent_webhooks` is inbound HTTP -> wake an agent,
    `flow_connections` is workspace event -> POST to an external URL. All three
    end in a paid model turn or an outbound request. Automations fill the only
    uncovered cell: event-triggered with an INTERNAL, deterministic action. None
    of the three is modified, and `flow_connections` is deliberately NOT renamed
    or absorbed — it is the outbound edge and it already does signed delivery,
    idempotency, retry classification and an SSRF guard properly.
  - **The value is determinism, not authoring.** Before this, the only thing in
    the product that could decide anything was a language model. "If a message
    here says 'deploy failed', post to #urgent" now costs zero model calls and
    gives the same answer every time.
  - **There is no `dispatch_agent` action, on purpose.** v1's only action is
    `post_message`, which inserts a message and notifies subscribers but never
    calls `continueConversation` — so it wakes nobody and an automation run
    cannot spend tokens. That makes unbounded agent-job fan-out impossible BY
    CONSTRUCTION rather than bounded by a limiter someone could raise. If you
    add `dispatch_agent`, it MUST go through `continueConversation` (never a
    direct `agent_jobs` insert) so it inherits the one-active-job index, the
    turn budget and the conversation lock — and re-checking the author's role at
    RUN time becomes mandatory, not advisory.
  - **The cycle brake is carried by the data.** A message an automation produced
    has `sender_kind='automation'`, and the matcher skips those, so automations
    cannot chain — including the two-automation cycle (A posts, B fires on A and
    posts, A fires on B) that a per-automation self-exclusion check would miss.
    This is why there is no `depth` column on `messages`: a flat "automations do
    not chain" rule needs no schema change to the hottest table in the product.
    Relaxing it means adding that column, and the cycle risk comes back with it.
  - **The drain runs on its OWN 1s worker**, a sibling of `flowDeliveryWorker`
    rather than a passenger on the 30s reaper tick — "when X happens, do Y"
    arriving up to 30 seconds later reads as broken. It is a sibling and not
    merged into that worker because a slow automation must not delay a webhook
    delivery. **A faster tick is not a bigger tick**: the per-tick drain bound is
    unchanged, so peak work per tick is strictly lower than it was, and the
    in-flight boolean makes a slow drain skip the next tick rather than stack.
    `sweepAutomationRuns` stays on the 30s tick — reclaiming an expired lease is
    housekeeping and does not need to run 30x more often. The BOUND is the
    invariant, not the number; do not remove it to make the worker faster.
  - **Definitions are JSON. YAML is rendered, never parsed.** YAML's silent
    coercions (`on:` -> true, an unquoted `1.0` -> float) do not throw; they
    produce a different valid document that runs the wrong step. There is no
    YAML parser in this repo and adding one would mean third-party parsing of
    `manage`-supplied text on the Fly machine for no capability gain.
  - **Conditions are not a language and must not become one.** A closed field
    allowlist (a `Map` to reader functions, never a path walker), seven string
    ops, no regex (user regex over user content is a ReDoS primitive), no OR, no
    nesting, no arithmetic. Any addition is a visible diff to one list with a
    test enumerating it.
  - **`manage` on every write**, because an automation is a STANDING grant to act
    without a human — `run_agents` is "you may run something now". Rows are
    read-only to clients through `/backend/db` (same shape as `agent_schedules`),
    so the dedicated route stays the only place a definition is validated. Create,
    update, delete, enable and disable all write to the audit log.
  - **The UI is `src/components/windows/AutomationsWindowContent.tsx`**, with the
    display logic split into the pure `src/lib/automationView.ts` so it is
    testable without mounting. Three things it must keep saying: that a rule can
    only post a message (so it cannot wake an agent or spend a token), that
    authoring needs `manage`, and — most importantly — that a rule the runaway
    guard switched off is DIFFERENT from one a person paused. Both are
    `enabled: false` in the database; a rule that silently stopped firing is the
    worst outcome this feature has, so `automationState()` returns three states,
    never two.
  - **The flag gates execution, not a button.** The enqueue hook, the worker and
    the routes all check `AGENSIS_AUTOMATIONS`. A flag that only hid the UI would
    still run automations.

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
    one.** It is client-authored — the browser inserts through the generic route
    and supplies its own `event_type`, `title` and `user_id` — and its
    insert/update/delete sit at the `write` capability. That is the right design
    for a feed and the wrong design for evidence. Never move a privileged action
    into it, and never read a row out of it as proof that something happened;
    `audit_log` is where that belongs.
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

- **Structured stop reasons, and two deadlines instead of one** — a finished or
  failed turn now reports WHY it stopped, and the idle deadline is separated from
  the hard one. Three things to know before touching any of it:
  - **The vocabulary is duplicated on purpose, in two repos.** It lives in
    `packages/agensis-cli/src/stopReasons.mjs` (agensis-agent) and as `STOP_REASONS`
    in `server/agent-jobs.cjs`. There is no shared module across the repos, so the
    two lists must be kept identical by hand — a value added on one side and not
    the other is silently dropped rather than stored. The set is:
    `completed | cancelled | max_tokens | max_turns | max_budget | refused |
    idle_timeout | hard_timeout | permission_denied | agent_error | connection_lost`.
  - **A daemon-supplied reason is untrusted and ends up in a human's transcript.**
    It is matched against the closed set in `normalizeStopReason` and anything else
    becomes `''` — never a passthrough, the same discipline `AMP_ERROR_CODE_RE`
    uses next door. `stopDetail` is charset-restricted and length-capped. Nothing
    lands in a message that did not come out of the server's own `STOP_REASON_TEXT`.
  - **9 vs 10 minutes is a PAIR across two repos, and it silently inverts if
    either moves.** `DEFAULT_IDLE_TIMEOUT_MS` (agensis-agent `agensis.mjs`) is nine
    minutes; `AGENT_JOB_IDLE_REAP_MINUTES` (`server/agent-jobs.cjs`) is ten. The
    daemon is deliberately first because only the daemon can actually stop the
    work — the server can only rewrite the row. If the server ever wins the race,
    a human is told "it stopped responding" while a CLI keeps running on someone's
    laptop for another twenty minutes. `AGENT_JOB_HARD_CEILING_MINUTES` (30) pairs
    with the daemon's `DEFAULT_TIMEOUT_MS` the same way.
  - **`AGENSIS_SESSION_SLOTS` (default 1) is off for a reason.** `--max-concurrency`
    was a no-op: the queue admitted two lanes and the keyed mutex funnelled them
    onto one `sessionKey`, so real parallelism was 1. Slots
    (`packages/agensis-cli/src/sessionSlots.mjs`) give the mutex more than one
    connection. At 1 the key is `silo#0` and behaviour is byte-identical to before.
    Raising it also stops separate conversations sharing one runtime history —
    correct, but visible, hence opt-in. The allocator NEVER refuses a slot;
    admission stays the queue's job, so a leaked claim can cost slot preference
    but can never wedge a silo. `isDaemonIdle` counts jobs, not sessions, so
    self-update's guard needs no change.

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
    key. That by-name refusal is the enforcement; do not weaken it on the
    assumption that the JSON Schema is doing the same job (see
    [The MCP tool surface is a public
    contract](#the-mcp-tool-surface-is-a-public-contract)).
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
    agent* carries. Workspace/agent ids come from the token; neither a workspace
    control-plane token nor either kind of join URL can spend a provider key.
    Per-agent `providerCallRateLimiter` at 20/min on top of `mcpRateLimiter`.
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
    `requireAuth` and every other `verify*`. `workspace_invites` remains the
    legacy human-accept record for up to 14 days and is also deliberately absent
    from MCP authentication. Don't merge the two tables.
  - **No User-Agent sniffing, anywhere.** An agent succeeds via `Accept:
    application/json` / `?format=json`, or via the HTML itself, which carries the
    contract four ways (JSON-LD, a *visible* fenced machine block, plain prose
    addressed to an agent, and the same steps in the redemption response).
    `tests/join-link.test.cjs` asserts the page is byte-identical across five
    User-Agents and that no join code reads the header.
  - **Redemption intent is explicit even though the URL is shared.** The human
    button sends `as: 'human'` with a valid session; the machine contract sends
    `as: 'agent'` with no Authorization header. Missing or contradictory intent
    is refused before the single-use UPDATE. Never infer agent identity from a
    failed human authentication check — an expired browser session must not
    consume a link by provisioning an unintended agent.
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

### The MCP tool surface is a public contract

`buildTools()` in `server/mcp.cjs` is not an internal list. `listToolSummaries()`
feeds `/backend/skill` (also `/api/skill`, `/skill`, `/.well-known/agent-skill`),
which is served with **no authentication** — an IP rate limiter only — so the
name and description of all 30 tools are public, and the point of publishing them
is that third parties bind to them. `tools/list` then hands the full JSON Schema
to any valid bearer.

So **renaming a tool, removing one, or adding a required argument breaks clients
we cannot see or redeploy.** `tests/mcp-public-surface.test.cjs` pins the exact
name set and every tool's `required` array. Adding a tool is fine — add the line
in the same commit; the friction is deliberate, because a new tool joins a public
surface. Do not delete the test to make it pass.

Two related rules:

- **`additionalProperties: false` on a tool schema is a promise to clients, and a
  tool must not rely on it as its own input validation.** A schema-driven client
  rejects unknown flags locally on the strength of that flag, so it has to stay
  true — but a tool that accepts anything security-relevant validates its own
  arguments in its handler. `call_provider` is the worked example: it carries an
  explicit by-name `unknownProviderCallArgs` refusal rather than trusting the
  published schema. Write new tools the same way.
- **If something needs a capability MCP does not have, add an MCP tool — never a
  parallel client-only route.** `runToolForIdentity` is the single authorization
  chokepoint (kinds allowlist, Flows scope, channel pin, tool-specific capability
  checks, 120/min limiter). Anything reached another way is outside all of it.

### Login tokens at the MCP door

`verifyMcpToken` (`server/index.cjs`) tries four verifiers in order, and the last
is `verifyUserAuthMcpToken`: **a human's ordinary agensis session token
authenticates at `/backend/mcp`**, resolving to a `kind: 'user'` identity on the
workspace that user owns. This is **deliberate** — it arrived with the MCP client
registration approval flow, the order is documented above `verifyMcpToken`, and
`get_connect_command` carries a per-kind branch that re-checks the `manage` role
specifically for `kind === 'user'`. Do not "fix" it as a fall-through bug.

Know what it costs before you point anyone at it:

- **It grants nothing the `agw_` workspace token does not.** Both reach the same
  29 tools — asserted in `tests/mcp-user-token-assumption.test.cjs`, which fails
  if that ever stops being true.
- **It is not separately revocable.** Revocation is `token_version` on
  `app_users`, a per-user counter, so withdrawing a pasted copy signs the human
  out everywhere. `agw_` is revoked by re-minting and touches MCP clients only.
- **It has no distinguishing prefix.** The minted token classes carry
  pattern-matchable prefixes, so a redactor can strip them from a log, transcript
  or screenshot on shape alone. A session token cannot be recognised that way —
  which is why `cli/src/render.mjs` redacts the exact resolved credential as well
  as matching on prefix. Any new redaction path has to do both; matching on shape
  alone leaves this class of token in the output.
- **It expires in 14 days** (`DEFAULT_TOKEN_TTL_SEC`), so a working MCP config
  silently starts returning 401. `agw_` does not expire.
- **It picks the user's OLDEST owned workspace** (`order by created_at asc limit
  1`), not the one they are looking at.

So: **`agw_` is the credential to hand an MCP client.** Only the actual
`workspaces.user_id` owner may mint or rotate it or enable automatic
registration approval; an admin's `manage` capability is not enough. It is the
only MCP credential the UI ever produces (`src/lib/mcpConnect.ts`). It remains
the workspace control-plane credential for registering agents and creating
workspace-visible resources, but it cannot read private sessions by borrowing
the owner's identity. Nothing in the product tells anyone to paste a login
token, and nothing should start.

**The door records that this happened, so the decision can rest on data.** A
`mcp.login_token_used` audit row is written when a `kind: 'user'` identity
authenticates — workspace, user id and kind, never the token, its hash or any
fragment. It answers one question: is anyone actually using this path?

MCP auth runs on **every request**, so the row is emitted at most **once per user
per 24h per process** via `createFirstUseWindow` (`shared/backend-core.cjs`). That
dedup is what makes the audit log the right home rather than the wrong one: after
it, the rate is bounded by *distinct humans per day* — the same rate class as
`invite.created` — instead of by request volume. Without it, a per-request row
would bury the privileged actions the log exists for and flood a tamper-evident
chain. **If you ever need the actual call volume, do not reach for this table**;
that is a metrics counter, and the audit log would answer less by containing
more. Recording is scoped by a frozen `KINDS_TO_RECORD` set, and rows are never
awaited, so no DB write is on the MCP hot path.

Read the rows as "this credential appeared today", **not** as a request count —
the window is process-local, so a multi-instance deploy can produce one row per
instance.

One thing that is **not** implementable, so nobody spends a day on it: you cannot
"allow the tools but deny `/backend/db/*`" for a login token used at MCP. It is
one string, and when it later arrives at `/backend/db/*` nothing marks it as
having been used at the MCP door. MCP acceptance does not *grant* that reach
either — the session token always had it through `requireAuth`. The only lever is
whether `verifyMcpToken` keeps accepting login tokens at all, and that is a
product decision: removing it would break anyone who has already pasted one.

### `cli/` is a client for that surface, not a second one

`cli/agensis-ops.mjs` (`npm run ops -- <command>`) is a transport-only wrapper
over `POST /backend/mcp`, for **humans and CI** — not for agents, which already
have all 30 tools over MCP inside every job. It ships **zero server routes and
zero hand-written tool schemas**: `call` builds its flag parser from the
`inputSchema` the server publishes at runtime, so it cannot drift.

The rule above is enforced here mechanically. `cli/src/rpc.mjs` is the CLI's
**only** network egress, POSTs to one URL, and will emit only
`initialize`/`tools/list`/`tools/call` — anything else throws.
`tests/ops-cli.test.cjs` drives every command while recording every request and
asserts that URL and method set, so **adding a bespoke CLI route fails a test.**
If a command needs a capability MCP lacks, add an MCP tool.

Two things to know before editing it: the package is `private: true` so there is
no publish lane (run it from a checkout), and `cli/**/*.mjs` is listed in
`eslint.config.js` with `auth.mjs`, `render.mjs` and `rpc.mjs` in
`tests/lint-coverage.test.cjs` — those three hold the bearer token, the redaction
and the egress allowlist. Full reference: `cli/README.md`.

## Tests (two runners)

- `npm test` — Node's built-in runner over `tests/*.test.cjs` (backend/integration,
  mock DBs). 334 tests. Note the glob is **top-level only** — a `.test.cjs` in a
  subdirectory is never run, and is invisible to both runners.
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
- Onboarding testing: `npm run reset:test-account` wipes the configured test
  account (user + all their workspaces) so the onboarding tour can be re-run from
  scratch;
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

**`npm run smoke` is in that chain, and is not optional.** It exists because a
workspace holding several agents once rendered "No agents match — You haven't
created any agents yet" over the full list, with no control on screen to undo
it: `ownerFilter` is persisted, and the Mine/All toggle only rendered when the
filter had matches. typecheck, eslint, both suites and the build were all green,
because **none of them renders the app**. The smoke gate does, and asserts the
one thing they structurally cannot: an empty state must not be showing while
data exists, and a persisted filter must never hide the control that clears it.
Dropping it means that class of bug is unguarded again — it was verified failing
against the pre-fix code before it was added.

`npm run ci` is the single gate. **Run it locally, and treat a local pass as the
thing that gates a merge** — not a green tick in GitHub Actions.

A workflow run that reports success without having executed anything looks
identical, at a glance, to one that ran the whole suite. If you are relying on
CI for a verdict, confirm the run actually did work before you believe it:

```bash
gh run view <id> --json jobs
```

An empty `steps: []` on a job means no runner was ever assigned and nothing ran.
There is no red X in that case, so the only way to notice is to look.

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


## Agent daemon (separate repository)

The host-side daemon lives in its own repository, deliberately separate from
this app/backend repo: it has a different release cadence, a different
distribution channel (npm), and it runs on a contributor's own machine rather
than on our infrastructure. Its source, tests, release workflow, and published
bundle live at `../agensis-agent` locally and
[`jasonkneen/agensis-agent`](https://github.com/jasonkneen/agensis-agent).
The npm package is `@agensis/agensis-agent`; changes to the server/daemon
wire contract must be coordinated across both repositories.

## Desktop ACP (Electron) — local dev setups

Desktop can run local ACP harnesses (“Start on this Mac”) and bridge them as
daemon-shaped WebSocket agents. **Operator guide for local dev:**
**[docs/desktop.md](./docs/desktop.md)** (setup A fully local, setup B + live web).

| Setup | Command | Backend |
| --- | --- | --- |
| A — fully local | `npm run desktop:dev:local` | `:3142` |
| B — desktop + live web | `npm run desktop:dev:prod` | Fly |

Rules agents must not break:

- **Same backend as the UI** for bridges. Live web never stays green for agents
  registered only on local `:3142`.
- **“Online” = live socket on this server process**, not “ACP child is running”.
- **Job result wire:** `agent_job_result` uses **`response`** (and `error`);
  deltas use `content`. Wrong field → `@handle finished without output`.
- Switching A ↔ B requires **re-Start** ACP (token + autostart `baseUrl`).
  Code: `electron/acp/*`, `scripts/desktop-dev.mjs` / `desktop-build.mjs`.

## Conventions

- Match the surrounding file's style: 2-space indent, its semicolon convention,
  `cn()` for class merging, shadcn/ui primitives already imported in the file.
- No new npm dependencies without a strong reason. Drag-and-drop is native HTML5
  (`draggable` + `onDragStart/onDragOver/onDrop`) or pointer events — see
  `src/components/windows/ThreadWidgetRail.tsx` and `TasksWindowContent.tsx`.
- The root package is the agensis app. Keep app, backend, database and deployment
  code out of the daemon repository — not because either repo is private, but
  because the daemon is a small, separately released client of the wire contract
  and copying server code into it duplicates the thing the contract exists to
  keep in one place.
- User-facing rich text is sanitized through `src/lib/sanitize.ts` (DOMPurify) at
  every render/paste boundary.
