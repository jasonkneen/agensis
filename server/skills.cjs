'use strict';

// Skill / marketplace surface for agensis.
//
// agensis exposes its workspace toolset over a native MCP server (server/mcp.cjs).
// This module renders the *companion knowledge* an agent needs to USE that MCP
// well, packaged in the open Agent Skills format (https://agentskills.io) so any
// skills-compatible client (Claude Code, Codex, Cursor, Gemini CLI, Goose, ...)
// can install it.
//
// Three deliverables, all derived from the live MCP tool list so they can never
// drift from the real server:
//   - renderSkillMd()   -> a valid agentskills.io SKILL.md (frontmatter + body)
//   - buildAgentPrompt() -> a copyable onboarding prompt for the agent
//   - skillManifest()   -> JSON discovery doc (name/description + install recipes)
//
// IMPORTANT: nothing here embeds a per-agent secret. The skill is generic and
// publicly servable; the agent's Bearer token is delivered separately via the
// "Configure MCP" dialog (which mints it through the existing connection-command
// endpoint). The skill TELLS the agent/operator how to wire the token in.

const { listToolSummaries, SERVER_NAME } = require('./mcp.cjs');

const SKILL_NAME = 'agensis';
const SKILL_VERSION = '1.0.0';
const DEFAULT_MCP_PATH = '/backend/mcp';
// Placeholder shown wherever a real agent token belongs. The Configure MCP
// dialog substitutes the freshly-minted token in its place.
const TOKEN_PLACEHOLDER = 'aga_YOUR_AGENT_TOKEN';

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

// Build the canonical MCP endpoint URL from a backend base URL.
function mcpEndpoint(baseUrl, mcpPath = DEFAULT_MCP_PATH) {
  const base = trimTrailingSlash(baseUrl);
  const path = mcpPath.startsWith('/') ? mcpPath : `/${mcpPath}`;
  return `${base}${path}`;
}

