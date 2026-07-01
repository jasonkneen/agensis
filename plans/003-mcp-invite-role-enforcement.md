# Plan 003: Enforce invite role on MCP write tools

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2e41d3..HEAD -- server/index.cjs server/mcp.cjs`
> If either file changed since this plan was written, compare the excerpts below against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

Workspace owners can mint an MCP invite scoped to an explicit role — `admin`, `editor`,
`commenter`, or `viewer` (`server/index.cjs:4442-4443`) — expecting `viewer`/`commenter` invites to
grant read-only or comment-only access. But `verifyInviteToken` never reads or propagates the
invite's `role` column, and `server/mcp.cjs`'s write-capable tools (`write_doc`, `create_task`,
`update_task`, `add_memory`, `create_channel`) check only `identity.workspaceId`, never a
capability. The equivalent HTTP routes (`/backend/db/*`) already enforce this correctly via
`enforceDbOperationAccess`, mapping insert/update/delete to the `write` capability a `viewer` role
lacks — so the exact same operation is blocked over HTTP but wide open over MCP with the identical
invite token. Anyone who shares a "read-only" invite link has, in practice, handed out full write
access to documents, tasks, memory, and channels — with no way to detect or prevent it from the UI,
since this is an MCP-only surface.

## Current state

**`server/index.cjs:1223-1238`** — `verifyInviteToken` does not select `role`:

```js
// The SAME invite link a human accepts can be used by an MCP client as its Bearer.
// It grants workspace access; the client then works AS an agent (claim_job { as }).
async function verifyInviteToken(token) {
  if (!token || typeof token !== 'string') return null;
  const rows = await getDb().unsafe(
    `select id, workspace_id, email from workspace_invites
      where token = $1 and status in ('pending', 'accepted')
        and (expires_at is null or expires_at > now())
      limit 1`,
    [token],
  );
  const invite = rows[0];
  if (!invite) return null;
  // An invite link is pre-authorization → a client joining through it is auto-approved.
  return { kind: 'invite', workspaceId: invite.workspace_id, inviteId: invite.id, name: invite.email || 'MCP client', autoApprove: true };
}
```

**`server/index.cjs:689-702`** — the `workspace_invites` table confirms `role` is a real column
with a checked, meaningful value set:

```sql
CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  email text DEFAULT '',
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'commenter', 'viewer')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  ...
```

**`server/mcp.cjs:76-86`** — the tool-kind gate has no role/capability dimension at all:

```js
function buildTools() {
  const tools = [];
  // A tool's `kinds` lists which identities may call it. Identity kinds:
  //   'agent'     — a per-agent connect token; you ARE that agent.
  //   'workspace' — the one workspace MCP token.
  //   'user'      — your agensis login.
  //   'invite'    — an invite link (auto-approve).
  // The last three authenticate INTO a workspace; you then register_agent to become an
  // agent. Default kinds = everything that can act in a workspace. Handler enforces it.
  const CONNECTED = ['agent', 'workspace', 'user', 'invite'];
  const add = (def) => tools.push({ kinds: CONNECTED, ...def });
```

**`server/mcp.cjs:392-436`** (`write_doc`) is representative of the gap — its `run(args, { db,
identity, deps })` handler only ever reads `identity.workspaceId`, never a role/capability:

```js
async run(args, { db, identity, deps }) {
  const docId = typeof args?.doc_id === 'string' && args.doc_id.trim() ? args.doc_id.trim() : null;
  ...
  const rows = await db.unsafe(
    `insert into documents (workspace_id, title, content, folder)
     values ($1, $2, $3, $4) returning *`,
    [identity.workspaceId, title, content || '', folder]);
  ...
}
```

`create_task`/`update_task` (~mcp.cjs:490-569), `add_memory` (~mcp.cjs:600-621), and
`create_channel` (~mcp.cjs:315-340) follow the identical pattern — no capability check.

For contrast, the HTTP path that already does this correctly: `server/index.cjs`'s
`enforceDbOperationAccess` (used by `/backend/db/*`) maps write operations (insert/update/delete)
to a `write` capability, and the workspace-role ACL (`server/index.cjs:275-279` area — the
`role → capabilities` table) does not grant `write` to `viewer`. Use that same ACL/capability
lookup for this fix rather than inventing a new one.

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Typecheck        | `npm run typecheck`               | exit 0, no errors                |
| Lint             | `npm run lint`                    | 0 errors                          |
| Node test suite  | `npm test`                        | all pass (baseline 119)          |

## Scope

**In scope** (the only files you should modify):
- `server/index.cjs` (`verifyInviteToken`, ~line 1225)
- `server/mcp.cjs` (the tool dispatch/`buildTools` area, and each write-capable tool's `run()`)
- `tests/mcp.test.cjs` or a new `tests/mcp-invite-role.test.cjs` (see Test plan)

**Out of scope** (do NOT touch, even though they look related):
- The `agent`/`workspace`/`user` identity kinds' authorization — these already resolve to either a
  specific agent (full access to its own actions), the single workspace-wide MCP token (already
  effectively admin-equivalent by design), or a logged-in user's own account (already gated by
  that user's real workspace role elsewhere) — this plan is scoped to the `invite` kind only, where
  the role information exists but is dropped.
- Read-only MCP tools (`list_docs`, `read_doc`, `list_tasks`, `whoami`, `list_channels`,
  `read_channel`, `search_messages`, `search_docs`, `list_members`, `list_agents`,
  `get_workspace_memory`) — these should remain accessible to all invite roles including `viewer`,
  matching the read capability every role has. Do not add a role check to these.
- `register_agent`/`claim_job`/`submit_job_result`/`fail_job`/`dispatch_agent`/`registration_status`
  /`get_connect_command` — these are about *becoming* or *acting as* an agent, a different
  authorization dimension from document/task/memory/channel writes; out of scope for this plan.

## Steps

### Step 1: Propagate the invite's role into its identity

In `verifyInviteToken` (`server/index.cjs:1225-1238`), add `role` to the `select` and to the
returned identity object:

```js
async function verifyInviteToken(token) {
  if (!token || typeof token !== 'string') return null;
  const rows = await getDb().unsafe(
    `select id, workspace_id, email, role from workspace_invites
      where token = $1 and status in ('pending', 'accepted')
        and (expires_at is null or expires_at > now())
      limit 1`,
    [token],
  );
  const invite = rows[0];
  if (!invite) return null;
  return { kind: 'invite', workspaceId: invite.workspace_id, inviteId: invite.id, name: invite.email || 'MCP client', autoApprove: true, role: invite.role };
}
```

**Verify**: a unit/integration test (see Test plan) confirms an identity resolved from a `viewer`
invite has `identity.role === 'viewer'`.

### Step 2: Pass the existing capability-check function into the MCP handler's `deps`

The role→capability lookup already exists at `server/index.cjs:386-388`:

```js
function roleHasWorkspaceCapability(role, capability) {
  return Boolean(WORKSPACE_ROLE_CAPABILITIES[role]?.has(capability));
}
```

This is exactly what's needed: it takes a role string directly (no DB lookup), which matches
`identity.role` from Step 1. Note `enforceWorkspaceRole` (already in `deps`, `server/index.cjs:4146`)
is **not** the right function to reuse here — it takes a `userId` and looks up the role via a DB
query, but invite identities have no `userId`, only the `role` string already resolved onto the
identity. Use `roleHasWorkspaceCapability` directly instead.

In `server/index.cjs`, where `createMcpHandler({...})` is called (~line 4134), add
`roleHasWorkspaceCapability` to the `deps` object:

```js
const mcpHandler = createMcpHandler({
  getDb,
  verifyMcpToken,
  continueConversation,
  notifyDbSubscribers,
  slugHandle,
  claimMcpJob,
  submitMcpJobResult,
  resolveWorkspaceAgentByHandle,
  registerAgentRequest,
  getRegistrationStatus,
  getAgentConnectionCommand: buildAgentConnectionCommand,
  enforceWorkspaceRole,
  roleHasWorkspaceCapability, // add this line
  rateLimiter: mcpRateLimiter,
  rateLimitBlocked,
  runtimeSchemaReady,
  serverVersion: '1.0.0',
});
```

**Verify**: `grep -n "roleHasWorkspaceCapability" server/index.cjs` shows both the function
definition (~line 386) and its new appearance in the `createMcpHandler({...})` call (~line 4134+).

### Step 3: Gate the five write-capable tools

For each of `write_doc`, `create_task`, `update_task`, `add_memory`, `create_channel` in
`server/mcp.cjs`: at the top of each tool's `run(args, { db, identity, deps })`, when
`identity.kind === 'invite'`, call `deps.roleHasWorkspaceCapability(identity.role, 'write')` and
throw a `ToolError` (the same error class already used elsewhere in this file, e.g. `write_doc`'s
`'Document not found in this workspace'` throw) with a message like `'This invite is read-only and
cannot create or modify documents'` if it returns false. Do **not** add this check for
`identity.kind !== 'invite'` — other identity kinds are out of scope (see Scope section).

**Verify**: manually trace one tool (`write_doc`) end-to-end: an identity with
`{kind:'invite', role:'viewer'}` calling `write_doc` throws before reaching the `insert`/`update`
SQL (`roleHasWorkspaceCapability('viewer', 'write')` → `WORKSPACE_ROLE_CAPABILITIES.viewer` is
`new Set(['read'])`, so this returns `false`); an identity with `{kind:'invite', role:'editor'}`
reaches the SQL as before (`editor`'s capability set includes `'write'`).

## Test plan

Add to `tests/mcp.test.cjs` (matching its existing structure — it already tests tool registration
and dispatch against a mock/real DB, per the recon) or a new `tests/mcp-invite-role.test.cjs`
following that same pattern:

- A `viewer`-role invite identity calling `write_doc` (create path, no `doc_id`) is rejected before
  any DB write occurs.
- A `commenter`-role invite identity calling `create_task` is rejected.
- An `editor`-role invite identity calling `write_doc` still succeeds (no regression for the
  intended-write case).
- An `admin`-role invite identity calling `add_memory` still succeeds.
- A `viewer`-role invite identity calling a read-only tool (`list_docs` or `read_doc`) still
  succeeds (confirms the fix didn't over-broadly block reads).

Verification: `npm test` → all pass, including these new cases, no regressions in the 119-test
baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including the new invite-role test cases
- [ ] `grep -n "role: invite.role" server/index.cjs` shows the propagation in `verifyInviteToken`
- [ ] Each of `write_doc`/`create_task`/`update_task`/`add_memory`/`create_channel` in
      `server/mcp.cjs` has a capability check gated on `identity.kind === 'invite'`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- No existing role→capability lookup function can be found/reused — do not invent a second,
  parallel capability table; report back so the two lookups can be reconciled deliberately instead
  of by accident.
- The `mcp.cjs` tool `run()` signature doesn't actually receive enough context (e.g. no `deps`
  object, no way to reach `server/index.cjs`'s functions) to perform the capability check without a
  larger wiring change than this plan anticipates.
- Any existing test in `tests/mcp*.test.cjs` starts failing after adding the role checks (would
  indicate an existing test relies on invite-kind identities having unconditional write access —
  confirm that's not an intentional, documented behavior before "fixing" it away).

## Maintenance notes

- Any *new* write-capable MCP tool added in the future must remember to add this same
  `identity.kind === 'invite'` capability check — there's no structural guarantee (e.g. a wrapper)
  enforcing it automatically. Consider, as a fast follow (not part of this plan), wrapping write
  tools in a small `requireCapability('write')` helper at registration time (in `buildTools`'s
  `add()` function) instead of repeating the check in each `run()`, so future tools inherit it by
  construction.
- This plan does not change behavior for the `agent`/`workspace`/`user` identity kinds — if a
  future review decides those need finer-grained capability checks too, that's a separate,
  larger-scoped plan.
