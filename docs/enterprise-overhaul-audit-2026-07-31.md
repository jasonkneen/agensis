# Agensis enterprise overhaul audit

**Review date:** 2026-07-31

**Audited snapshot:** `84987556` (`fix(ui): remove inert composer controls`)

**Baseline before this overhaul:** `e6788ffb`

**Disposition:** Not ready for an enterprise release at this snapshot

## Executive outcome

The overhaul has materially improved the application. The audited branch now has
a single audience-bound join URL, owner-only workspace control credential
minting, private-session-aware status and huddle fanout, safer Electron IPC,
better offline account isolation, selected-agent sub-thread routing, and a
cleaner composer. Those are substantive product and security changes rather
than cosmetic refactoring.

The snapshot is not yet enterprise-ready. Three release-blocking areas remain:

1. Client-authored messages and generic message mutations do not establish
   trustworthy authorship or author-only edit/delete semantics.
2. Several session-derived tables are workspace-scoped but not private-session
   scoped on every REST and realtime path.
3. Generic database mutations can return a broader row than the corresponding
   safe generic read projection, including privileged columns on affected
   tables.

Separate branches were addressing the first two findings while this document
was written. They are intentionally recorded as **pending**, not treated as
fixed merely because code exists elsewhere. Agent-purpose/resource taxonomy and
persistent-service integration were also in parallel. The final integration
branch must refresh this document and rerun all release gates.

The product direction is sound if five concepts remain independent:

- stable agent identity;
- purpose, such as collaborator or resource steward;
- runtime adapter, such as built-in Anthropic, Claude Agent SDK, Codex
  app-server, or future ACP;
- execution host and placement;
- authority and credentials.

Templates may prefill purpose and behaviour. They must never silently grant
authority, host access, secrets, or workspace control.

## What “complete review” means here

This review combined:

- a tracked-file and source-size inventory;
- repository-wide searches for security boundaries, database access, realtime
  fanout, session inheritance, model selection, agent execution, process
  lifecycle, and desktop IPC;
- focused semantic review of the highest-risk backend, shared-policy, frontend
  conversation, connection, Electron, and daemon paths;
- review of the commits delivered between `e6788ffb` and `84987556`;
- targeted unit, integration, type/build, and browser evidence supplied by the
  parallel overhaul work;
- an end-to-end browser pass over onboarding, channels, messages, threads,
  sub-threads, agent routing, join redemption, and the Users window;
- a behavioural comparison with the sibling Buzz checkout;
- review of the sibling persistent-service implementation in
  `agensis-agent`.

Every tracked source file was included in the inventory and automated
reachability surface. This document does **not** claim that every line received
equal manual semantic scrutiny, that every conditional branch executed, or that
every visible control was clicked. Those would be false assurances. The release
gates below turn the remaining uncertainty into explicit work.

### Snapshot size

The live count at `84987556` was:

| Measure | Count |
| --- | ---: |
| Tracked files | 1,100 |
| TypeScript, TSX, CJS, and MJS files | 848 |
| Lines in those files, including tests | 223,920 |
| Lines in those files, excluding test paths | 147,160 |

The largest implementation files were:

| File | Lines |
| --- | ---: |
| `server/index.cjs` | 8,925 |
| `src/components/windows/ChatWindowContent.tsx` | 4,740 |
| `src/App.tsx` | 4,151 |
| `src/components/windows/AgentsWindowContent.tsx` | 3,608 |
| `netlify/functions/backend.mjs` | 3,025 |
| `shared/backend-core.cjs` | 2,579 |
| `src/components/windows/TasksWindowContent.tsx` | 2,416 |
| `src/components/Sidebar.tsx` | 2,132 |
| `server/mcp.cjs` | 2,082 |

Size is not itself a defect, but these files combine enough policy, persistence,
or UI state that a local change can have distant effects. They are the primary
targets for feature-slice extraction.

## Delivered change ledger

This ledger records what is present in the audited snapshot. “Delivered” means
the change is committed here; it does not waive the final composite release
gates.

