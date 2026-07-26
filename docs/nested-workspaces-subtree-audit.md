# Nested workspaces — `workspace_id` subtree audit

**Status:** advisory. Nothing in this document has been implemented. The
`parent_id` foundation has landed (schema, cycle guards, inherited
authorization, projection); the sweep described here happens when nesting
becomes user-visible.

**Why it exists.** `workspaces.parent_id` makes every existing `workspace_id`
comparison ambiguous: *this workspace, or the subtree?* There are **433 raw
occurrences** across the two backends —

| File | `workspace_id` occurrences | distinct functions / routes |
|---|---:|---:|
| `server/index.cjs` | 335 | 185 |
| `netlify/functions/backend.mjs` | 62 | 30 |
| `shared/backend-core.cjs` | 36 | 15 |

— and rewriting them blind is how a tenancy bug ships. **33 call sites are
flagged for change** below, and a further **17 entries are called out as
must-NOT-change** because widening them is the leak. Anything not listed keeps
single-workspace semantics by default.

---

## The rule that decides every row in this document

> A child inherits **AGENTS** and **MEMBERS** from its ancestors.
> **CONTENT is ISOLATED** — channels, documents, tasks and memory belong to
> exactly one workspace and are never visible from a sibling or a parent.

That splits the work into three, and the split is what keeps it small:

- **↑ ANCESTOR-scoped** — a child reads *upward* for agents and members. `W ∪ ancestors(W)`.
- **↓ SUBTREE-scoped** — a parent rolls *downward* for lists, counts and inboxes. `W ∪ descendants(W)`.
- **= UNCHANGED** — content. `workspace_id = $1`, exactly as today.

The third group is the largest by far and the most important to leave alone.
Pure helpers for the first two live in `shared/workspace-tree.cjs`
(`selfAndAncestorIds`, `subtreeIds`).

---

## Already done (this branch) — do not redo

| Site | What changed |
|---|---|
| `shared/backend-core.cjs` `assertWorkspaceRole` | Grants on a role held in **any ancestor**; direct-role fast path unchanged |
| `shared/backend-core.cjs` `userCanAccessWorkspace` | Same |
| `server/index.cjs` `enforceWorkspaceRole` / `userCanAccessWorkspace` | Delegate to the shared versions so Fly and Netlify cannot drift |
| `publicWorkspace` + `GET /backend/workspaces` SELECT, both backends | `parent_id` projected |
| `enforceDbOperationAccess`, `workspaces` branch | `parent_id` writes authorized + cycle-checked; delete-with-children → 409 |

---

## ↑ ANCESTOR-scoped — 21 sites

A child must see the agents and members of the workspaces above it. These read
`W ∪ ancestors(W)` (nearest-first; the *closest* definition wins on conflict).

### Agents

