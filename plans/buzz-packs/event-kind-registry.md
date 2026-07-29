# Event kind registry (buzz pack, rank 3, priority 85)

Domain: protocol. Target surface as stated by the pack: "server event/bus layer
(prefer additive message types over new REST)".

Status: plan only. No code was written, no tests or builds were run.

---

## 1. Verdict

**Adopt-modified — option (b), a declared-and-enforced protocol surface, not a
numbered kind registry and not a runtime dispatch rewrite.**

The pack's two stated interfaces are "a central map of message/event type
integers or names" and "unknown types ignored by clients; additive evolution".
The second one **agensis already satisfies structurally** and has since the
realtime client was written: `src/lib/backendClient.ts:509-526` parses a frame,
handles `type: 'system'`, and hands everything else to
`LocalChannel.handleMessage` (`src/lib/backendClient.ts:767-793`), which matches
only `broadcast` and `db_changes` and returns silently otherwise. An unknown
`type` is dropped with no error and no throw. Adding a message type today is
already additive and already safe for old clients. On the daemon side the same
is true: `agensis.mjs` is a ladder of `if (message.type === "…")` with no else,
so an unrecognised frame is a no-op.

The first interface — the central map — **does not exist at all**, and that is
where the real cost is. There are roughly 50 distinct wire messages in this
system and **zero of them are declared anywhere**. The dispatch ladder in
`server/realtime.cjs:449-543` *is* the specification, and it is only readable by
reading it.

Numbering them buys nothing here. Buzz's kind integers exist because buzz is
Nostr: events are signed, relayed between independent implementations, and
persisted by kind with range-based semantics (replaceable 10000-19999,
addressable 30000-39999). agensis has one server, one first-party browser
client, one first-party daemon, no signatures, no relay, no third-party clients,
and no event log — messages are RPC-ish frames over an authenticated socket
against a Postgres row store. Swapping `'agent_job_delta'` for `31023` would make
every log line, every grep and every test fixture worse and would buy zero
interop. **Reject the numbering.**

Option (a), a real runtime dispatch registry replacing the `if` ladder, is also
a reject for v1: it is a pure refactor of the hottest code path in the product
(every delta of every agent turn, ~1/s per running job) with no user-visible
change and real regression risk. The ladder is 95 lines and is not the problem.

What *is* the problem is drift and undeclared surface, and it is not
hypothetical. Auditing the protocol for this plan turned up **five live defects**,
all of the same shape — one side of the wire believes in something the other
side does not:

1. `server/schedules-routes.cjs:114,140,154,172` and `server/index.cjs:5383`
   broadcast `agent_schedules` row changes. `src/hooks/useSchedules.ts:57`
   subscribes to them. `agent_schedules` is **not in `ALLOWED_TABLES`**
   (`shared/backend-core.cjs:31-88`), so `ensureTable`
   (`server/lib/db-sql.cjs:35-40`) throws at subscribe time
   (`server/realtime.cjs:320`), the server replies `{type:'error'}`
   (`server/realtime.cjs:551`), and the client drops that frame on the floor.
   **The schedules list is not live and nothing says so.**
2. Identical for gateways: `server/workspaces-routes.cjs:120,150,165` broadcast
   `gateway_configs`; `src/hooks/useGateways.ts:39` subscribes;
   `gateway_configs` is in neither `ALLOWED_TABLES` nor
   `WORKSPACE_SCOPED_TABLES`.
3. `server/channel-bridges.cjs:274,320` and
   `server/bridge-admin-routes.cjs:122,206` broadcast `channel_bridges`. Not in
   `ALLOWED_TABLES`; nothing in `src/` subscribes. Four dead fanout calls.
4. `server/channel-bridges.cjs:322` broadcasts a **pseudo-table** `bridge_qr`
   carrying a live WhatsApp/Signal linking QR. There is no such table, no
   subscriber anywhere in the repo, and `bridge_qr` appears exactly once in the
   entire codebase. The comment above it says the QR "is broadcast straight to
   the open dialog" — it is not; the dialog cannot receive it.
5. The daemon has live handlers for two message types **the server has never
   sent**: `bridge_stop` (`agensis.mjs:537`) and `agent_reach_disable`
   (`agensis.mjs:568`). Neither string exists anywhere under `server/`.
   Separately, `server/channel-bridges.cjs:210` documents a `bridge_send_result`
   frame that neither side implements.

Plus one dead allowlist entry: `'agent-presence'` is an accepted broadcast
channel prefix (`server/realtime.cjs:305`) with no producer and no consumer in
either repo.

None of these are caught by 1471 backend + 2359 frontend passing tests, because
nothing anywhere asserts what the protocol *is*. That is the case for this pack,
and it is a strong one — but the deliverable that fixes it is a declaration plus
conformance tests, not integers.

### What already exists in agensis today