| Commit | Delivered change | Main evidence |
| --- | --- | --- |
| `38b0d5ce` | Narrowed workspace control credentials | Owner-only mint/rotation and no implicit private-session owner access in [`server/workspace-mcp-routes.cjs`](../server/workspace-mcp-routes.cjs) |
| `5c3de4f0` | Scoped private agent-status fanout | `emitAgentStatus` and session audience work in [`server/realtime.cjs`](../server/realtime.cjs) |
| `fe5cc242` | Added explicit join intent | `as: human \| agent`, audience checks, and conditional claim in [`server/join-pages-routes.cjs`](../server/join-pages-routes.cjs) |
| `900b3963` | Unified workspace connections | Feature model/API/hook under [`src/features/workspace-connections`](../src/features/workspace-connections) |
| `df2e96df` | Corrected agent-owned chat and sub-thread routing | Active-host guards and selected-agent dispatch in [`src/hooks/useSubThreads.ts`](../src/hooks/useSubThreads.ts) |
| `61feb684` | Scoped private permission requests | Session-aware authorization/fanout in [`server/agent-permissions.cjs`](../server/agent-permissions.cjs) |
| `be2e2f3e` | Hardened Electron renderer and PTY ownership | `trustedRendererUrl`, `trustedIpcSender`, and owner maps in [`electron/main.cjs`](../electron/main.cjs) |
| `eff5f069` | Scoped private huddles and huddle events | Host-session access checks in [`server/huddles.cjs`](../server/huddles.cjs) and realtime audience routing |
| `4c791289` | Updated invitation/realtime documentation | Product and operational contract updates |
| `0494d8e1` | Isolated offline data between accounts | `prepareOfflineDataForUser` and `clearOfflineData` in [`src/lib/offlineDb.ts`](../src/lib/offlineDb.ts) |
| `84987556` | Removed inert composer controls | Removed visible voice/attachment affordances that had no working action |

### Parallel work not credited as fixed in this snapshot

- **Session-derived private scoping:** separate commit `3a5df6c8` existed on a
  parallel worktree and requires integration plus composite verification.
- **Message integrity and author-only mutations:** parallel work was in progress
  and uncommitted when this snapshot was reviewed.
- **Collaborator/resource taxonomy:** parallel work was in progress, including
  purpose fields, templates, and three-place schema updates.
- **Persistent service:** sibling `agensis-agent` commit `de59da2` implemented
  service commands. Desktop surfacing and clean-host lifecycle proof were not
  part of `84987556`.

## End-to-end product evidence

### What was exercised

| Journey or control | Result at the audited snapshot | Evidence/limit |
| --- | --- | --- |
| Sign-up and onboarding | Passed for the built-in flow | Browser run; not a deployed multi-region test |
| Open/create a channel and send a message | Passed | Browser run |
| View a chat transcript | Passed | Existing and newly created messages rendered |
| Open a standard message thread | Passed | Thread panel opened, reply rendered, count updated |
| Create/view an agent sub-thread | Passed | Sub-thread rendered with its own scoped transcript |
| Route a sub-thread to selected agent only | Passed | Scout was selected; unrelated agent did not receive the turn |
| Isolate a sub-thread across windows/hosts | Passed in the exercised scenario | Browser evidence plus active-host guards; not a load/concurrency proof |
| Open the Users/connections window | Passed | Browser run |
| Create a human audience link | Passed | Link issued through the unified surface |
| Redeem a human link | Passed | Redemption succeeded, URL query was stripped, lifecycle changed to redeemed |
| Revoke an audience link | Passed | Browser run |
| Inspect agent/machine join contract | Passed | Server-rendered join page and machine payload inspected |
| Redeem an agent link from a real daemon | Covered by tests, not by this browser run | Must be included in release E2E |
| Model picker in channel/thread/sub-thread composer | Correctly absent | Model configuration belongs to the agent/runtime |
| Voice/attachment composer controls | Initially visible but inert; removed by `84987556` | Removal is safer than a false affordance |

The browser evidence is stored temporarily under
`/private/tmp/agensis-enterprise-audit/`. Particularly relevant captures are:

- `channel-thread-no-model.png`
- `thread-panel.png`
- `subthread-scoped.png`
- `subthread-agent-routing.png`
- `subthread-host-isolation.png`
- `unified-join-page.png`
- `unified-join-machine.png`
- `users-redeemed.png`
- `users-revoked.png`

These files are audit evidence, not committed product assets and not a visual
regression baseline.

### Visual and interaction gaps observed

1. An expanded **Get Started** footer could cover the Users entry until the
   footer was collapsed. This is a layout and keyboard-access risk, not merely
   an aesthetic issue.
2. A blank navigation rail appeared briefly after join redemption and populated
   roughly 2.5 seconds later. The flow needs an explicit loading/skeleton state
   and a deterministic post-redemption refresh.
3. There is no automated cross-browser visual diff, reduced-motion pass,
   keyboard-only matrix, screen-reader pass, or responsive viewport matrix.
4. The run exercised the controls listed above. It did not prove every menu
   item, destructive confirmation, shortcut, hover state, focus ring, disabled
   state, or error state.

### Test evidence available during the overhaul

- 24 targeted join/development tests passed.
- 31 focused frontend tests passed.
- 144 focused and adjacent huddle tests passed.
- 3 Electron security tests passed.
- A full `npm run ci` passed at an intermediate permission-scoping checkpoint.

The last item is not a substitute for a full final run after all parallel
branches are integrated.

## Findings

Severity reflects the impact at `84987556`, before parallel fixes are merged.

### Critical: release blockers

#### C-01 — Message identity and ownership are client-authoritative

**Status:** Open at this snapshot; parallel fix in progress.

