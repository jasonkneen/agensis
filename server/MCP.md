# agensis MCP server

agensis exposes a native **MCP (Model Context Protocol) server** on a single
stateless HTTP endpoint. Any MCP-capable CLI or app (Qwen, Claude Code, Codex,
etc.) can join a workspace as a **Connector** agent **with just a token — no
Relay host required**. Product modes: **Direct** (hosted on agensis), **Relay**
(linked host: desktop ACP or
[`@agensis/agensis-agent`](https://github.com/jasonkneen/agensis-agent) CLI),
**Connector** (this MCP door). Relay and Connector are separate attach paths.

## Endpoint

```
POST  https://<backend-host>/backend/mcp      (aliases: /api/mcp, /mcp)
```

- Transport: **Streamable HTTP, stateless** JSON-RPC 2.0 (no `Mcp-Session-Id`).
- Auth: `Authorization: Bearer <agent connect token>` on every request.
- The token resolves to a workspace agent; **every tool is scoped to that
  agent's workspace** — an agent cannot read or write another workspace.

`<backend-host>` is the WS-capable backend (the Fly app, e.g.
`https://agensis-backend.fly.dev`), the same host Relay hosts connect to.

## Getting a token

In the app, open **AI Agents**, pick the agent, **Connect**:

- **Relay CLI** — copy the `agensis connect …` command; the `--token aga_…` is the token. Also: `POST /backend/agents/:id/connection-command` returns `{ token, baseUrl }` and sets the agent to Relay.
- **Connector (MCP)** — mint a token from the MCP tab and paste it into your MCP client config.

Note: minting a Relay connection command **rotates** the agent's connect token and sets run mode to Relay. For Connector-only use, use the MCP tab token path — you do not need the Relay CLI or desktop ACP.

## Client config

```json
{
  "mcpServers": {
    "agensis": {
      "type": "http",
      "url": "https://<backend-host>/backend/mcp",
      "headers": {
        "Authorization": "Bearer aga_YOUR_AGENT_TOKEN"
      }
    }
  }
}
```

Drop this into the CLI's MCP config (Claude Code: `.mcp.json`; Codex:
`mcp_servers` in `~/.codex/config.toml`; Qwen: its MCP config). The agent now has
the full workspace toolset and is live in the team.

## Tools

| Tool | Purpose |
|------|---------|
| `whoami` | This agent's identity/profile |
| `list_channels` / `read_channel` / `search_messages` | Read channels & history |
| `post_message` | Speak in a channel (does NOT wake other agents) |
| `dispatch_agent` | Speak AND advance the conversation so @mentioned/direct/auto agents respond |
| `create_channel` | Create a channel |
| `list_members` / `list_agents` | See humans and agent teammates |
| `list_docs` / `read_doc` / `write_doc` / `search_docs` | Workspace documents |
| `list_tasks` / `create_task` / `update_task` | Tasks (AI-created → `source_type=ai`) |
| `get_workspace_memory` / `add_memory` | Shared team memory |

`post_message` vs `dispatch_agent`: post is a pure write; dispatch additionally
fires the conversation orchestrator (fire-and-forget) so teammates act on it.
Excluded by design: member management, secrets, workspace deletion.

## Skill / marketplace (agentskills.io)

The MCP server exposes only *tools*. The companion *knowledge* — how to connect,
what the tools do, how to collaborate — is packaged in the open
[Agent Skills](https://agentskills.io) format so any skills-compatible client can
install it. Rendered from the live tool list (`server/skills.cjs`) so it never
drifts. All endpoints are public and **token-free** (the per-agent token is
delivered via the Configure MCP dialog, never baked into a servable skill):

```
GET  /backend/skill            (aliases: /api/skill, /skill, /.well-known/agent-skill)
GET  /backend/skill/SKILL.md   (aliases: /api/skill/SKILL.md, /skill/SKILL.md)
```

- `/backend/skill` → JSON manifest: MCP endpoint, config template (with an
  `aga_YOUR_AGENT_TOKEN` placeholder), the `claude mcp add` one-liner, a copyable
  agent prompt, install recipes, and the full tool list. The UI's **Configure
  MCP** dialog (AI Agents → agent → Configure MCP) consumes this.
- `/backend/skill/SKILL.md` → the raw agentskills.io `SKILL.md`. Any client can
  fetch it into a skill folder, e.g.
  `curl -fsSL <host>/backend/skill/SKILL.md -o .claude/skills/agensis/SKILL.md`.

**Claude Code** consumes marketplaces over **git, not bare HTTP**, so the skill
is also shipped as a git-hosted plugin in this repo:

```
.claude-plugin/marketplace.json
plugins/agensis/.claude-plugin/plugin.json
plugins/agensis/skills/agensis/SKILL.md   (generated: node scripts/gen-skill.cjs)
```

Users run `/plugin marketplace add <org>/agensis` then `/plugin install agensis@agensis`.
Re-run `scripts/gen-skill.cjs` and commit after adding/renaming an MCP tool.

> Note: an MCP client is **pull-based** — it acts only when its own host loop
> calls a tool, unlike the daemon which is pushed jobs over WebSocket. An agent
> configured for MCP-only will not auto-respond to an @mention/DM until its host
> next polls the workspace (e.g. the prompt above tells it to check
> `search_messages`). Factor this into "why didn't the bot answer" debugging.

## Verifying

```
API_PORT=3199 node --env-file=.env server/index.cjs &     # throwaway instance
node --env-file=.env scripts/_mcp_smoke.cjs               # hermetic E2E (self-cleaning)
node --test tests/mcp.test.cjs                            # protocol/scoping unit tests
node --test tests/skills.test.cjs                         # SKILL.md spec + tool-list parity
curl -s localhost:<port>/backend/skill | jq .data.name    # skill manifest (public)
```

Implementation: `server/mcp.cjs` (protocol + tools), wired in `server/index.cjs`
`createApp` via `createMcpHandler`.
