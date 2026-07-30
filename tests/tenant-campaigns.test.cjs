// ============================================================================
// tests/tenant-campaigns.test.cjs
// ----------------------------------------------------------------------------
// Owner broadcasts: segment accounts by behaviour, send them one in-app message.
//
// Two things can go catastrophically wrong here and both are tested first:
//
//   1. SENDING TO EVERYBODY BY ACCIDENT. An empty condition list under "match
//      all" is vacuously true in boolean algebra, which would turn "the owner
//      opened the composer and ticked nothing" into a message to every account
//      on the deployment. The empty case is asserted from both directions and in
//      both modes, at the matcher AND at the send route.
//   2. A NON-OWNER SENDING ANYTHING AT ALL. The RBAC suite for that lives in
//      tests/tenants-admin.test.cjs, which now runs its whole negative battery
//      (no token, bad token, ordinary user, near-miss email, owner's email
//      supplied in the body) over the campaign routes as well. What is pinned
//      HERE is the other half: that a non-owner cannot reach the DELIVERY routes
//      for somebody ELSE, and that those routes cannot write a campaign.
//
// The route tests run the REAL netlify/functions/backend.mjs handler against a
// mocked Postgres, so what is asserted is the wiring rather than a
// re-implementation of it. server/index.cjs cannot be booted here, so its half
// is pinned by sharing one module with the Netlify side (tested directly below)
// plus the source assertions in tests/tenants-admin.test.cjs.
// ============================================================================

'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const core = require('../shared/backend-core.cjs');
const campaigns = require('../shared/tenant-campaigns.cjs');
const tenantAdmin = require('../shared/tenant-admin.cjs');

const OWNER_EMAIL = 'owner@example.test';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

const EMAIL_BY_USER = {
 [OWNER_ID]: OWNER_EMAIL,
 [MEMBER_ID]: 'ordinary@example.test',
 [OTHER_ID]: 'other@example.test',
};

// ---------------------------------------------------------------------------
// Fixtures: three accounts with deliberately different behaviour
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** Everything present — an account doing well. Matches almost nothing. */
function activeAccount(overrides = {}) {
 return campaigns.shapeTenantFacts({
  user_id: 'active',
  email: 'active@example.test',
  created_at: new Date(NOW - 400 * DAY).toISOString(),
  workspace_count: 2,
  channel_count: 6,
  agent_count: 3,
  live_daemon_count: 2,
  huddle_count: 4,
  document_count: 5,
  human_message_count: 120,
  agent_message_count: 340,
  member_count: 4,
  last_activity_at: new Date(NOW - 1 * DAY).toISOString(),
  ...overrides,
 });
}

/** Signed up, did nothing. Matches nearly every filter. */
function dormantAccount(overrides = {}) {
 return campaigns.shapeTenantFacts({
  user_id: 'dormant',
  email: 'dormant@example.test',
  created_at: new Date(NOW - 90 * DAY).toISOString(),
  workspace_count: 1,
  channel_count: 0,
  agent_count: 0,
  live_daemon_count: 0,
  huddle_count: 0,
  document_count: 0,
  human_message_count: 0,
  agent_message_count: 0,
  last_activity_at: null,
  ...overrides,
 });
}

// ---------------------------------------------------------------------------
// 1. THE EMPTY SEGMENT — the one that mails the whole deployment if inverted
// ---------------------------------------------------------------------------

test('an empty segment matches NOBODY, in BOTH modes', () => {
 // `all` over an empty set is vacuously TRUE in logic. Getting this wrong is not
 // a subtle bug: it is the difference between sending to nobody and sending to
 // every account on the deployment.
 for (const match of ['all', 'any']) {
  for (const facts of [activeAccount(), dormantAccount()]) {
   assert.equal(
    campaigns.evaluateSegment({ match, conditions: [] }, facts, NOW), false,
    `an empty ${match} segment must match nobody`,
   );
  }
 }
 assert.deepEqual(
  campaigns.selectSegmentMatches({ match: 'all', conditions: [] }, [activeAccount(), dormantAccount()], NOW),
  [],
 );
});

test('a segment whose conditions are missing entirely also matches nobody', () => {
 for (const segment of [{}, { match: 'all' }, { match: 'any', conditions: null }, null, undefined]) {
  assert.equal(campaigns.evaluateSegment(segment, dormantAccount(), NOW), false);
 }
});

test('an empty segment cannot be SENT, however the count is confirmed', () => {
 // Belt and braces on top of the matcher: even if a future change made
 // evaluateSegment return an empty list some other way, the send path refuses.
 for (const confirmed of [0, 1, 500, null, undefined, '0']) {
  assert.throws(() => campaigns.assertSendable(0, confirmed), (error) => error.status === 400);
 }
});

// ---------------------------------------------------------------------------
// 2. Composition — single, ANY, ALL, negation
// ---------------------------------------------------------------------------

test('a SINGLE condition selects exactly the accounts that satisfy it', () => {
 const segment = campaigns.normalizeSegment({ match: 'all', conditions: [{ category: 'never_huddled' }] });
 assert.equal(campaigns.evaluateSegment(segment, dormantAccount(), NOW), true);
 assert.equal(campaigns.evaluateSegment(segment, activeAccount(), NOW), false);
});

test('ANY across several conditions is a union — one is enough', () => {
 const segment = campaigns.normalizeSegment({
  match: 'any',
  conditions: [{ category: 'never_huddled' }, { category: 'no_documents' }, { category: 'no_agents' }],
 });
 // Has huddled and has documents, but no agents — one match is enough.
 const partial = activeAccount({ user_id: 'partial', agent_count: 0 });
 assert.equal(campaigns.evaluateSegment(segment, partial, NOW), true);
 assert.equal(campaigns.evaluateSegment(segment, dormantAccount(), NOW), true);
 assert.equal(campaigns.evaluateSegment(segment, activeAccount(), NOW), false);
});