[`src/hooks/useChat.ts`](../src/hooks/useChat.ts) `insertUserMessage` sends
message role and display identity from the browser. The generic insert path
accepts client values after generic column filtering rather than deriving the
human sender identity from the authenticated principal. The same generic path
can therefore create semantically privileged-looking sender kinds unless every
caller behaves.

Editing and deletion are also exposed as broad conversation callbacks:
`handleSaveEdit` and `handleConfirmDeleteMessage` in
[`src/components/windows/ChatWindowContent.tsx`](../src/components/windows/ChatWindowContent.tsx)
are supplied to message bubbles without a server-established author-only
mutation contract. In
[`shared/backend-core.cjs`](../shared/backend-core.cjs),
`enforceDbOperationAccess` applies the session predicate to selects, but generic
updates/deletes rely on workspace capability and table filters.

This is more than attribution polish. `sender_kind` changes downstream meaning:
agent, automation, and system messages take different execution, display, and
cycle-prevention paths.

**Required remediation**

- Server-stamp human `sender_id`, `sender_name`, `sender_kind`, and role from the
  authenticated session.
- Keep agent, automation, and system inserts on server-owned routes only.
- Add dedicated edit/delete commands that require original authorship.
- Add a separate, audited moderator override requiring `manage`.
- Reject identity fields on generic message inserts and remove generic message
  update/delete access.
- Test forged sender kinds, another human’s message, private sessions, deleted
  members, automation markers, and both Fly and Netlify surfaces.

#### C-02 — Session-derived data is not uniformly private-session scoped

**Status:** Open at this snapshot; a separate scoping commit is pending
integration.

The documented private-session contract is strong for `chat_sessions`,
`messages`, permission requests, huddles, and huddle events. It is not yet
uniform for all tables derived from a session.

At the snapshot:

- `appendSessionAccessClause` in
  [`shared/backend-core.cjs`](../shared/backend-core.cjs) covers only the named
  table shapes above.
- `SESSION_AUDIENCE_TABLES` in
  [`server/realtime.cjs`](../server/realtime.cjs) does not include every
  session-derived table.
- `thread_items`, `agent_jobs`, and `agent_schedules` can carry private-session
  references or content while retaining workspace-wide generic/list paths.
- `agent_jobs` can expose prompt/response material through HTTP generic reads;
  realtime heavy-field stripping does not protect an HTTP response.
- [`server/schedules-routes.cjs`](../server/schedules-routes.cjs) lists/manages
  schedules at workspace granularity even when a schedule targets a private
  conversation.

**Required remediation**

- Merge and review the pending session-scope branch.
- Define a declared session-resolution strategy for every subscribable or
  readable session-derived table.
- Apply the same fail-closed audience decision to REST, MCP, realtime, dedicated
  routes, and both backend deployments.
- Hide prompt/response bodies from generic `agent_jobs` projection.
- Add negative two-user tests for each table and each transport.
- Keep the realtime allowlist test as a structural gate; do not fix failures by
  broadly allowlisting a sensitive table.

#### C-03 — Generic mutation responses can bypass safe read projections

**Status:** Open.

The generic insert/update handlers in
[`server/index.cjs`](../server/index.cjs) and
[`netlify/functions/backend.mjs`](../netlify/functions/backend.mjs) construct
their `RETURNING` clause from the request, commonly `*`. Safe generic selects
use table-specific projection controls, but mutation responses do not
consistently force those same projections.

On an affected table, a caller with mutation capability can update an allowed
field and receive a row containing columns intentionally hidden from generic
reads, such as connection hashes, encrypted API-key material, or sensitive
configuration. Realtime sanitisation is not relevant to the direct HTTP
response.

**Required remediation**

- Force insert/update/delete responses through
  `SELECTABLE_COLUMNS_BY_TABLE` or a stricter mutation-specific projection.
- Default to the smallest stable acknowledgement shape, not `returning *`.
- Move sensitive table mutation to dedicated routes where practical.
- Add tests proving a write cannot reveal any column a generic read cannot
  reveal at the same capability.
- Apply the same helper in Fly and Netlify rather than maintaining two copies.

### High priority

#### H-01 — Fly and Netlify conversation lifecycle parity can drift

The Fly generic insert path in [`server/index.cjs`](../server/index.cjs) invokes
`resolveInheritedSessionVisibility`, `addSessionParticipant`, and
`copyInheritedSessionMembers`. The Netlify mirror in
[`netlify/functions/backend.mjs`](../netlify/functions/backend.mjs) does not
have the same complete creation lifecycle.

A DM-derived thread or fork created through the wrong backend can therefore
miss inherited visibility or member copying.

**Remediation:** replace generic session creation with a shared, transactional
conversation command used by both deployments. Add a backend-parity test matrix
for channel, DM, thread, split, fork, merge, and huddle transcript creation.

#### H-02 — A legacy unauthenticated AI edge function remains in the tree

