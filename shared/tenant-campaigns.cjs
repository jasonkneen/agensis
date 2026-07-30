// ============================================================================
// shared/tenant-campaigns.cjs
// ----------------------------------------------------------------------------
// SEGMENT, then DELIVER. The owner picks behavioural conditions ("has never
// started a huddle", "no agent has ever connected"), sees exactly who matches,
// and sends those accounts one in-app message on one of three surfaces.
//
// This module is the whole decision layer, deliberately separated from both
// backends and from `shared/tenant-admin.cjs` (which stays read-only — the
// invariant `tests/tenants-admin.test.cjs` pins). Four rules it exists to keep
// in one place:
//
//   1. AN EMPTY SEGMENT MATCHES NOBODY. Under boolean algebra, ALL over an
//      empty condition set is vacuously TRUE — which would mean "the owner
//      opened the composer, ticked nothing, and mailed the entire deployment".
//      `evaluateSegment` refuses an empty condition list in BOTH modes. This is
//      the single most dangerous line in the feature and it is tested from both
//      directions.
//
//   2. AN UNKNOWN CONDITION IS A REFUSAL, NOT A SKIP. Dropping a condition the
//      server does not recognise SILENTLY WIDENS the segment: a client on a
//      newer build sends `never_huddled AND is_paying`, the server ignores the
//      second, and the message goes to twice the intended list. Normalization
//      throws 400 instead.
//
//   3. THE COUNT THE OWNER CONFIRMS IS THE COUNT THE SERVER SENDS TO. The send
//      route re-evaluates the segment itself and refuses unless the caller's
//      confirmed number matches what the server just computed. A preview that
//      went stale while the owner was reading it cannot become a send.
//
//   4. THE BODY IS OPERATOR TEXT RENDERED INTO OTHER PEOPLE'S UI. It is stored
//      and returned as plain text: length-capped, control characters stripped,
//      never HTML, and the client renders it as text nodes. No field anywhere in
//      this module carries a link of any kind.
//
// Every category below answers a question the STATS BLOCK can actually answer —
// the same numbers the Tenants list renders per account, read through
// shared/tenant-admin.cjs rather than counted again here. A category whose facts
// we do not have is not offered, and one whose available field means something
// slightly different is NAMED for what the field means: an operator segmenting
// on a filter that silently means something else is how the wrong people get
// mailed. That is why the connection filter says "right now" and the activity
// filter says "activity" rather than "posted".
//
// Metered usage (tokens, cost) is deliberately NOT a filter. Metering only
// counts from the day it shipped, so "has spent nothing" would select every
// account that predates it — a filter that reads as disengagement and actually
// means "we were not measuring yet" is precisely the trap this comment exists
// to stop somebody walking into later.
// ============================================================================

'use strict';

const { httpError } = require('./backend-core.cjs');
// The stats layer is the SINGLE source of every number a filter reads — see
// loadTenantFacts. Importing it rather than re-querying is what stops the
// Tenants list and the segment matcher disagreeing about the same tenant.
const { WORKSPACE_STATS_SQL, rollUpAccountStats } = require('./tenant-admin.cjs');

/** Where a message is shown. The sender picks exactly one. */
const CAMPAIGN_SURFACES = ['tip', 'dialog', 'banner'];

/** Hard caps. A broadcast is a notice, not a newsletter. */
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 1000;
/** How many matched accounts a preview will enumerate before it just counts. */
const PREVIEW_SAMPLE_LIMIT = 500;
/** Past campaigns shown in the admin list. */
const CAMPAIGN_LIST_LIMIT = 50;
/** Undismissed messages one user's client will be handed at once. */
const USER_MESSAGE_LIMIT = 5;

/** Bounds for a category that takes a day count, so `days` cannot become a scan. */
const MIN_DAYS = 1;
const MAX_DAYS = 3650;
const DEFAULT_DAYS = 30;
// Named recipients per campaign. A broadcast to a hand-picked list is a list,
// not a segment; past a few hundred the owner wanted a filter and should be made
// to say so. Capped for the same reason every other input here is: this shape
// arrives over HTTP.
const MAX_NAMED_ACCOUNTS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The categories. `test(facts, options)` is a PURE predicate over one account's
 * facts — no clock of its own, no DB — so the whole matcher is testable by
 * handing it plain objects.
 *
 * `label` is what the composer's checkbox says; `describe` is what the confirm
 * dialog says, because "haven't used huddles" and "Never started a huddle" must
 * be recognisably the same condition when the owner is about to press send.
 */
