// Schema-driven argument parsing.
//
// The CLI holds NO hand-written knowledge of any tool. Flags, their types, and
// which ones are required are all derived at runtime from the `inputSchema` the
// server hands back from `tools/list` (server/mcp.cjs returns
// `{ name, description, inputSchema }` per tool). A tool added to `buildTools()`
// on Fly is callable from an unchanged CLI the moment it deploys, and a tool
// whose arguments change cannot be called with the old ones — because the old
// ones are not in the schema this process just fetched.
//
// Rejecting unknown flags locally rests on `additionalProperties: false`, which
// every one of the 30 tool schemas sets today (verified) and which AGENTS.md
// records as a promise to clients rather than an internal detail.

import { EXIT } from './exitCodes.mjs';
import { rpc } from './rpc.mjs';

/** Fetch the tool list once per process. */
export async function fetchTools(ctx) {
  if (ctx.__tools) return { ok: true, value: ctx.__tools };
  const outcome = await rpc('tools/list', {}, ctx);
  if (!outcome.ok) return outcome;
  const tools = Array.isArray(outcome.value?.tools) ? outcome.value.tools : [];
  ctx.__tools = tools;
  return { ok: true, value: tools };
}

/** `channel_id` is reachable as --channel-id or --channel_id. */
export function flagToProperty(flag) {
  return flag.replace(/^--/, '').replace(/-/g, '_');
}

export function propertyToFlag(name) {
  return `--${String(name).replace(/_/g, '-')}`;
}

function coerce(name, spec, raw) {
  const type = spec?.type;
  if (type === 'integer' || type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, message: `${propertyToFlag(name)} expects a number, got "${raw}".` };
    if (type === 'integer' && !Number.isInteger(n)) {
      return { ok: false, message: `${propertyToFlag(name)} expects a whole number, got "${raw}".` };
    }
    return { ok: true, value: n };
  }
  if (type === 'boolean') {
    if (raw === true) return { ok: true, value: true };
    const s = String(raw).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return { ok: true, value: true };
    if (s === 'false' || s === '0' || s === 'no') return { ok: true, value: false };
    return { ok: false, message: `${propertyToFlag(name)} expects true or false, got "${raw}".` };
  }
  if (type === 'array') {
    // Repeated flags accumulate; a single JSON array is also accepted.
    const s = String(raw).trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return { ok: true, value: parsed, replace: true };
      } catch { /* fall through to the single-item reading */ }
    }
    return { ok: true, value: [s] };
  }
  if (type === 'object') {
    try {
      const parsed = JSON.parse(String(raw));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed };
    } catch { /* reported below */ }
    return { ok: false, message: `${propertyToFlag(name)} expects a JSON object, got "${raw}".` };
  }
  return { ok: true, value: String(raw) };
}

/**
 * Turn `['--channel-id','abc','--limit','10','--broadcast']` into a tool
 * arguments object, validated against the tool's own schema. Purely local:
 * on failure NO request is sent.
 *
 * `seed` carries values already bound from positional arguments by an alias.
 */
export function parseToolArgs(tool, tokens, seed = {}) {
  const schema = tool?.inputSchema || {};
  const properties = schema.properties || {};
  const args = { ...seed };
  const known = new Set(Object.keys(properties));

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      return { ok: false, code: EXIT.USAGE, message: `Unexpected argument "${token}". Tool arguments are passed as flags, e.g. ${propertyToFlag(Object.keys(properties)[0] || 'name')} <value>.` };
    }
    const eq = token.indexOf('=');
    const rawFlag = eq === -1 ? token : token.slice(0, eq);
    const name = flagToProperty(rawFlag);
    if (!known.has(name)) {
      const options = [...known].map(propertyToFlag).join(', ') || '(none)';
      return { ok: false, code: EXIT.USAGE, message: `Unknown argument "${rawFlag}" for ${tool.name}. Accepted: ${options}.` };
    }
    const spec = properties[name];

    let raw;
    if (eq !== -1) {
      raw = token.slice(eq + 1);
    } else if (spec.type === 'boolean') {
      // Bare `--broadcast` means true; `--broadcast false` is also allowed.
      const next = tokens[i + 1];
      if (typeof next === 'string' && /^(true|false|yes|no|0|1)$/i.test(next)) { raw = next; i += 1; }
      else raw = true;
    } else {
      raw = tokens[i + 1];
      if (raw === undefined) {
        return { ok: false, code: EXIT.USAGE, message: `${rawFlag} needs a value.` };
      }
      i += 1;
    }

    const coerced = coerce(name, spec, raw);
    if (!coerced.ok) return { ok: false, code: EXIT.USAGE, message: coerced.message };
    if (spec.type === 'array' && !coerced.replace && Array.isArray(args[name])) {
      args[name] = args[name].concat(coerced.value);
    } else {
      args[name] = coerced.value;
    }
  }

  const missing = (schema.required || []).filter((k) => args[k] === undefined || args[k] === '');
  if (missing.length) {
    return {
      ok: false,
      code: EXIT.USAGE,
      message: `${tool.name} requires ${missing.map(propertyToFlag).join(', ')}.`,
    };
  }
  return { ok: true, value: args };
}

/** One-line usage string for a tool, generated from its schema. */
export function describeTool(tool) {
  const properties = tool?.inputSchema?.properties || {};
  const required = new Set(tool?.inputSchema?.required || []);
  const parts = Object.entries(properties).map(([name, spec]) => {
    const flag = `${propertyToFlag(name)}${spec.type === 'boolean' ? '' : ` <${spec.type || 'string'}>`}`;
    return required.has(name) ? flag : `[${flag}]`;
  });
  return `agensis-ops call ${tool.name} ${parts.join(' ')}`.trim();
}