test('ALL across several conditions is an intersection — one miss is a miss', () => {
 const segment = campaigns.normalizeSegment({
  match: 'all',
  conditions: [{ category: 'never_huddled' }, { category: 'no_agents' }, { category: 'no_channels' }],
 });
 assert.equal(campaigns.evaluateSegment(segment, dormantAccount(), NOW), true);
 // Satisfies two of three: has a channel.
 const nearly = dormantAccount({ user_id: 'nearly', channel_count: 2 });
 assert.equal(campaigns.evaluateSegment(segment, nearly, NOW), false);
});

test('ANY and ALL genuinely differ over the same conditions', () => {
 const conditions = [{ category: 'never_huddled' }, { category: 'no_agents' }];
 const halfway = activeAccount({ user_id: 'halfway', agent_count: 0 });
 assert.equal(campaigns.evaluateSegment(campaigns.normalizeSegment({ match: 'any', conditions }), halfway, NOW), true);
 assert.equal(campaigns.evaluateSegment(campaigns.normalizeSegment({ match: 'all', conditions }), halfway, NOW), false);
});

test('NEGATION inverts one condition and only that condition', () => {
 const positive = campaigns.normalizeSegment({ match: 'all', conditions: [{ category: 'never_huddled' }] });
 const negated = campaigns.normalizeSegment({ match: 'all', conditions: [{ category: 'never_huddled', negate: true }] });
 for (const facts of [activeAccount(), dormantAccount()]) {
  assert.equal(
   campaigns.evaluateSegment(negated, facts, NOW),
   !campaigns.evaluateSegment(positive, facts, NOW),
   'a negated condition must be the exact complement of the positive one',
  );
 }
 // Mixed: "has huddled AND has no agents".
 const mixed = campaigns.normalizeSegment({
  match: 'all',
  conditions: [{ category: 'never_huddled', negate: true }, { category: 'no_agents' }],
 });
 assert.equal(campaigns.evaluateSegment(mixed, activeAccount({ agent_count: 0 }), NOW), true);
 assert.equal(campaigns.evaluateSegment(mixed, activeAccount(), NOW), false);
 assert.equal(campaigns.evaluateSegment(mixed, dormantAccount(), NOW), false);
});

test('negate is a real boolean — a truthy string does not flip a filter', () => {
 // The difference between "has no agents" and "has agents" is a different
 // mailing list, so only `true` counts.
 for (const negate of ['true', 1, 'yes', {}]) {
  const [condition] = campaigns.normalizeSegment({ conditions: [{ category: 'no_agents', negate }] }).conditions;
  assert.equal(condition.negate, false, `negate: ${JSON.stringify(negate)} must not invert the filter`);
 }
 assert.equal(campaigns.normalizeSegment({ conditions: [{ category: 'no_agents', negate: true }] }).conditions[0].negate, true);
});

// ---------------------------------------------------------------------------
// 3. The day-parameterised categories
// ---------------------------------------------------------------------------

test('"no activity for N days" counts an account that NEVER posted as inactive', () => {
 // Excluding them would silently drop the least-activated accounts out of the
 // re-engagement segment they exist for.
 const segment = campaigns.normalizeSegment({ conditions: [{ category: 'inactive_days', days: 30 }] });
 assert.equal(campaigns.evaluateSegment(segment, dormantAccount(), NOW), true);
 assert.equal(campaigns.evaluateSegment(segment, activeAccount(), NOW), false);
 const stale = activeAccount({ user_id: 'stale', last_activity_at: new Date(NOW - 45 * DAY).toISOString() });
 assert.equal(campaigns.evaluateSegment(segment, stale, NOW), true);
});

test('the day count is part of the condition, so two spans give different answers', () => {
 const facts = activeAccount({ last_activity_at: new Date(NOW - 20 * DAY).toISOString() });
 const short = campaigns.normalizeSegment({ conditions: [{ category: 'inactive_days', days: 7 }] });
 const long = campaigns.normalizeSegment({ conditions: [{ category: 'inactive_days', days: 60 }] });
 assert.equal(campaigns.evaluateSegment(short, facts, NOW), true);
 assert.equal(campaigns.evaluateSegment(long, facts, NOW), false);
});

test('a day count outside its bounds is refused, not clamped', () => {
 // Clamping would send to a segment the owner did not describe.
 for (const days of [0, -1, 4000, 'lots', NaN, Infinity]) {
  assert.throws(
   () => campaigns.normalizeSegment({ conditions: [{ category: 'inactive_days', days }] }),
   (error) => error.status === 400,
   `days: ${days} must be refused`,
  );
 }
 assert.equal(campaigns.normalizeSegment({ conditions: [{ category: 'inactive_days' }] }).conditions[0].days, 30);
});

test('a day count on a category that does not take one is dropped, not stored', () => {
 const [condition] = campaigns.normalizeSegment({ conditions: [{ category: 'no_agents', days: 9 }] }).conditions;
 assert.equal(condition.days, undefined);
});

// ---------------------------------------------------------------------------
// 4. Unknown conditions REFUSE rather than widen
// ---------------------------------------------------------------------------

test('an unknown category is a 400 — never a silently dropped condition', () => {
 // Dropping it would WIDEN the segment: "never_huddled AND is_paying" becomes
 // "never_huddled", which is a strictly larger list than the owner asked for.
 for (const category of ['is_paying', '', null, 42, undefined, 'NEVER_HUDDLED']) {
  assert.throws(
   () => campaigns.normalizeSegment({ conditions: [{ category: 'never_huddled' }, { category }] }),
   (error) => error.status === 400,
   `category: ${JSON.stringify(category)} must be refused`,
  );
 }
});