const CAMPAIGN_CATEGORIES = [
 {
  id: 'never_huddled',
  label: 'Never started a huddle',
  describe: () => 'never started a huddle',
  test: (facts) => facts.huddle_count === 0,
 },
 {
  id: 'no_agents',
  label: 'Has no agents',
  describe: () => 'has no agents',
  test: (facts) => facts.agent_count === 0,
 },
 {
  id: 'no_live_daemon',
  label: 'No agent connected right now',
  describe: () => 'no agent connected right now',
  // The stats layer counts connections with status <> 'offline', so this is
  // "connected NOW", not "ever connected". Named for what it measures: an
  // "ever connected" filter would need its own query, which is exactly the
  // second counting pass loadTenantFacts exists to avoid. The audience is
  // frozen at send time, so a laptop that is merely asleep affects who matches
  // at that instant and nothing afterwards — and the owner sees the list first.
  test: (facts) => facts.live_daemon_count === 0,
 },
 {
  id: 'no_agent_messages',
  label: 'No agent has ever replied to them',
  describe: () => 'no agent has ever replied to them',
  // The sharpest activation signal available: an agent ROW is a form somebody
  // filled in, an agent MESSAGE is the product having worked for them once.
  test: (facts) => facts.agent_message_count === 0,
 },
 {
  id: 'no_channels',
  label: 'Has no channels',
  describe: () => 'has no channels',
  test: (facts) => facts.channel_count === 0,
 },
 {
  id: 'no_documents',
  label: 'Has no documents',
  describe: () => 'has no documents',
  test: (facts) => facts.document_count === 0,
 },
 {
  id: 'no_workspaces',
  label: 'Owns no workspace',
  describe: () => 'owns no workspace',
  // Counted by the stats layer, which does not exclude the platform-created
  // System workspace — so this is "owns no workspace at all", and the one
  // account that has a System workspace (the operator) does not match. That is
  // the operator's own row on their own admin screen, so it costs nothing.
  test: (facts) => facts.workspace_count === 0,
 },
 {
  id: 'solo',
  label: 'Has never invited anyone',
  describe: () => 'has never invited anyone',
  // member_count counts members across every workspace they own, THEMSELVES
  // INCLUDED. So one member per owned workspace is a person working alone, and
  // anything above that means somebody else is in there. Comparing the two
  // rather than testing a fixed number is what makes this right for an account
  // that owns three workspaces as well as one that owns one.
  test: (facts) => facts.member_count <= facts.workspace_count,
 },
 {
  id: 'never_posted',
  label: 'Has never posted a message',
  describe: () => 'has never posted a message',
  // The HUMAN half of the message count. The stats layer splits them because
  // the agent half is what drives spend; here it is the human half that says
  // whether this person has actually used the thing.
  test: (facts) => facts.human_message_count === 0,
 },
 {
  id: 'inactive_days',
  label: 'No activity for N days',
  days: true,
  describe: (options) => `no activity for ${options.days} days`,
  // NEVER posted counts as inactive: an account with no last_activity_at has
  // been inactive for its whole life, and excluding it would quietly drop the
  // least-activated accounts out of a re-engagement segment.
  test: (facts, options, now) => {
   if (!facts.last_activity_at) return true;
   return now - facts.last_activity_at >= options.days * DAY_MS;
  },
 },
 {
  id: 'signed_up_within_days',
  label: 'Signed up in the last N days',
  days: true,
  describe: (options) => `signed up in the last ${options.days} days`,
  test: (facts, options, now) => {
   if (!facts.created_at) return false;
   return now - facts.created_at <= options.days * DAY_MS;
  },
 },
];

const CATEGORY_BY_ID = new Map(CAMPAIGN_CATEGORIES.map((category) => [category.id, category]));
const CAMPAIGN_CATEGORY_IDS = CAMPAIGN_CATEGORIES.map((category) => category.id);

// ---------------------------------------------------------------------------
// Normalization — everything below this line may assume its input is validated
// ---------------------------------------------------------------------------