| Site | Lines | Recommendation |
|---|---|---|
| `GET /backend/workspaces/:id/agents` | `server/index.cjs:8913` | **Subtree-up.** Union the workspace's own agents with every ancestor's. Tag inherited ones in the projection so the Agents window can show where they come from — an agent you cannot edit must not look like one you can. |
| `handleWorkspaceAgents` | `netlify/functions/backend.mjs:929` | **Subtree-up.** Must match the Fly route exactly; the client reads whichever backend answered. |
| `buildWorkspaceBootstrap` — agents slice | `server/index.cjs:2691` | **Subtree-up.** Cold load builds the whole agent roster here; miss it and inherited agents appear only after a manual refresh. Mind `BOOTSTRAP_LIMITS.agents` (200) — the cap now spans a tree. |
| `resolveWorkspaceAgentByHandle` | `server/index.cjs:2451` | **Subtree-up.** `@handle` in a child channel must resolve an inherited agent. Handles are only unique per workspace, so define precedence: **nearest ancestor wins**, own workspace first. |
| `agentIdsFromWsRequest` | `server/index.cjs:2474` | **Subtree-up**, consistent with the above. |
| `findConnectedAgent` | `server/index.cjs:2586` | **Subtree-up.** The daemon connection belongs to the agent's own workspace; a child dispatching to an inherited agent will not find it otherwise. |
| `POST /backend/agents/dispatch` | `server/index.cjs:9888` | **Subtree-up** for *resolving* the agent; the job row and its messages stay stamped with the **child** workspace. This is the one place the two directions meet — get it wrong and a client's conversation lands in the parent. |
| `GET /backend/agents/connections` | `server/index.cjs:9488` | **Subtree-up.** |
| `handleAgentConnections` | `netlify/functions/backend.mjs:1007` | **Subtree-up.** Parity with the above. |
| `refreshConnectedAgentConfigs` | `server/index.cjs:3004` | **Subtree-up.** A soul/instruction edit on a parent agent must reach daemons serving children. |
| `seedDefaultAgents` | `server/index.cjs:7615`, `netlify/functions/backend.mjs:1782` | **Suppress on create when an ancestor already has agents.** Otherwise every new client workspace gets a duplicate set of default agents shadowing the inherited ones. |
| `sharedModelRoutesFromConnections` / `liveSharedModelRoutes` | `server/index.cjs:5302`, `:5331` | **Subtree-up.** Shared inference routes ride the agent. |
| `runDueSchedules` | `server/index.cjs:5009` | **Follows the agent.** A schedule owned by a parent agent stays in the parent; if a schedule can target a child channel, the run's messages must be stamped with the child. |
| `GET`/`POST /backend/workspaces/:id/schedules` | `server/index.cjs:9635`, `:9705` | **Subtree-up** for listing (so a child can see what an inherited agent is scheduled to do); creation stays in the workspace that owns the agent. |

### Members and invites

| Site | Lines | Recommendation |
|---|---|---|
| `GET /backend/workspaces/:id/members` | `server/index.cjs:10257` | **Subtree-up.** Show inherited members, flagged as inherited and not removable here — removing them belongs to the ancestor that granted them. |
| `PATCH` / `DELETE /backend/workspaces/:id/members/:memberId` | `server/index.cjs:10285`, `:10310` | **Reject on an inherited member, explicitly.** Today the row simply is not found; that must become a clear "this member comes from <parent>" rather than a 404. Same for `handleUpdateWorkspaceMember` / `handleDeleteWorkspaceMember`, `netlify/functions/backend.mjs:896`, `:915`. |
| `POST /backend/workspaces/:id/invites` | `server/index.cjs:10355` | **Unchanged scope, new decision:** an invite to a parent grants the whole subtree. Say so in the invite UI, or people will hand out more access than they mean to. |
| `ensureMentionedParticipants` | `server/index.cjs:4112` | **Subtree-up.** `@person` in a child must resolve an inherited member. |

### Credentials an inherited agent needs to actually run — decide before shipping

An inherited agent runs *inside the child workspace* but its API key, gateway
and vault entries live in the parent. Strict content isolation would leave it
unable to make a single call. This is the one place the inheritance rule as
written is under-specified.

| Site | Lines | Recommendation |
|---|---|---|
| `resolveSecret` / `getWorkspaceSecretValue` | `server/index.cjs:143`, `:1374`; `shared/backend-core.cjs:1170`; `netlify/functions/backend.mjs:652` | **Ancestor fallback on READ only** — child's own value first, then up the chain, then the app/env default. Writes stay in the workspace addressed. Ciphertext must not cross tenants any other way. |
| `resolveGatewayRoute` + `GET /backend/workspaces/:id/gateways` | `server/index.cjs:8954`, `:8978` | **Ancestor fallback on READ**, same shape. Never project `api_key_cipher`; `has_key` only, as today. |
| `verifyWorkspaceMcpToken` / `POST /backend/workspaces/:id/mcp-token` | `server/index.cjs:2386`, `:10625` | **No inheritance.** A group's MCP token must not silently be a key to every client workspace under it. Mint per workspace. |

