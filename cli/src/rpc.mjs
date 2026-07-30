// The ONLY thing in this CLI that performs network I/O.
//
// This is the structural reason the CLI cannot grow into a second API surface.
// There is exactly one egress function; it POSTs to exactly one endpoint; and
// the set of JSON-RPC methods it will emit is a frozen allowlist of three. Any
// future "just add a small endpoint for X" has to either go through here — where
// it is limited to calling an MCP tool — or add a second network call site,
// which `tests/ops-cli.test.cjs` fails on: that suite records every request made
// while driving every command and asserts the URL and method set.
//
// So the rule "if a command needs something MCP cannot do, add an MCP tool, not
// a CLI route" is enforced by a test rather than by a comment somebody has to
// remember to read.

import { EXIT } from './exitCodes.mjs';

export const RPC_METHODS = Object.freeze(['initialize', 'tools/list', 'tools/call']);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 10_000;

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/**
 * One JSON-RPC request. Returns a typed outcome; never throws for anything a
 * caller could have caused, and never returns a value that still needs HTTP
 * knowledge to interpret.
 */
export async function rpc(method, params, ctx) {
  if (!RPC_METHODS.includes(method)) {
    // Not a caller error — a programming error. Loud on purpose.
    throw new Error(`rpc(): "${method}" is not in the allowlist [${RPC_METHODS.join(', ')}]`);
  }
  const fetchFn = ctx.fetchFn || globalThis.fetch;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : DEFAULT_TIMEOUT_MS;

  let attempt = 0;
  for (;;) {
    const outcome = await once(method, params, ctx, fetchFn, timeoutMs);
    if (outcome.ok || outcome.code !== EXIT.RATE_LIMITED || attempt >= 1) return outcome;
    // One retry only. A loop here would spend the caller's 120/min budget — the
    // same budget its real agent traffic is drawn from.
    attempt += 1;
    const waitMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, (outcome.retryAfterSeconds || 1) * 1000));
    ctx.onNote?.(`rate limited; retrying once in ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
}

async function once(method, params, ctx, fetchFn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(ctx.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${ctx.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return fail(
      EXIT.TRANSPORT,
      aborted
        ? `Timed out after ${timeoutMs}ms calling ${ctx.url}`
        : `Cannot reach ${ctx.url}: ${error?.message || error}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    return fail(
      EXIT.AUTH,
      `Rejected as unauthorized by ${ctx.url}. The credential came from ${ctx.tokenSource || 'an unknown source'}.`,
    );
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers?.get?.('retry-after')) || 0;
    return fail(EXIT.RATE_LIMITED, 'Rate limit exceeded (120 requests/minute per identity).', {
      retryAfterSeconds: retryAfter,
    });
  }

  let text;
  try {
    text = await res.text();
  } catch (error) {
    return fail(EXIT.TRANSPORT, `Could not read the response body: ${error?.message || error}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // The single most likely misconfiguration: pointing at agensis.io, which
    // serves the SPA. `/backend/mcp` is mounted on the Fly backend only.
    const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(text);
    return fail(
      EXIT.TRANSPORT,
      looksLikeHtml
        ? `${ctx.url} returned HTML, not JSON-RPC. That is usually the web app rather than `
          + 'the backend — the MCP endpoint lives on the Fly backend '
          + '(try --url https://agensis-backend.fly.dev).'
        : `${ctx.url} returned a non-JSON body (HTTP ${res.status}).`,
    );
  }

  // Valid JSON, but not a JSON-RPC envelope: this is not the MCP door. The
  // realistic case is pointing at agensis.io, whose Netlify function answers
  // `{ data: null, error: { message: 'Backend route not found' } }` with a 404 —
  // `/backend/mcp` is mounted on the Fly backend only. Reporting that as a
  // protocol error would send the operator looking for a JSON-RPC problem that
  // does not exist.
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0') {
    const detail = body?.error?.message ? ` It said: ${body.error.message}.` : '';
    return fail(
      EXIT.TRANSPORT,
      `${ctx.url} answered with JSON that is not a JSON-RPC 2.0 envelope (HTTP ${res.status}).`
      + `${detail} That host is usually not the MCP endpoint — it lives on the Fly `
      + 'backend (try --url https://agensis-backend.fly.dev).',
    );
  }

  if (body.error) {
    const code = body.error.code;
    // -32001 is the door's own unauthorized code; it can arrive on a status we
    // did not special-case above, and it is an auth problem either way.
    if (code === -32001) {
      return fail(EXIT.AUTH, `Unauthorized: ${body.error.message || 'invalid token'}. `
        + `The credential came from ${ctx.tokenSource || 'an unknown source'}.`);
    }
    return fail(EXIT.PROTOCOL, `JSON-RPC error ${code}: ${body.error.message || 'unknown'}`);
  }

  if (!res.ok) {
    return fail(EXIT.TRANSPORT, `HTTP ${res.status} from ${ctx.url}.`);
  }
  if (!('result' in body)) {
    return fail(EXIT.PROTOCOL, 'Response carried neither a result nor an error.');
  }
  return { ok: true, value: body.result, raw: body };
}

/**
 * A tool result is one text content part holding JSON (server/mcp.cjs
 * `toolContent`). Unwrap it to the tool's OWN object — no CLI-invented wrapper,
 * no renamed fields. What `--json` prints is what the tool returned.
 */
export function unwrapToolResult(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
  if (result?.isError) return { ok: false, code: EXIT.TOOL_ERROR, message: text || 'Tool reported an error.' };
  if (!text) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Tools may return a bare string; `toolContent` passes those through as-is.
    return { ok: true, value: text };
  }
}
