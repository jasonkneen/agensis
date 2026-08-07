'use strict';

// ---------------------------------------------------------------------------
// AGENT SHARING — what a connected agent contributes to the WORKSPACE.
//
// A daemon that connects mirrors things up: the bodies behind its skill names
// (`agent_skill_sync` -> agent_skill_documents), its memory palace
// (`agent_memory_sync` -> agent_memory_files), the markdown it can see from its
// own locations (`agent_document_sync` -> agent_documents), and the tool/CLI
// surface it advertises on `agent_capabilities_sync`. Before this module those
// four were unconditional: connecting an agent published all of it, and the
// only off switch was not connecting the agent.
//
// One jsonb column (`workspace_agents.sharing`) holds four booleans. It is ONE
// column rather than four because these are one decision made in one place —
// and because the next channel should be a key here, not a fifth migration.
//
// FAIL OPEN, on purpose and for the same reason `ambient_replies` does. All
// four channels shipped and have been mirroring for every existing agent; a
// missing key that read as "off" would silently empty three browse surfaces on
// deploy, and nothing would error — the worst failure shape this repo has.
// So absent == shared, and only an explicit `false` withholds.
//
// ENFORCEMENT IS AT INGEST, NOT AT RENDER. `sharingGate` is called by the sync
// handlers in server/agent-connections.cjs: a withheld channel refuses the push
// AND prunes what that agent already mirrored. A flag that only hid rows in the
// UI would leave the bodies sitting in the workspace's database, which is not
// what "stop sharing my memory" means to the person who switched it off.
//
// The frontend twin is src/lib/agentSharing.ts (the Agents window renders these
// toggles and must state the same defaults). tests/unit/agentSharing.test.ts
// pins the two together.
// ---------------------------------------------------------------------------

/**
 * The channels, in the order the UI lists them.
 *
 * `tools` is the odd one out and stays deliberately: tools are not mirrored
 * into a table, they ride `agent_connections.capabilities`. Its flag governs
 * whether the workspace-wide surfaces COUNT and LIST this agent's tool/CLI/MCP
 * advert — see sharedCapabilityChannels below. Keeping it in the same set is
 * the point: a person switching an agent's sharing off means all four.
 */
const SHARING_CHANNELS = Object.freeze(['memory', 'skills', 'tools', 'documents']);

/** What each toggle says it does, in the words the settings UI uses. */
const SHARING_CHANNEL_LABELS = Object.freeze({
 memory: 'Memory files',
 skills: 'Skill documents',
 tools: 'Tools and CLIs',
 documents: 'Documents',
});

const SHARING_CHANNEL_DESCRIPTIONS = Object.freeze({
 memory: 'Mirror this agent’s memory files into the workspace memory browser.',
 skills: 'Mirror the body behind each skill this agent advertises.',
 tools: 'List this agent’s tools, CLIs and MCP servers in workspace surfaces.',
 documents: 'Contribute this agent’s markdown documents to the shared library.',
});

/**
 * Normalize whatever is in the column into all four booleans.
 *
 * Accepts the row, the agent, or the raw value — every call site has one of the
 * three and a normalizer that only took one of them is a normalizer somebody
 * bypasses. A JSON string is parsed because postgres.js hands back jsonb as an
 * object but a client round-trip through a text input does not.
 */
function normalizeAgentSharing(input) {
 const raw = extractSharing(input);
 const out = {};
 for (const channel of SHARING_CHANNELS) {
  // The fail-open rule, spelled once: only an explicit false withholds.
  out[channel] = raw[channel] !== false;
 }
 return out;
}

function extractSharing(input) {
 let value = input;
 if (value && typeof value === 'object' && !Array.isArray(value) && 'sharing' in value) {
  value = value.sharing;
 }
 if (typeof value === 'string') {
  try {
   value = JSON.parse(value);
  } catch {
   return {};
  }
 }
 if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
 return value;
}

/** Does this agent contribute `channel` to the workspace? */
function agentSharesChannel(input, channel) {
 if (!SHARING_CHANNELS.includes(channel)) return false;
 return normalizeAgentSharing(input)[channel];
}

/**
 * Validate + narrow a sharing patch coming from a client.
 *
 * Unknown keys are DROPPED rather than rejected: the column is jsonb and the
 * generic write path would otherwise let anyone park arbitrary data on a
 * workspace_agents row. Only the four known booleans survive, so the column can
 * never hold anything the readers above do not already understand.
 */
function sanitizeAgentSharingPatch(value) {
 const raw = extractSharing(value);
 const out = {};
 for (const channel of SHARING_CHANNELS) {
  if (!Object.prototype.hasOwnProperty.call(raw, channel)) continue;
  out[channel] = raw[channel] !== false;
 }
 return out;
}

/**
 * The gate the sync handlers ask before ingesting a push.
 *
 * Returns `{ allowed, prune }`. `prune` is true whenever the channel is
 * withheld, because a daemon that pushed yesterday left rows behind: refusing
 * the new push without removing the old ones would freeze a stale snapshot in
 * the workspace forever, which reads as "it is still sharing".
 */
function sharingGate(agentRow, channel) {
 const allowed = agentSharesChannel(agentRow, channel);
 return { allowed, prune: !allowed };
}

/**
 * Which capability keys survive for an agent that withholds `tools`.
 *
 * `skills` stays: a skill NAME is what the Skills window rows are built from,
 * and it is governed by the `skills` toggle rather than this one. What is
 * withheld is the executable surface advert — the CLIs, MCP servers and shared
 * models a workspace-wide tool count is built from.
 */
const TOOL_CAPABILITY_KEYS = Object.freeze(['clis', 'mcpServers', 'sharedModels', 'commands']);

/**
 * Redact the tool advert from a capabilities block when `tools` is withheld.
 *
 * Shape-preserving: the keys stay, emptied, so every reader that expects an
 * array still gets one. A reader that had to learn "these keys may be absent"
 * is a reader that will one day forget.
 */
function applyToolSharing(capabilities, agentRow) {
 const block = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
  ? capabilities
  : {};
 if (agentSharesChannel(agentRow, 'tools')) return block;
 const out = { ...block };
 for (const key of TOOL_CAPABILITY_KEYS) out[key] = [];
 return out;
}

module.exports = {
 SHARING_CHANNELS,
 SHARING_CHANNEL_LABELS,
 SHARING_CHANNEL_DESCRIPTIONS,
 TOOL_CAPABILITY_KEYS,
 normalizeAgentSharing,
 agentSharesChannel,
 sanitizeAgentSharingPatch,
 sharingGate,
 applyToolSharing,
};