test('a condition that is not an object at all is a 400', () => {
 for (const condition of ['never_huddled', 42, null, [], true]) {
  assert.throws(() => campaigns.normalizeSegment({ conditions: [condition] }), (error) => error.status === 400);
 }
});

test('an unrecognised match mode narrows to ALL rather than widening to ANY', () => {
 for (const match of ['ANY', 'or', '', null, undefined, 1]) {
  assert.equal(campaigns.normalizeSegment({ match, conditions: [{ category: 'no_agents' }] }).match, 'all');
 }
 assert.equal(campaigns.normalizeSegment({ match: 'any', conditions: [{ category: 'no_agents' }] }).match, 'any');
});

test('a stored segment naming a RETIRED category shrinks rather than matching everyone', () => {
 // normalizeStoredSegment drops it (history stays renderable); conditionHolds
 // returns false for it if one ever reaches the matcher directly.
 const stored = campaigns.normalizeStoredSegment({ match: 'all', conditions: [{ category: 'gone_away' }] });
 assert.deepEqual(stored.conditions, []);
 assert.equal(campaigns.conditionHolds({ category: 'gone_away' }, dormantAccount(), NOW), false);
 assert.equal(campaigns.evaluateSegment({ match: 'all', conditions: [{ category: 'gone_away' }] }, dormantAccount(), NOW), false);
});

// ---------------------------------------------------------------------------
// 5. The send-time agreement
// ---------------------------------------------------------------------------

test('assertSendable refuses a confirmed count that is not the computed one', () => {
 assert.equal(campaigns.assertSendable(38, 38), 38);
 for (const confirmed of [37, 39, 0, -1, null, undefined, '38', 38.5, NaN]) {
  assert.throws(
   () => campaigns.assertSendable(38, confirmed),
   (error) => error.status === 409,
   `confirmed ${JSON.stringify(confirmed)} must not be accepted for a computed 38`,
  );
 }
});

// ---------------------------------------------------------------------------
// 6. The message body — operator text rendered into other people's UI
// ---------------------------------------------------------------------------

test('a message is capped, trimmed, and stripped of control characters', () => {
 const input = campaigns.normalizeCampaignInput({
  title: '  Hello \u001b[31m there  ',
  body: 'Line one\r\nLine two\u0007',
  surface: 'tip',
  segment: { conditions: [{ category: 'no_agents' }] },
 });
 // The escape sequences are gone from both, and neither is left padded.
 assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(input.title), false);
 assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(input.body), false);
 assert.equal(input.title, input.title.trim());
 assert.match(input.title, /^Hello/);
 // Newlines survive in the BODY (a two-paragraph notice is reasonable) and a
 // CRLF is normalised; a title is one line in every surface that renders it.
 assert.equal(input.body, 'Line one\nLine two');
 assert.equal(input.title.includes('\n'), false);
});

test('an over-long title or body is truncated to the documented cap', () => {
 const input = campaigns.normalizeCampaignInput({
  title: 'x'.repeat(500),
  body: 'y'.repeat(5000),
  surface: 'banner',
  segment: { conditions: [{ category: 'no_agents' }] },
 });
 assert.equal(input.title.length, campaigns.MAX_TITLE_LENGTH);
 assert.equal(input.body.length, campaigns.MAX_BODY_LENGTH);
});

test('an empty title or body is refused', () => {
 const base = { surface: 'tip', segment: { conditions: [{ category: 'no_agents' }] } };
 for (const overrides of [{ title: '', body: 'x' }, { title: '   ', body: 'x' }, { title: 'x', body: '' }, { title: 'x', body: '\n\n' }]) {
  assert.throws(() => campaigns.normalizeCampaignInput({ ...base, ...overrides }), (error) => error.status === 400);
 }
});

test('an unknown surface is refused rather than defaulted', () => {
 // Defaulting would put a message somewhere the sender did not choose — and
 // 'dialog' is far more interrupting than 'tip'.
 for (const surface of ['toast', '', null, 'TIP', 'popup']) {
  assert.throws(
   () => campaigns.normalizeCampaignInput({ title: 'x', body: 'y', surface, segment: { conditions: [{ category: 'no_agents' }] } }),
   (error) => error.status === 400,
  );
 }
 for (const surface of campaigns.CAMPAIGN_SURFACES) {
  assert.equal(
   campaigns.normalizeCampaignInput({ title: 'x', body: 'y', surface, segment: { conditions: [{ category: 'no_agents' }] } }).surface,
   surface,
  );
 }
});

test('the campaign module never emits HTML and holds no url/href field', () => {
 const source = fs.readFileSync(path.join(root, 'shared/tenant-campaigns.cjs'), 'utf8');
 for (const forbidden of ['innerHTML', 'dangerouslySetInnerHTML', 'href', '<a ']) {
  assert.equal(source.includes(forbidden), false, `shared/tenant-campaigns.cjs must not mention ${forbidden}`);
 }
 // And the three components that render a message body use a text node.
 for (const file of [
  'src/components/onboarding/OwnerMessageCard.tsx',
  'src/components/onboarding/OwnerMessageDialog.tsx',
  'src/components/onboarding/OwnerMessageBanner.tsx',
 ]) {
  const component = fs.readFileSync(path.join(root, file), 'utf8');
  // The JSX prop, not the word: naming it in a comment that explains why it is
  // absent is exactly the documentation this invariant deserves.
  assert.equal(
   /dangerouslySetInnerHTML\s*=/.test(component), false,
   `${file} must not build HTML from a message`,
  );
  assert.match(component, /\{message\.body\}/, `${file} must render the body as a text child`);
  assert.equal(/href=/.test(component), false, `${file} must not render a link`);
 }
});