The repo already contains four partial registries. This work should extend them,
not invent a parallel structure.

| Existing registry | Location | Covers |
|---|---|---|
| `ALLOWED_TABLES` | `shared/backend-core.cjs:31-88` | which tables the generic `/db` path and realtime `db_changes` may address |
| `DB_TABLE_ACCESS` | `shared/backend-core.cjs:187+` | required role per table per operation |
| `REALTIME_HEAVY_FIELDS` | `server/realtime.cjs:175-184` | per-table fields stripped from fanout |
| broadcast channel prefixes | `server/realtime.cjs:305` | the 5 accepted `broadcast` channel namespaces |

And `messages.message_kind` is **already a kind discriminator with four values**
(`server/index.cjs:1206-1210` declares the column). It is the closest thing
agensis has to the pack's concept, and it is declared in up to four places per
value:

| kind | declarations |
|---|---|
| `''` (normal message) | implicit; asserted as SQL in `server/agent-jobs.cjs:180` |
| `'tool_step'` | `src/components/chat/toolSteps.ts:11` (const), `server/agent-jobs.cjs:1058` (inline SQL literal), `server/builtin-turn.cjs:664` (inline SQL literal), `src/lib/huddleVoice.ts:199` (inline literal) |
| `'permission_request'` | `server/agent-permissions.cjs:40` (const), `src/components/chat/permissionRequests.ts:4` (const) |
| `'huddle'` | `server/huddles.cjs:262` (const), `src/lib/huddleTranscript.ts:17` (const) |

So `'tool_step'` is written out four times, twice as a bare string inside a SQL
`values (...)` clause where no type system or grep-for-the-constant will ever
find it.

### Protocol surface, counted

Measured from the source today, on `main-next`:

- **23 inbound actions** — `server/realtime.cjs:449, 459, 463, 471(x2), 479, 483,
  491, 495, 499, 503, 507, 516(x2), 520(x4), 524, 528, 532, 536, 540`.
- **1 inbound `type` frame** — `{type:'auth'}`, `server/realtime.cjs:428`.
- **1 inbound binary frame shape** — PCM audio, `server/realtime.cjs:413`.
- **20 outbound `type` values** — `agent_job`, `agent_job_cancel`,
  `agent_inference_cancel`, `agent_inference_request`, `system`, `db_changes`,
  `broadcast`, `agent_disabled`, `error`, `agent_permission_decision`,
  `agent_config`, `agent_registered`, `agent_memory_refresh`,
  `agent_capabilities_refresh`, `agent_skills_refresh`, `bridge_send`,
  `bridge_start`, `peer_ticket_grant`, `peer_ticket`, `peer_list`.
- **5 `system` sub-events** — `authenticated`, `subscribed`, `unsubscribed`,
  `voice_stt`, `deploy_published`.
- **7 broadcast events over 4 live prefixes** — `object_upsert`/`object_delete`
  (`canvas:`), `cursor_move`/`cursor_leave` (`cursors:`),
  `presence_snapshot`/`presence_leave` (`item-presence:`), `agent_status`
  (`agent-status:`). Plus the dead `agent-presence:` prefix.
- **26 tables** subscribed over `db_changes` from `src/`, two of which are
  rejected (above).

Call it ~50 wire messages. Declared: 0. Validated on ingress: 0. Typed on the
client: `RealtimeInboundMessage.type?: string`
(`src/lib/backendClient.ts:68-75`) — a bare optional string. `src/types/index.ts`
contains no WebSocket message types at all.

### Is a shared TS union + validator better than numbered kinds?

Yes for the client half, and no for the whole. A TS union is compile-time only
and cannot help the two consumers that are not TypeScript: `server/*.cjs` and
the daemon (`agensis-cli`, a separate repo, separate npm package, deps are only
`@anthropic-ai/claude-agent-sdk` and `ws` — it cannot import from this repo).
The declaration therefore has to live somewhere all three lanes can reach, and
the only such place today is `shared/*.cjs`: it is `require`d by
`server/index.cjs`, `import`ed by `netlify/functions/backend.mjs:33`, `require`d
by the node backend tests, and — proven by `tests/unit/vaultSurface.test.ts:2` —
**importable by vitest directly**. So: one `.cjs` declaration as the source of
truth, a hand-written `.ts` mirror for the browser bundle, and a unit test that
imports both and fails if they diverge. That exact pattern is already in the
repo (`tests/unit/vaultSurface.test.ts` cross-checks
`shared/backend-core.cjs` against `src/hooks/useWorkspaceVault`).

A runtime validator library is not warranted. There are 75 dependencies and none
of them is zod/ajv/valibot; adding one to validate ~24 frame shapes, on the
hottest path, in a bundle we are actively shrinking (plans/013), is a bad trade.
Hand-rolled per-field guards in the declaration module are enough.

---

## 2. What the pack actually proposes

