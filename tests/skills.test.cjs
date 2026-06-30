'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  renderSkillMd,
  skillManifest,
  buildAgentPrompt,
  configBlock,
  mcpEndpoint,
  claudeMcpAddCommand,
  TOKEN_PLACEHOLDER,
} = require('../server/skills.cjs');
const { listToolSummaries } = require('../server/mcp.cjs');

const BASE = 'https://agensis-backend.fly.dev';

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'SKILL.md must start with YAML frontmatter');
  const fields = {};
  for (const line of m[1].split('\n')) {
    const fm = line.match(/^([a-z_-]+):\s?(.*)$/);
    if (fm) fields[fm[1]] = fm[2];
  }
  return fields;
}

test('mcpEndpoint builds a clean URL and tolerates trailing slashes', () => {
  assert.equal(mcpEndpoint(BASE), `${BASE}/backend/mcp`);
  assert.equal(mcpEndpoint(`${BASE}/`), `${BASE}/backend/mcp`);
});

test('SKILL.md frontmatter is valid per the agentskills.io spec', () => {
  const md = renderSkillMd({ baseUrl: BASE });
  const fm = parseFrontmatter(md);

  // name: <=64, lowercase a-z/0-9/hyphens, no leading/trailing/double hyphen
  assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fm.name.length >= 1 && fm.name.length <= 64);

  // description: 1-1024 chars, non-empty
  assert.ok(fm.description && fm.description.length >= 1 && fm.description.length <= 1024);

  // compatibility (optional) must be <=500 if present
  if (fm.compatibility) assert.ok(fm.compatibility.length <= 500);
});

test('SKILL.md tool table lists EVERY live MCP tool (no drift)', () => {
  const md = renderSkillMd({ baseUrl: BASE });
  for (const { name } of listToolSummaries()) {
    assert.ok(md.includes(`\`${name}\``), `SKILL.md is missing tool ${name}`);
  }
});

test('SKILL.md embeds the real endpoint and a token placeholder, never a real token', () => {
  const md = renderSkillMd({ baseUrl: BASE });
  assert.ok(md.includes(`${BASE}/backend/mcp`));
  assert.ok(md.includes(TOKEN_PLACEHOLDER));
  // A real minted token would look like aga_<base64url>; the static skill must not carry one.
  assert.ok(!/Bearer aga_(?!YOUR_)/.test(md), 'SKILL.md must not embed a real aga_ token');
});

test('configBlock has the MCP http shape with Bearer auth', () => {
  const cfg = configBlock(BASE, 'aga_test');
  assert.equal(cfg.mcpServers.agensis.type, 'http');
  assert.equal(cfg.mcpServers.agensis.url, `${BASE}/backend/mcp`);
  assert.equal(cfg.mcpServers.agensis.headers.Authorization, 'Bearer aga_test');
});

test('claudeMcpAddCommand registers an http transport with the auth header', () => {
  const cmd = claudeMcpAddCommand(BASE, 'aga_test');
  assert.ok(cmd.startsWith('claude mcp add --transport http agensis '));
  assert.ok(cmd.includes(`${BASE}/backend/mcp`));
  assert.ok(cmd.includes('Authorization: Bearer aga_test'));
});

test('buildAgentPrompt names the agent and references the tool surface', () => {
  const prompt = buildAgentPrompt({ name: 'Boris', handle: 'boris', baseUrl: BASE });
  assert.ok(prompt.includes('Boris'));
  assert.ok(prompt.includes('@boris'));
  assert.ok(prompt.includes('whoami'));
  assert.ok(prompt.includes('dispatch_agent'));
});

test('skillManifest exposes token-free install recipes and the full tool list', () => {
  const m = skillManifest({ baseUrl: BASE, name: 'Boris', handle: 'boris' });
  assert.equal(m.name, 'agensis');
  assert.equal(m.format, 'agentskills.io');
  assert.equal(m.mcp.endpoint, `${BASE}/backend/mcp`);
  assert.equal(m.mcp.tokenPlaceholder, TOKEN_PLACEHOLDER);
  assert.ok(m.install.skillUrl.endsWith('/backend/skill/SKILL.md'));
  assert.ok(m.install.curlSkill.includes('SKILL.md'));
  assert.ok(m.install.claudeMcpAdd.includes('claude mcp add'));
  assert.equal(m.tools.length, listToolSummaries().length);
  // No real token leaked into any string field.
  const blob = JSON.stringify(m);
  assert.ok(!/Bearer aga_(?!YOUR_)/.test(blob));
});