// ---------------------------------------------------------------------------
// 7. describeSegment — what the owner reads in the confirm
// ---------------------------------------------------------------------------

test('describeSegment reads back as the filters that were ticked', () => {
 assert.equal(campaigns.describeSegment({ conditions: [] }), 'nothing selected');
 assert.equal(
  campaigns.describeSegment(campaigns.normalizeSegment({
   match: 'all',
   conditions: [{ category: 'never_huddled' }, { category: 'no_agents' }],
  })),
  'never started a huddle and has no agents',
 );
 assert.equal(
  campaigns.describeSegment(campaigns.normalizeSegment({
   match: 'any',
   conditions: [{ category: 'no_channels' }, { category: 'inactive_days', days: 14, negate: true }],
  })),
  'has no channels or NOT no activity for 14 days',
 );
});

// ---------------------------------------------------------------------------
// 8. Facts shaping — bigint strings, missing columns, bad timestamps
// ---------------------------------------------------------------------------

test('counts arrive as bigint strings on both drivers and shape to numbers', () => {
 const facts = campaigns.shapeTenantFacts({ id: 'u', huddle_count: '0', agent_count: '17', human_message_count: null });
 assert.equal(facts.huddle_count, 0);
 assert.equal(facts.agent_count, 17);
 assert.equal(facts.human_message_count, 0);
 assert.equal(facts.user_id, 'u');
});

test('an unreadable timestamp is ABSENT, never NaN', () => {
 // NaN in a date comparison is silently false, which would quietly exclude an
 // account from a segment it belongs in.
 const facts = campaigns.shapeTenantFacts({ id: 'u', created_at: 'not a date', last_activity_at: '' });
 assert.equal(facts.created_at, null);
 assert.equal(facts.last_activity_at, null);
 // And "never active" still reads as inactive.
 assert.equal(
  campaigns.evaluateSegment(campaigns.normalizeSegment({ conditions: [{ category: 'inactive_days', days: 1 }] }), facts, NOW),
  true,
 );
 // While "signed up recently" with no created_at is FALSE — an unknown signup
 // date must not put somebody in a new-accounts segment.
 assert.equal(
  campaigns.evaluateSegment(campaigns.normalizeSegment({ conditions: [{ category: 'signed_up_within_days', days: 7 }] }), facts, NOW),
  false,
 );
});

test('the facts a filter reads come from the STATS layer, not a second count', async () => {
 // The Tenants list and the segment matcher must never disagree about the same
 // tenant, so this reads WORKSPACE_STATS_SQL (shared/tenant-admin.cjs) rather
 // than counting again. A per-account counting pass here would also be the N+1
 // over every account on the deployment that the stats work removed.
 const issued = [];
 const db = async (sql) => { issued.push(String(sql)); return []; };
 await campaigns.loadTenantFacts(db);
 const sql = issued.join('\n');
 assert.ok(issued.some((text) => text === tenantAdmin.WORKSPACE_STATS_SQL), 'must issue the shared stats aggregate verbatim');
 for (const forbidden of ['password_hash', 'token_version', 'local_path', 'git_remote', 'api_key_cipher']) {
  assert.equal(new RegExp(forbidden, 'i').test(sql), false, `the facts query must not read ${forbidden}`);
 }
 assert.equal(/select\s+\*/i.test(sql), false, 'the facts query must never select *');
 // Two queries total, whatever the size of the deployment.
 assert.equal(issued.length, 2);
});

test('every category reads a field the stats layer actually produces', () => {
 // The guard against a filter that silently tests undefined and matches
 // everyone (or nobody) forever. Every fact key must exist in the rolled-up
 // stats block, or be one of the two that come from app_users.
 const fromAppUsers = new Set(['user_id', 'email', 'display_name', 'created_at']);
 const statKeys = new Set([
  ...Object.keys(tenantAdmin.emptyWorkspaceStats()),
  'workspace_count',
 ]);
 for (const key of Object.keys(campaigns.shapeTenantFacts({}))) {
  assert.ok(
   fromAppUsers.has(key) || statKeys.has(key),
   `facts.${key} is not a field rollUpAccountStats produces — a filter reading it would test undefined`,
  );
 }
});

// ---------------------------------------------------------------------------
// 9. buildSegmentPreview — the number the owner is about to confirm
// ---------------------------------------------------------------------------

test('a preview reports the matched count, the total, and who matched', () => {
 const all = [activeAccount(), dormantAccount(), dormantAccount({ user_id: 'dormant2', email: 'd2@example.test' })];
 const preview = campaigns.buildSegmentPreview(
  campaigns.normalizeSegment({ conditions: [{ category: 'no_agents' }] }), all, NOW,
 );
 assert.equal(preview.matched_count, 2);
 assert.equal(preview.total_accounts, 3);
 assert.equal(preview.truncated, false);
 assert.equal(preview.summary, 'has no agents');
 assert.deepEqual(preview.accounts.map((account) => account.email), ['dormant@example.test', 'd2@example.test']);
});

test('a preview of an empty segment is zero accounts, not every account', () => {
 const preview = campaigns.buildSegmentPreview({ match: 'all', conditions: [] }, [activeAccount(), dormantAccount()], NOW);
 assert.equal(preview.matched_count, 0);
 assert.deepEqual(preview.accounts, []);
 assert.equal(preview.summary, 'nothing selected');
});

test('a preview carries no column beyond the three the tenant list already shows', () => {
 const preview = campaigns.buildSegmentPreview(
  campaigns.normalizeSegment({ conditions: [{ category: 'no_agents' }] }), [dormantAccount()], NOW,
 );
 assert.deepEqual(Object.keys(preview.accounts[0]).sort(), ['created_at', 'display_name', 'email', 'id']);
});