`crates/buzz-core/src/kind.rs` is a flat file of `pub const KIND_*: u32`
constants with doc comments recording, per kind, its ownership key and its
storage class — `(pubkey, kind)` for replaceable, `(pubkey, kind, d_tag)` for
addressable — following the Nostr NIP numbering. `ARCHITECTURE.md` states the
payoff: "Adding a new feature means defining a new kind number; existing clients
see nothing and break nothing," with the relay as sole source of truth and every
action a signed event.

The transferable ideas, stripped of Nostr:

1. **One file is authoritative for the message-type namespace.** Not the
   dispatch site — a declaration, greppable, with the semantics next to the name.
2. **Each type carries its own rules in the declaration** — who may send it, what
   it is keyed by, how it is stored, whether it replaces a prior one.
3. **Additive evolution is a guarantee, not a hope** — unknown types are ignored
   by contract, which makes adding a type a one-sided deploy.
4. **Prefer a new message type over a new REST route** for workspace operations.

The assumptions that do **not** transfer:

- **Signed events / cryptographic identity.** agensis authenticates the
  *socket* (`server/realtime.cjs:388-444`), not the frame. There is no per-event
  signature to key a registry against.
- **The relay as sole source of truth.** agensis has two backends over one
  Postgres (`AGENTS.md:9-18`), and the serverless mirror
  (`netlify/functions/backend.mjs`) has **no WebSockets at all**. Point 4 —
  "prefer events over one-off HTTP" — is therefore actively wrong for us: an
  operation that exists only as a WS message type does not exist on the Netlify
  backend. REST-first is a deliberate architectural constraint here, not an
  oversight.
- **Kinds as the storage key.** buzz stores events by kind. agensis stores rows
  in typed tables; the WS message is transport, not the record. Replaceable /
  ephemeral / addressable ranges have no meaning against
  `insert into messages …`.
- **Multiple independent implementations.** The whole reason for a stable
  integer namespace. agensis has three first-party consumers in three deploy
  lanes, which is a versioning problem (the daemon lags — 0.1.44 in the wild),
  but not an interop problem.

Point 4 is worth restating because the pack's own `target_surface` field leads
with it: **do not adopt "prefer additive message types over new REST" in
agensis.** It would split the API across two backends, one of which cannot serve
it. Adopt points 1-3 only.

---

## 3. Impact on our system

### Subsystems touched

| Subsystem | Change |
|---|---|
| `server/realtime.cjs` | inbound dispatch gains a declaration lookup before the ladder; unknown actions counted + warned instead of silently dropped. Ladder itself unchanged. |
| `shared/backend-core.cjs` | `ALLOWED_TABLES` / `DB_TABLE_ACCESS` / `WORKSPACE_SCOPED_TABLES` gain the three real tables currently broadcast but unsubscribable. Security-relevant — see below. |
| `src/lib/backendClient.ts` | `RealtimeInboundMessage.type` narrows from `string` to the declared union; the silent-drop path gains a dev-only warn. |
| `src/types/realtime.ts` | gains the outbound-type union and the `system` sub-event union. |
| `src/components/chat/toolSteps.ts`, `permissionRequests.ts`, `src/lib/huddleTranscript.ts` | re-export from one declared `MESSAGE_KINDS` map instead of holding independent consts. |
| `server/agent-jobs.cjs`, `server/builtin-turn.cjs` | the two bare `'tool_step'` SQL literals become a bound reference to the declared constant. |
| `server/channel-bridges.cjs` | the `bridge_qr` pseudo-table fanout moves to a real broadcast channel. |
| `AGENTS.md` | new section; the schema-sync rule's prose allowlist step becomes a test. |
| Daemon (`agensis-agent`) | **v1: no code change.** Its two orphan handlers are recorded in the declaration as `reserved`. |

### Interaction with the three-place schema-sync rule

`AGENTS.md:23-37` requires a schema change to land in `ensureRuntimeSchema`,
`database/neon-schema.sql`, and a `supabase/migrations/` file. **The registry
does not replace or extend that rule** — it is about wire messages, not columns,
and adding a fourth mandatory place for every column change would be a
regression in an already-onerous checklist.

Where it *does* interact is the paragraph immediately after (`AGENTS.md:33-37`):
"If a column is workspace-scoped, also confirm the table is in the access
allowlists in `shared/backend-core.cjs`." That confirmation is **prose**, and
prose is exactly what failed — `agent_schedules`, `gateway_configs`,
`channel_bridges` and `bridge_qr` all slipped past it. The registry work turns
that one sentence into an executable check: every table name passed to
`notifyDbSubscribers` must be in `ALLOWED_TABLES`. That is the single
highest-value line item in this plan and it is worth shipping on its own.

### What it breaks / forces

Nothing at runtime if sequenced as below. The narrowing of
`RealtimeInboundMessage.type` to a union is the only change that can fail a
build, and only in `src/` (caught by `npm run typecheck`, not at runtime).

