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
  skillRateLimiter,
 } = deps;

 app.post(['/backend/mcp', '/api/mcp', '/mcp'], mcpHandler);
 app.get(['/backend/mcp', '/api/mcp', '/mcp'], (_req, res) => {
  res.status(405).json({
   error: { message: 'MCP endpoint: use HTTP POST with JSON-RPC 2.0 and an Authorization: Bearer <agent token> header.' },
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

 // --- Orbs: the event-driven webhook trigger --------------------------------
 // (plans/021-event-driven-orbs.md)
 //
 // What this route used to do, and why all of it had to change:
 //
 //   1. It built the prompt as
 //      `req.body.prompt || .text || .message || JSON.stringify(req.body)` —
 //      the attacker-controlled payload WAS the entire user turn, delivered to an
 //      agent whose permission_mode may be 'yolo' (--no-sandbox --yolo).
 //   2. It called runAnthropicCompletion INLINE, so a daemon or sandbox agent
 //      never actually ran in its runtime: it got a one-shot built-in completion
 //      with no tools, no filesystem and no agent_jobs row. The orb never woke.
 //   3. It awaited that completion before responding, routinely blowing past
 //      GitHub's ~10s delivery timeout — so the provider retried, and with no
 //      deduplication each retry created another session and another billed run.
 //      The synchronous response shape was the retry-storm generator.
 //   4. Nothing was verified. The token was the only authenticator, so a URL
 //      leaked into a CI log was an unlimited agent-run button.
 //
 // Unauthenticated, so every gate below is load-bearing. The order is
 // cheap-before-expensive with one deliberate exception: the IP rate limiter runs
 // FIRST, ahead of the free header checks, because it is the only defence against
 // volume and a malformed flood is still load.
}

module.exports = { mountMcpDoorsRoutes };