[`supabase/functions/ai-chat/index.ts`](../supabase/functions/ai-chat/index.ts)
directly invokes a provider key without the application’s current auth, RBAC,
rate-limit, audit, and workspace-context controls. It also contains an
independent model mapping that can drift from the active execution system.

This finding does not assert that any named model is invalid. The problem is an
independent spend and trust boundary.

**Remediation:** prove the function is undeployed and remove it, or bring it
behind the same authenticated server-owned execution contract and deployment
gates.

#### H-03 — Runtime DDL, canonical schema, and migrations are not fully aligned

`agent_jobs` is created through `ensureRuntimeSchema` in
[`server/index.cjs`](../server/index.cjs), but the complete definition is not
represented consistently in both
[`database/neon-schema.sql`](../database/neon-schema.sql) and a migration.

The repository’s three-place schema rule is necessary today, but it remains a
manual drift hazard.

**Remediation:** reconcile the table in all three places immediately. Longer
term, generate or verify runtime bootstrap from the canonical migration state
and run a fresh-database schema diff in CI.

#### H-04 — Prompt context has no enforceable section budgets or trust boundary

`buildSystemPrompt` and `normalizeAiChatMessages` in
[`server/index.cjs`](../server/index.cjs) assemble workspace instructions,
documents, memories, and conversation content without a hard, per-section
budget. [`src/hooks/useChat.ts`](../src/hooks/useChat.ts) also loads full session
history for some agent-context flows.

Large histories increase cost and latency. More importantly, user/workspace
content can be visually placed next to trusted system instructions without a
strong server-owned untrusted-content boundary.

**Remediation:** define per-section byte/token budgets, explicit truncation and
summarisation policy, server-owned context assembly, nonce-fenced untrusted
content, pagination, and observability for discarded context.

#### H-05 — Split, escalate, and merge are non-transactional browser workflows

The conversation operations in [`src/hooks/useChat.ts`](../src/hooks/useChat.ts)
perform several client-visible inserts/copies in sequence. A network failure or
concurrent change can leave a partially created session, marker, or copy.

**Remediation:** move each operation to a dedicated idempotent server command
with a database transaction, operation key, audit entry, inherited privacy
policy, and retry-safe response.

#### H-06 — The legacy invite acceptance path is not an atomic claim

[`server/members-invites-routes.cjs`](../server/members-invites-routes.cjs)
reads an invite, inserts membership, then updates the invite in separate
operations. The newer unified join path uses a conditional claim, but the legacy
route remains a race surface.

**Remediation:** retire the legacy path or wrap it in the same transaction and
conditional status/expiry/audience claim used by unified join.

#### H-07 — Workspace control is still a broad, singleton credential

The delivered owner-only guard is an important fix. The current `agw_` style
workspace credential is nevertheless a long-lived, broad control-plane token
with coarse rotation. It cannot express named clients, delegated scope, expiry,
per-client revocation, or useful last-used lineage.

**Remediation:** introduce named scoped control credentials and one-time
workspace-control enrollment. An enrolled controller may register its own
agents and stewarded resources within delegated scopes. It must not gain private
conversation reads, arbitrary message posting, raw vault access, or owner
impersonation by implication.

#### H-08 — Persistent local execution is not yet an integrated product

The sibling `agensis-agent` branch implements a credible service layer, but at
this snapshot:

- it is not part of this branch’s release evidence;
- the desktop has no complete local supervisor control socket/proxy contract;
- ACP is not an implemented adapter;
- clean-host install, reboot, desktop-quit, reconnect, upgrade, and uninstall
  behaviour has not been proven.

The desktop must be a client of the supervisor, never the lifetime parent of
agent processes.

#### H-09 — There is no deployed, automated, multi-principal E2E matrix

The browser pass used one signed-in human and targeted machine-contract tests.
It did not run two independent human accounts plus a real agent daemon against
both deployed backend shapes.

**Remediation:** add Playwright journeys for two humans, one collaborator agent,
one resource agent, private/public sessions, invite replay/expiry/revoke,
reconnect, cross-window sub-threads, and permission decisions. Run against both
Fly WebSocket/HTTP and Netlify HTTP paths where applicable.

#### H-10 — Running agent work lacks a complete user-facing cancellation path

The code has abort/cleanup mechanics in limited contexts, but the reviewed chat
surface does not provide a consistent Stop action that propagates to built-in
and daemon runtimes and records a structured cancellation reason.

**Remediation:** add an idempotent cancel command, runtime cancellation adapter,
visible state transition, timeout fallback, and audit/activity evidence.

### Medium priority

#### M-01 — Fatal process handling can accumulate and continue unsafely

`startBackendServer` in [`server/index.cjs`](../server/index.cjs) installs
process-level exception handlers. Repeated embedded starts can accumulate
listeners, and continuing after an unknown `uncaughtException` risks corrupted
state.