The one genuine migration is **adding tables to `ALLOWED_TABLES`**, which is a
security surface change, not a cosmetic one.

### Security and permission implications

- **Adding a table to `ALLOWED_TABLES` opens the generic `/backend/db` path to
  it.** Every table added must land in `DB_TABLE_ACCESS` in the same commit or
  it falls through to `DEFAULT_TABLE_ACCESS` (read/write) — the exact
  fall-through `shared/backend-core.cjs:209-211` warns about. Required roles:
  - `agent_schedules` — `{ select: 'read', insert: 'manage', update: 'manage',
    delete: 'manage' }`. Schedules run agents on a timer; a `write` member must
    not be able to create one via `/db/insert`, bypassing
    `server/schedules-routes.cjs`. Already in `WORKSPACE_SCOPED_TABLES`
    (`shared/backend-core.cjs:167`), so scoping is in place.
  - `gateway_configs` — `manage` for all four. Gateways hold `base_url`, which
    is the subject of a known live SSRF finding; generic writes must stay shut.
    Needs adding to `WORKSPACE_SCOPED_TABLES` too — it is in neither set today.
    The fanout here is already safe: all three calls map through
    `publicGatewayConfig` (`server/workspaces-routes.cjs:71-84`), which reduces
    `api_key_cipher` to a `has_key` boolean. One caveat — it passes `headers`
    through verbatim, and an operator can put an `Authorization` header there, so
    `headers` is worth a look before the fanout goes live.
  - `channel_bridges` — `{ select: 'read', insert: 'manage', update: 'manage',
    delete: 'manage' }`, **and `config` must be added to
    `REALTIME_HEAVY_FIELDS` in the same commit.** This is not a hypothetical:
    `channel_bridges.config` is a `jsonb` column (`server/index.cjs:893`) holding
    `botToken` for Telegram, `botToken` + `signingSecret` for Slack, and
    `gatewayUrl` + `authToken` for OpenClaw
    (`server/bridge-admin-routes.cjs:26-32`). The REST projection
    `publicBridge` (`server/bridge-admin-routes.cjs:217-231`) drops `config`
    entirely — but **all four fanout calls pass raw `returning *` rows, not the
    projection** (`server/bridge-admin-routes.cjs:122,206`,
    `server/channel-bridges.cjs:274,320`). So the tokens are already on the
    broadcast payload and are invisible today only because the subscription is
    refused. Adding the table to `ALLOWED_TABLES` without the strip hands every
    workspace member with `read` a live Slack bot token. **This one must not be
    waved through.**
- **`bridge_qr` must NOT be added to `ALLOWED_TABLES`.** It is not a table; a
  generic `/db/select` on it would hit Postgres and error. More importantly the
  QR is a **live linking credential** with a lifetime of seconds — anyone who
  scans it links a device to the operator's WhatsApp/Signal account. It belongs
  on a broadcast channel, and `authorizeRealtimeBroadcast`
  (`server/realtime.cjs:339-343`) enforces only `'read'` for **every** channel
  prefix. Shipping the QR on a `read`-gated channel would make every workspace
  reader able to hijack the operator's messaging account. So this fix requires a
  **per-prefix required role** in the registry, defaulting to `read` and set to
  `manage` for `bridge-qr:`. Today it is latently safe only because the frame is
  undeliverable.
- The registry itself is **static data, not a table**. No new RBAC surface, no
  new route, no connect-token change, no client-writable state.
- The inbound-validation shim runs **after** the auth gate
  (`server/realtime.cjs:446-448`), so it cannot weaken authentication, and it
  must fail *closed by ignoring* (unknown action → warn + return), never by
  closing the socket: closing on an unknown frame would let an older daemon be
  hung up on by a newer server, inverting the additive-evolution guarantee this
  pack exists to protect.

### Interaction with work in flight