/** Postgres counts arrive as bigint strings on both drivers. */
function countValue(value) {
 const parsed = Number(value);
 return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** A timestamp column as epoch ms, or null. Never NaN — an invalid date is absent. */
function timeValue(value) {
 if (value === null || value === undefined || value === '') return null;
 const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
 return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One account's facts, in the shape every predicate above reads. Built from a
 * DB row here and from a literal in the tests, which is the point: the matcher
 * has no idea a database exists.
 */
function shapeTenantFacts(row) {
 return {
  user_id: row.user_id || row.id || '',
  email: row.email || '',
  display_name: row.display_name || '',
  created_at: timeValue(row.created_at),
  // Everything below this line comes from rollUpAccountStats — the same block
  // the Tenants list renders in each row. Named exactly as it names them so a
  // reader can check a filter against what the UI shows for that account.
  workspace_count: countValue(row.workspace_count),
  channel_count: countValue(row.channel_count),
  agent_count: countValue(row.agent_count),
  live_daemon_count: countValue(row.live_daemon_count),
  huddle_count: countValue(row.huddle_count),
  document_count: countValue(row.document_count),
  human_message_count: countValue(row.human_message_count),
  agent_message_count: countValue(row.agent_message_count),
  member_count: countValue(row.member_count),
  last_activity_at: timeValue(row.last_activity_at),
 };
}

/**
 * Validate one condition. Throws 400 on anything unrecognised — see rule 2.
 *
 * `negate` is a real boolean only: a truthy string from a hand-written request
 * flipping a condition by accident is the difference between "has no agents"
 * and "has agents", which is a different mailing list.
 */
function normalizeCondition(input) {
 if (!input || typeof input !== 'object' || Array.isArray(input)) {
  throw httpError(400, 'Each condition must be an object');
 }
 const id = typeof input.category === 'string' ? input.category.trim() : '';
 const category = CATEGORY_BY_ID.get(id);
 if (!category) {
  // The id is echoed because the owner needs to know WHICH filter the server
  // does not have — this surface has one operator and no attacker to inform.
  throw httpError(400, `Unknown filter: ${id || '(none)'}`);
 }
 const condition = { category: id, negate: input.negate === true };
 if (category.days) {
  const raw = input.days === undefined || input.days === null ? DEFAULT_DAYS : Number(input.days);
  if (!Number.isFinite(raw) || Math.floor(raw) < MIN_DAYS || Math.floor(raw) > MAX_DAYS) {
   throw httpError(400, `${category.label} needs a day count between ${MIN_DAYS} and ${MAX_DAYS}`);
  }
  condition.days = Math.floor(raw);
 }
 return condition;
}

/**
 * Validate a whole segment: `{ match: 'any'|'all', conditions: [...] }`.
 *
 * An absent/unknown `match` is 'all' rather than 'any' — if the two are ever
 * confused, the narrower one is the safe default for a broadcast. An empty
 * condition list is ALLOWED here (the composer starts empty and previews zero);
 * what it may never do is send, and that is `evaluateSegment`'s job.
 */
function normalizeSegment(input) {
 const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
 const match = source.match === 'any' ? 'any' : 'all';
 const rawConditions = Array.isArray(source.conditions) ? source.conditions : [];
 if (rawConditions.length > CAMPAIGN_CATEGORIES.length * 2) {
  throw httpError(400, 'Too many conditions');
 }
 return {
  match,
  conditions: rawConditions.map(normalizeCondition),
  account_ids: normalizeAccountIds(source.account_ids),
 };
}

/**
 * The hand-picked half of a segment: accounts named outright.
 *
 * Deduped and order-preserving, so the confirm count matches the number of
 * chips the owner is looking at even if the UI let them add one twice. Ids are
 * kept as opaque strings and only ever COMPARED — never interpolated into SQL —
 * so a malformed one selects nobody rather than doing anything worse.
 */
function normalizeAccountIds(input) {
 if (input === undefined || input === null) return [];
 if (!Array.isArray(input)) throw httpError(400, 'account_ids must be a list');
 const seen = new Set();
 for (const value of input) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) continue;
  seen.add(id);
  if (seen.size > MAX_NAMED_ACCOUNTS) {
   throw httpError(400, `A campaign can name at most ${MAX_NAMED_ACCOUNTS} accounts directly`);
  }
 }
 return [...seen];
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/**
 * Does one condition hold for one account?
 *
 * `negate` is applied HERE, once, around the category's own predicate — so
 * "not (never huddled)" is exactly "has huddled" and no predicate has to know
 * about negation.
 */
function conditionHolds(condition, facts, now) {
 const category = CATEGORY_BY_ID.get(condition.category);
 // Unreachable through normalizeSegment; a stored segment from an older build
 // whose category has since been retired lands here. Refuse rather than treat
 // it as satisfied — a retired filter must shrink a segment, never widen it.
 if (!category) return false;
 const held = category.test(facts, condition, now) === true;
 return condition.negate ? !held : held;
}

/**
 * Does an account match the segment?
 *
 * THE EMPTY CASE IS THE ONE THAT MATTERS. With no conditions this returns false
 * whatever the mode — see rule 1 at the top of the file. `all` over an empty set
 * is vacuously true in logic and catastrophically wrong here.
 */
function evaluateSegment(segment, facts, now = Date.now()) {
 // A named account is selected OUTRIGHT, never intersected with the filters.
 // "Send to these three people, and also to everyone with no agents" is the only
 // reading of a list beside a filter that does not silently drop someone the
 // owner explicitly picked — and silently dropping a named recipient is the one
 // failure this surface must not have. `match: 'all'` deliberately does not
 // apply here: it governs the conditions, which is what it is labelled as doing.
 const named = segment?.account_ids;
 if (Array.isArray(named) && named.length > 0) {
  const id = facts?.user_id || '';
  if (id && named.includes(id)) return true;
 }
 const conditions = segment?.conditions;
 if (!Array.isArray(conditions) || conditions.length === 0) return false;
 if (segment.match === 'any') {
  return conditions.some((condition) => conditionHolds(condition, facts, now));
 }
 return conditions.every((condition) => conditionHolds(condition, facts, now));
}

/** The accounts a segment selects, in the order they were given. */
function selectSegmentMatches(segment, accounts, now = Date.now()) {
 if (!Array.isArray(accounts)) return [];
 return accounts.filter((facts) => evaluateSegment(segment, facts, now));
}

/**
 * The segment in one sentence, for the confirm dialog and the audit row.
 * Reads "no agents and never started a huddle", or "nothing selected" — which
 * is what an unsendable segment should look like when read aloud.
 */
function describeSegment(segment) {
 const conditions = Array.isArray(segment?.conditions) ? segment.conditions : [];
 const named = Array.isArray(segment?.account_ids) ? segment.account_ids.length : 0;
 // The audit row is the only lasting record of who a broadcast went to, so a
 // hand-picked list has to appear in it. Counted, not listed: 500 uuids is not a
 // sentence, and the recipient rows hold the exact list.
 const namedText = named === 0 ? '' : named === 1 ? '1 named account' : `${named} named accounts`;
 if (conditions.length === 0) return namedText || 'nothing selected';
 const parts = conditions.map((condition) => {
  const category = CATEGORY_BY_ID.get(condition.category);
  const text = category ? category.describe(condition) : condition.category;
  return condition.negate ? `NOT ${text}` : text;
 });
 const filterText = parts.join(segment?.match === 'any' ? ' or ' : ' and ');
 return namedText ? `${namedText}, plus ${filterText}` : filterText;
}

// ---------------------------------------------------------------------------
// The message itself
// ---------------------------------------------------------------------------

/**
 * Strip what must never reach another user's screen, and cap the length.
 *
 * Control characters go (they can hide text in a log or a terminal); newlines
 * survive in the body because a two-paragraph notice is reasonable. NOTHING here
 * tries to sanitize HTML, because nothing renders this as HTML: the value is
 * handed to React as a string child and becomes a text node. Escaping would be
 * the wrong shape of defence and would make `<3` render as `&lt;3`.
 */
// Control characters are stripped deliberately: they can hide text in a log,
// reorder it on screen, or terminate a line in a terminal reading the audit row.
// Two ranges, because a body keeps its newlines and a one-line title does not.
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const ALL_CONTROL = /[\u0000-\u001f\u007f]/g;

function cleanText(value, { maxLength, allowNewlines }) {
 const raw = typeof value === 'string' ? value : '';
 const normalized = raw.replace(/\r\n?/g, '\n');
 const stripped = allowNewlines
  ? normalized.replace(CONTROL_EXCEPT_NEWLINE, '')
  : normalized.replace(ALL_CONTROL, ' ');
 return stripped.trim().slice(0, maxLength);
}

/** Validate the composed message. Throws 400; never returns a partial. */
function normalizeCampaignInput(input) {
 const source = input && typeof input === 'object' ? input : {};
 const title = cleanText(source.title, { maxLength: MAX_TITLE_LENGTH, allowNewlines: false });
 const body = cleanText(source.body, { maxLength: MAX_BODY_LENGTH, allowNewlines: true });
 if (!title) throw httpError(400, 'A title is required');
 if (!body) throw httpError(400, 'A message is required');
 const surface = typeof source.surface === 'string' ? source.surface.trim() : '';
 if (!CAMPAIGN_SURFACES.includes(surface)) {
  throw httpError(400, `Surface must be one of: ${CAMPAIGN_SURFACES.join(', ')}`);
 }
 return { title, body, surface, segment: normalizeSegment(source.segment) };
}

/**
 * The send-time agreement between what the owner confirmed and what the server
 * computed. Both halves are refusals a careless client cannot talk its way past:
 *
 *   - a segment that selects NOBODY is not a send, it is a mistake;
 *   - a confirmed count that is not the server's count means the deployment
 *     changed (or the client is lying) since the preview, and the owner has not
 *     actually agreed to this list.
 */
function assertSendable(matchedCount, confirmedCount) {
 if (!Number.isInteger(matchedCount) || matchedCount <= 0) {
  throw httpError(400, 'That segment matches no accounts, so there is nobody to send to');
 }
 // A real number, not something that COERCES to one: the confirmed count is the
 // operator agreeing to a specific list, and "38" arriving from a hand-written
 // client is not that agreement in a form worth trusting.
 if (typeof confirmedCount !== 'number' || !Number.isInteger(confirmedCount) || confirmedCount !== matchedCount) {
  throw httpError(409, `The number of matching accounts changed to ${matchedCount}. Review the list and send again.`);
 }
 return matchedCount;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Every account's behavioural facts.
 *
 * THIS DOES NOT COMPUTE THE FACTS. It reads them from the tenant stats work
 * (shared/tenant-admin.cjs): one batched aggregate — WORKSPACE_STATS_SQL —
 * grouped per workspace, then rolled up per account by rollUpAccountStats. The
 * tenants list is every account on the deployment, so a second per-account
 * counting pass here would be the N+1 that work exists to have removed, and two
 * independent counts of "how many huddles has this tenant had" would eventually
 * disagree — with the segmenting one silently mailing the wrong list.
 *
 * So a filter here can only ever be about a number the stats block already
 * carries. That constraint is the feature: every category below is answerable,
 * and a category we cannot answer is not offered.
 *
 * app_users is still read for created_at (a signup date is not workspace
 * activity) and for the email/display name a preview shows.
 */
async function loadTenantFacts(db) {
 const users = await db(
  `select u.id as user_id, u.email, u.display_name, u.created_at
     from app_users u
    order by u.created_at asc nulls last, u.id asc`,
  [],
 );
 const workspaceStats = await db(WORKSPACE_STATS_SQL, []);
 const statsByAccount = rollUpAccountStats(workspaceStats);

 return (users || []).map((row) => shapeTenantFacts({
  ...row,
  ...(statsByAccount.get(String(row.user_id)) || {}),
 }));
}

/** What a preview hands back: who matched, capped, plus the true count. */
function buildSegmentPreview(segment, allFacts, now = Date.now()) {
 const matched = selectSegmentMatches(segment, allFacts, now);
 return {
  matched_count: matched.length,
  total_accounts: allFacts.length,
  truncated: matched.length > PREVIEW_SAMPLE_LIMIT,
  summary: describeSegment(segment),
  accounts: matched.slice(0, PREVIEW_SAMPLE_LIMIT).map((facts) => ({
   id: facts.user_id,
   email: facts.email,
   display_name: facts.display_name,
   created_at: facts.created_at ? new Date(facts.created_at).toISOString() : null,
  })),
 };
}

function shapeCampaign(row) {
 return {
  id: row.id,
  title: row.title || '',
  body: row.body || '',
  surface: row.surface || 'tip',
  segment: normalizeStoredSegment(row.segment),
  summary: row.segment_summary || '',
  recipient_count: countValue(row.recipient_count),
  dismissed_count: countValue(row.dismissed_count),
  created_by_email: row.created_by_email || '',
  created_at: row.created_at || null,
 };
}

/**
 * A segment read back from jsonb. The drivers disagree about what a jsonb
 * column yields (Fly's porsager parses it; a legacy row written as a string
 * scalar comes back as text), so a string is parsed once and anything
 * unreadable becomes an empty segment — which describes as "nothing selected"
 * rather than throwing while rendering a history list.
 */
function normalizeStoredSegment(value) {
 let source = value;
 if (typeof source === 'string') {
  try {
   source = JSON.parse(source);
  } catch {
   source = null;
  }
 }
 const match = source?.match === 'any' ? 'any' : 'all';
 const conditions = Array.isArray(source?.conditions)
  ? source.conditions
   .filter((condition) => condition && CATEGORY_BY_ID.has(condition.category))
   .map((condition) => ({
    category: condition.category,
    negate: condition.negate === true,
    ...(condition.days === undefined ? {} : { days: Number(condition.days) || DEFAULT_DAYS }),
   }))
  : [];
 const accountIds = Array.isArray(source?.account_ids)
  ? source.account_ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
  : [];
 return { match, conditions, account_ids: accountIds };
}

/** Past campaigns, newest first, each with how many have dismissed it. */
async function listCampaigns(db, { limit = CAMPAIGN_LIST_LIMIT } = {}) {
 const capped = Math.max(1, Math.min(CAMPAIGN_LIST_LIMIT, Number(limit) || CAMPAIGN_LIST_LIMIT));
 const rows = await db(
  `select c.id, c.title, c.body, c.surface, c.segment, c.segment_summary,
          c.recipient_count, c.created_by_email, c.created_at,
          (select count(*) from tenant_campaign_recipients r
            where r.campaign_id = c.id and r.dismissed_at is not null) as dismissed_count
     from tenant_campaigns c
    order by c.created_at desc nulls last, c.id desc
    limit $1`,
  [capped],
 );
 return { campaigns: (rows || []).map(shapeCampaign) };
}

/**
 * Write the campaign AND freeze its audience.
 *
 * `segmentBind` is the value each backend's driver needs for a `::jsonb` bind
 * and is the caller's job, NOT this module's: porsager (Fly) turns a stringified
 * bind into a jsonb STRING SCALAR and needs the object, while
 * @netlify/database requires the string. One shared helper guessing which
 * runtime it is inside is exactly how that bug came back last time, so the
 * decision stays at the two call sites where the driver is known.
 *
 * The recipient rows are written from the ids the SERVER matched, in one
 * multi-row insert, so there is no window in which a campaign exists with no
 * audience and no second evaluation that could disagree with the confirmed
 * count. `on conflict do nothing` makes a retry idempotent rather than a
 * duplicate-key 500.
 */
async function createCampaign(db, {
 title, body, surface, segmentBind, summary, recipientIds, createdBy, createdByEmail,
}) {
 const ids = Array.isArray(recipientIds) ? recipientIds.filter((id) => typeof id === 'string' && id) : [];
 if (ids.length === 0) throw httpError(400, 'A campaign needs at least one recipient');

 const inserted = await db(
  `insert into tenant_campaigns
     (title, body, surface, segment, segment_summary, recipient_count, created_by, created_by_email)
   values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
   returning id, title, body, surface, segment, segment_summary, recipient_count,
             created_by_email, created_at`,
  [title, body, surface, segmentBind, summary, ids.length, createdBy || null, createdByEmail || ''],
 );
 const campaign = inserted?.[0];
 if (!campaign?.id) throw httpError(500, 'The campaign could not be created');

 // One statement, one placeholder per recipient. `unnest` keeps the SQL a fixed
 // string whatever the audience size, so a 400-account send is not a 400-line
 // VALUES list built by concatenation.
 await db(
  `insert into tenant_campaign_recipients (campaign_id, user_id)
   select $1, id from unnest($2::uuid[]) as t(id)
   on conflict (campaign_id, user_id) do nothing`,
  [campaign.id, toUuidArrayLiteral(ids)],
 );

 return shapeCampaign({ ...campaign, dismissed_count: 0 });
}

/**
 * A uuid[] bind as a Postgres array literal.
 *
 * postgres.js will not array-serialize a raw JS array bound through `.unsafe`
 * (the same reason ARRAY_COLUMNS_BY_TABLE exists in backend-core), and the
 * Netlify driver wants a literal too — so both lanes get the same string. Every
 * element is checked against the uuid charset first: these ids come from the
 * server's own match, but a literal is string concatenation and a value that
 * could carry a quote has no business reaching one.
 */
function toUuidArrayLiteral(ids) {
 const safe = ids.filter((id) => /^[0-9a-fA-F-]{1,64}$/.test(id));
 if (safe.length !== ids.length) throw httpError(400, 'A recipient id was not a uuid');
 return `{${safe.join(',')}}`;
}

/**
 * The messages one user has not dismissed, newest first.
 *
 * Joined through the RECIPIENT rows rather than re-evaluating the segment: the
 * audience was frozen at send time, so a user who matched "has no agents" and
 * has since created one still receives the message the owner sent them, and a
 * user who did NOT match can never start receiving it by changing their usage.
 */
async function listUserCampaignMessages(db, userId) {
 const id = typeof userId === 'string' ? userId.trim() : '';
 if (!id) return { messages: [] };
 const rows = await db(
  `select c.id, c.title, c.body, c.surface, c.created_at
     from tenant_campaign_recipients r
     join tenant_campaigns c on c.id = r.campaign_id
    where r.user_id = $1 and r.dismissed_at is null
    order by c.created_at desc nulls last, c.id desc
    limit $2`,
  [id, USER_MESSAGE_LIMIT],
 );
 return {
  messages: (rows || []).map((row) => ({
   id: row.id,
   title: row.title || '',
   body: row.body || '',
   surface: CAMPAIGN_SURFACES.includes(row.surface) ? row.surface : 'tip',
   created_at: row.created_at || null,
  })),
 };
}

/**
 * Dismiss one message FOR ONE USER.
 *
 * The user id is bound from the caller's verified session and is half the
 * primary key, so the statement can only ever touch the caller's own row — there
 * is no shape of request that dismisses somebody else's message, and none that
 * deletes the campaign. `dismissed_at is null` in the WHERE keeps the first
 * dismissal's timestamp when a second tab sends the same request.
 */
async function dismissCampaignMessage(db, userId, campaignId) {
 const user = typeof userId === 'string' ? userId.trim() : '';
 const campaign = typeof campaignId === 'string' ? campaignId.trim() : '';
 if (!user) throw httpError(401, 'Sign in required');
 if (!campaign) throw httpError(400, 'A message id is required');
 await db(
  `update tenant_campaign_recipients
      set dismissed_at = now()
    where campaign_id = $1 and user_id = $2 and dismissed_at is null`,
  [campaign, user],
 );
 return { dismissed: true };
}

module.exports = {
 CAMPAIGN_SURFACES,
 CAMPAIGN_CATEGORIES,
 CAMPAIGN_CATEGORY_IDS,
 CAMPAIGN_LIST_LIMIT,
 PREVIEW_SAMPLE_LIMIT,
 USER_MESSAGE_LIMIT,
 MAX_TITLE_LENGTH,
 MAX_BODY_LENGTH,
 MIN_DAYS,
 MAX_DAYS,
 DEFAULT_DAYS,
 shapeTenantFacts,
 normalizeCondition,
 normalizeSegment,
 normalizeStoredSegment,
 conditionHolds,
 evaluateSegment,
 selectSegmentMatches,
 describeSegment,
 normalizeCampaignInput,
 assertSendable,
 loadTenantFacts,
 buildSegmentPreview,
 shapeCampaign,
 createCampaign,
 toUuidArrayLiteral,
 listCampaigns,
 listUserCampaignMessages,
 dismissCampaignMessage,
};
