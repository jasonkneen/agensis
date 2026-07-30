'use strict';

// Generates the static, committed copy of the agensis Agent Skill from the SAME
// renderer the live /backend/skill/SKILL.md endpoint uses, so the Claude Code
// plugin marketplace skill can never drift from the MCP server's real tool list.
//
// Usage:
//   node scripts/gen-skill.cjs [baseUrl]
//   AGENSIS_PUBLIC_MCP_URL=https://host node scripts/gen-skill.cjs
//
// Writes plugins/agensis/skills/agensis/SKILL.md. Run after adding/renaming an
// MCP tool, then commit the result alongside the marketplace.

const fs = require('fs');
const path = require('path');
const { renderSkillMd } = require('../server/skills.cjs');

const baseUrl =
  process.argv[2]
  || process.env.AGENSIS_PUBLIC_MCP_URL
  || process.env.AGENSIS_DAEMON_BASE_URL
  || 'https://agensis-backend.fly.dev';

const out = path.join(__dirname, '..', 'plugins', 'agensis', 'skills', 'agensis', 'SKILL.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, renderSkillMd({ baseUrl }), 'utf8');
console.log(`Wrote ${path.relative(path.join(__dirname, '..'), out)} (baseUrl=${baseUrl})`);
