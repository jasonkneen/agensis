'use strict';

// ============================================================================
// server/marketplace-routes.cjs
// ----------------------------------------------------------------------------
// The agent marketplace. Dependencies are INJECTED rather than imported,
// matching every other *-routes.cjs here, so the auth, RBAC and audit contract
// stays single-sourced in index.cjs / backend-core.cjs.
//
// WHAT THESE ROUTES ARE FOR. shared/marketplace.cjs is the security surface;
// these routes exist because the generic /backend/db path cannot run it —
// marketplace_listings and marketplace_hires are deliberately absent from
// ALLOWED_TABLES, so these are the only doors.
//
// ROLES, and why each one:
//   browse            any signed-in user. Listings are published on purpose.
//   publish/unpublish 'manage' on the PUBLISHING workspace. Publishing pushes
//                     a workspace's prose across the tenant boundary (and, for
//                     hire, stands up an offer of the host's own compute) —
//                     the same class of decision as importing, which is
//                     already manage. Audited.
//   copy → templates  'manage' on the RECEIVING workspace, enforced by
//                     reusing importAgentTemplate itself: a copy IS an import
//                     (attacker-influenced prose a teammate's agent will later
//                     speak), so it must go through the same validator, the
//                     same role gate and the same audit write. No second door.
//   hire / end hire   'manage' on the HIRING workspace. A hire is a standing
//                     arrangement with another tenant's agent. Audited in BOTH
//                     workspaces — the host deserves a record that its agent
//                     was hired as much as the hirer deserves one of hiring.
//
// THE HIRE INSERT IS SERVER-AUTHORED, FROM NO CALLER FIELDS. The one existing
// rule — "there is no server-side create-agent route, and there must not be
// one" (AGENTS.md) — is about TEMPLATE INSTANTIATION: caller-supplied prose
// must go through the Agents-window form and the generic insert's column
// guards. A hire is the opposite shape: the caller names a LISTING ID and
// nothing else; every inserted value comes from hiredAgentDraft (which PICKS
// cosmetic fields and carries no prose) or from fixed server-owned constants
// (permission_mode 'default', run_mode 'external', empty prompt, empty
// skills). register_agent and the CursorBuddy provisioner are the precedents.
// tests/marketplace.test.cjs pins the inserted shape.
// ============================================================================

const MAX_LISTINGS_PAGE = 200;
const MAX_LISTINGS_PER_WORKSPACE = 50;

function badRequest(message) {
 return Object.assign(new Error(message), { status: 400 });
}

function conflict(message) {
 return Object.assign(new Error(message), { status: 409 });
}

function notFound(message) {
 return Object.assign(new Error(message), { status: 404 });
}

/** The hire record as the hirer's UI sees it. Explicit projection, never `*`. */
function publicHire(row) {
 if (!row) return null;
 return {
  id: row.id,
  listing_id: row.listing_id || null,
  hirer_workspace_id: row.hirer_workspace_id,
  hired_agent_id: row.hired_agent_id,
  host_workspace_id: row.host_workspace_id || null,
  listing_name: row.listing_name || '',
  status: row.status === 'ended' ? 'ended' : 'active',
  created_at: row.created_at,
  updated_at: row.updated_at,
 };
}