Install process handlers once at the executable boundary. On an uncaught
exception, stop admission, drain if safe, and exit for supervisor restart.

#### M-02 — A global 50 MB JSON parser runs before route-specific need

[`server/index.cjs`](../server/index.cjs) enables a large `express.json` limit
globally. Most authenticated control and chat routes need far less.

Use small defaults and opt in only on routes that demonstrably require larger
bodies, after the earliest practical authentication/rate-limit checks.

#### M-03 — Realtime subscription failure is not observable enough

[`src/lib/backendClient.ts`](../src/lib/backendClient.ts) marks subscriptions
active before a server acknowledgement and does not surface every server error
frame to the owning feature. A refused subscription can look like an empty,
working surface.

Add subscription request IDs, acknowledgement/error states, feature-visible
failure, retry/backoff metrics, and tests that cross the actual wire grammar.

#### M-04 — Batch inserts derive shape from the first row

Both backend generic insert paths derive columns from `Object.keys(rows[0])`.
Later rows with extra keys can lose data; missing keys can produce ambiguous
binding.

Reject heterogeneous row shapes or normalise against an explicit validated
column set. Do not silently drop keys.

#### M-05 — Inherited workspace access is not fully discoverable

Authorization can inherit a role from a parent workspace through
`getInheritedWorkspaceRoles` in
[`shared/backend-core.cjs`](../shared/backend-core.cjs), while workspace listing
in [`server/workspaces-routes.cjs`](../server/workspaces-routes.cjs) primarily
discovers direct ownership/membership.

Include effective inherited workspaces in the list response and label the role
source so the UI can explain why access exists.

#### M-06 — Sub-thread and agent-context history can grow without a bound

[`src/hooks/useSubThreads.ts`](../src/hooks/useSubThreads.ts) loads complete
sub-thread message sets, and several merge/context paths load full histories.

Add cursor pagination and a deliberate recent-window/summary strategy for model
context. The transcript UI and agent context need not share the same query.

#### M-07 — Loading and layout states need regression coverage

The Get Started overlap and transient blank rail show that otherwise correct
features can be temporarily unreachable or appear broken.

Add layout collision assertions, deterministic redemption loading states,
keyboard reachability, responsive screenshots, and reduced-motion coverage.

#### M-08 — Large cross-cutting modules impede isolation

The largest files mix route composition, SQL, authorization, realtime,
orchestration, and UI state. This raises review cost and makes backend parity
harder to prove.

Use the feature-slice target below. Do not perform a platform rewrite or a
single big-bang file split.

#### M-09 — Performance and failure behaviour are not characterised

There is no accepted load envelope for large workspaces, large transcripts,
WebSocket reconnect storms, agent fanout, queue saturation, or database
failover.

Define service-level objectives and run load, soak, fault-injection, and recovery
tests before enterprise release.

## Target product model

### Five orthogonal axes

| Axis | Question answered | Must not imply |
| --- | --- | --- |
| Identity | Which stable agent/resource-facing identity is this? | Runtime, model, permissions, or host |
| Purpose | Is it a collaborator or a resource steward, and which facets does it serve? | Authority |
| Runtime adapter | How are turns executed: built-in, Claude Agent SDK, Codex app-server, ACP, or another adapter? | Placement or workspace role |
| Host/placement | Where does this runtime run, and which instance currently owns the lease? | Purpose or private-data access |
| Authority | Which explicit workspace, conversation, resource, tool, and secret capabilities were granted? | Behaviour inferred from a template |

`workspace_agents.id` should remain the stable identity. Model choice belongs in
the agent/runtime binding. A channel, thread, sub-thread, or prompt composer
therefore should not display a model selector.

### Agent purpose and templates

Use a purpose discriminator:

```text
purpose: collaborator | resource
resource_facets: context | knowledge | tooling | code
```

`resource_facets` should support more than one value. Examples:

- a **collaborator** reasons, discusses, reviews, or proposes;
- a **resource/context** agent supplies curated context;
- a **resource/knowledge** agent retrieves or maintains knowledge;
- a **resource/tooling** agent exposes a controlled tool interface;
- a **resource/code** agent owns code checkout, patch, build, or execution
  operations.

A code proposer and a code handler can run on different machines. The proposer
emits a structured proposal artifact; the code handler validates and applies it
through its own scoped host operations.

Templates should carry prose and requests only:

- name, description, system prompt, default skills/tools as advisory requests;
- purpose and resource facets;
- user-visible expectations and handoff protocol.

Templates must not carry:

- permission mode or workspace role;
- control credentials;
- connect-token material;
- vault values;
- host folders or sandbox endpoints;
- execution placement;
- auto-approval state.

The schema should make those authority fields impossible to import through a
template, preserving the existing defensive template design.

### Agent-gated shared resources

Keep agents as resource gatekeepers. Do not turn shared resources into raw
workspace-wide tables that every client can read.