---

## ↓ SUBTREE-scoped — 12 sites

A parent's *views* roll up. None of these expose content: they expose the
existence of, and counts about, workspaces the caller can already reach.

| Site | Lines | Recommendation |
|---|---|---|
| `GET /backend/workspaces` | `server/index.cjs:8900` | **Subtree-down — ship first, before any nesting UI.** Today it returns only workspaces you own or are a direct member of. A child you can reach by id but cannot see in the list is exactly the broken half-state to avoid. Add descendants of every workspace you are a member of. |
| `handleWorkspaces` | `netlify/functions/backend.mjs:888` | **Subtree-down.** Byte-for-byte the same rule; these two queries are already near-identical and must stay so. |
| `appendWorkspaceAccessClause` | `shared/backend-core.cjs:931`, `server/index.cjs:1600` | **Subtree-down, in step with the two above.** This gates the generic `select * from workspaces`. If it and `/backend/workspaces` disagree, one path shows a workspace the other hides. |
| `GET /backend/workspace/:id/usage` | `server/index.cjs:9074` (13 refs) | **Subtree-down, with the own-workspace figure kept separate.** Billing and quota questions are asked about the group. Return `{ own, subtree }` rather than silently changing what the existing number means. |
| `handleWorkspaceUsage` | `netlify/functions/backend.mjs:943` (13 refs) | **Subtree-down.** Parity. |
| `buildInboxSql` | `server/index.cjs:2838` | **Subtree-down.** The inbox is "addressed to YOU"; a mention in a client workspace must reach an agency member's inbox or the feature is useless in a group. |
| `GET /backend/workspaces/:workspaceId/inbox` | `server/index.cjs:9523` | **Subtree-down**, following `buildInboxSql`. Carry the source workspace on each row so the UI can label it. |
| `POST /backend/inbox/read` | `server/index.cjs:9555` | **Subtree-down.** Read markers are keyed `(user, workspace, context)` — the marker must be written against the row's OWN workspace, not the one the request addressed, or "mark all read" in a parent silently marks nothing. |
| `GET /backend/workspaces/:id/my-threads` | `server/index.cjs:9654` | **Subtree-down.** Same reasoning as the inbox. |
| `buildAgentActivityDigest` | `server/index.cjs:3929` | **Subtree-down** for a parent's activity feed; the digest an agent receives stays scoped to its own workspace. |
| `GET /backend/workspaces/:id/agent-registrations` | `server/index.cjs:10670` | **Subtree-down.** Approving a daemon is an admin action and belongs on the group's screen. |
| `POST /backend/files/upload` — quota query | `server/index.cjs:8415` | **Decide, then be explicit.** `WORKSPACE_STORAGE_QUOTA_BYTES` currently means per workspace; under nesting a group could multiply its quota by creating children. Recommend charging the **subtree root**. |

---

## = UNCHANGED — 17 entries that must NOT gain subtree semantics

These are load-bearing. Relaxing any of them is how one client's content
reaches another; several would be a silent leak with no error to notice.

