'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// The MCP and skill doors: the native MCP endpoint any MCP-capable CLI points at,
// and the SKILL.md an agent fetches to learn what this workspace offers.
//
// The handler itself is built in index.cjs (createMcpHandler) and injected,
// because it shares mcpToolDeps() verbatim with the builtin tool loop — the tool
// surface an external client reaches must be the same one an internal turn does.

function mountMcpDoorsRoutes(app, deps = {}) {
 const {
  rateLimitBlocked, clientIpFromReq, mcpHandler, normalizeBaseUrl,
  renderSkillMd, requestBaseUrl, skillManifest,
  skillRateLimiter, oauthWwwAuthenticate,
 } = deps;

 // Wrap so unauthenticated MCP calls advertise RFC 9728 protected-resource metadata.
 function mcpHandlerWithOauthChallenge(req, res) {
  const originalSetHeader = res.setHeader.bind(res);
  const originalStatus = res.status.bind(res);
  let statusCode = 200;
  res.status = (code) => {
   statusCode = code;
   return originalStatus(code);
  };
  // After handler runs we cannot easily patch; instead patch setHeader when 401.
  // Prefer: mcpHandler sets WWW-Authenticate — override via deps if provided.
  const run = typeof mcpHandler === 'function' ? mcpHandler : async (_r, s) => s.status(500).end();
  // Monkey-patch json to attach resource_metadata on 401 if missing.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
   if (statusCode === 401 && typeof oauthWwwAuthenticate === 'function') {
    try {
     originalSetHeader('WWW-Authenticate', oauthWwwAuthenticate(req));
    } catch { /* ignore */ }
   }
   return originalJson(body);
  };
  return run(req, res);
 }

 app.post(['/backend/mcp', '/api/mcp', '/mcp'], mcpHandlerWithOauthChallenge);
 app.get(['/backend/mcp', '/api/mcp', '/mcp'], (req, res) => {
  if (typeof oauthWwwAuthenticate === 'function') {
   res.setHeader('WWW-Authenticate', oauthWwwAuthenticate(req));
  }
  res.status(405).json({
   error: { message: 'MCP endpoint: use HTTP POST with JSON-RPC 2.0 and an Authorization: Bearer token (OAuth or workspace/agent credential).' },
  });
 });

 // Skill / marketplace endpoints (agentskills.io format). Public + token-free:
 // they serve generic instructions for joining a workspace over the MCP server
 // above. The per-agent Bearer token is delivered separately via the Configure
 // MCP dialog (connection-command). The MCP host is the WS-capable backend
 // (AGENSIS_DAEMON_BASE_URL when set, e.g. Fly), mirroring connection-command.
 function skillBaseUrl(req) {
  return normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL) || requestBaseUrl(req);
 }
 app.get(['/backend/skill', '/api/skill', '/skill', '/.well-known/agent-skill'], (req, res) => {
  if (rateLimitBlocked(res, skillRateLimiter, `skill:${clientIpFromReq(req)}`)) return;
  const manifest = skillManifest({
   baseUrl: skillBaseUrl(req),
   name: typeof req.query?.name === 'string' ? req.query.name : undefined,
   handle: typeof req.query?.handle === 'string' ? req.query.handle : undefined,
  });
  res.json({ data: manifest, error: null });
 });
 app.get(['/backend/skill/SKILL.md', '/api/skill/SKILL.md', '/skill/SKILL.md'], (req, res) => {
  if (rateLimitBlocked(res, skillRateLimiter, `skill:${clientIpFromReq(req)}`)) return;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(renderSkillMd({ baseUrl: skillBaseUrl(req) }));
 });

}

module.exports = { mountMcpDoorsRoutes };