The target model is:

```text
workspace_resource
  id
  workspace_id
  steward_agent_id
  facet
  descriptor
  version
  visibility
  created_by
  created_at

resource_operation
  resource_id
  requested_by
  operation: read | propose | apply | publish
  input_artifact
  output_artifact
  status
  audit_reference
```

The steward agent mediates access, policy, versioning, and host-specific
execution. A caller receives an operation result or a versioned artifact, never
an ambient raw credential. Resource-agent classification is the first product
step; structured `workspace_resources` and operations are the durable model.

## One secure invite URL

### Individual human and agent joining

The delivered foundation is correct:

```text
https://<public-origin>/join/<opaque-token>
```

The same URL serves a browser-readable page and a machine-readable contract.
Lane selection is explicit and authenticated:

- a human opens the URL, signs in if needed, and submits `as: "human"`;
- an agent reads the machine contract and submits `as: "agent"`;
- the grant declares `audience: human | agent | both`;
- contradictory or missing intent is rejected;
- redemption is a single conditional transition checking audience, status,
  expiry, and token hash.

Do not use user-agent sniffing to decide whether a visitor is human or agent.
Automatic here means one discoverable URL and an appropriate client experience,
not guessing identity from HTTP headers.

The existing join implementation is centred on:

- `mountJoinPagesRoutes` in
  [`server/join-pages-routes.cjs`](../server/join-pages-routes.cjs);
- `joinDescriptor`, `machinePayload`, and `renderJoinHtml` in
  [`server/join-page.cjs`](../server/join-page.cjs);
- the shared frontend feature in
  [`src/features/workspace-connections`](../src/features/workspace-connections).

Enterprise acceptance requires short default expiry, single use, hash-at-rest,
revoke, replay resistance, redacted logs/referrers, lifecycle audit, and
two-principal negative tests.

### Workspace control enrollment is a different grant

Workspace control is intentionally not an ordinary member/agent invitation.
It may share the `/join/<token>` route family, but it must remain visibly
high-authority:

```text
grant_kind: individual | workspace_control
```

A workspace-control grant should require:

- current owner confirmation;
- a shorter, one-time enrollment TTL;
- an audience fixed to an agent/controller;
- a named controller identity;
- requested scopes shown before confirmation;
- exchange into a named, revocable credential;
- parent-child credential lineage and non-escalating delegation;
- expiry, last-used metadata, rotation, and audit.

Suggested initial scopes:

```text
agents:register
agents:manage_own
resources:create
resources:manage_own
placements:request
```

Workspace control must not automatically include:

```text
private_sessions:read
messages:post_anywhere
vault:read_raw
roles:grant
credentials:escalate
```

This gives a controller the requested ability to add its own agents and create
stewarded shared resources without silently turning it into a workspace owner or
a private-conversation observer.

## Runtime, desktop, and persistent supervisor

### Current adapter boundaries

The sibling `agensis-agent` implementation currently has two distinct executor
contracts in `packages/agensis-cli/src/connectionExecutors.mjs`:

- Claude uses `@anthropic-ai/claude-agent-sdk` and `query()`.
- Codex uses `codex app-server` over stdio JSON-RPC.

Neither of those should be relabelled ACP. ACP is a future third adapter behind
the same Agensis execution interface.

The common interface should cover:

- start/resume/cancel;
- streaming text, reasoning, tool calls, and tool results;
- permission requests and decisions;
- structured stop reasons;
- usage/cost metadata;
- runtime/session identity;
- reconnect and lost-connection semantics.

### Persistent service branch

Sibling commit `de59da2` adds:

```text
agensis service install [--profile <name>]
agensis service status [--profile <name>]
agensis service logs [--profile <name>] [--follow]
agensis service uninstall [--profile <name>]
```

Its intended lifecycle is:

- macOS LaunchAgent with `RunAtLoad` and `KeepAlive`;
- Linux systemd user unit with `Restart=always`;
- service command runs `agensis supervise --profile <name>`;
- service definition stores paths, not the connection token;
- the profile token remains in the mode-`0600` profile under
  `~/.agensis/daemon-profiles/<profile>.json`;
- Windows reports unsupported without mutating the machine.

This is a good foundation, but unit/helper coverage is not clean-host lifecycle
proof.

### Required desktop/supervisor relationship

```text
Agensis cloud
      |
local supervisor service  <---->  runtime adapters
      |
authenticated local control socket
      |
desktop UI
```

Closing or crashing the desktop must leave the supervisor and active agents
running. Reopening the desktop should reconnect to state rather than recreate
processes. The local socket or named pipe needs OS-user scoping, profile
separation, protocol versioning, replay protection where relevant, and no token
exposure to the Electron renderer.

Execution hosts and placements should be first-class:

- `execution_hosts`: owner, capabilities, platform, health, trust tier;
- `agent_placements`: agent/runtime/host binding and desired state;
- `runtime_instances`: actual instance, fenced lease, heartbeat, version;
- only the active lease holder may complete or mutate a job.

