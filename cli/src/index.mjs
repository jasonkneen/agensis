// The real entry point. `runOpsCommand` RETURNS an exit code — it never calls
// process.exit and never touches process.stdout — so the tests drive exactly the
// code path the binary does.

import { EXIT } from './exitCodes.mjs';
import { resolveAuth } from './auth.mjs';
import { rpc, unwrapToolResult } from './rpc.mjs';
import { fetchTools, parseToolArgs, describeTool, propertyToFlag } from './schema.mjs';
import { ALIASES, validateAliases, bindPositionals } from './aliases.mjs';
import { redact, chooseFormat, renderHuman, formatTable } from './render.mjs';

const VALUE_FLAGS = new Set(['--profile', '--url', '--token', '--timeout-ms']);
const BOOL_FLAGS = new Set(['--json', '--human', '--quiet', '--raw', '--full-ids', '--help', '-h']);

/**
 * Pull the global flags out of argv wherever they appear, leaving the command
 * and its own arguments behind. Scanning stops at `--`, so a message body that
 * happens to contain `--json` can always be passed after it.
 */
export function splitGlobalFlags(argv) {
  const flags = {};
  const rest = [];
  let verbatim = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (verbatim) { rest.push(token); continue; }
    if (token === '--') { verbatim = true; continue; }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, message: `${token} needs a value.` };
      flags[token.replace(/^--/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(token)) {
      const name = token === '-h' ? 'help' : token.replace(/^--/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      flags[name] = true;
      continue;
    }
    rest.push(token);
  }
  return { ok: true, flags, rest };
}

const USAGE = `agensis-ops — operator/CI client for the agensis MCP surface

  This is a transport-only wrapper over POST /backend/mcp. It ships no server
  routes and no hand-written tool schemas: every command is built from the
  tool list the server publishes. Agents running inside agensis already have
  these tools over MCP and do not need this.

USAGE
  agensis-ops <command> [args] [global flags]

COMMANDS
  whoami                          Which identity does this token authenticate as?
  channels                        List channels.
  read <channel-id>               Read recent messages.
  search <query>                  Search messages.
  post <channel-id> <content>     Post a message.
  dispatch <channel-id> <content> Post and wake the agents it addresses.
  tasks                           List tasks.
  agents                          List workspace agents.
  tools                           List every tool this token can reach.
  call <tool> [--arg value ...]   Call any tool, arguments checked against its schema.
  help                            This text.

GLOBAL FLAGS
  --json | --human    Force output shape. Default: human on a TTY, JSON otherwise.
  --raw               Print the whole JSON-RPC response (transport debugging).
  --quiet             Suppress notes on stderr.
  --full-ids          Do not shorten uuids in human output.
  --profile <name>    Daemon profile to read credentials from (default: "default").
  --url <url>         Backend base URL. Default: the profile's, else the Fly backend.
  --token <token>     DISCOURAGED: lands in ps output and shell history. Prefer
                      AGENSIS_TOKEN.
  --timeout-ms <n>    Request timeout (default 30000).
  --                  Everything after this is passed through verbatim.

AUTH
  Token:  --token, then AGENSIS_TOKEN, then AGENSIS_MCP_TOKEN, then the daemon
          profile at ~/.agensis/daemon-profiles/<name>.json.
  URL:    --url, then AGENSIS_MCP_URL, then AGENSIS_URL, then the profile.

EXIT CODES
  0 ok   1 internal   2 usage   3 auth   4 rate limited
  5 tool error   6 transport   7 protocol`;

export async function runOpsCommand(argv, io = {}) {
  const write = (stream, text) => {
    const fn = io[stream];
    if (typeof fn === 'function') fn(`${redact(text, io.__secrets || [])}\n`);
  };
  const out = (text) => write('stdout', text);
  const err = (text) => write('stderr', text);

  try {
    return await execute(argv, io, out, err);
  } catch (error) {
    err(`agensis-ops: ${error?.stack || error?.message || error}`);
    return EXIT.INTERNAL;
  }
}

