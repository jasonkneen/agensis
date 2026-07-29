# FB-002 — Bare workspace token enumerates the whole workspace (short report)

- **Task ID:** `16da2e77-8895-47d4-807e-ed32d4aee8ea`
- **Reporter:** "Cheers! enjoying it mate" (56bf0ff4-f573-435e-95a2-865b9c42ebe9)
- **Page:** /app — Main
- **Status:** todo → done (this writeup only; no code changed)
- **See also:** FB-006 — the same bug, reported independently in more detail by "The Oracle". Fix once, closes both.

## Original message

> 1. A bare workspace token [redacted] the entire workspace — agents, human members, all channels including which DMs exist and who's in them, document titles, skills, workspace memory. No registration, no approval.
> 2. An approved agent reads DM channels it isn't a participant of.
> 3. Write is properly gated per agent and that gate works.
> 4. Whether a bare token reads message bodies is unknown.
> it's the difference between "metadata exposure" and "reads everyone's private messages." - Cheers! enjoying it mate
>
> Page: /app — Main

## What I found in the codebase

Confirmed via `server/mcp.cjs` and `server/index.cjs`:

1. **No approval/registration gate on read tools.** `whoami`, `list_channels`, `read_channel`, `search_messages`, `list_members`, `list_agents`, `list_docs`, `read_doc`, `search_docs`, `list_tasks`, `get_workspace_memory`, `list_skills`, `read_skill` (defined across `mcp.cjs:261-1153`) all default to `kinds: CONNECTED = ['agent', 'workspace', 'user', 'invite', 'integration']` (`mcp.cjs:256-257`) and never narrow it. `verifyWorkspaceMcpToken` (`server/index.cjs:2988-2997`) mints a `kind: 'workspace'` identity from the raw token alone — no agent row, no `mcp_approved` check:
   ```js
   return { kind: 'workspace', workspaceId: ws.id, name: 'MCP client', autoApprove: Boolean(ws.mcp_auto_approve) };
   ```
   The only approval check that exists, `resolveActingAgent` (`mcp.cjs:1293-1305`, `if (!agent.mcp_approved) throw ...`), is wired only into the *write*-attribution path (`post_message`/`dispatch_agent`/`claim_job` with `as:`). None of the read tools call it, and `connectionCanUseTool` (`server/flow-integration.cjs:115-121`) is a no-op for every kind except `'integration'`. This matches point 1 and point 3 of the report exactly: writes are gated, reads are not.

2. **DM channels aren't filtered by participation.** `list_channels` (`mcp.cjs:299-321`) queries `chat_sessions where workspace_id = $1` only — `participants` is returned but never used as a filter predicate. `read_channel` (`mcp.cjs:337-342`) only checks tenancy via `assertChannelInWorkspace` (`mcp.cjs:1587-1592`), not participant membership. So even an *approved* agent can read any DM in the workspace — matching point 2 of the report.

3. **Point 4 (message bodies via a bare token) is the same root cause as point 1** — since `read_channel`/`search_messages` sit behind the same unrestricted `kinds` list, a bare token can read message bodies too, not just metadata. This is a live confirmation of what the reporter flagged as "unknown."

## Recommendation

1. Restrict `kinds` on the discovery/read tools to `['agent', 'integration']` (or add a shared `requireApprovedAgent` gate, mirroring the check in `resolveActingAgent`, applied centrally wherever tools are dispatched) — keep only `whoami`/`register_agent`/registration-status style tools open to a bare `workspace` token.
2. Add participant-membership filtering to `list_channels` (exclude/mark DMs the caller isn't in) and to `read_channel`/`search_messages` (reject DM reads for non-participants), closing points 2 and 4 in the same pass.

This is a real pre-approval data exposure — recommend treating as high priority.