That model permits a thinking agent and a code handler on different boxes
without giving the thinking agent the code host’s filesystem authority.

## Behavioural comparison with Buzz

The sibling Buzz repository was studied only for behaviour and lifecycle
concepts. No source should be copied.

Useful concepts:

- separate collaborative identity from execution placement;
- keep invitations, identity, audit, and managed-agent lifecycle explicit;
- use an adapter layer for agent protocols, including ACP;
- make agent-owned credentials and actions inspectable.

The important non-example is shutdown behaviour. Buzz’s desktop shutdown path
explicitly stops managed agents. Agensis has the opposite product requirement:
agent work must survive desktop quit. That makes the persistent supervisor the
lifetime owner and the desktop a control client.

Agensis should retain its existing React/Vite, Express/WebSocket, Netlify,
Neon, and Electron platform. This is a behavioural reference, not a request to
adopt Buzz’s Tauri, protocol, or persistence architecture.

## Feature/package target

Use a strangler refactor: new work enters a feature slice, and touched legacy
logic moves behind it. Do not pause product delivery for a big-bang rewrite.

```text
shared/features/
  conversations/
  workspace-connections/
  agent-catalog/
  resources/
  execution-control/
  workspace-control/

server/features/<feature>/
  routes.cjs
  service.cjs
  repository.cjs
  policy.cjs

src/features/<feature>/
  api.ts
  model.ts
  hooks/
  components/

tests/features/<feature>/
  policy/
  backend-parity/
  realtime/
  browser/
```

`src/features/workspace-connections` is the first useful exemplar.

### Boundaries

| Feature | Owns | Does not own |
| --- | --- | --- |
| Conversations | sessions, messages, threads, sub-threads, inherited privacy, transactional split/merge/fork | runtime implementation |
| Workspace connections | invite grants, join contract, redemption lifecycle | control credential authority |
| Agent catalog | stable identity, purpose, templates, visible configuration | host process lifecycle |
| Resources | stewarded artifacts and structured operations | raw vault values |
| Execution control | jobs, permissions, cancellation, stop reasons, runtime interface | agent purpose |
| Execution hosts | service health, placements, instances, leases | conversation membership |
| Workspace control | scoped credentials, delegation, audit | private-message visibility |
| Huddles | huddle lifecycle and transcript relationship | generic conversation mutation |

`server/index.cjs` should become a composition root rather than the owner of
feature policy. Netlify should import the same shared command/policy functions,
not maintain a second behavioural implementation. Canonical migrations should
own schema; runtime bootstrap should be generated from or checked against them.

## Phased implementation plan

### Phase 0 — Close the current release blockers

1. Integrate and review message integrity.
2. Integrate and review session-derived private scoping.
3. Fix safe projections on generic mutation responses.
4. Reconcile schema parity and Fly/Netlify conversation lifecycle.
5. Rerun the full composite CI and negative privacy matrix.

**Acceptance:** no critical finding above remains open; forged authorship,
cross-user private reads, private realtime fanout, and mutation-return secret
exposure all fail in automated tests on both backends.

### Phase 1 — Complete purpose taxonomy without authority coupling

1. Add `purpose` and `resource_facets` in runtime schema, canonical schema, and
   migration.
2. Add collaborator and resource templates, including a Code Handler.
3. Expose purpose in create/edit/detail surfaces.
4. Keep resource agents out of ambient auto-reply by default.

**Acceptance:** purpose round-trips across fresh and upgraded databases;
templates cannot carry authority fields; changing purpose changes no permission;
collaborator and resource agents work in browser and daemon flows.

### Phase 2 — Add stewarded resources

1. Add `workspace_resources` and versioned artifacts.
2. Add closed, structured read/propose/apply/publish operations.
3. Require a steward agent and explicit caller capability.
4. Audit changes and prevent raw-secret return.

**Acceptance:** a proposer on host A can submit a code proposal to a code handler
on host B; only the handler applies it; every transition is attributable and
retry-safe; unauthorized direct resource access fails.

### Phase 3 — Replace singleton workspace control

1. Add named scoped credentials with hash, expiry, revoke, last-used, and parent
   lineage.
2. Add one-time workspace-control enrollment grants.
3. Permit constrained creation of child agents/resources.
4. Add owner review and audit UI.

**Acceptance:** compromise of one controller can be revoked independently; it
cannot escalate scopes, read private sessions, grant roles, or read raw secrets;
delegated child agents/resources are attributable to the controller.

### Phase 4 — Productise persistent execution

1. Integrate the `agensis service` branch.
2. Add an authenticated versioned local control protocol.
3. Make desktop connect/status/log/start/stop operations use the supervisor.
4. Add hosts, placements, runtime instances, and fenced leases.
5. Define upgrade and rollback.

