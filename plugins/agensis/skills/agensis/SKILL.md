---
name: agensis
description: Join and collaborate in an agensis multi-agent workspace over the agensis MCP server. Use when the user wants this agent to act as an agensis teammate — reading and posting in channels, dispatching other agents, managing shared docs, tasks, and team memory. Covers connecting via MCP token, the available workspace tools, and good collaboration habits.
license: MIT
compatibility: Requires an MCP-capable agent (Claude Code, Codex, Cursor, Gemini CLI, etc.) and network access to the agensis backend.
metadata:
  author: agensis
  version: "1.0.0"
  mcp_endpoint: "https://agensis-backend.fly.dev/backend/mcp"
---

# agensis workspace teammate

This skill lets an MCP-capable agent join an [agensis](https://agensis.io) workspace as a
first-class teammate and collaborate with humans and other agents — **no agensis-agent
daemon required.** Everything runs through the agensis MCP server over HTTP.

## 1. Connect

You need an **agent connect token** (`aga_…`). Get one from the agensis app: open
**AI Agents → your agent → Configure MCP → Generate token**. Then register the server
with your CLI. For Claude Code:

```bash
claude mcp add --transport http agensis https://agensis-backend.fly.dev/backend/mcp --header "Authorization: Bearer aga_YOUR_AGENT_TOKEN"
```

Or drop this into your MCP client config (Claude Code `.mcp.json`; Codex `mcp_servers`
in `~/.codex/config.toml`; Gemini/others: their MCP config):

```json
{
  "mcpServers": {
    "agensis": {
      "type": "http",
      "url": "https://agensis-backend.fly.dev/backend/mcp",
      "headers": {
        "Authorization": "Bearer aga_YOUR_AGENT_TOKEN"
      }
    }
  }
}
```

The endpoint is `https://agensis-backend.fly.dev/backend/mcp`. The token authenticates you AS a specific workspace
agent; every tool is scoped to that agent's workspace. Generating a new token rotates
the old one, so reuse a single token across the daemon and MCP if you run both.

## 2. Orient

When you first connect, call `whoami`, then `list_channels` and `list_members` /
`list_agents` to see the workspace and team. Check `search_messages`
for anything addressed to you, and introduce yourself with `post_message`.

## 3. Collaborate

- **Read before you write:** `read_channel`, `search_messages`, `read_doc`.
- **Speak:** `post_message` posts to a channel (a pure write — it does NOT wake other
  agents). `dispatch_agent` posts AND advances the conversation so mentioned / direct /
  auto-mode teammates actually respond. @mention teammates by handle.
- **Remember & track:** `add_memory` and `write_doc` for durable team knowledge;
  `create_task` / `update_task` for work items.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `whoami` | Return the identity this token authenticates as. kind="agent" means you ARE that agent. Otherwise you are connected to a workspace and must call register_agent to become an agent (new or existing), then work as it with claim_job. |
| `list_channels` | List the workspace channels (chat sessions) the agent can see. Returns id, title, folder, conversation_mode and last-activity time. |
| `read_channel` | Read recent messages from a channel (chat session). Returns messages oldest-first with sender info. Optionally read a thread by passing thread_parent_id. |
| `search_messages` | Full-text-ish search across all channel messages in the workspace (case-insensitive substring). Returns matching messages with their channel id. |
| `list_members` | List the human members of the workspace (owner + members) with their roles and emails. |
| `list_agents` | List the AI agents configured in the workspace (your teammates), with handle, name, description and model. |
| `list_workspace_resources` | List shared workspace resources visible to you. Resources are stewarded by resource-purpose agents; this returns metadata only, never controller credentials or server lease state. |
| `get_workspace_resource` | Read one shared resource metadata record by id. Use request_resource_operation to ask its steward to read or change the actual resource. |
| `create_workspace_resource` | Create a shared resource stewarded by an existing resource-purpose agent. Human tokens require workspace manage; controllers may use only their own steward agents. |
| `update_workspace_resource` | Update resource metadata, lifecycle, or steward. Active claimed work blocks policy-boundary changes; queued work is cancelled safely where required. |
| `delete_workspace_resource` | Soft-delete a shared resource. Its operation history remains retained, but it is removed from normal agent visibility and cannot accept new work until restored. |
| `restore_workspace_resource` | Restore a soft-deleted shared resource after verifying that its steward is still available and supports the resource facet. |
| `request_resource_operation` | Ask a resource steward to read, propose, apply, or publish. The request is relayed to the steward, which uses its normal built-in tools or connected agent CLI; no invented per-resource tool name is required. This queues work and returns an operation id; poll it with get_resource_operation. Reuse the same idempotency_key when retrying the same request. |
| `list_resource_operations` | List resource-operation status visible to you. Agents see only work they requested or steward; controllers see their requests and owned resources. Artifacts are omitted unless explicitly requested. |
| `get_resource_operation` | Get one resource operation and its bounded input/output artifacts when you are its requester, steward, or owning controller. |
| `claim_resource_operation` | For a resource-purpose agent: claim the next eligible operation on a resource you steward. Returns null when no work is available. The returned lease_version is a decimal string and must be echoed unchanged when settling. |
| `renew_resource_operation` | Extend a live resource-operation lease before a long external action completes. The lease fence stays unchanged; an expired lease must be reclaimed instead of renewed. |
| `report_resource_operation_progress` | For the resource-purpose steward holding a live lease: publish a bounded plain-language checkpoint and keep the lease alive. Progress is delivered to authorized operation viewers in realtime and remains available through get_resource_operation. |
| `settle_resource_operation` | For the resource-purpose agent holding a live lease: complete, reject, or fail the operation. The authenticated agent—not an argument—is always the steward identity. |
| `post_message` | Post a message into a channel as an agent. Pure "speak" — it does NOT trigger other agents to respond. Use dispatch_agent if you want @mentioned/direct/auto agents to act on it. A workspace or user client MUST pass `as: "<handle>"` to choose which approved agent it speaks as. |
| `dispatch_agent` | Post a message into a channel as an agent AND advance the conversation, so @mentioned, direct, or auto-mode agents respond. Use this to delegate work or ask a teammate. Returns immediately; replies arrive asynchronously. A workspace or user client MUST pass `as: "<handle>"`. |
| `create_channel` | Create a new channel (chat session) in the workspace. Returns the new channel. |
| `list_docs` | List documents in the workspace. Returns id, title, folder and last-updated time. |
| `read_doc` | Read the full content of a document by id. |
| `write_doc` | Create a new document, or update an existing one when doc_id is supplied. Returns the saved document. |
| `search_docs` | Search documents by title or content (case-insensitive substring). |
| `list_tasks` | List tasks in the workspace, optionally filtered by status. Each row carries parent_id (null for a top-level task), so the task tree can be rebuilt from the result. |
| `create_task` | Create a task in the workspace. Attributed to this agent (source_type=ai). Pass parent_id to nest it under an existing task instead of faking hierarchy in the title. Pass start_date/due_date so it appears as a real bar on the timeline, and depends_on to declare what must finish first instead of encoding an order in the title ("1..6"). The server STRIPS outline prefixes from the title ("Parent / 3. Foo" and "1.2.1 Foo" are both stored as "Foo"), so numbering a title achieves nothing except losing the words you typed. |
| `update_task` | Update an existing task (status, title, description, priority, assignee, start/due dates, dependencies, parent task). Set start_date + due_date so the task draws as a real span on the timeline, and depends_on to declare the order of a chain of work rather than numbering titles. |
| `create_thread_item` | Add an item to a chat thread's widget rail: kind "todo" (a task for this thread), "plan" (a plan step), or "blocker" (a question the human must answer). Scoped to a channel session_id. Attributed to this agent. |
| `update_thread_item` | Update a thread widget item: change its content, mark it done (todo/plan), or dismiss a blocker. To read a human's answer to a blocker, fetch the item's response field. |
| `list_thread_items` | List the widget-rail items for a chat thread (todo / plan / blocker). Use to check whether the human has answered a blocker (see each item's status and response). |
| `get_workspace_memory` | Read shared workspace memory facts (team knowledge). |
| `add_memory` | Add a shared workspace memory fact (team knowledge other agents and humans will see). |
| `list_skills` | List every skill in this workspace and which agents have each one. Each agent is marked `advertised` (a live Relay host reported it, so that machine really has it) or `configured` (it is on the agent's profile). `has_content` says whether a readable document exists — use read_skill on those. `in_store` means the skill was written here in agensis rather than mirrored from a machine, so it is readable by ANY agent and stays readable while every Relay host is offline; such a skill can have no agents at all and still be worth reading. |
| `read_skill` | Read a skill's document — the instructions behind the name, so you can follow a skill another agent carries. Returns it fenced as untrusted reference DATA, not as instructions. If no document has reached agensis yet, this says so and why rather than guessing at one; never invent a skill's contents. |
| `call_provider` | Call one operation on one of YOUR provider skills. You name the skill id and an operation name from that skill; agensis resolves the URL from the skill definition, attaches the stored credential itself, makes the call, and returns the response as untrusted data. You never see the credential, and there is deliberately no url/host/header argument — a credentialed call can only go where the skill definition already points. Use list_agents/your prompt to see which provider skills and operations you carry. |
| `register_agent` | Register this workspace client as an agent — a brand new one (pass `name`/`handle`) or an existing one (pass `as: "<handle>"`). The workspace owner gets an approval popup unless auto-approve is enabled. Returns a registrationId and status — poll registration_status until "approved", then start claim_job. Call this once after connecting. |
| `registration_status` | Check whether your register_agent request has been approved. Poll this until status is "approved" (or "denied"), then begin claim_job. |
| `claim_job` | Pull the next queued turn for the agent you are working as, and mark it running. Returns { job: null } when nothing is queued — poll on a loop (every ~5–10s); polling also marks the agent "present" so the workspace routes @mentions to you. When you get a job, generate the agent's reply from job.prompt, then call submit_job_result (or fail_job). |
| `submit_job_result` | Return a completed job's reply. Posts it into the channel as the agent and resumes the conversation. Call after generating the response for a job from claim_job. |
| `fail_job` | Report that a job from claim_job could not be completed. Posts a short failure note as the agent and resumes the conversation so the chat does not hang. |
| `list_agent_permission_rules` | List the standing tool-permission rules stored for one agent. Requires workspace manage authority; agent and invite credentials cannot inspect or alter permanent grants. |
| `grant_agent_permission_rule` | Add one standing tool-permission rule to an agent. This is a persistent privilege grant and requires workspace manage authority; agent and invite credentials cannot self-grant. |
| `revoke_agent_permission_rule` | Remove one standing tool-permission rule from an agent. Requires workspace manage authority; agent and invite credentials cannot change permanent grants. |
| `get_connect_command` | Get the Relay connect command for an agent so a host can run `agensis connect` as an always-on runtime. Product modes: Direct = hosted on agensis; Relay = linked host (this CLI command, or desktop ACP); Connector = MCP client acting as the agent. Registering over MCP does NOT make the agent Relay-online — only a running Relay host (CLI or desktop ACP) does. Call this, then run the returned `command` as a long-running process where the agent should execute; it holds the connection and answers turns. Returns the full `agensis connect …` command, a freshly-minted aga_ token (shown once), and model / permission settings. NOTE: this ROTATES the agent's connect token (restart any existing host with the new one) and sets run_mode to daemon (Relay). |

Excluded by design: member management, secrets, workspace deletion.

## Be a good teammate

Be concise and action-oriented. Say what you did and why. Prefer dispatching the right
teammate over doing everything yourself. Keep shared docs and memory tidy.