- `self-update-supervise` (pack #12) — no overlap. That is daemon lifecycle;
  this is wire format.
- **Permission requests surviving a daemon reconnect** — shipped today; it added
  `resumedPermissionRequests` to the `agent_registered` frame
  (`server/agent-connections.cjs:707-712`) and the
  `permissionRequestIds` field to the inbound `agent_register`. Both go into the
  declaration as-is. Note the comment at :706: "Absent from an older server's
  reply, which every daemon must read as 'none'" — that is precisely the
  additive-evolution contract, currently recorded only as a code comment. It
  should be a declared property.
- **Channel bridges** (`server/channel-bridges.cjs`) — shipped today and the
  source of three of the five defects. Coordinate: the `bridge_qr` fix is a
  change to a subsystem someone else may still be finishing.
- `thread_harvests` — already correctly in `ALLOWED_TABLES`
  (`shared/backend-core.cjs:32`). Good counter-example: it was done right.

---

## 4. Exact work breakdown

No DDL. No new tables, no new columns, nothing for `ensureRuntimeSchema`. That
is deliberate and is the main reason this is cheap.

### Files to create

| File | Reason |
|---|---|
| `shared/realtime-protocol.cjs` | The registry. Source of truth for every inbound action, outbound type, `system` sub-event, broadcast prefix + its required role, and `message_kind` value. Plain data + small pure predicates, no I/O, no DB. Lives in `shared/` because it is the only directory reachable by `server/*.cjs`, `netlify/functions/backend.mjs`, the node test runner, and vitest. |
| `src/types/realtimeProtocol.ts` | Browser-side mirror: the same names as TS unions. Hand-written, kept honest by a cross-check test rather than by a build step (no codegen — this repo has none and adding one for ~50 strings is not worth the build complexity). |
| `tests/realtime-protocol.test.cjs` | node runner. Conformance: declaration vs. actual dispatch, and every broadcast table vs. `ALLOWED_TABLES`. |
| `tests/unit/realtimeProtocol.test.ts` | vitest. Cross-check the `.ts` mirror against `shared/realtime-protocol.cjs`. |

### Files to modify

| File | Change |
|---|---|
| `shared/backend-core.cjs` | add `agent_schedules`, `gateway_configs`, `channel_bridges` to `ALLOWED_TABLES`; matching `DB_TABLE_ACCESS` entries (roles above); add `gateway_configs` + `channel_bridges` to `WORKSPACE_SCOPED_TABLES`. |
| `server/realtime.cjs` | import the registry; replace the hardcoded prefix array at :305 with the registry's prefix map; make `authorizeRealtimeBroadcast` (:339-343) enforce the registry's per-prefix role instead of a hardcoded `'read'`; add `channel_bridges: ['config']` to `REALTIME_HEAVY_FIELDS` (:175-184) **before** the table joins `ALLOWED_TABLES`; add the unknown-action warn after the ladder (:543). |
| `server/channel-bridges.cjs` | :322 — replace `notifyDbSubscribers('bridge_qr', …)` with `relayBroadcast('bridge-qr:' + bridge.workspace_id, 'bridge_qr', {…})`. |
| `server/agent-jobs.cjs` | :1058 — bind the declared `tool_step` constant instead of the inline SQL literal. |
| `server/builtin-turn.cjs` | :664 — same. |
| `server/agent-permissions.cjs` | :40 — re-export from the registry rather than declaring locally. |
| `server/huddles.cjs` | :262 — same. |
| `src/lib/backendClient.ts` | :68-75 narrow `RealtimeInboundMessage`; :523 add a dev-only `console.debug` on an unmatched frame type. |
| `src/types/realtime.ts` | re-export the unions from `src/types/realtimeProtocol.ts`. |
| `src/components/chat/toolSteps.ts` :11, `src/components/chat/permissionRequests.ts` :4, `src/lib/huddleTranscript.ts` :17 | re-export from the mirror; keep the existing export names so no call site changes. |
| `src/lib/huddleVoice.ts` | :199 — use the constant instead of the bare `'tool_step'`. |
| `src/hooks/useGateways.ts`, `src/hooks/useSchedules.ts` | no change needed once the allowlist is fixed; verify the subscription now succeeds. |
| `AGENTS.md` | new "Realtime protocol" section under "Realtime" (:39-45): where the registry lives, that adding a type means adding a declaration, and that broadcasting a table requires it to be in `ALLOWED_TABLES` — with a pointer to the test that enforces it. |

### Registry shape

Data, not classes. Sketch of the intended content (not final code):

- `INBOUND_ACTIONS` — keyed by action name; each entry records the lane
  (`'human'` for a session token, `'agent'` for a connect token, `'either'`),
  a one-line semantic, and the handler module it dispatches to.
- `OUTBOUND_TYPES` — keyed by `type`; each records the audience
  (`'browser' | 'daemon' | 'both'`), a one-line semantic, and `reserved: true`
  for `bridge_stop` / `agent_reach_disable` / `bridge_send_result` so the two
  orphan daemon handlers are documented rather than silently rotting.
- `SYSTEM_EVENTS` — the 5 `type:'system'` sub-events.
- `BROADCAST_CHANNELS` — prefix to `{ event names, requiredRole }`.
  `requiredRole` defaults `'read'`; `'bridge-qr'` is `'manage'`.
- `MESSAGE_KINDS` — `{ NORMAL: '', TOOL_STEP: 'tool_step', PERMISSION_REQUEST:
  'permission_request', HUDDLE: 'huddle' }`.
- `isKnownInboundAction(action)` / `isKnownOutboundType(type)` — pure
  predicates, the only functions the module exports.

### New routes / WS message types

**None.** This plan adds no wire messages. `bridge_qr` moves lanes (pseudo-table
`db_changes` to a real `broadcast` channel) but is the same payload, and today it
reaches nobody either way.

### Ordered build sequence

**Slice 1 — the vertical slice that pays for itself (ship alone).**
Write `tests/realtime-protocol.test.cjs` with one assertion: every table name
passed to `notifyDbSubscribers` anywhere under `server/` is in `ALLOWED_TABLES`.
Watch it fail on four names. Then, in order:
(a) add `channel_bridges: ['config']` to `REALTIME_HEAVY_FIELDS` and prove the
strip with the `sanitizeRealtimeRow` test below;
(b) add `agent_schedules`, `gateway_configs`, `channel_bridges` to
`ALLOWED_TABLES` with the `DB_TABLE_ACCESS` roles above;
(c) move `bridge_qr` to a broadcast channel with a `manage`-gated prefix.
The strip lands before the table is reachable, not after. Two broken UI surfaces
(schedules, gateways) go live as a side effect. No registry module needed yet.

**Slice 2 — the declaration.** Add `shared/realtime-protocol.cjs`. Extend the
conformance test: declared inbound actions must equal the set actually
dispatched in `server/realtime.cjs`, and declared outbound types must equal the
set actually constructed under `server/`. Add the unknown-action warn.

**Slice 3 — the client half.** `src/types/realtimeProtocol.ts` + the vitest
cross-check + narrowing `RealtimeInboundMessage`.

**Slice 4 — `message_kind` consolidation.** Collapse the seven scattered
declarations to one. Lowest risk, lowest value; do it last.

**Slice 5 — docs.** `AGENTS.md`.

Slices 1 and 2 are independently shippable and independently valuable. If effort
runs out, stopping after 2 still leaves the system materially better.

---

## 5. Test plan

**The globs matter and have bitten twice.** Frontend unit tests run **only** from
`tests/unit/**/*.test.ts` (`vitest.config.ts:8`). Backend tests run **only** from
`tests/*.test.cjs` (`package.json` `"test"`). A file anywhere else silently never
runs.

### `tests/realtime-protocol.test.cjs` (node runner)

This must be a **source-text conformance test**, reading `server/*.cjs` off disk
with `fs.readFileSync` and regex, not a mock-DB test. That is unusual for this
repo but correct here: the invariant is "the declaration matches the code", and
only reading the code can check that. It also sidesteps the vacuous-mock trap —
there is no DB in the loop to mock.

| Invariant | Mutation that must break it |
|---|---|
| Every table passed to `notifyDbSubscribers(…)` under `server/` is in `ALLOWED_TABLES` | add `notifyDbSubscribers('nope', 'INSERT', [{}])` to any server file → fail |
| Every `message.action === '…'` in `server/realtime.cjs` is declared in `INBOUND_ACTIONS` | add a new `if (message.action === 'x')` branch without declaring it → fail |
| Every declared inbound action is actually dispatched | delete a dispatch branch, leave the declaration → fail |
| Every `type: '…'` literal constructed in a `sendWs` / `sendToAgent` call under `server/` is declared in `OUTBOUND_TYPES` | add `sendWs(ws, { type: 'surprise' })` → fail |
| Every prefix in `BROADCAST_CHANNELS` is accepted by `workspaceIdFromRealtimeChannel` and vice versa | add a prefix to the registry only → fail |
| `bridge-qr` requires `manage` | change its declared role to `read` → fail |

The dynamic-type sites need explicit handling, and are the reason this test must
be written to fail loudly rather than to silently skip what it cannot parse:
`server/agent-connections.cjs:816` sends `{ type: nudge }` where `nudge` comes
from the string list at :783-789, and `server/realtime.cjs:520` dispatches four
actions from an array literal. The test should parse both forms and assert the
count of *unparseable* `sendWs` call sites is zero, so a new dynamic site fails
the test rather than escaping it.

### `tests/unit/realtimeProtocol.test.ts` (vitest)

| Invariant | Mutation that must break it |
|---|---|
| The `.ts` mirror's unions exactly equal the `.cjs` declaration's key sets | add a type to the `.cjs` only → fail; add to the `.ts` only → fail |
| `TOOL_STEP_KIND` / `PERMISSION_REQUEST_KIND` / `HUDDLE_MARKER_KIND` still export their current string values | change any value → fail (protects the persisted `message_kind` column, whose existing rows would orphan) |

Import `shared/realtime-protocol.cjs` directly, exactly as
`tests/unit/vaultSurface.test.ts:2` imports `shared/backend-core.cjs`.

### Extend, do not duplicate

`tests/realtime-revocation.test.cjs` already exercises `authorizeRealtimeBinding`
through the real path. Add three cases there — all on the security-relevant half,
and all belonging where the other realtime authorization tests already live:

| Invariant | Mutation that must break it |
|---|---|
| Subscribing to `bridge_qr` is rejected | add `bridge_qr` to `ALLOWED_TABLES` → fail |
| Subscribing to `bridge-qr:<workspaceId>` as a `read`-only member is rejected | drop the prefix's `manage` requirement → fail |
| `sanitizeRealtimeRow('channel_bridges', { config: { botToken: 'x' } })` returns a row with no `config` key | remove the `REALTIME_HEAVY_FIELDS` entry → fail |

That last one is the guard for risk #1 and is worth writing **first**, before the
allowlist change, so the strip is proven before the table becomes reachable.

`tests/channel-bridges.test.cjs` should gain an assertion that the QR is emitted
on the broadcast lane, not via `notifyDbSubscribers`.

### Explicitly not tested

Frame-level payload validation. v1 declares *names*, not shapes. Asserting the
field-by-field shape of 24 frames is a much larger job with a much worse
effort-to-defect ratio, and the ad-hoc coercion already in the handlers
(`String(message.jobId || '')`, `parseJsonObject`) is not currently a source of
production bugs.

---

## 6. Migration and rollout

**Data migration: none.** No DDL, no backfill, no `ensureRuntimeSchema` change,
no `database/neon-schema.sql` change, no `supabase/migrations/` file. The
three-place rule does not apply to this work.

**Deploy lanes:**

| Lane | Needed? | Why |
|---|---|---|
| `fly deploy` | **Yes** | `shared/backend-core.cjs`, `server/realtime.cjs`, `server/channel-bridges.cjs` all change. Deploy Fly **before** Netlify — the frontend depends on the allowlist fix landing server-side first. |
| Netlify (auto on push) | **Yes** | `src/` changes in slices 3-4. |
| npm publish `@agensis/agensis-agent` | **No** for v1 | The daemon's two orphan handlers stay; they are recorded as `reserved` in the declaration, not deleted. No daemon-visible wire change. |
| local daemon restart | **No** | Nothing in the daemon changes. |

Note `netlify/functions/backend.mjs` imports `shared/backend-core.cjs`
(`:33`), so the `ALLOWED_TABLES` change also alters the serverless backend's
generic `/db` surface. That is intended and is why the `DB_TABLE_ACCESS` entries
must land in the same commit — but it means the security review has to consider
both backends, not just Fly.

**Feature flag:** none, and none is warranted. Slice 1 is a data-only change to
two allow-sets. Slices 2-3 are declarations and tests with one behavioural
addition (a log line). There is no user-visible toggle to gate.

**Rollback, concretely:** revert the commit and `fly deploy` the prior revision.
The only state change anywhere is that three tables become readable through
`/backend/db` for workspace members with the declared role; reverting closes
them again with no residue. There is no data written and nothing to un-migrate.
Note that reverting slice 1 also re-breaks the schedules and gateways
subscriptions — i.e. it restores today's behaviour exactly.

---

## 7. Risk register and effort

Ranked. The first two are the only ones that can hurt.

1. **`channel_bridges` carries live provider tokens on the realtime fanout.**
   *(security regression, highest severity — confirmed, not speculative)*
   `config` is `jsonb` (`server/index.cjs:893`) holding Slack/Telegram
   `botToken`, Slack `signingSecret`, OpenClaw `authToken`
   (`server/bridge-admin-routes.cjs:26-32`). All four
   `notifyDbSubscribers('channel_bridges', …)` calls
   (`server/bridge-admin-routes.cjs:122,206`, `server/channel-bridges.cjs:274,320`)
   pass raw `returning *` rows, bypassing the `publicBridge` projection that the
   REST routes use to drop `config`. The moment the table enters
   `ALLOWED_TABLES`, every `read` member receives those tokens.
   **Mitigation:** add `channel_bridges: ['config']` to `REALTIME_HEAVY_FIELDS`
   (`server/realtime.cjs:175-184`) in the same commit — the same structural
   strip that protects `workspace_secrets`, chosen over "remember to map through
   `publicBridge`" precisely because it survives the next person who adds a fifth
   fanout call. Prefer stripping the whole column over field-by-field: a new
   provider added to `PROVIDER_FIELDS` would otherwise leak by default.
   **If this cannot be done confidently, ship slice 1 without
   `channel_bridges`** (fix only `agent_schedules`, `gateway_configs`,
   `bridge_qr`) and handle bridges separately. Those four fanout calls are dead
   today; leaving them dead another week costs nothing.

2. **The `bridge_qr` fix could make a live credential broadcastable.**
   *(security regression)* Moving the QR to a broadcast channel without adding
   the per-prefix role would put it on a `read`-gated channel
   (`server/realtime.cjs:339-343` hardcodes `'read'`), letting any workspace
   reader link a device to the operator's messaging account.
   **Mitigation:** the per-prefix role must land in the *same* commit as the
   channel move, with the `tests/realtime-revocation.test.cjs` case above proving
   a `read` member is refused. Do not split these across commits.

3. **`gateway_configs` and the known `base_url` SSRF.** Opening the table for
   generic reads exposes stored `base_url` values to any workspace member.
   **Mitigation:** `manage` on all four operations, and check whether
   `publicGatewayConfig` (`server/workspaces-routes.cjs:120`) already redacts —
   if it does, the fanout is already the redacted projection and only the
   generic `/db/select` path needs the `manage` gate.

4. **The source-text conformance test is brittle.** It regexes `server/*.cjs`;
   a refactor that changes formatting can fail it spuriously, and a maintainer
   who "fixes" it by loosening the regex silently disarms it.
   **Mitigation:** assert the *count of unparseable call sites is zero* rather
   than skipping them, and put a comment at the top of the test saying that
   loosening the pattern is the failure mode. Accept some brittleness: a test
   that occasionally fails loudly is strictly better than the current state,
   which is four defects nobody noticed.

5. **A registry that nobody updates is worse than no registry**, because it
   reads as authoritative while being stale. **Mitigation:** the conformance
   test is not optional decoration — it is the entire reason the declaration is
   trustworthy. If the tests are dropped, drop the registry too.

6. **Narrowing `RealtimeInboundMessage.type` breaks the build** in places that
   pass through arbitrary frames. Low severity — `npm run typecheck` catches it
   before anything ships. **Mitigation:** keep the union open with a
   `| (string & {})` escape if the fallout is wide.

### Effort

| Slice | Days | Confidence |
|---|---|---|
| 1 — allowlist conformance test + fix 4 dead fanouts | 1.0 | Medium-high. The unknown is the `channel_bridges` column audit, which could double it or push the table out of scope. |
| 2 — `shared/realtime-protocol.cjs` + dispatch conformance | 1.5 | Medium-high. Mostly transcription; the dynamic-send sites are the fiddly part. |
| 3 — client mirror + cross-check + narrowing | 1.0 | Medium. Depends on how many call sites the union narrowing touches. |
| 4 — `message_kind` consolidation | 0.5 | High. Seven known sites, mechanical. |
| 5 — `AGENTS.md` | 0.25 | High. |
| **Total** | **~4.25 engineer-days** | |

**Biggest unknown:** whether `channel_bridges` can safely be broadcast at all.
If its `config` column holds secrets that cannot be cleanly stripped, that table
drops out of scope and the bridges UI needs a different mechanism — which is a
separate, larger piece of work and should not be smuggled into this one.

### Deliberately NOT in v1

- **Numbered kinds.** Rejected outright; see the verdict.
- **A runtime dispatch registry** replacing the `if` ladder at
  `server/realtime.cjs:449-543`. Pure refactor, hottest path, no user-visible
  benefit.
- **Per-frame payload validation** (field types, required fields, size limits).
  Names only in v1.
- **A validator dependency** (zod/ajv/valibot). Not worth 75 → 76 deps and the
  bundle cost for ~24 shapes.
- **Codegen** from the `.cjs` to the `.ts`. A hand-written mirror plus a
  cross-check test achieves the same guarantee without adding a build step to a
  repo that has none.
- **Publishing the registry as an npm package** so `agensis-cli` can import it.
  Correct eventually — it is the only way the daemon stops drifting — but it
  couples two release cadences and needs its own decision. v1 documents the
  daemon's surface in the declaration and leaves the daemon untouched.
- **Deleting the daemon's orphan handlers** (`bridge_stop`,
  `agent_reach_disable`). Requires an npm publish and a fleet-wide daemon
  update to remove 8 lines of harmless dead code. Mark `reserved` instead.
