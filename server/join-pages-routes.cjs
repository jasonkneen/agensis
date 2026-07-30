'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// The join page itself: https://agensis.io/join/<token>, server-rendered, one
// URL for a human OR an agent.
//
// NO USER-AGENT SNIFFING, ANYWHERE. An agent succeeds via Accept: application/json
// or ?format=json, or via the HTML itself, which carries the contract four ways
// (JSON-LD, a visible fenced machine block, prose addressed to an agent, and the
// same steps in the redemption response). tests/join-link.test.cjs asserts the
// page is byte-identical across five User-Agents.
//
// NO ORACLE. Unknown, malformed, expired, revoked, spent and wrong-audience all
// return an identical 410 body, and the refusal page never names the workspace.
//
// The single-use rule IS the conditional UPDATE — one statement, so two
// concurrent redemptions cannot both win. Consume-before-provision is
// deliberate: a failure leaves the link dead rather than replayable.
//
// /join/preview renders the same template from invented data through a handler
// containing no getDb, no crypto and no minter — a dedicated path rather than
// ?preview=1, so there is no branch inside the real handler that talks to the
// database.

function mountJoinPagesRoutes(app, deps = {}) {
 const {
  jsonError, getDb, notifyDbSubscribers, rateLimitBlocked,
  dbRateLimitBlocked, clientIpFromReq, agentNextSteps, bearerToken,
  configBlock, createAgentConnectToken, hashAgentToken, invalidDescriptor,
  isJoinLinkToken, joinApiBaseUrl, joinDescriptor, joinLinkRateLimiter,
  joinLinkRefused, joinPublicBaseUrl, joinRedeemDbRateLimiter,
  joinRedeemRateLimiter, joinWantsJson, loadJoinLinkForDisplay,
  logJoinLinkActivity, machinePayload, mcpEndpoint, previewDescriptor,
  publicFarmEnrolledAgent, renderJoinHtml, setJoinJsonHeaders,
  setJoinPageHeaders, uniqueAgentHandle, verifyToken,
 } = deps;

 app.get(['/backend/join/preview', '/join/preview'], (req, res) => {
  if (rateLimitBlocked(res, joinLinkRateLimiter, `join:${clientIpFromReq(req)}`)) return;
  const descriptor = previewDescriptor({
   publicBaseUrl: joinPublicBaseUrl(req),
   apiBaseUrl: joinApiBaseUrl(req),
   mcpEndpoint: mcpEndpoint(joinApiBaseUrl(req)),
  });
  if (joinWantsJson(req)) {
   setJoinJsonHeaders(res);
   return res.json({ data: machinePayload(descriptor), error: null });
  }
  setJoinPageHeaders(res);
  return res.send(renderJoinHtml(descriptor));
 });

 // --- The join page ---------------------------------------------------------
 // Public and unauthenticated by design: a human who has not signed up yet must
 // be able to read what they are being invited to, and an agent must be able to
 // read its instructions before it has any credential at all. Reading changes
 // nothing — redemption is a separate POST.
 app.get(['/backend/join/:token', '/join/:token'], async (req, res) => {
  try {
   if (rateLimitBlocked(res, joinLinkRateLimiter, `join:${clientIpFromReq(req)}`)) return;
   const token = String(req.params.token || '');
   const publicBaseUrl = joinPublicBaseUrl(req);
   // Shape check first: garbage in the path never reaches Postgres, and it is
   // refused with the same response a real-but-spent link gets.
   const row = isJoinLinkToken(token) ? await loadJoinLinkForDisplay(token) : null;
   const descriptor = row
    ? joinDescriptor({
     token,
     publicBaseUrl,
     apiBaseUrl: joinApiBaseUrl(req),
     mcpEndpoint: mcpEndpoint(joinApiBaseUrl(req)),
     workspaceName: row.workspace_name,
     role: row.role,
     label: row.label,
     audience: row.audience,
     expiresAt: row.expires_at,
     status: 'open',
    })
    : invalidDescriptor({ publicBaseUrl });
   // 410 for every invalid link, whatever made it invalid.
   const status = descriptor.status === 'open' ? 200 : 410;
   if (joinWantsJson(req)) {
    setJoinJsonHeaders(res);
    return res.status(status).json({ data: machinePayload(descriptor), error: null });
   }
   setJoinPageHeaders(res);
   return res.status(status).send(renderJoinHtml(descriptor));
  } catch (error) {
   // Note what is NOT here: the token. `error` is whatever Postgres or the
   // renderer threw; jsonError never sees the path parameter, and no console
   // line in this block interpolates one.
   return jsonError(res, error.status || 500, new Error('Join link could not be read'));
  }
 });

 // --- Redemption ------------------------------------------------------------
 // The only thing holding a join link lets you do. Two lanes, one route, chosen
 // by what the caller PRESENTS:
 //
 //   human — a valid agensis session token in Authorization. Adds the user to
 //           the workspace as a member. Returns NO credential: their own
 //           sign-in is their access, and there is nothing new to show them.
 //   agent — no session. Creates a workspace agent and mints its bearer token,
 //           returned ONCE, in this response, in exactly one field.
 //
 // No User-Agent is read. A browser with a session and a CLI with a session take
 // the same lane; a browser without one and a curl without one take the same
 // other lane.
 app.post(['/backend/join/:token/redeem', '/join/:token/redeem'], async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, joinRedeemRateLimiter, joinRedeemDbRateLimiter, `join-redeem:${clientIpFromReq(req)}`)) return;
   const token = String(req.params.token || '');
   if (!isJoinLinkToken(token)) return joinLinkRefused(res);

   // Which lane? Purely "did they present a valid session".
   //
   // An INVALID Authorization header — an expired session, or an agent's own
   // aga_ token — resolves to null and therefore takes the agent lane. That is
   // the right default: the alternative is refusing the request outright, and
   // the caller who most often arrives without a usable session is exactly the
   // agent this route exists for. A person whose session has expired gets an
   // agent record rather than a membership, and the response says `as: 'agent'`
   // in so many words.
   const userId = await verifyToken(bearerToken(req)).catch(() => null);
   const lane = userId ? 'human' : 'agent';

   // THE guard. Single statement, so the row lock makes it atomic: two
   // concurrent redemptions of the same link cannot both return a row. The
   // audience predicate is folded in deliberately — a wrong-lane caller matches
   // nothing and gets the same refusal as an unknown token, rather than a
   // distinct error that would confirm the link exists.
   const claimed = await getDb().unsafe(
    `update workspace_join_links
        set status = 'redeemed',
            redeemed_as = $2,
            redeemed_by = $3,
            redeemed_at = now(),
            updated_at = now()
      where token_hash = $1
        and status = 'pending'
        and expires_at > now()
        and audience in ('both', $2)
      returning *`,
    [hashAgentToken(token), lane, userId || null],
   );
   const link = claimed[0];
   if (!link) return joinLinkRefused(res);

   // From here the link is SPENT, before any provisioning runs. That ordering is
   // deliberate: if the work below fails, the link stays dead. A half-completed
   // redemption that can be replayed is a worse outcome than one that has to be
   // re-issued, and re-issuing costs the owner one click.
   const wsRows = await getDb().unsafe('select id, name from workspaces where id = $1 limit 1', [link.workspace_id]);
   const workspace = wsRows[0] || null;

   setJoinJsonHeaders(res);

   if (lane === 'human') {
    const owns = await getDb().unsafe('select 1 from workspaces where id = $1 and user_id = $2 limit 1', [link.workspace_id, userId]);
    if (owns.length === 0) {
     const existing = await getDb().unsafe(
      'select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1',
      [link.workspace_id, userId],
     );
     if (existing.length === 0) {
      const memberRows = await getDb().unsafe(
       `insert into workspace_members (workspace_id, user_id, role, invited_by)
             values ($1, $2, $3, $4) returning *`,
       [link.workspace_id, userId, link.role, link.created_by],
      );
      notifyDbSubscribers('workspace_members', 'INSERT', memberRows);
     }
    }
    await logJoinLinkActivity({
     workspaceId: link.workspace_id,
     userId,
     eventType: 'join_link_redeemed',
     title: 'A person joined through a join link',
     metadata: { join_link_id: String(link.id), lane: 'human', role: link.role, audience: link.audience },
    });
    // No `credential` key at all — not empty, ABSENT. A human's access is their
    // own session, so there is nothing here for anyone to copy.
    return res.json({
     data: {
      redeemed: true,
      as: 'human',
      workspace,
      role: link.role,
      next: `You are now a member of ${workspace?.name || 'the workspace'}. Open the app to start.`,
     },
     error: null,
    });
   }

   // --- agent lane ---
   const name = String(req.body?.name || '').trim().slice(0, 120) || 'MCP agent';
   const handle = await uniqueAgentHandle(link.workspace_id, req.body?.handle || name);
   const description = String(req.body?.description || '').trim().slice(0, 500);
   const agentToken = createAgentConnectToken();
   const agentRows = await getDb().unsafe(
    `insert into workspace_agents
        (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode,
         enabled, mcp_approved, connect_token_hash, metadata, created_by)
        values ($1, $2, $3, $4, '', 'auto', 'external', 'default', true, true, $5, $6::jsonb, $7)
        returning *`,
    [
     link.workspace_id,
     name,
     handle,
     description,
     hashAgentToken(agentToken),
     // Bind the OBJECT, not a string: porsager turns a stringified ::jsonb bind
     // into a jsonb STRING SCALAR (tests/jsonb-bind-hygiene.test.cjs).
     { joinLinkId: String(link.id), joinedVia: 'join_link' },
     link.created_by || null,
    ],
   );
   const agent = agentRows[0];
   // publicFarmEnrolledAgent strips connect_token_hash before the row goes out
   // over realtime. The plaintext token was never in the row to begin with.
   notifyDbSubscribers('workspace_agents', 'INSERT', agentRows.map(publicFarmEnrolledAgent));
   await getDb().unsafe(
    'update workspace_join_links set redeemed_agent_id = $2, updated_at = now() where id = $1',
    [link.id, agent.id],
   );
   await logJoinLinkActivity({
    workspaceId: link.workspace_id,
    userId: null,
    eventType: 'join_link_redeemed',
    title: `@${agent.handle} joined through a join link`,
    metadata: {
     join_link_id: String(link.id),
     lane: 'agent',
     agent_id: String(agent.id),
     agent_handle: agent.handle,
     audience: link.audience,
    },
   });

   const backendBaseUrl = joinApiBaseUrl(req);
   return res.json({
    data: {
     redeemed: true,
     as: 'agent',
     workspace,
     agent: { id: agent.id, name: agent.name, handle: agent.handle },
     // ONE field, and only one, carries the secret. Everything else describing
     // the connection uses the placeholder — the same rule server/skills.cjs
     // follows and the same rule the mcp-token route now follows. It means an
     // agent has exactly one thing to store, a test can assert the token
     // appears exactly once in this response, and there is no second,
     // more-convenient string that also happens to contain it.
     credential: {
      token: agentToken,
      type: 'bearer',
      shown_once: true,
      note: 'Store this now. It is not recoverable and this link will not work again.',
     },
     mcp: {
      endpoint: mcpEndpoint(backendBaseUrl),
      transport: 'http',
      config: configBlock(backendBaseUrl),
     },
     next: agentNextSteps(),
    },
    error: null,
   });
  } catch (error) {
   // Same rule as the page route: the token is never in an error we construct,
   // and a provisioning failure must not describe the link it failed on.
   return jsonError(res, error.status || 500, new Error('This join link could not be redeemed'));
  }
 });

 // --- Managing join links (workspace owner / admin) -------------------------
}

module.exports = { mountJoinPagesRoutes };
