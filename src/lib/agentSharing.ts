// ---------------------------------------------------------------------------
// AGENT SHARING, frontend side.
//
// The twin of shared/agentSharing.cjs. The server is the authority — it gates
// every daemon push on these flags — and everything here exists so the Agents
// window can render the four toggles and the library can label a withheld
// agent without guessing at the defaults.
//
// Kept in .ts rather than importing the .cjs for the reason every other twin in
// this repo is: the frontend bundle must not pull a CommonJS server module in.
// tests/unit/agentSharing.test.ts asserts the two files still agree, which is
// the only thing standing between a fail-open default here and a fail-closed
// one there.
// ---------------------------------------------------------------------------

export const SHARING_CHANNELS = ['memory', 'skills', 'tools', 'documents'] as const;

export type AgentSharingChannel = typeof SHARING_CHANNELS[number];

export type AgentSharing = Record<AgentSharingChannel, boolean>;

/** Mirrors SHARING_CHANNEL_LABELS. */
export const SHARING_CHANNEL_LABELS: Record<AgentSharingChannel, string> = {
  memory: 'Memory files',
  skills: 'Skill documents',
  tools: 'Tools and CLIs',
  documents: 'Documents',
};

/** Mirrors SHARING_CHANNEL_DESCRIPTIONS. */
export const SHARING_CHANNEL_DESCRIPTIONS: Record<AgentSharingChannel, string> = {
  memory: 'Mirror this agent’s memory files into the workspace memory browser.',
  skills: 'Mirror the body behind each skill this agent advertises.',
  tools: 'List this agent’s tools, CLIs and MCP servers in workspace surfaces.',
  documents: 'Contribute this agent’s markdown documents to the shared library.',
};

function extractSharing(input: unknown): Record<string, unknown> {
  let value: unknown = input;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'sharing' in (value as object)) {
    value = (value as { sharing?: unknown }).sharing;
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * All four booleans, from a row, an agent, or the raw column.
 *
 * FAIL OPEN — absent means shared, only an explicit `false` withholds. Same
 * rule as the server's, and for the same reason: every one of these channels
 * shipped before the column existed, so a missing key describes an agent that
 * has been mirroring all along.
 */
export function normalizeAgentSharing(input: unknown): AgentSharing {
  const raw = extractSharing(input);
  return {
    memory: raw.memory !== false,
    skills: raw.skills !== false,
    tools: raw.tools !== false,
    documents: raw.documents !== false,
  };
}

export function agentSharesChannel(input: unknown, channel: AgentSharingChannel): boolean {
  return normalizeAgentSharing(input)[channel];
}

/** The channels this agent withholds, for a "sharing 2 of 4" style summary. */
export function withheldSharingChannels(input: unknown): AgentSharingChannel[] {
  const sharing = normalizeAgentSharing(input);
  return SHARING_CHANNELS.filter(channel => !sharing[channel]);
}

/**
 * One line describing what an agent contributes.
 *
 * The all-on case says so rather than listing four things: the default state is
 * the uninteresting one, and a summary that reads the same whether or not
 * anything was changed is a summary nobody scans.
 */
export function describeAgentSharing(input: unknown): string {
  const withheld = withheldSharingChannels(input);
  if (withheld.length === 0) return 'Sharing memory, skills, tools and documents';
  if (withheld.length === SHARING_CHANNELS.length) return 'Sharing nothing with the workspace';
  const shared = SHARING_CHANNELS.filter(channel => !withheld.includes(channel));
  return `Sharing ${shared.map(channel => SHARING_CHANNEL_LABELS[channel].toLowerCase()).join(', ')}`;
}