**Acceptance:** active work survives desktop quit and crash; macOS and Linux
services survive login/reboot as designed; duplicate supervisors cannot both
complete a job; uninstall is clean; Windows remains explicitly unsupported
until implemented.

### Phase 5 — Add ACP as an adapter

1. Specify the common executor event/command contract.
2. Wrap current Claude Agent SDK and Codex app-server adapters.
3. Add ACP without changing identity, authority, or conversation semantics.
4. Add conformance fixtures for streaming, tools, permissions, cancellation,
   reconnect, and stop reasons.

**Acceptance:** the same agent-facing job contract passes against each adapter;
the UI does not special-case protocol details; model remains agent/runtime
configuration.

### Phase 6 — Extract vertical feature slices

Move touched behaviour into the package target above, beginning with
conversations and execution control. Keep `server/index.cjs` and the Netlify
mirror as thin composition/adaptation layers.

**Acceptance:** shared policy tests run once against both backend adapters;
session lifecycle has one implementation; no schema-owning feature exists only
in runtime DDL; largest modules show measurable responsibility reduction.

### Phase 7 — Enterprise assurance and release

Run the release gates below, perform canary deployment, validate observability
and rollback, then publish the enterprise support envelope.

## Enterprise release gates

All gates are required unless an explicit risk acceptance names an owner and an
expiry date.

### Source and build

- All parallel branches integrated with reviewed diffs.
- Clean install and lockfile reproducibility.
- Full `npm run ci`, production build, and syntax checks for Fly and Netlify
  entrypoints.
- Sibling daemon/service unit and integration suites.
- No critical/high dependency or secret-scan finding without signed acceptance.

### Database and backend parity

- Apply migrations to an empty database with runtime DDL disabled.
- Compare resulting schema with canonical schema and runtime expectations.
- Upgrade a production-like old schema and compare again.
- Run the same session lifecycle and authorization contract against Fly and
  Netlify handlers.
- Verify array binding, projections, transactions, idempotency, and rollback.

### Security and privacy

- Two-human negative matrix for every private-session-derived table over REST,
  MCP, and realtime.
- Agent-token matrix for pinned, workspace-control, and integration tokens.
- Message authorship/edit/delete forgery tests.
- Invite expiry, replay, revoke, wrong-audience, token leakage, and concurrent
  redemption tests.
- Generic read and mutation projection tests for every sensitive table.
- Electron navigation, IPC sender, PTY ownership, external URL, and renderer
  secret-boundary tests.
- Threat model and manual penetration review of join, workspace control, local
  service, vault, outbound URL, and tool approval paths.

### End-to-end behaviour

- Automated Playwright run with two humans, one collaborator agent, and one
  resource/code-handler agent.
- Channel chat, DM, normal thread, sub-thread, split, fork, merge, huddle, and
  transcript reload.
- Selected-agent routing and cross-window isolation.
- Human and machine invitation creation, redemption, revoke, expiry, and replay.
- Permission request once/always/deny and cancellation.
- Account switch/offline cache isolation.
- Keyboard, screen-reader, reduced-motion, responsive, and visual-regression
  matrix.
- Every enabled control in the supported UI inventory has a success, disabled,
  error, and destructive-confirmation test as applicable.

### Persistent service and runtime

- Clean macOS and Linux install/status/logs/restart/uninstall.
- Login, reboot, desktop quit/crash, network loss, server restart, token
  rotation, daemon upgrade, and rollback.
- Active job recovery and exactly-one completion under duplicate/reconnected
  instances.
- Adapter conformance for Claude Agent SDK, Codex app-server, and ACP once
  shipped.
- Explicit support statement for Windows.

### Performance and operations

- SLOs for message send, realtime delivery, join redemption, job dispatch, and
  reconnect.
- Large transcript/workspace benchmarks and pagination proof.
- WebSocket reconnect storm, agent fanout, permission burst, and schedule burst
  tests.
- Database latency/failover and backend restart fault injection.
- Structured logs, metrics, traces, audit visibility, alert thresholds, and
  runbooks.
- Fly and Netlify canary with matching build identity, schema state, secrets,
  public join origin, rollback, and smoke tests.

## Explicitly not proven at this snapshot

The audit does not claim:

- every line received equal manual review;
- every UI control was clicked;
- all accessibility or visual states are correct;
- agent invitation was redeemed by a real daemon in the browser run;
- Fly and Netlify have complete behavioural parity;
- the parallel message/session/taxonomy branches are integrated;
- the persistent service survives real reboot/desktop-quit scenarios;
- ACP is implemented;
- Windows service support exists;
- large-workspace performance, fault tolerance, or multi-region deployment is
  acceptable;
- a final composite CI run has passed after every overhaul commit.

Those are release work, not caveats to hide. The architecture and phased plan
above provide a path to prove each one without changing the application’s
platform or weakening the agent-as-resource-gatekeeper model.