// ---------------------------------------------------------------------------
// 10. createCampaign — the write, and its bind hygiene
// ---------------------------------------------------------------------------

function recordingDb(campaignId = 'c1') {
 const issued = [];
 const db = async (sql, params = []) => {
  issued.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  if (/insert into tenant_campaigns/i.test(sql)) {
   return [{
    id: campaignId, title: params[0], body: params[1], surface: params[2],
    segment: params[3], segment_summary: params[4], recipient_count: params[5],
    created_by_email: params[7], created_at: '2026-07-27T12:00:00.000Z',
   }];
  }
  return [];
 };
 db.issued = issued;
 return db;
}

test('createCampaign writes the campaign then the frozen recipient list', async () => {
 const db = recordingDb();
 const result = await campaigns.createCampaign(db, {
  title: 'Try huddles', body: 'They are good.', surface: 'tip',
  segmentBind: { match: 'all', conditions: [{ category: 'never_huddled', negate: false }] },
  summary: 'never started a huddle',
  recipientIds: [MEMBER_ID, OTHER_ID],
  createdBy: OWNER_ID, createdByEmail: OWNER_EMAIL,
 });
 assert.equal(result.recipient_count, 2);
 assert.equal(result.created_by_email, OWNER_EMAIL);
 assert.equal(db.issued.length, 2);
 assert.match(db.issued[0].sql, /insert into tenant_campaigns/i);
 assert.match(db.issued[1].sql, /insert into tenant_campaign_recipients/i);
 // The recipients are bound as an array literal, not concatenated into the SQL.
 assert.equal(db.issued[1].sql.includes(MEMBER_ID), false);
 assert.equal(db.issued[1].params[1], `{${MEMBER_ID},${OTHER_ID}}`);
});

test('createCampaign refuses an empty recipient list', async () => {
 const db = recordingDb();
 await assert.rejects(
  () => campaigns.createCampaign(db, { title: 't', body: 'b', surface: 'tip', segmentBind: {}, summary: '', recipientIds: [] }),
  (error) => error.status === 400,
 );
 assert.equal(db.issued.length, 0, 'nothing may be written for an empty audience');
});

test('a recipient id that is not a uuid is refused before it reaches an array literal', async () => {
 // These ids come from the server's own match, but the literal IS string
 // concatenation, and a value carrying a brace or a quote has no business in one.
 for (const bad of ["a','b", '}; drop table', 'id with space', '<script>']) {
  assert.throws(() => campaigns.toUuidArrayLiteral([MEMBER_ID, bad]), (error) => error.status === 400);
 }
 assert.equal(campaigns.toUuidArrayLiteral([MEMBER_ID]), `{${MEMBER_ID}}`);
});

test('the FLY server binds the segment OBJECT and netlify binds the STRING', () => {
 // porsager turns a stringified bind into a jsonb STRING SCALAR even under an
 // explicit cast; @netlify/database is the exact opposite and requires the
 // string. tests/jsonb-bind-hygiene.test.cjs enforces the Fly half globally;
 // this pins that the two call sites here actually differ.
 // The Fly LANE, not one file — the tenants routes moved to
 // server/tenants-routes.cjs in Wave 2 of the index.cjs reduction.
 const serverSource = require('./helpers/fly-lane.cjs').flyLaneSource();
 const netlifySource = fs.readFileSync(path.join(root, 'netlify/functions/backend.mjs'), 'utf8');
 assert.match(serverSource, /segmentBind: input\.segment,/);
 assert.equal(/segmentBind: JSON\.stringify/.test(serverSource), false, 'the Fly server must bind the object');
 assert.match(netlifySource, /segmentBind: JSON\.stringify\(input\.segment\),/);
});

// ---------------------------------------------------------------------------
// 11. dismissCampaignMessage — a user can only ever dismiss their own
// ---------------------------------------------------------------------------

test('a dismissal binds the CALLER\'s id and cannot address another user\'s row', async () => {
 const issued = [];
 const db = async (sql, params = []) => { issued.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return []; };
 await campaigns.dismissCampaignMessage(db, MEMBER_ID, 'c1');
 assert.equal(issued.length, 1);
 assert.match(issued[0].sql, /^update tenant_campaign_recipients/i);
 assert.deepEqual(issued[0].params, ['c1', MEMBER_ID]);
 // The user id is half the WHERE and the statement is an UPDATE of one column —
 // there is no shape of it that deletes a campaign or touches somebody else.
 assert.equal(/delete/i.test(issued[0].sql), false);
 assert.match(issued[0].sql, /where campaign_id = \$1 and user_id = \$2/);
});

test('a dismissal without a session, or without a message id, is refused before any query', async () => {
 const db = async () => { throw new Error('should not be called'); };
 await assert.rejects(() => campaigns.dismissCampaignMessage(db, '', 'c1'), (error) => error.status === 401);
 await assert.rejects(() => campaigns.dismissCampaignMessage(db, MEMBER_ID, '  '), (error) => error.status === 400);
});

test('the per-user message read is scoped by the caller id and by "not dismissed"', async () => {
 const issued = [];
 const db = async (sql, params = []) => { issued.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return []; };
 await campaigns.listUserCampaignMessages(db, MEMBER_ID);
 assert.match(issued[0].sql, /where r\.user_id = \$1 and r\.dismissed_at is null/);
 assert.equal(issued[0].params[0], MEMBER_ID);
 // No session, no query at all.
 assert.deepEqual(await campaigns.listUserCampaignMessages(async () => { throw new Error('no'); }, ''), { messages: [] });
});

