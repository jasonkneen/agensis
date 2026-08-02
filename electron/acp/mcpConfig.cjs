'use strict';

// Build the ACP session/new mcpServers entry for the workspace MCP door.
// Grok (and other harnesses) load MCP on their own; without a Bearer they hit
// our OAuth 401 (WWW-Authenticate: Bearer realm="agensis-mcp") and log
// AuthRequired / worker quit. Passing the agent connect token here is the
// authenticated path — same credential the WS bridge already uses.

/**
 * @param {{ baseUrl?: string, token?: string, name?: string }} opts
 * @returns {object[]} ACP McpServerHttp list (0 or 1 entry)
 */
function buildAgensisMcpServers(opts = {}) {
  const token = String(opts.token || '').trim();
  const base = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
  if (!token || !base) return [];

  let origin;
  try {
    const u = new URL(base.includes('://') ? base : `https://${base}`);
    // Renderer sometimes hands Vite :5173 — MCP is never on the static host.
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const host = u.hostname.toLowerCase();
    if (
      (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0')
      && (port === '5173' || port === '8888' || port === '80')
    ) {
      origin = 'http://127.0.0.1:3142';
    } else {
      origin = `${u.protocol}//${u.host}`;
    }
  } catch {
    return [];
  }

  const url = `${origin}/backend/mcp`;
  return [{
    type: 'http',
    name: String(opts.name || 'agensis').trim() || 'agensis',
    url,
    headers: [
      { name: 'Authorization', value: `Bearer ${token}` },
    ],
  }];
}

module.exports = {
  buildAgensisMcpServers,
};
