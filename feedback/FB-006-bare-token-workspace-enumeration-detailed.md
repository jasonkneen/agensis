# FB-006 — Bare workspace token enumerates the whole workspace (detailed report)

- **Task ID:** `600cb7cd-12fc-4efa-9900-67106c513ff1`
- **Reporter:** 56bf0ff4-f573-435e-95a2-865b9c42ebe9
- **Page:** /app — Main
- **Status:** todo → done (this writeup only; no code changed)
- **Duplicate of:** FB-002 — same root cause, reported independently by a different user with more reproduction detail. **Fix once, close both tasks.**

## Original message

> Expected: a credential can't read what's behind an approval step before that step.
> Actual: a workspace token with no registration and no approval enumerates the whole workspace.
> Connect an MCP client with a workspace token, never call register_agent, and these all still work: whoami, list_agents, list_channels, list_members, list_docs, list_skills, get_workspace_memory. So a bare token reveals every agent, every member, which DMs exist and who's in them, document titles, skills, and workspace memory.
> Proof of the ordering: pre-registration list_agents returned 7 agents; the same call after approval returned 8, including the one I'd just registered. list_channels at that first point already included DM channels with their participant lists.
> Also: an approved agent reads DMs it isn't part of. Mine read the Project Manager DM in full — its only listed participant is @pm.
> Not checked: whether a bare token reads message bodies. Every read_channel call I made was post-registration.
> Solo it's all my own data. With a second person it's the shape of every private conversation in the workspace.
>
> Page: /app — Main

## What I found in the codebase

(Full detail also in FB-002 — repeating here since each task gets its own file.)

1. **No approval/registration gate on read tools.** All discovery/read tools — `whoami`, `list_agents`, `list_channels`, `read_channel`, `search_messages`, `list_members`, `list_docs`, `read_doc`, `search_docs`, `list_tasks`, `get_workspace_memory`, `list_skills`, `read_skill` (`server/mcp.cjs:261-1153`) — default to `kinds: CONNECTED = ['agent', 'workspace', 'user', 'invite', 'integration']` (`mcp.cjs:256-257`) and never narrow it further. `verifyWorkspaceMcpToken` (`server/index.cjs:2988-2997`) mints a `kind: 'workspace'` identity directly from the raw token — no agent row, no `mcp_approved` check involved:
   ```js
   return { kind: 'workspace', workspaceId: ws.id, name: 'MCP client', autoApprove: Boolean(ws.mcp_auto_approve) };
   ```
   The only approval check in the codebase, `resolveActingAgent` (`mcp.cjs:1293-1305`), is wired solely into the write-attribution path (`post_message`/`dispatch_agent`/`claim_job` with `as:`) — never into any read tool. This exactly reproduces the reported before/after: `list_agents` returning 7 pre-registration and 8 post-approval is simply the tool running identically both times; only the *count of registered agents* changed in between, not any access check.

2. **DMs aren't filtered by participant membership.** `list_channels` (`mcp.cjs:299-321`) selects from `chat_sessions where workspace_id = $1` with no participant predicate — `participants` is returned in the payload but never filtered on. `read_channel` (`mcp.cjs:337-342`) is guarded only by `assertChannelInWorkspace` (`mcp.cjs:1587-1592`), which checks workspace tenancy, not participation. This is why an *approved* agent could still read the Project Manager DM despite `@pm` being its only listed participant.

3. **Message bodies are exposed too, not just metadata.** Since `read_channel`/`search_messages` sit behind the same unrestricted `kinds` check as everything else, and are also unfiltered on DM participation, the "not checked" item in the report resolves to: yes, a bare token can read message bodies, including DM contents — this isn't a metadata-only exposure.

## Recommendation

1. Restrict `kinds` on the discovery/read tools to `['agent', 'integration']` (dropping bare `workspace`/`user`/`invite` tokens from all but `whoami`/registration tools), or add a shared `requireApprovedAgent` gate applied centrally to this tool list, reusing the check already implemented in `resolveActingAgent`.
2. Add a participant-membership predicate to `list_channels` (filter/mark DM rows the caller isn't in) and enforce the same check in `read_channel`/`search_messages`.

This closes FB-002 and FB-006 together — recommend treating as one high-priority security fix, not two separate tickets.