- **Migrating any REST route to a WS message type.** The pack asks for this and
  it is wrong for our architecture — `netlify/functions/backend.mjs` has no
  WebSockets, so a WS-only operation would exist on one backend and not the
  other.

---

## 8. What is deliberately different from the reference

- **Names, not integers.** No stable numeric namespace, because there is no
  independent implementation to keep stable for.
- **A declaration plus conformance tests, not a dispatch mechanism.** buzz's
  registry is load-bearing at runtime (kind determines storage class). Ours is
  load-bearing at review and CI time.
- **REST stays primary.** buzz's "a new feature is a new kind" is possible
  because the relay is the only server. We have two backends and one of them
  cannot serve WebSockets, so new operations remain routes.
- **Per-channel required role**, which buzz has no analogue for — it authorizes
  at the event/community level via signatures and host resolution. Ours is
  workspace RBAC, and the registry is the natural place to declare it because
  `authorizeRealtimeBroadcast` currently cannot express "this channel needs more
  than `read`".
- **`message_kind` is folded in.** buzz has one kind space; agensis has two —
  the wire types and the persisted `messages.message_kind` discriminator. Both
  go in one file because both are "the set of things a client must recognise or
  ignore", and the persisted one is the more dangerous of the two: a wire type
  can be renamed in a deploy, a `message_kind` value is written into rows
  forever.