async function execute(argv, io, out, err) {
  const split = splitGlobalFlags(argv);
  if (!split.ok) { err(split.message); return EXIT.USAGE; }
  const { flags, rest } = split;

  const chosen = chooseFormat({ json: flags.json, human: flags.human, isTTY: Boolean(io.isTTY) });
  if (!chosen.ok) { err(chosen.message); return EXIT.USAGE; }
  const format = chosen.format;
  const note = (text) => { if (!flags.quiet) err(`note: ${text}`); };

  const fail = (code, message) => {
    if (format === 'json') err(JSON.stringify({ error: { code: nameFor(code), message } }));
    else err(`error: ${message}`);
    return code;
  };

  const command = rest[0];
  if (flags.help || command === 'help' || command === undefined) {
    if (command === 'help' || flags.help) { out(USAGE); return EXIT.OK; }
    err(USAGE);
    return EXIT.USAGE;
  }

  const isAlias = Object.prototype.hasOwnProperty.call(ALIASES, command);
  if (!isAlias && command !== 'tools' && command !== 'call') {
    return fail(EXIT.USAGE, `Unknown command "${command}". Run \`agensis-ops help\`.`);
  }

  const auth = await resolveAuth(flags, io);
  if (!auth.ok) return fail(EXIT.AUTH, auth.message);
  // Everything written from here on is redacted against the exact credential
  // this process resolved, not only against the known token prefixes — a user
  // login token has no prefix.
  io.__secrets = [auth.token];

  const ctx = {
    url: auth.url,
    token: auth.token,
    tokenSource: auth.tokenSource,
    fetchFn: io.fetchFn,
    sleep: io.sleep,
    timeoutMs: flags.timeoutMs,
    onNote: note,
  };

  const listed = await fetchTools(ctx);
  if (!listed.ok) return fail(listed.code, listed.message);
  const tools = listed.value;

  if (command === 'tools') {
    if (format === 'json') out(JSON.stringify(tools, null, 2));
    else out(formatTable(
      tools.map((t) => ({ tool: t.name, arguments: describeArguments(t), description: t.description })),
      ['tool', 'arguments', 'description'],
      { maxWidth: 70 },
    ));
    return EXIT.OK;
  }

  let toolName;
  let tokens;
  let seed = {};

  if (command === 'call') {
    toolName = rest[1];
    if (!toolName) return fail(EXIT.USAGE, 'call needs a tool name. Run `agensis-ops tools`.');
    tokens = rest.slice(2);
  } else {
    const validation = validateAliases(tools);
    if (!validation.ok) return fail(validation.code, validation.message);
    const alias = ALIASES[command];
    toolName = alias.tool;
    const bound = bindPositionals(alias, rest.slice(1));
    seed = bound.seed;
    tokens = bound.rest;
  }

  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return fail(EXIT.USAGE, `This token cannot reach a tool named "${toolName}". `
      + 'Run `agensis-ops tools` to see the surface it does reach.');
  }

  const parsed = parseToolArgs(tool, tokens, seed);
  if (!parsed.ok) {
    err(format === 'json'
      ? JSON.stringify({ error: { code: nameFor(parsed.code), message: parsed.message } })
      : `error: ${parsed.message}\nusage: ${describeTool(tool)}`);
    return parsed.code;
  }

  const called = await rpc('tools/call', { name: tool.name, arguments: parsed.value }, ctx);
  if (!called.ok) return fail(called.code, called.message);

  if (flags.raw) {
    // The RESPONSE only. Request headers are never dumped — that is where the
    // bearer lives.
    out(JSON.stringify(called.raw, null, 2));
    return unwrapToolResult(called.value).ok ? EXIT.OK : EXIT.TOOL_ERROR;
  }

  const unwrapped = unwrapToolResult(called.value);
  if (!unwrapped.ok) return fail(unwrapped.code, unwrapped.message);

  if (tool.name === 'whoami' && unwrapped.value?.kind && unwrapped.value.kind !== 'agent') {
    // Identity confusion is the realistic operator mistake: `verifyMcpToken`
    // also accepts a user LOGIN token and resolves it to the workspace that user
    // owns, so a pasted session token acts with owner reach.
    note(`this token authenticates as kind="${unwrapped.value.kind}", not as an agent.`);
  }

  warnIfTruncated(parsed.value, unwrapped.value, note);

  if (format === 'json') out(JSON.stringify(unwrapped.value, null, 2));
  else out(renderHuman(unwrapped.value, { fullIds: Boolean(flags.fullIds) }));
  return EXIT.OK;
}

/**
 * v1 pagination is pass-through: `--limit` reaches the tool, and if a returned
 * array is exactly that long the caller is told the page may be short of the
 * truth. There is no cursor to offer — no read tool accepts `before` or an
 * offset today, so anything more would be invented rather than reported.
 */
function warnIfTruncated(args, value, note) {
  const limit = Number(args?.limit);
  if (!Number.isFinite(limit) || limit <= 0) return;
  if (!value || typeof value !== 'object') return;
  for (const [key, rows] of Object.entries(value)) {
    if (Array.isArray(rows) && rows.length === limit) {
      note(`"${key}" hit the requested limit of ${limit}; there may be more. `
        + 'This surface has no cursor yet, so raise --limit to see further back.');
      return;
    }
  }
}

function describeArguments(tool) {
  const properties = tool?.inputSchema?.properties || {};
  const required = new Set(tool?.inputSchema?.required || []);
  return Object.keys(properties)
    .map((name) => (required.has(name) ? propertyToFlag(name) : `[${propertyToFlag(name)}]`))
    .join(' ');
}

function nameFor(code) {
  switch (code) {
    case EXIT.USAGE: return 'usage_error';
    case EXIT.AUTH: return 'auth_error';
    case EXIT.RATE_LIMITED: return 'rate_limited';
    case EXIT.TOOL_ERROR: return 'tool_error';
    case EXIT.TRANSPORT: return 'transport_error';
    case EXIT.PROTOCOL: return 'protocol_error';
    default: return 'internal_error';
  }
}