| Site | Lines | Why it must stay exact |
|---|---|---|
| `resolveOperationWorkspace` | `shared/backend-core.cjs:513`, `server/index.cjs:357` | Must keep resolving a row to **exactly one** workspace. Widening it to "somewhere in the subtree" removes the anchor everything else authorizes against. |
| `assertUpdateKeepsTenancy` | `shared/backend-core.cjs:790` | Compares the target workspace for **equality** on purpose. An ancestor-or-descendant match here would let a row be moved from one client to another under one manager's authority. |
| `enforceDbOperationAccess` — the per-row loop | `shared/backend-core.cjs:849` | Authorizes each row's own workspace. The *capability check* now honours ancestors; the *row scoping* must not. |
| `storagePathBelongsToWorkspace` | `shared/backend-core.cjs:329` | Prefix check against one workspace id. A subtree version reintroduces the traversal class it was written to close. |
| `storagePathFor` / `resolveStoragePathForWorkspace` | `server/index.cjs:6416`, `:6430` | Uploads stay under their own workspace prefix. |
| `buildWorkspaceBootstrap` — sessions, documents, tasks, files, memory slices | `server/index.cjs:2703`–`2744` | Content. Five separate queries, all `where workspace_id = $1`; each one is a leak if widened. The agents slice above is the **only** one that changes. |
| `GET /backend/workspaces/:id/bootstrap` | `server/index.cjs:9121` | Snapshot of one workspace. |
| `notifyDbSubscribers` / `sanitizeRealtimeRow` | `server/index.cjs:7488`, `:7475` | Realtime fanout stays per workspace. A parent member subscribed to the group must not receive live child content rows. |
| `workspaceIdFromRealtimeChannel`, `authorizeRealtimeBinding`, `authorizeRealtimeBroadcast` | `server/index.cjs:7693`, `:7701`, `:7731` | Channel names are workspace-scoped identifiers, not tree queries. (The `enforceWorkspaceRole` inside them now honours ancestors — that is the correct and sufficient change.) |
| `workspaceSessionCacheGet` / `Set` | `server/index.cjs:7138`, `:7146` | Cache keyed by workspace. A subtree key would serve one tenant another's cached sessions. |
| `logMessageActivity` / `logMessageActivityIdempotent` / `logConnectionActivity` | `server/index.cjs:7189`, `:7235`; `shared/backend-core.cjs:970` | An event is stamped with the workspace it happened in. Roll up at read time (see the digest above), never at write time. |
| `mirrorAgentReplyToTaskComment` | `server/index.cjs:3335` | Task and comment are in the same workspace, always. |
| `runAgentTurn` | `server/index.cjs:4299` (15 refs) | Every message, job and thread-item write stamps the **session's** workspace. An inherited agent does not move the conversation into its own workspace. |
| `finalizeAgentJobResult`, `handleAgentJobDelta` / `Step` / `Segment` | `server/index.cjs:5531`, `:5964`, `:6109`, `:6198` | Job rows belong to the workspace that dispatched them. |
| `git/*` routes and `GET /backend/workspaces/:id/project-files` | `server/index.cjs:8524`, `:8634`, `:8676`, `:8752`, `:8765`, `:8778` | `workspaces.local_path` / `git_root` are per-workspace. There is no group-level checkout. |
| `enqueueFlowWebhookEvents`, flow-connection store | `server/index.cjs:7352`, `:1449` | Outbound integrations are per workspace; a group-wide fan-out would post one client's events to another's endpoint. |
| Huddles (`server/huddles.cjs`), `feedback_reports`, `thread_items`, `document_comments`, `task_comments`, `activity_event_comments` | table-scoped throughout | Content. |

---

## Sequencing, if this ships

1. `GET /backend/workspaces` + `handleWorkspaces` + `appendWorkspaceAccessClause`
   — all three together. Without them a child is unreachable in the UI; with only
   some of them the two read paths disagree.
2. Agents (`↑`), including the bootstrap slice and handle resolution — this is
   what makes a child workspace useful rather than empty.
3. Members (`↑`), with inherited rows visibly marked and not editable in place.
4. Credentials (`↑`), or inherited agents cannot make a call.
5. Rollups (`↓`): inbox, my-threads, usage, registrations.
6. Nesting UI last.

## Test coverage this sweep will need

`tests/workspace-nesting.test.cjs` already asserts the authorization direction
(sibling denied, parent denied from a child, grandchild denied upward) and the
cycle guards; `tests/unit/workspaceTree.test.ts` covers the pure traversals.
Each item above needs its own negative test in the same shape — for every site
moved to `↑` or `↓`, a test that a **sibling** workspace still cannot reach it.