function createMarketplace(deps = {}) {
 const {
  getDb,
  notifyDbSubscribers,
  enforceWorkspaceRole,
  normalizeMarketplaceListing,
  publicMarketplaceListing,
  hiredAgentDraft,
  agentToTemplateDraft,
  buildTemplateExport,
  importAgentTemplate,
  recordAudit,
 } = deps;

 async function audit(entry) {
  if (typeof recordAudit === 'function') await recordAudit(entry);
 }

 /** Every published listing, marketplace-wide. Auth is the only gate. */
 async function listMarketplaceListings({ type } = {}) {
  const filter = type === 'template' || type === 'hire' ? type : null;
  const rows = filter
   ? await getDb().unsafe(
     `select * from marketplace_listings where status = 'published' and listing_type = $1
       order by created_at desc limit $2`,
     [filter, MAX_LISTINGS_PAGE],
    )
   : await getDb().unsafe(
     `select * from marketplace_listings where status = 'published'
       order by created_at desc limit $1`,
     [MAX_LISTINGS_PAGE],
    );
  return rows.map(publicMarketplaceListing);
 }

 /** The publishing workspace's own listings, for the manage surface. */
 async function listWorkspaceMarketplaceListings({ userId, workspaceId } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  await enforceWorkspaceRole(userId, id, 'read');
  const rows = await getDb().unsafe(
   'select * from marketplace_listings where publisher_workspace_id = $1 order by created_at desc limit $2',
   [id, MAX_LISTINGS_PER_WORKSPACE],
  );
  return rows.map(publicMarketplaceListing);
 }

 /**
  * "Share this agent to the marketplace."
  *
  * THE PRIVILEGE-STRIP HAPPENS HERE, exactly as in saveAgentAsTemplate: the
  * row read below is a full workspace_agents record (permission_mode,
  * metadata with host_folders, connect_token_hash — all of it), and
  * agentToTemplateDraft PICKS named fields rather than spreading the row.
  * For a 'hire' listing not even the draft is stored: the validator refuses a
  * body on a hire listing, and the table CHECK refuses it again.
  */
 async function publishMarketplaceListing({ userId, workspaceId, agentId, listing, requestIp } = {}) {
  const id = String(workspaceId || '').trim();
  const agent = String(agentId || '').trim();
  if (!id || !agent) throw badRequest('workspace id and agent id are required');
  await enforceWorkspaceRole(userId, id, 'manage');

  const agents = await getDb().unsafe(
   'select * from workspace_agents where id = $1 and workspace_id = $2 limit 1',
   [agent, id],
  );
  if (!agents[0]) throw notFound('Agent was not found');
  const agentRow = agents[0];

  const meta = listing && typeof listing === 'object' && !Array.isArray(listing) ? listing : {};
  const listingType = String(meta.listingType || 'template');
  const draft = agentToTemplateDraft(agentRow);

  const result = normalizeMarketplaceListing({
   listingType,
   slug: meta.slug || draft.slug,
   name: meta.name || draft.name,
   category: meta.category,
   description: meta.description !== undefined ? meta.description : draft.description,
   capabilities: meta.capabilities,
   // On a template listing the validator takes cosmetics and intent from the
   // body; these are only read on the hire branch.
   purpose: draft.purpose,
   resourceFacets: draft.resourceFacets,
   avatar: draft.avatar,
   accentColor: draft.accentColor,
   template: listingType === 'template' ? draft : undefined,
  });
  if (!result.ok) throw badRequest(result.errors.join('; '));
  const normalized = result.listing;
  const body = normalized.template;

  const count = await getDb().unsafe(
   'select count(*)::int as n from marketplace_listings where publisher_workspace_id = $1',
   [id],
  );
  if (Number(count[0]?.n || 0) >= MAX_LISTINGS_PER_WORKSPACE) {
   throw badRequest(`A workspace can publish at most ${MAX_LISTINGS_PER_WORKSPACE} listings`);
  }

  const rows = await getDb().unsafe(
   `insert into marketplace_listings
      (publisher_workspace_id, slug, listing_type, name, category, description,
       capabilities, handle_hint, system_prompt, soul, instructions, tools,
       skills, purpose, resource_facets, model, run_mode, runtime, avatar,
       accent_color, source_agent_id, fingerprint, status, created_by)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,'published',$23)
    on conflict (publisher_workspace_id, slug) do update set
       listing_type = excluded.listing_type,
       name = excluded.name,
       category = excluded.category,
       description = excluded.description,
       capabilities = excluded.capabilities,
       handle_hint = excluded.handle_hint,
       system_prompt = excluded.system_prompt,
       soul = excluded.soul,
       instructions = excluded.instructions,
       tools = excluded.tools,
       skills = excluded.skills,
       purpose = excluded.purpose,
       resource_facets = excluded.resource_facets,
       model = excluded.model,
       run_mode = excluded.run_mode,
       runtime = excluded.runtime,
       avatar = excluded.avatar,
       accent_color = excluded.accent_color,
       source_agent_id = excluded.source_agent_id,
       fingerprint = excluded.fingerprint,
       status = 'published',
       updated_at = now()
    returning *`,
   [
    id, normalized.slug, normalized.listingType, normalized.name, normalized.category,
    normalized.description,
    // Bound as OBJECTS, never stringified: porsager turns a stringified
    // ::jsonb bind into a jsonb string scalar (tests/jsonb-bind-hygiene).
    normalized.capabilities,
    body ? body.handleHint : '',
    body ? body.systemPrompt : '',
    body ? body.soul : '',
    body ? body.instructions : '',
    body ? body.tools : [],
    body ? body.skills : [],
    normalized.purpose, normalized.resourceFacets,
    body ? body.model : 'auto',
    body ? body.runMode : (agentRow.run_mode || 'builtin'),
    body ? body.runtime : '',
    normalized.avatar, normalized.accentColor,
    normalized.listingType === 'hire' ? agent : null,
    normalized.fingerprint,
    String(userId || ''),
   ],
  );

  await audit({
   workspaceId: id,
   actor: { userId: String(userId || '') },
   action: 'marketplace.listing_published',
   target: { type: 'marketplace_listing', id: String(rows[0]?.id || ''), label: normalized.name },
   after: normalized.listingType,
   detail: { slug: normalized.slug, agent_id: agent },
   requestIp: requestIp || '',
  });

  return publicMarketplaceListing(rows[0]);
 }

 async function unpublishMarketplaceListing({ userId, workspaceId, listingId, requestIp } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(listingId || '').trim();
  if (!id || !target) throw badRequest('workspace id and listing id are required');
  await enforceWorkspaceRole(userId, id, 'manage');
  const rows = await getDb().unsafe(
   'delete from marketplace_listings where id = $1 and publisher_workspace_id = $2 returning *',
   [target, id],
  );
  if (!rows.length) throw notFound('Listing was not found');
  await audit({
   workspaceId: id,
   actor: { userId: String(userId || '') },
   action: 'marketplace.listing_removed',
   target: { type: 'marketplace_listing', id: target, label: rows[0].name || '' },
   detail: { slug: rows[0].slug || '' },
   requestIp: requestIp || '',
  });
  return { id: target, deleted: true };
 }

 /**
  * "Copy this template listing into my workspace's templates."
  *
  * Deliberately routed THROUGH importAgentTemplate: a marketplace copy is an
  * import (prose from outside the workspace that a teammate's agent will later
  * speak), so it gets the same manage gate, the same loud validator refusals
  * and the same agent_template.imported audit row. Building a second, softer
  * door here would be how the import rule stops meaning anything.
  */
 async function copyMarketplaceListing({ userId, workspaceId, listingId, requestIp } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(listingId || '').trim();
  if (!id || !target) throw badRequest('workspace id and listing id are required');

  const rows = await getDb().unsafe(
   `select * from marketplace_listings where id = $1 and status = 'published' limit 1`,
   [target],
  );
  if (!rows[0]) throw notFound('Listing was not found');
  const listing = publicMarketplaceListing(rows[0]);
  if (listing.listingType !== 'template' || !listing.template) {
   throw badRequest('This listing is offered for hire — its definition is not shared and cannot be copied');
  }

  const saved = await importAgentTemplate({
   userId,
   workspaceId: id,
   payload: buildTemplateExport(listing.template),
   requestIp,
  });

  // Popularity is a counter, not a fact anyone depends on — failure to bump it
  // must not fail the copy.
  try {
   await getDb().unsafe(
    'update marketplace_listings set install_count = install_count + 1, updated_at = now() where id = $1',
    [target],
   );
  } catch { /* counter only */ }

  return saved;
 }

 /** A handle not already taken in the workspace: base, base-2, base-3, … */
 async function availableHandle(workspaceId, base) {
  const rows = await getDb().unsafe(
   'select handle from workspace_agents where workspace_id = $1',
   [workspaceId],
  );
  const taken = new Set(rows.map((row) => String(row.handle || '').toLowerCase()).filter(Boolean));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
   const candidate = `${base}-${i}`;
   if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw badRequest('Could not find a free handle for the hired agent');
 }

 /**
  * "Hire this agent."
  *
  * Creates the Connector-shell roster row plus the hire record. Every value
  * written into workspace_agents comes from hiredAgentDraft (cosmetics and
  * intent PICKED from the listing) or is a fixed server-owned constant —
  * empty prompt, empty skills and tools, permission_mode 'default',
  * run_mode 'external', ambient_replies false (a hired agent is a callable
  * capability, not another voice competing in every room). Until the host's
  * runtime serves it, the disconnected-Connector rule applies: turns queue
  * and the server posts its own waiting notice, never an impersonation.
  */
 async function hireMarketplaceListing({ userId, workspaceId, listingId, requestIp } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(listingId || '').trim();
  if (!id || !target) throw badRequest('workspace id and listing id are required');
  await enforceWorkspaceRole(userId, id, 'manage');

  const rows = await getDb().unsafe(
   `select * from marketplace_listings where id = $1 and status = 'published' limit 1`,
   [target],
  );
  if (!rows[0]) throw notFound('Listing was not found');
  const listingRow = rows[0];
  if (listingRow.listing_type !== 'hire') {
   throw badRequest('This listing is a template — copy it instead of hiring it');
  }
  if (String(listingRow.publisher_workspace_id) === id) {
   throw badRequest('This workspace published that listing — the agent is already in its roster');
  }

  const existing = await getDb().unsafe(
   `select id from marketplace_hires where hirer_workspace_id = $1 and listing_id = $2 and status = 'active' limit 1`,
   [id, target],
  );
  if (existing[0]) throw conflict('This workspace has already hired that agent');

  const draft = hiredAgentDraft(listingRow);
  const handle = await availableHandle(id, draft.handle);

  const agentRows = await getDb().unsafe(
   `insert into workspace_agents
      (workspace_id, name, handle, description, system_prompt, soul, instructions,
       tools, skills, purpose, resource_facets, model, run_mode, permission_mode,
       avatar, accent_color, enabled, ambient_replies, created_by, metadata)
    values ($1,$2,$3,$4,'','','','[]'::jsonb,'[]'::jsonb,$5,$6::jsonb,$7,'external','default',$8,$9,true,false,$10,$11::jsonb)
    returning *`,
   [
    id, draft.name, handle, draft.description,
    draft.purpose, draft.resourceFacets,
    draft.model,
    draft.avatar, draft.accentColor,
    String(userId || ''),
    // Server-authored wiring, never caller input: which listing this roster
    // row came from and which host serves it. metadata stays MANAGE_ONLY on
    // the generic path, so a hirer-side editor cannot rewrite the link.
    {
     marketplace_hire: {
      listing_id: target,
      listing_slug: String(listingRow.slug || ''),
      host_workspace_id: String(listingRow.publisher_workspace_id || ''),
      host_agent_id: String(listingRow.source_agent_id || ''),
      hired_at: new Date().toISOString(),
     },
    },
   ],
  );
  const hiredAgent = agentRows[0];
  if (!hiredAgent) throw badRequest('Could not create the hired agent');
  notifyDbSubscribers('workspace_agents', 'INSERT', agentRows);

  const hireRows = await getDb().unsafe(
   `insert into marketplace_hires
      (listing_id, hirer_workspace_id, hired_agent_id, host_workspace_id, host_agent_id, listing_name, created_by)
    values ($1,$2,$3,$4,$5,$6,$7)
    returning *`,
   [
    target, id, hiredAgent.id,
    listingRow.publisher_workspace_id, listingRow.source_agent_id,
    String(listingRow.name || ''), String(userId || ''),
   ],
  );

  try {
   await getDb().unsafe(
    'update marketplace_listings set hire_count = hire_count + 1, updated_at = now() where id = $1',
    [target],
   );
  } catch { /* counter only */ }

  await audit({
   workspaceId: id,
   actor: { userId: String(userId || '') },
   action: 'marketplace.agent_hired',
   target: { type: 'workspace_agent', id: String(hiredAgent.id), label: draft.name },
   after: String(listingRow.slug || ''),
   detail: { listing_id: target },
   requestIp: requestIp || '',
  });
  // The host workspace gets its own record: its agent was hired. The row
  // names the listing, never the hirer's people.
  await audit({
   workspaceId: String(listingRow.publisher_workspace_id || ''),
   actor: { userId: String(userId || '') },
   action: 'marketplace.listing_hired',
   target: { type: 'marketplace_listing', id: target, label: String(listingRow.name || '') },
   detail: { slug: String(listingRow.slug || '') },
   requestIp: requestIp || '',
  });

  return { hire: publicHire(hireRows[0]), agentId: hiredAgent.id };
 }

 async function listMarketplaceHires({ userId, workspaceId } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  await enforceWorkspaceRole(userId, id, 'read');
  const rows = await getDb().unsafe(
   'select * from marketplace_hires where hirer_workspace_id = $1 order by created_at desc limit 200',
   [id],
  );
  return rows.map(publicHire);
 }

 /** End a hire: the record flips to 'ended' and the roster row is disabled. */
 async function endMarketplaceHire({ userId, workspaceId, hireId, requestIp } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(hireId || '').trim();
  if (!id || !target) throw badRequest('workspace id and hire id are required');
  await enforceWorkspaceRole(userId, id, 'manage');

  const rows = await getDb().unsafe(
   `update marketplace_hires set status = 'ended', updated_at = now()
     where id = $1 and hirer_workspace_id = $2 and status = 'active'
    returning *`,
   [target, id],
  );
  if (!rows.length) throw notFound('Hire was not found');

  const agentRows = await getDb().unsafe(
   'update workspace_agents set enabled = false, updated_at = now() where id = $1 and workspace_id = $2 returning *',
   [rows[0].hired_agent_id, id],
  );
  if (agentRows.length) notifyDbSubscribers('workspace_agents', 'UPDATE', agentRows);

  await audit({
   workspaceId: id,
   actor: { userId: String(userId || '') },
   action: 'marketplace.hire_ended',
   target: { type: 'workspace_agent', id: String(rows[0].hired_agent_id || ''), label: rows[0].listing_name || '' },
   detail: { hire_id: target },
   requestIp: requestIp || '',
  });

  return publicHire(rows[0]);
 }

 return {
  listMarketplaceListings,
  listWorkspaceMarketplaceListings,
  publishMarketplaceListing,
  unpublishMarketplaceListing,
  copyMarketplaceListing,
  hireMarketplaceListing,
  listMarketplaceHires,
  endMarketplaceHire,
  publicHire,
 };
}

function mountMarketplaceRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, clientIpFromReq,
  listMarketplaceListings, listWorkspaceMarketplaceListings,
  publishMarketplaceListing, unpublishMarketplaceListing,
  copyMarketplaceListing, hireMarketplaceListing,
  listMarketplaceHires, endMarketplaceHire,
 } = deps;

 const requestIp = (req) => (clientIpFromReq ? clientIpFromReq(req) : '');

 app.get('/backend/marketplace/listings', requireAuth, async (req, res) => {
  try {
   const data = await listMarketplaceListings({ type: req.query?.type });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/marketplace/listings', requireAuth, async (req, res) => {
  try {
   const data = await listWorkspaceMarketplaceListings({ userId: req.userId, workspaceId: req.params.id });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/marketplace/listings', requireAuth, async (req, res) => {
  try {
   const data = await publishMarketplaceListing({
    userId: req.userId,
    workspaceId: req.params.id,
    agentId: req.body?.agentId,
    listing: req.body?.listing ?? req.body,
    requestIp: requestIp(req),
   });
   res.status(201).json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/marketplace/listings/:listingId', requireAuth, async (req, res) => {
  try {
   const data = await unpublishMarketplaceListing({
    userId: req.userId, workspaceId: req.params.id, listingId: req.params.listingId,
    requestIp: requestIp(req),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/marketplace/listings/:listingId/copy', requireAuth, async (req, res) => {
  try {
   const data = await copyMarketplaceListing({
    userId: req.userId, workspaceId: req.params.id, listingId: req.params.listingId,
    requestIp: requestIp(req),
   });
   res.status(201).json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/marketplace/listings/:listingId/hire', requireAuth, async (req, res) => {
  try {
   const data = await hireMarketplaceListing({
    userId: req.userId, workspaceId: req.params.id, listingId: req.params.listingId,
    requestIp: requestIp(req),
   });
   res.status(201).json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/marketplace/hires', requireAuth, async (req, res) => {
  try {
   const data = await listMarketplaceHires({ userId: req.userId, workspaceId: req.params.id });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/marketplace/hires/:hireId/end', requireAuth, async (req, res) => {
  try {
   const data = await endMarketplaceHire({
    userId: req.userId, workspaceId: req.params.id, hireId: req.params.hireId,
    requestIp: requestIp(req),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = {
 createMarketplace,
 mountMarketplaceRoutes,
 publicHire,
 MAX_LISTINGS_PER_WORKSPACE,
};
