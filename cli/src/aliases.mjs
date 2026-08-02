// Ergonomic verbs. These are SUGAR OVER `call`, never a second code path: an
// alias resolves to `{ tool, positional }` and is then executed by exactly the
// same schema-driven parser and the same single transport function.
//
// The table below is the only hand-written knowledge of any tool name in the
// whole CLI, and it is deliberately tiny. Two things keep it from drifting:
//
//   1. `validateAliases()` runs against the schema fetched from the LIVE server
//      before an aliased command dispatches. If a tool were renamed or a
//      positional stopped being a real property, the alias fails locally with
//      exit 2 and a message naming the drift — rather than sending a request the
//      server rejects with something opaque.
//   2. `tests/mcp-public-surface.test.cjs` (this repo) pins the tool names and
//      every `required` array, so the rename fails CI in the repo where the
//      rename happens.
//
// Anything not aliased is still reachable: `agensis-ops call <tool> --k v`
// covers every tool the credential may use with no table entry at all.

import { EXIT } from './exitCodes.mjs';

export const ALIASES = Object.freeze({
  whoami: { tool: 'whoami', positional: [], summary: 'Show which identity this token authenticates as.' },
  channels: { tool: 'list_channels', positional: [], summary: 'List channels.' },
  read: { tool: 'read_channel', positional: ['channel_id'], summary: 'Read recent messages in a channel.' },
  search: { tool: 'search_messages', positional: ['query'], summary: 'Search messages.' },
  post: { tool: 'post_message', positional: ['channel_id', 'content'], summary: 'Post a message.' },
  dispatch: { tool: 'dispatch_agent', positional: ['channel_id', 'content'], summary: 'Post a message and wake the agents it addresses.' },
  tasks: { tool: 'list_tasks', positional: [], summary: 'List tasks.' },
  agents: { tool: 'list_agents', positional: [], summary: 'List workspace agents.' },
});

/**
 * Check every alias against the tools the server just described. Runs before an
 * aliased command dispatches, so a stale binary fails with a message that says
 * what moved instead of a rejected request.
 */
export function validateAliases(tools) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const problems = [];
  for (const [verb, alias] of Object.entries(ALIASES)) {
    const tool = byName.get(alias.tool);
    if (!tool) {
      problems.push(`"${verb}" maps to tool "${alias.tool}", which this server does not expose.`);
      continue;
    }
    const properties = Object.keys(tool.inputSchema?.properties || {});
    for (const name of alias.positional) {
      if (!properties.includes(name)) {
        problems.push(`"${verb}" binds its positional to "${alias.tool}.${name}", which is no longer an argument of that tool.`);
      }
    }
  }
  if (problems.length) {
    return {
      ok: false,
      code: EXIT.USAGE,
      message: 'This CLI is out of step with the server\'s tool surface:\n  '
        + `${problems.join('\n  ')}\n`
        + 'Use `agensis-ops tools` to see what the server actually exposes, and '
        + '`agensis-ops call <tool> --arg value` to reach it in the meantime.',
    };
  }
  return { ok: true };
}

/** Bind an alias's positional arguments; the rest are parsed from the schema. */
export function bindPositionals(alias, tokens) {
  const seed = {};
  const rest = [...tokens];
  for (const name of alias.positional) {
    if (!rest.length || rest[0].startsWith('--')) break;
    seed[name] = rest.shift();
  }
  return { seed, rest };
}
