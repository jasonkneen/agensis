'use strict';

const { CONTROLLER_TOKEN_PLACEHOLDER } = require('./join-page.cjs');

async function consumeJoinLinkAndProvision({ database, tokenHash, lane, userId, provision }) {
 if (!database || typeof database.begin !== 'function') {
  throw new Error('Join redemption requires transactional database support');
 }

 return database.begin(async (transaction) => {
  if (!transaction || typeof transaction.unsafe !== 'function' || typeof transaction.savepoint !== 'function') {
   throw new Error('Join redemption requires savepoint support');
  }

  // The outer transaction owns the one-time state transition. Provisioning is
  // isolated in a savepoint so its writes can be rolled back without reviving
  // the credential. That preserves consume-before-provision while ruling out a
  // half-created member, agent, or controller.
  const claimed = await transaction.unsafe(
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
       and grant_kind = case when $2 = 'controller' then 'workspace_control' else 'individual' end
     returning *`,
   [tokenHash, lane, userId || null],
  );
  const link = claimed[0];
  if (!link) return { state: 'refused' };

  try {
   const value = await transaction.savepoint((provisioningDb) => provision({
    db: provisioningDb,
    link,
   }));
   return { state: 'provisioned', link, value };
  } catch (error) {
   // Catch inside the OUTER transaction so it commits the spent link after the
   // savepoint has rolled back every provisioning write.
   return { state: 'failed', error };
  }
 });
}

async function runPostCommitEffect(label, effect) {
 try {
  return await effect();
 } catch (error) {
  // Provisioning has committed at this point. A fanout or audit transport
  // failure must not suppress the one response containing a new credential.
  console.error(`[agensis] join link ${label} failed:`, error?.message || error);
  return undefined;
 }
}

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
  createControllerCredential, controllerNextSteps,
  isJoinLinkToken, joinApiBaseUrl, joinDescriptor, joinLinkRateLimiter,
  joinLinkRefused, joinPublicBaseUrl, joinRedeemDbRateLimiter,
  joinRedeemRateLimiter, joinWantsJson, loadJoinLinkForDisplay,
  logJoinLinkActivity, machinePayload, mcpEndpoint, previewDescriptor,
  publicFarmEnrolledAgent, renderJoinHtml, setJoinJsonHeaders,
  setJoinPageHeaders, uniqueAgentHandle, verifyToken, parseJsonArray,
  recordAudit,
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
     grantKind: row.grant_kind,
     controllerName: row.controller_name,
     controllerScopes: parseJsonArray(row.controller_scopes),
     controllerExpiresAt: row.controller_expires_at,
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
 //   human — body.as='human' plus a valid agensis session token in
 //           Authorization. Adds the user to the workspace as a member. Returns
 //           NO credential: their own sign-in is their access.
 //   agent — body.as='agent' and no Authorization header. Creates a workspace
 //           agent and mints its bearer token, returned ONCE, in this response.
 //
 // No User-Agent is read. The human button and the machine-readable agent
 // contract set `as` themselves, so there is still one URL and no identity
 // choice in the visible flow. Explicit intent prevents a failed authentication
 // check from changing a person into an agent.
 app.post(['/backend/join/:token/redeem', '/join/:token/redeem'], async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, joinRedeemRateLimiter, joinRedeemDbRateLimiter, `join-redeem:${clientIpFromReq(req)}`)) return;
   const token = String(req.params.token || '');
   if (!isJoinLinkToken(token)) return joinLinkRefused(res);

   const lane = String(req.body?.as || '').trim().toLowerCase();
   if (lane !== 'human' && lane !== 'agent' && lane !== 'controller') {
    return jsonError(res, 400, new Error('as must be human, agent, or controller'));
   }

   // Authentication must agree with the stated subject. Falling a failed human
   // session through to the unauthenticated agent lane used to consume the link
   // and provision an unintended agent. Conversely, an ambient browser session
   // must not be enough to create an agent through the human-facing action.
   const authorization = String(req.headers?.authorization || '').trim();
   const presentedToken = bearerToken(req);
   const userId = presentedToken ? await verifyToken(presentedToken).catch(() => null) : null;
   if (lane === 'human' && !userId) {
    return jsonError(res, 401, new Error('Authentication failed'));
   }
   if ((lane === 'agent' || lane === 'controller') && authorization) {
    return jsonError(res, 400, new Error(`${lane === 'controller' ? 'Controller' : 'Agent'} redemption must not include Authorization`));
   }

   const redemption = await consumeJoinLinkAndProvision({
    database: getDb(),
    tokenHash: hashAgentToken(token),
    lane,
    userId,
    provision: async ({ db: provisioningDb, link }) => {
     const wsRows = await provisioningDb.unsafe(
      'select id, name from workspaces where id = $1 limit 1',
      [link.workspace_id],
     );
     const workspace = wsRows[0] || null;

     if (lane === 'human') {
      let memberRows = [];
      const owns = await provisioningDb.unsafe(
       'select 1 from workspaces where id = $1 and user_id = $2 limit 1',
       [link.workspace_id, userId],
      );
      if (owns.length === 0) {
       const existing = await provisioningDb.unsafe(
        'select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1',
        [link.workspace_id, userId],
       );
       if (existing.length === 0) {
        memberRows = await provisioningDb.unsafe(
         `insert into workspace_members (workspace_id, user_id, role, invited_by)
               values ($1, $2, $3, $4) returning *`,
         [link.workspace_id, userId, link.role, link.created_by],
        );
       }
      }
      return { workspace, memberRows };
     }

     if (lane === 'controller') {
      const created = await createControllerCredential({
       db: provisioningDb,
       workspaceId: link.workspace_id,
       name: link.controller_name,
       scopes: parseJsonArray(link.controller_scopes),
       expiresAt: link.controller_expires_at,
       createdBy: link.created_by || null,
      });
      await provisioningDb.unsafe(
       'update workspace_join_links set redeemed_controller_id = $2, updated_at = now() where id = $1',
       [link.id, created.controller.id],
      );
      return { workspace, created };
     }

     const name = String(req.body?.name || '').trim().slice(0, 120) || 'MCP agent';
     const handle = await uniqueAgentHandle(
      link.workspace_id,
      req.body?.handle || name,
      provisioningDb,
     );
     const description = String(req.body?.description || '').trim().slice(0, 500);
     const agentToken = createAgentConnectToken();
     const agentRows = await provisioningDb.unsafe(
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
       // Bind the OBJECT, not a string: porsager turns a stringified ::jsonb
       // bind into a jsonb STRING SCALAR (tests/jsonb-bind-hygiene.test.cjs).
       { joinLinkId: String(link.id), joinedVia: 'join_link' },
       link.created_by || null,
      ],
     );
     const agent = agentRows[0];
     await provisioningDb.unsafe(
      'update workspace_join_links set redeemed_agent_id = $2, updated_at = now() where id = $1',
      [link.id, agent.id],
     );
     return { workspace, agentRows, agent, agentToken };
    },
   });

   if (redemption.state === 'refused') return joinLinkRefused(res);
   if (redemption.state === 'failed') throw redemption.error;

   const { link, value } = redemption;
   const { workspace } = value;
   setJoinJsonHeaders(res);

   if (lane === 'human') {
    if (value.memberRows.length > 0) {
     await runPostCommitEffect('member fanout', async () => {
      notifyDbSubscribers('workspace_members', 'INSERT', value.memberRows);
     });
    }
    await runPostCommitEffect('activity write', () => logJoinLinkActivity({
     workspaceId: link.workspace_id,
     userId,
     eventType: 'join_link_redeemed',
     title: 'A person joined through a join link',
     metadata: { join_link_id: String(link.id), lane: 'human', role: link.role, audience: link.audience },
    }));
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

   if (lane === 'controller') {
    const { created } = value;
    await runPostCommitEffect('activity write', () => logJoinLinkActivity({
     workspaceId: link.workspace_id,
     userId: null,
     eventType: 'join_link_redeemed',
     title: `${created.controller.name} enrolled as a workspace controller`,
     metadata: {
      join_link_id: String(link.id),
      lane: 'controller',
      controller_id: String(created.controller.id),
      grant_kind: 'workspace_control',
     },
    }));
    await runPostCommitEffect('audit write', () => recordAudit({
     workspaceId: link.workspace_id,
     actor: { label: created.controller.name },
     action: 'controller.enrolled',
     target: {
      type: 'workspace_controller',
      id: String(created.controller.id),
      label: created.controller.name,
     },
     after: 'active',
     detail: {
      joinLinkId: String(link.id),
      scopes: created.controller.scopes,
      expiresAt: created.controller.expires_at,
     },
     requestIp: clientIpFromReq ? clientIpFromReq(req) : '',
    }));

    const backendBaseUrl = joinApiBaseUrl(req);
    return res.json({
     data: {
      redeemed: true,
      as: 'controller',
      workspace,
      controller: created.controller,
      credential: {
       token: created.token,
       type: 'bearer',
       shown_once: true,
       expires_at: created.controller.expires_at,
       note: 'Store this now. It is not recoverable and this enrollment link will not work again.',
      },
      mcp: {
       endpoint: mcpEndpoint(backendBaseUrl),
       transport: 'http',
       config: configBlock(backendBaseUrl, CONTROLLER_TOKEN_PLACEHOLDER),
      },
      next: controllerNextSteps(),
     },
     error: null,
    });
   }

   // --- agent lane ---
   const { agentRows, agent, agentToken } = value;
   // publicFarmEnrolledAgent strips connect_token_hash before the row goes out
   // over realtime. The plaintext token was never in the row to begin with.
   await runPostCommitEffect('agent fanout', async () => {
    notifyDbSubscribers('workspace_agents', 'INSERT', agentRows.map(publicFarmEnrolledAgent));
   });
   await runPostCommitEffect('activity write', () => logJoinLinkActivity({
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
   }));

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
