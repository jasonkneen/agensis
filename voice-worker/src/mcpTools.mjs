// agensis MCP -> LiveKit function tools.
//
// The voice agent in the room is a full workspace citizen, not a talking head:
// it can read documents, post messages, open tasks and hand work to another
// agent, because every agensis MCP tool is exposed to it verbatim.
//
// The bridge is deliberately thin. agensis MCP is plain JSON-RPC over one POST
// (server/mcp-doors-routes.cjs:47) and its tools already publish JSON Schema,
// which is exactly what LiveKit's `tool()` takes — so there is no schema
// translation layer to drift out of sync. Adding a tool server-side makes it
// available to voice with no change here.

import { llm } from '@livekit/agents';

/** Tools that make no sense mid-conversation, or that would fight the session. */
const EXCLUDED = new Set([
  // Minting a connect token or registering during a call is a setup action, and
  // both rotate credentials — not something a voice turn should ever do.
  'get_connect_command',
  'register_agent',
  'registration_status',
]);

/**
 * One JSON-RPC round trip to the agensis MCP endpoint.
 *
 * Errors are returned, never thrown past the tool boundary: a failed tool call
 * must come back to the model as text it can talk about, otherwise the agent
 * goes silent mid-sentence and the human just hears nothing.
 */
async function rpc({ url, token, method, params, signal, timeoutMs = 30_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params ?? {} }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP ${method} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    // The endpoint may answer as SSE when it streams; take the last data: frame.
    const body = text.trimStart().startsWith('{')
      ? text
      : (text.split('\n').filter((l) => l.startsWith('data:')).pop() || '').slice(5).trim();
    if (!body) throw new Error(`MCP ${method} returned an empty body`);
    const parsed = JSON.parse(body);
    if (parsed.error) throw new Error(`MCP ${method}: ${parsed.error.message || 'error'}`);
    return parsed.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Flatten an MCP tool result into text the model can speak about. */
export function flattenToolResult(result) {
  if (result == null) return '';
  const content = Array.isArray(result?.content) ? result.content : null;
  if (!content) return typeof result === 'string' ? result : JSON.stringify(result);
  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return String(part.text || '');
      if (part?.type === 'resource') return String(part.resource?.text || part.resource?.uri || '');
      return '';
    })
    .filter(Boolean)
    .join('\n');
  return text || JSON.stringify(result);
}

/**
 * A JSON Schema the models will actually accept.
 *
 * Some providers reject a parameter schema that is not an object at the top
 * level, and MCP servers are allowed to omit inputSchema entirely for a
 * no-argument tool. Normalising here keeps one weird tool from failing the
 * whole session at connect time.
 */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  return { ...schema, properties: schema.properties || {} };
}

/**
 * Fetch the workspace's MCP tools and return them as LiveKit function tools.
 *
 * @param {{ url: string, token: string, include?: string[], exclude?: string[], log?: Console }} opts
 * @returns {Promise<Record<string, unknown>>} a ToolContext for Agent({ tools })
 */
export async function loadMcpTools({ url, token, include = null, exclude = [], log = console } = {}) {
  if (!url) return {};
  let listed;
  try {
    listed = await rpc({ url, token, method: 'tools/list' });
  } catch (error) {
    // No tools is a degraded agent, not a dead one — it can still hold a
    // conversation. Say so loudly rather than looking mysteriously incapable.
    log.error?.(`[voice] MCP tools unavailable, agent will have no workspace tools: ${error?.message || error}`);
    return {};
  }

  const skip = new Set([...EXCLUDED, ...exclude]);
  const tools = {};
  for (const entry of listed?.tools || []) {
    const name = String(entry?.name || '').trim();
    if (!name || skip.has(name)) continue;
    if (include && !include.includes(name)) continue;

    tools[name] = llm.tool({
      description: String(entry.description || name),
      parameters: normalizeSchema(entry.inputSchema || entry.input_schema),
      execute: async (args, { ctx } = {}) => {
        try {
          const result = await rpc({
            url,
            token,
            method: 'tools/call',
            params: { name, arguments: args ?? {} },
            signal: ctx?.signal,
          });
          const text = flattenToolResult(result);
          // An MCP tool can report failure in-band; surface it as text so the
          // agent can say what went wrong instead of stalling.
          if (result?.isError) return `Tool ${name} failed: ${text}`;
          return text || `Tool ${name} completed.`;
        } catch (error) {
          return `Tool ${name} failed: ${error?.message || error}`;
        }
      },
    });
  }

  log.log?.(`[voice] ${Object.keys(tools).length} MCP tools available to the voice agent`);
  return tools;
}