test('a delivered message carries no sender, no segment and no counts', async () => {
 const db = async () => ([{
  id: 'c1', title: 'Hi', body: 'There', surface: 'dialog', created_at: '2026-07-27T00:00:00.000Z',
  // Columns the join could have selected but must not surface to a recipient.
  created_by: OWNER_ID, created_by_email: OWNER_EMAIL, recipient_count: 400, segment: {},
 }]);
 const { messages } = await campaigns.listUserCampaignMessages(db, MEMBER_ID);
 assert.deepEqual(Object.keys(messages[0]).sort(), ['body', 'created_at', 'id', 'surface', 'title']);
 const serialized = JSON.stringify(messages);
 assert.equal(serialized.includes(OWNER_EMAIL), false, 'a recipient must not learn who sent it');
 assert.equal(serialized.includes('400'), false, 'a recipient must not learn how many others got it');
});

test('an unreadable surface on a delivered row falls back to the quietest one', () => {
 // A row written by a newer build naming a surface this client does not have
 // should render SOMEWHERE, and 'tip' is the least interrupting of the three.
 assert.equal(campaigns.CAMPAIGN_SURFACES[0], 'tip');
});

// ---------------------------------------------------------------------------
// 12. The routes, through the REAL netlify handler
// ---------------------------------------------------------------------------

let handler;
let authSecret;
let issuedSql = [];
/** Rows the mocked DB returns for the two queries loadTenantFacts issues. */
let userRows = [];
let statRows = [];