// The ready-to-paste MCP client config (the shape every MCP CLI accepts).
function configBlock(baseUrl, token = TOKEN_PLACEHOLDER, mcpPath = DEFAULT_MCP_PATH) {
  return {
    mcpServers: {
      [SERVER_NAME]: {
        type: 'http',
        url: mcpEndpoint(baseUrl, mcpPath),
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

// The `claude mcp add` one-liner — cleaner than hand-editing .mcp.json.
function claudeMcpAddCommand(baseUrl, token = TOKEN_PLACEHOLDER, mcpPath = DEFAULT_MCP_PATH) {
  return `claude mcp add --transport http ${SERVER_NAME} ${mcpEndpoint(baseUrl, mcpPath)} --header "Authorization: Bearer ${token}"`;
}

// A copyable prompt the operator pastes into their agent (or sets as its system
// prompt) so it knows it is now part of an agensis team and how to behave.
function buildAgentPrompt({ name, handle, baseUrl, mcpPath = DEFAULT_MCP_PATH } = {}) {
  const tools = listToolSummaries();
  const displayName = (name && String(name).trim()) || 'a named agent';
  const displayHandle = (handle && String(handle).trim()) || 'your-handle';
  const toolNames = tools.map((t) => t.name).join(', ');
  return [
    `You are ${displayName} (@${displayHandle}), a member of an agensis workspace — a shared, multi-agent collaboration space with human teammates and other AI agents.`,
    '',
    `You are connected to the workspace through the "${SERVER_NAME}" MCP server (${mcpEndpoint(baseUrl, mcpPath)}). All workspace actions go through its tools.`,
    '',
    'On joining, do this in order:',
    '1. Call whoami to confirm your identity, then list_channels and list_members / list_agents to see the workspace and who is on the team.',
    '2. Call list_mentions (or search_messages) to catch up on anything addressed to you.',
    '3. Introduce yourself briefly in the most relevant channel with post_message.',
    '',
    'While working:',
    '- Read before you write: use read_channel / search_messages / read_doc for context.',
    '- Use post_message to speak in a channel. Use dispatch_agent when you want your message to actively wake a mentioned, direct, or auto-mode teammate so they respond.',
    '- @mention teammates by handle to bring them in.',
    '- Record durable team knowledge with add_memory and write_doc; track work with create_task / update_task.',
    '',
    `Every tool is scoped to your workspace. Available tools: ${toolNames}.`,
    'Be a good teammate: concise, action-oriented, and transparent about what you did.',
  ].join('\n');
}

// Render the agentskills.io SKILL.md (frontmatter + Markdown body). `name` must
// stay valid per the spec: <=64 chars, lowercase a-z/0-9/hyphens, no leading,
// trailing, or doubled hyphens. `description` must be 1-1024 chars.
function renderSkillMd({ baseUrl, mcpPath = DEFAULT_MCP_PATH } = {}) {
  const tools = listToolSummaries();
  const endpoint = mcpEndpoint(baseUrl, mcpPath);
  const description =
    'Join and collaborate in an agensis multi-agent workspace over the agensis MCP server. '
    + 'Use when the user wants this agent to act as an agensis teammate — reading and posting in channels, '
    + 'dispatching other agents, managing shared docs, tasks, and team memory. '
    + 'Covers connecting via MCP token, the available workspace tools, and good collaboration habits.';

  const toolTable = tools
    .map((t) => `| \`${t.name}\` | ${t.description.replace(/\|/g, '\\|')} |`)
    .join('\n');

  const config = JSON.stringify(configBlock(baseUrl, TOKEN_PLACEHOLDER, mcpPath), null, 2);

  const frontmatter = [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${description}`,
    'license: MIT',
    'compatibility: Requires an MCP-capable agent (Claude Code, Codex, Cursor, Gemini CLI, etc.) and network access to the agensis backend.',
    'metadata:',
    '  author: agensis',
    `  version: "${SKILL_VERSION}"`,
    `  mcp_endpoint: "${endpoint}"`,
    '---',
  ].join('\n');

  const body = [
    '',
    `# agensis workspace teammate`,
    '',
    'This skill lets an MCP-capable agent join an [agensis](https://agensis.io) workspace as a',
    'first-class teammate and collaborate with humans and other agents — **no agensis-agent',
    'daemon required.** Everything runs through the agensis MCP server over HTTP.',
    '',
    '## 1. Connect',
    '',
    'You need an **agent connect token** (`aga_…`). Get one from the agensis app: open',
    '**AI Agents → your agent → Configure MCP → Generate token**. Then register the server',
    'with your CLI. For Claude Code:',
    '',
    '```bash',
    claudeMcpAddCommand(baseUrl, TOKEN_PLACEHOLDER, mcpPath),
    '```',
    '',
    'Or drop this into your MCP client config (Claude Code `.mcp.json`; Codex `mcp_servers`',
    'in `~/.codex/config.toml`; Gemini/others: their MCP config):',
    '',
    '```json',
    config,
    '```',
    '',
    `The endpoint is \`${endpoint}\`. The token authenticates you AS a specific workspace`,
    'agent; every tool is scoped to that agent\'s workspace. Generating a new token rotates',
    'the old one, so reuse a single token across the daemon and MCP if you run both.',
    '',
    '## 2. Orient',
    '',
    'When you first connect, call `whoami`, then `list_channels` and `list_members` /',
    '`list_agents` to see the workspace and team. Check `list_mentions` / `search_messages`',
    'for anything addressed to you, and introduce yourself with `post_message`.',
    '',
    '## 3. Collaborate',
    '',
    '- **Read before you write:** `read_channel`, `search_messages`, `read_doc`.',
    '- **Speak:** `post_message` posts to a channel (a pure write — it does NOT wake other',
    '  agents). `dispatch_agent` posts AND advances the conversation so mentioned / direct /',
    '  auto-mode teammates actually respond. @mention teammates by handle.',
    '- **Remember & track:** `add_memory` and `write_doc` for durable team knowledge;',
    '  `create_task` / `update_task` for work items.',
    '',
    '## Tools',
    '',
    '| Tool | Purpose |',
    '| ---- | ------- |',
    toolTable,
    '',
    'Excluded by design: member management, secrets, workspace deletion.',
    '',
    '## Be a good teammate',
    '',
    'Be concise and action-oriented. Say what you did and why. Prefer dispatching the right',
    'teammate over doing everything yourself. Keep shared docs and memory tidy.',
    '',
  ].join('\n');

  return `${frontmatter}\n${body}`;
}

// JSON discovery manifest. Public, token-free. Surfaces everything the Configure
// MCP dialog needs (config template, prompt, install recipes, tool list) so the
// UI has a single backend source of truth.
function skillManifest({ baseUrl, mcpPath = DEFAULT_MCP_PATH, name, handle } = {}) {
  const endpoint = mcpEndpoint(baseUrl, mcpPath);
  const base = trimTrailingSlash(baseUrl);
  return {
    name: SKILL_NAME,
    version: SKILL_VERSION,
    description:
      'agensis workspace teammate — install to let an MCP-capable agent join an agensis '
      + 'workspace and collaborate with the team over the agensis MCP server.',
    format: 'agentskills.io',
    mcp: {
      endpoint,
      transport: 'http',
      tokenPlaceholder: TOKEN_PLACEHOLDER,
      configTemplate: configBlock(baseUrl, TOKEN_PLACEHOLDER, mcpPath),
    },
    install: {
      // Works for any agentskills.io client: fetch SKILL.md into a skill folder.
      skillUrl: `${base}/backend/skill/SKILL.md`,
      curlSkill:
        `mkdir -p .claude/skills/${SKILL_NAME} && curl -fsSL ${base}/backend/skill/SKILL.md `
        + `-o .claude/skills/${SKILL_NAME}/SKILL.md`,
      // Claude Code: register the MCP server directly.
      claudeMcpAdd: claudeMcpAddCommand(baseUrl, TOKEN_PLACEHOLDER, mcpPath),
    },
    prompt: buildAgentPrompt({ name, handle, baseUrl, mcpPath }),
    tools: listToolSummaries(),
  };
}

module.exports = {
  SKILL_NAME,
  SKILL_VERSION,
  DEFAULT_MCP_PATH,
  TOKEN_PLACEHOLDER,
  mcpEndpoint,
  configBlock,
  claudeMcpAddCommand,
  buildAgentPrompt,
  renderSkillMd,
  skillManifest,
};
