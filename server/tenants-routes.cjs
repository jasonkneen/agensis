'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// The system-owner admin surface: tenant accounts, and owner broadcasts.
//
// The ONLY routes in the backend that read ACROSS workspaces and accounts. They
// are authorized by assertSystemOwner (shared/tenant-admin.cjs) and by nothing
// else — no workspace membership, no role, no allow-list of ids, and no email
// taken from the request. The check resolves the caller's email from their
// authenticated userId and compares it to AGENSIS_SYSTEM_OWNER_EMAIL; it refuses
// when that is unset.
//
// The Tenants button being hidden from everyone else in the UI is a nicety.
// THESE CHECKS are the access control, and every route runs its own — a curl
// with a valid non-owner token gets 403 from each of them.
//
// /tenants/access is the one exception, and deliberately so: it answers only for
// the CALLER, which is how the client decides whether to render the button at
// all. assertSystemOwner still runs; only its 403 is translated into
// { owner: false }. Anything else — a DB failure, say — propagates, because a
// broken check is an error, not "not the owner".
//
// Reads are read-only. The one thing this surface can write is an owner
// broadcast, which carries its own audit trail and cannot change anybody's
// account — only add a dismissible message to their UI.

function mountTenantsRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, clientIpFromReq, dbRateLimitBlocked, dbQuery,
  CAMPAIGN_CATEGORIES, assertSendable, assertSystemOwner,
  buildSegmentPreview, campaignMessageDbRateLimiter,
  campaignMessageRateLimiter, createCampaign, describeSegment,
  dismissCampaignMessage, getTenantAccount, listCampaigns,
  listTenantAccounts, listUserCampaignMessages, loadTenantFacts,
  normalizeCampaignInput, normalizeSegment, selectSegmentMatches,
  tenantsDbRateLimiter, tenantsRateLimiter,
 } = deps;

 // --- Tenants (system-owner admin surface) ----------------------------------
 //
 // The only routes in this file that read ACROSS workspaces and accounts. They
 // are authorized by `assertSystemOwner` (shared/tenant-admin.cjs) and by
 // nothing else — no workspace membership, no role, no allow-list of ids, and
 // no email taken from the request. The check resolves the caller's email from
 // their authenticated userId and compares it to AGENSIS_SYSTEM_OWNER_EMAIL;
 // it refuses when that is unset.
 //
 // The Tenants button is hidden from everybody else in the UI. That is a
 // nicety. THESE THREE CHECKS are the access control, and each route runs its
 // own — a curl with a valid non-owner token gets 403 from every one of them.
 //
 // The read routes are read-only: upgrades and credits are still a later pass.
 // The ONE thing this surface can now write is an owner broadcast — see the
 // campaign routes below, which carry their own audit trail and cannot change
 // anybody's account, only add a dismissible message to their UI.

 // Whether the CALLER is the owner. Answers for the caller and nobody else, so
 // it is safe for any signed-in user to ask — it is how the client decides
 // whether to render the button at all, and a 403 there would be a console
 // error on every ordinary user's session. Authorization is still the ONE
 // gate: `assertSystemOwner` runs here exactly as on the data routes, and only
 // its 403 is translated into `{ owner: false }`. Anything else (a DB failure,
 // say) propagates — a broken check is an error, not "not the owner".
 app.get('/backend/tenants/access', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, tenantsRateLimiter, tenantsDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   let owner = true;
   try {
    await assertSystemOwner({ userId: req.userId, db: dbQuery });
   } catch (error) {
    if (error?.status !== 403) throw error;
    owner = false;
   }
   res.json({ data: { owner }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/tenants', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, tenantsRateLimiter, tenantsDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   await assertSystemOwner({ userId: req.userId, db: dbQuery });
   const result = await listTenantAccounts(dbQuery);
   res.json({ data: result, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- Owner broadcasts ----------------------------------------------------
 //
 // The ONLY write routes on this surface, and the first thing in the product
 // that puts one person's words into everybody else's UI. Every one of them
 // runs `assertSystemOwner` — the same gate, in the same place in the handler,
 // as the read routes above.
 //
 // REGISTERED BEFORE '/backend/tenants/:id'. Express matches in order, so
 // '/backend/tenants/campaigns' registered after the parameterised route would
 // be swallowed as an account id and answer 404 for the owner.
 //
 // The audit trail is the tenant_campaigns row itself: created_by, the sender's
 // email as it read at send time, the segment, its plain-English summary, the
 // recipient count, and the frozen recipient list in tenant_campaign_recipients.
 // Not an activity_events row — those are workspace-scoped, and a broadcast
 // belongs to no workspace.

 /** The filters the composer may offer. Ids and labels only — no predicates. */
 app.get('/backend/tenants/campaigns/categories', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, tenantsRateLimiter, tenantsDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   await assertSystemOwner({ userId: req.userId, db: dbQuery });
   res.json({
    data: {
     categories: CAMPAIGN_CATEGORIES.map(({ id, label, days }) => ({ id, label, days: days === true })),
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 /**
  * WHO WOULD RECEIVE THIS. The segment is evaluated server-side and the matched
  * accounts are returned in full, so the owner can read the list before sending
  * rather than trusting a number. Nothing is written.
  */
 app.post('/backend/tenants/campaigns/preview', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, tenantsRateLimiter, tenantsDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   await assertSystemOwner({ userId: req.userId, db: dbQuery });
   const segment = normalizeSegment(req.body?.segment);
   const facts = await loadTenantFacts(dbQuery);
   res.json({ data: buildSegmentPreview(segment, facts), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/tenants/campaigns', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, tenantsRateLimiter, tenantsDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   await assertSystemOwner({ userId: req.userId, db: dbQuery });
   res.json({ data: await listCampaigns(dbQuery), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 /**
  * SEND. Two refusals stand between a mis-click and the whole deployment:
  *
  *   1. the audience is recomputed HERE, from the segment in this request — the
  *      preview's list is never trusted, so a client cannot post a segment of
  *      one and a recipient list of four hundred;
  *   2. `assertSendable` refuses an empty match (nobody to send to) and refuses
  *      a `confirm_recipient_count` that is not exactly the number just
  *      computed — so the count the owner agreed to in the confirm dialog is
  *      the count that actually goes out, and a segment that grew while they
  *      were reading it comes back as a 409 to re-confirm.
  *
  * The jsonb bind is the OBJECT, not a string: porsager turns a stringified
  * bind into a jsonb string scalar even under an explicit cast (see
  * tests/jsonb-bind-hygiene.test.cjs). The Netlify mirror binds the string.
  */
 app.post('/backend/tenants/campaigns', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, tenantsRateLimiter, tenantsDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   const ownerId = await assertSystemOwner({ userId: req.userId, db: dbQuery });
   const input = normalizeCampaignInput(req.body);
   const facts = await loadTenantFacts(dbQuery);
   const matched = selectSegmentMatches(input.segment, facts);
   assertSendable(matched.length, req.body?.confirm_recipient_count);
   const ownerRows = await dbQuery('select email from app_users where id = $1 limit 1', [ownerId]);
   const campaign = await createCampaign(dbQuery, {
    title: input.title,
    body: input.body,
    surface: input.surface,
    segmentBind: input.segment,
    summary: describeSegment(input.segment),
    recipientIds: matched.map((account) => account.user_id),
    createdBy: ownerId,
    createdByEmail: ownerRows?.[0]?.email || '',
   });
   console.log('[campaign] sent', {
    id: campaign.id,
    by: ownerId,
    surface: campaign.surface,
    recipients: campaign.recipient_count,
    segment: campaign.summary,
   });
   res.json({ data: { campaign }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/tenants/:id', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, tenantsRateLimiter, tenantsDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   await assertSystemOwner({ userId: req.userId, db: dbQuery });
   const detail = await getTenantAccount(dbQuery, String(req.params.id || ''));
   if (!detail) return jsonError(res, 404, new Error('No such account'));
   res.json({ data: detail, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- Owner broadcasts, the receiving end -----------------------------------
 //
 // NOT owner-gated, and deliberately on a different path prefix so that stays
 // obvious: every signed-in user reads their OWN messages here. Authorization is
 // the user id from the verified session, bound into both statements — there is
 // no request shape that reads or dismisses somebody else's message, and no
 // route here can create, edit or delete a campaign.

 app.get('/backend/campaign-messages', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, campaignMessageRateLimiter, campaignMessageDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   res.json({ data: await listUserCampaignMessages(dbQuery, req.userId), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/campaign-messages/:id/dismiss', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, campaignMessageRateLimiter, campaignMessageDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   res.json({ data: await dismissCampaignMessage(dbQuery, req.userId, String(req.params.id || '')), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- Agent schedules -----------------------------------------------------
}

module.exports = { mountTenantsRoutes };