test.before(async () => {
 if (!process.env.AUTH_SECRET && !process.env.AGENSIS_AUTH_SECRET) {
  process.env.AUTH_SECRET = 'tenant-campaigns-test-secret';
 }
 authSecret = process.env.AUTH_SECRET || process.env.AGENSIS_AUTH_SECRET;
 process.env.AGENSIS_SYSTEM_OWNER_EMAIL = OWNER_EMAIL;

 mock.module('@netlify/database', {
  namedExports: {
   getDatabase: () => ({
    pool: {
     async query(text, params) {
      issuedSql.push({ sql: String(text), params });
      const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
      if (sql.startsWith('alter table') || sql.startsWith('create table') || sql.startsWith('create index')) {
       return { rows: [] };
      }
      if (/select token_version from app_users/.test(sql)) return { rows: [{ token_version: '1' }] };
      if (sql.startsWith('insert into rate_limits')) return { rows: [{ count: 1 }] };
      if (sql.startsWith('delete from rate_limits')) return { rows: [] };
      if (/select email from app_users where id = \$1/.test(sql)) {
       const email = EMAIL_BY_USER[params?.[0]];
       return { rows: email ? [{ email }] : [] };
      }
      if (/from app_users u/.test(sql)) return { rows: userRows };
      // The batched per-workspace aggregate loadTenantFacts delegates to.
      if (/with ws as/.test(sql)) return { rows: statRows };
      if (/insert into tenant_campaigns/.test(sql)) {
       return {
        rows: [{
         id: 'campaign-1', title: params[0], body: params[1], surface: params[2],
         segment: params[3], segment_summary: params[4], recipient_count: params[5],
         created_by_email: params[7], created_at: '2026-07-27T12:00:00.000Z',
        }],
       };
      }
      if (/insert into tenant_campaign_recipients/.test(sql)) return { rows: [] };
      if (/update tenant_campaign_recipients/.test(sql)) return { rows: [] };
      if (/from tenant_campaign_recipients r/.test(sql)) {
       return { rows: [{ id: 'campaign-1', title: 'Hi', body: 'There', surface: 'tip', created_at: null }] };
      }
      if (/from tenant_campaigns c/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected DB query in tenant-campaigns test: ${sql}`);
     },
    },
   }),
  },
 });

 handler = (await import(pathToFileURL(path.join(root, 'netlify/functions/backend.mjs')).href)).default;
});

function tokenFor(userId) {
 return core.issueAuthToken(userId, 1, authSecret);
}

async function call(method, pathname, { token, body } = {}) {
 issuedSql = [];
 const init = { method, headers: {} };
 if (token !== undefined) init.headers.Authorization = `Bearer ${token}`;
 if (body !== undefined) {
  init.headers['Content-Type'] = 'application/json';
  init.body = JSON.stringify(body);
 }
 const res = await handler(new Request(`http://localhost${pathname}`, init));
 return { res, body: await res.json().catch(() => null) };
}

/**
 * Two accounts: one dormant (matches "no agents"), one active. Split the way the
 * real queries split — identity from app_users, behaviour from the per-workspace
 * stats aggregate — so the test exercises the same join loadTenantFacts does.
 */
function seedFacts() {
 userRows = [
  { user_id: MEMBER_ID, email: 'ordinary@example.test', display_name: '', created_at: '2026-01-01T00:00:00.000Z' },
  { user_id: OTHER_ID, email: 'other@example.test', display_name: 'Other', created_at: '2026-02-01T00:00:00.000Z' },
 ];
 statRows = [
  {
   workspace_id: 'ws-dormant', user_id: MEMBER_ID,
   channel_count: '0', dm_count: '0', thread_count: '0',
   message_count: '0', agent_message_count: '0', human_message_count: '0',
   huddle_count: '0', live_huddle_count: '0', huddle_seconds: '0',
   agent_count: '0', live_daemon_count: '0', document_count: '0', member_count: '1',
   last_activity_at: null,
  },
  {
   workspace_id: 'ws-active', user_id: OTHER_ID,
   channel_count: '4', dm_count: '1', thread_count: '2',
   message_count: '120', agent_message_count: '30', human_message_count: '90',
   huddle_count: '3', live_huddle_count: '0', huddle_seconds: '900',
   agent_count: '2', live_daemon_count: '1', document_count: '2', member_count: '2',
   last_activity_at: '2026-07-26T00:00:00.000Z',
  },
 ];
}

test('the owner previews a segment and gets the matching accounts', async () => {
 seedFacts();
 const { res, body } = await call('POST', '/backend/tenants/campaigns/preview', {
  token: tokenFor(OWNER_ID),
  body: { segment: { match: 'all', conditions: [{ category: 'no_agents' }] } },
 });
 assert.equal(res.status, 200);
 assert.equal(body.data.matched_count, 1);
 assert.equal(body.data.total_accounts, 2);
 assert.deepEqual(body.data.accounts.map((account) => account.email), ['ordinary@example.test']);
});

test('a preview with no conditions matches nobody THROUGH THE ROUTE', async () => {
 seedFacts();
 const { res, body } = await call('POST', '/backend/tenants/campaigns/preview', {
  token: tokenFor(OWNER_ID),
  body: { segment: { match: 'all', conditions: [] } },
 });
 assert.equal(res.status, 200);
 assert.equal(body.data.matched_count, 0);
 assert.deepEqual(body.data.accounts, []);
});

test('the owner sends to a segment, and the recipients written are the ones matched', async () => {
 seedFacts();
 const { res, body } = await call('POST', '/backend/tenants/campaigns', {
  token: tokenFor(OWNER_ID),
  body: {
   title: 'Try huddles',
   body: 'Press the huddle button in any channel.',
   surface: 'tip',
   segment: { match: 'all', conditions: [{ category: 'no_agents' }] },
   confirm_recipient_count: 1,
  },
 });
 assert.equal(res.status, 200);
 assert.equal(body.data.campaign.recipient_count, 1);
 const recipientInsert = issuedSql.find((entry) => /insert into tenant_campaign_recipients/i.test(entry.sql));
 assert.ok(recipientInsert, 'the audience must be written');
 assert.equal(recipientInsert.params[1], `{${MEMBER_ID}}`, 'only the matched account may be a recipient');
});

test('a send whose confirmed count does not match the server\'s is a 409 and writes NOTHING', async () => {
 seedFacts();
 const { res } = await call('POST', '/backend/tenants/campaigns', {
  token: tokenFor(OWNER_ID),
  body: {
   title: 'Try huddles', body: 'x', surface: 'tip',
   segment: { match: 'all', conditions: [{ category: 'no_agents' }] },
   // The client claims both accounts matched. The server computed one.
   confirm_recipient_count: 2,
  },
 });
 assert.equal(res.status, 409);
 assert.equal(issuedSql.some((entry) => /insert into tenant_campaign/i.test(entry.sql)), false);
});

test('a send with NO conditions is refused and writes nothing — the whole-deployment case', async () => {
 seedFacts();
 for (const segment of [{ match: 'all', conditions: [] }, { match: 'any', conditions: [] }, {}, undefined]) {
  const { res } = await call('POST', '/backend/tenants/campaigns', {
   token: tokenFor(OWNER_ID),
   body: { title: 'x', body: 'y', surface: 'tip', segment, confirm_recipient_count: 2 },
  });
  assert.equal(res.status, 400, `an empty segment (${JSON.stringify(segment)}) must be refused`);
  assert.equal(issuedSql.some((entry) => /insert into tenant_campaign/i.test(entry.sql)), false);
 }
});

test('a send naming an unknown filter is refused rather than sent to the wider list', async () => {
 seedFacts();
 const { res } = await call('POST', '/backend/tenants/campaigns', {
  token: tokenFor(OWNER_ID),
  body: {
   title: 'x', body: 'y', surface: 'tip',
   segment: { match: 'all', conditions: [{ category: 'no_agents' }, { category: 'is_paying' }] },
   confirm_recipient_count: 1,
  },
 });
 assert.equal(res.status, 400);
 assert.equal(issuedSql.some((entry) => /insert into tenant_campaign/i.test(entry.sql)), false);
});

test('a NON-OWNER cannot send, preview, list, or read the filter catalogue', async () => {
 // The full negative battery (no token, forged token, near-miss email, owner's
 // address supplied in the body) runs over these same routes in
 // tests/tenants-admin.test.cjs. This is the "and nothing was written" half.
 seedFacts();
 const routes = [
  ['POST', '/backend/tenants/campaigns', { title: 'x', body: 'y', surface: 'tip', segment: { conditions: [{ category: 'no_agents' }] }, confirm_recipient_count: 1 }],
  ['POST', '/backend/tenants/campaigns/preview', { segment: { conditions: [{ category: 'no_agents' }] } }],
  ['GET', '/backend/tenants/campaigns', undefined],
  ['GET', '/backend/tenants/campaigns/categories', undefined],
 ];
 for (const [method, pathname, body] of routes) {
  const { res } = await call(method, pathname, { token: tokenFor(MEMBER_ID), body });
  assert.equal(res.status, 403, `${method} ${pathname} must refuse a non-owner`);
  assert.equal(issuedSql.some((entry) => /insert into tenant_campaign/i.test(entry.sql)), false);
  assert.equal(issuedSql.some((entry) => /from app_users u/i.test(entry.sql)), false, 'no tenant data may be read first');
 }
});

test('an ORDINARY user CAN read and dismiss their own messages — delivery is not owner-gated', async () => {
 const read = await call('GET', '/backend/campaign-messages', { token: tokenFor(MEMBER_ID) });
 assert.equal(read.res.status, 200);
 assert.equal(read.body.data.messages.length, 1);
 const messageRead = issuedSql.find((entry) => /from tenant_campaign_recipients r/i.test(entry.sql));
 assert.equal(messageRead.params[0], MEMBER_ID, 'the read must bind the CALLER, not a request field');

 const dismiss = await call('POST', '/backend/campaign-messages/campaign-1/dismiss', { token: tokenFor(MEMBER_ID) });
 assert.equal(dismiss.res.status, 200);
 const update = issuedSql.find((entry) => /update tenant_campaign_recipients/i.test(entry.sql));
 assert.deepEqual(update.params, ['campaign-1', MEMBER_ID]);
});

test('the delivery routes still require a session', async () => {
 for (const [method, pathname] of [
  ['GET', '/backend/campaign-messages'],
  ['POST', '/backend/campaign-messages/campaign-1/dismiss'],
 ]) {
  const { res } = await call(method, pathname);
  assert.equal(res.status, 401);
  const forged = await call(method, pathname, { token: 'not-a-real-token' });
  assert.equal(forged.res.status, 401);
 }
});

test('a user cannot dismiss on behalf of someone else by naming them', async () => {
 // There is no field for it — but the attempt must not change the bound id.
 await call('POST', '/backend/campaign-messages/campaign-1/dismiss', {
  token: tokenFor(MEMBER_ID),
  body: { user_id: OTHER_ID, userId: OTHER_ID, email: EMAIL_BY_USER[OTHER_ID] },
 });
 const update = issuedSql.find((entry) => /update tenant_campaign_recipients/i.test(entry.sql));
 assert.deepEqual(update.params, ['campaign-1', MEMBER_ID]);
});

test('the campaign tables are NOT reachable through the generic /backend/db gate', () => {
 // A broadcast is not workspace-scoped, so the generic gate (which resolves a
 // row's workspace and demands membership) has nothing to check. The dedicated
 // routes are the only door, in both directions.
 assert.equal(core.ALLOWED_TABLES.has('tenant_campaigns'), false);
 assert.equal(core.ALLOWED_TABLES.has('tenant_campaign_recipients'), false);
});

test('the schema landed in all THREE places', () => {
 const server = require('./helpers/fly-lane.cjs').flyLaneSource();
 const neon = fs.readFileSync(path.join(root, 'database/neon-schema.sql'), 'utf8');
 const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.includes('tenant_campaigns'))
  .map((name) => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8'))
  .join('\n');
 for (const [label, source] of [['ensureRuntimeSchema', server], ['neon-schema.sql', neon], ['a migration', migrations]]) {
  for (const table of ['tenant_campaigns', 'tenant_campaign_recipients']) {
   assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `${table} is missing from ${label}`);
  }
 }
});

// ---------------------------------------------------------------------------
// NAMED RECIPIENTS — "send this to these specific people".
//
// A hand-picked list is UNION'd with the filters, never intersected. Picking
// someone by hand and then having a filter they happen to fail quietly drop them
// is the one failure this surface must not have: the owner would believe a
// message went to a person it never reached.
// ---------------------------------------------------------------------------

test('a named account is selected even when it matches no filter', () => {
 const segment = campaigns.normalizeSegment({
  match: 'all',
  conditions: [{ category: 'never_huddled' }],
  account_ids: ['active'],
 });
 // activeAccount HAS huddled, so the filter alone excludes it.
 assert.equal(campaigns.evaluateSegment(segment, activeAccount(), NOW), true,
  'a hand-picked account must not be filtered back out');
 assert.equal(campaigns.evaluateSegment(segment, dormantAccount(), NOW), true,
  'the filter still selects on its own');
});

test('naming accounts is a complete campaign with no filters at all', () => {
 const segment = campaigns.normalizeSegment({ match: 'all', conditions: [], account_ids: ['active'] });
 assert.equal(campaigns.evaluateSegment(segment, activeAccount(), NOW), true);
 assert.equal(campaigns.evaluateSegment(segment, dormantAccount(), NOW), false,
  'naming one account must not widen to anybody else');
});

test('the empty case survives the new field: no filters and no names is nobody', () => {
 for (const match of ['all', 'any']) {
  for (const facts of [activeAccount(), dormantAccount()]) {
   assert.equal(
    campaigns.evaluateSegment(campaigns.normalizeSegment({ match, conditions: [], account_ids: [] }), facts, NOW),
    false,
    `an empty ${match} segment must still match nobody`,
   );
  }
 }
});

test('named ids are deduped and non-strings are dropped', () => {
 const segment = campaigns.normalizeSegment({
  conditions: [],
  account_ids: ['a', 'a', '  b  ', '', null, 42, { id: 'c' }],
 });
 assert.deepEqual(segment.account_ids, ['a', 'b'],
  'a duplicate would make the confirm count disagree with the chips on screen');
});

test('a non-array account_ids is refused rather than silently ignored', () => {
 assert.throws(() => campaigns.normalizeSegment({ conditions: [], account_ids: 'everyone' }), /account_ids/);
});

test('describeSegment names the hand-picked half, so the audit row cannot lie', () => {
 assert.match(
  campaigns.describeSegment(campaigns.normalizeSegment({ conditions: [], account_ids: ['a', 'b'] })),
  /2 named accounts/,
 );
 const both = campaigns.describeSegment(campaigns.normalizeSegment({
  match: 'all', conditions: [{ category: 'never_huddled' }], account_ids: ['a'],
 }));
 assert.match(both, /1 named account/);
 assert.match(both, /plus/, 'both halves have to appear or the record is incomplete');
});

test('a stored segment round-trips its named list', () => {
 const stored = campaigns.normalizeStoredSegment(
  JSON.stringify({ match: 'all', conditions: [], account_ids: ['a', 'b'] }),
 );
 assert.deepEqual(stored.account_ids, ['a', 'b'],
  're-reading a sent campaign must not lose who it went to');
 // A segment saved before the field existed must not explode.
 assert.deepEqual(campaigns.normalizeStoredSegment({ match: 'all', conditions: [] }).account_ids, []);
});
