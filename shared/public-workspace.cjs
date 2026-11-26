'use strict';

// ============================================================================
// shared/public-workspace.cjs
// ----------------------------------------------------------------------------
// The ONLY path from a workspace to the open internet. A workspace whose
// `visibility` is 'public' answers the unauthenticated read routes in
// server/public-workspace-routes.cjs (Fly) and netlify/functions/backend.mjs
// (the mirror). Both backends call the reader at the bottom of this file, and
// every value it returns is built here, from NAMED fields, never by spreading
// a row — the publicMarketplaceListing discipline.
//
// THE RULES, each of which has a test in tests/public-workspace.test.cjs:
//
//   1. No policy row = nothing leaves. An event type leaves only when the
//      workspace has a `workspace_public_policy` row for it with level
//      'public'. 'members' and 'private' never leave through these routes.
//   2. effective = workspace policy AND the agent's own share policy. An event
//      about an agent that withholds the channel the event belongs to
//      (memory, documents, tools) does not leave, whatever the workspace says.
//      Neither side can widen the other.
//   3. Detail levels: 'category' -> id, at, type, category. 'title' -> adds
//      title, actor and entity. 'full' -> adds `detail`, a short plain string
//      (<= 280 chars) taken from ONE named source per type. Each type also has
//      a CEILING here that the policy cannot raise: memory events stop at
//      'category' because their stored title IS the memory content.
//   4. Never leaves, whatever the policy: private-session and DM content
//      (resolved from the real session row, fail closed), private-project
//      tasks, prompts, tool arguments, file paths, host folders, URLs, tokens,
//      emails, memory content, document bodies, persona prose. Types that carry
//      those by construction (provider_call, join links) are not in the
//      publishable set at all. Text that survives the gates is pattern-scrubbed
//      as a second layer: a field that matches is DROPPED, never redacted.
//   5. A private workspace and a workspace that does not exist answer the same
//      way (the reader returns null for both; the routes turn null into one
//      fixed 404).
//
// The event source is `activity_events`, which is CLIENT-AUTHORED (AGENTS.md,
// "The audit log"). That is why privacy is resolved from the session / task /
// project rows rather than from anything the event row claims, and why the
// pattern scrub exists.
// ============================================================================

const crypto = require('node:crypto');
const { publicMarketplaceListing } = require('./marketplace.cjs');
const { SHARING_CHANNELS } = require('./agentSharing.cjs');
const { effectiveChannel, normalizeSharePolicyMessage } = require('./agentSharePolicy.cjs');
const { sessionOpenSql } = require('./backend-core.cjs');

const WORKSPACE_VISIBILITIES = Object.freeze(['private', 'public']);
const POLICY_LEVELS = Object.freeze(['public', 'members', 'private']);
const DETAIL_LEVELS = Object.freeze(['category', 'title', 'full']);
const DETAIL_RANK = Object.freeze({ category: 0, title: 1, full: 2 });

/** Not an event: the policy row that lets `Agent.activity` leave. */
const AGENT_ACTIVITY_TYPE = 'agent_activity';

const MAX_TITLE = 160;
const MAX_DETAIL = 280;
const MAX_EVENTS_PAGE = 200;
const DEFAULT_EVENTS_PAGE = 50;
const MAX_LISTINGS = 200;

/**
 * The publishable event types. CLOSED: an event type that is not here never
 * leaves, and the policy validator refuses to store a row for it.
 *
 *   category  the family the Activity window files it under
 *             (src/lib/activityFamily.ts ACTIVITY_FAMILY)
 *   ceiling   the most detail this type can ever carry, whatever the policy
 *   channel   the agent share channel the event belongs to (rule 2)
 *   gate      'session' -> the session must resolve and be open;
 *             'task' -> the task must resolve and not sit in a private project
 *   detail    the ONE named source of `detail` at 'full', or absent
 *   entity    the entity kind that may be named at 'title', or absent
 *   title     'agent' -> the stored title is NOT used; the public title is
 *             "<public agent name> <verb>", or absent for an unknown agent
 */
const PUBLIC_EVENT_TYPES = Object.freeze({
 task_created: { category: 'tasks', ceiling: 'title', gate: 'task', entity: 'task' },
 task_updated: { category: 'tasks', ceiling: 'title', gate: 'task', entity: 'task' },
 task_completed: { category: 'tasks', ceiling: 'title', gate: 'task', entity: 'task' },
 document_created: { category: 'docs', ceiling: 'title', channel: 'documents', entity: 'document' },
 document_updated: { category: 'docs', ceiling: 'title', channel: 'documents', entity: 'document' },
 document_deleted: { category: 'docs', ceiling: 'title', channel: 'documents' },
 comment_created: { category: 'comments', ceiling: 'title' },
 chat_created: { category: 'messages', ceiling: 'title', gate: 'session', entity: 'chat' },
 message_sent: { category: 'messages', ceiling: 'full', gate: 'session', detail: 'message' },
 // The stored title is "Memory added: <the memory itself>".
 memory_added: { category: 'memory', ceiling: 'category', channel: 'memory' },
 // Titles written by older clients can carry an invitee's address.
 member_joined: { category: 'people', ceiling: 'category' },
 canvas_updated: { category: 'canvas', ceiling: 'title' },
 // The stored title is "@<handle> connected"; the handle never leaves (see
 // publicAgent), so the public title is rebuilt from the public display name.
 agent_connected: { category: 'agents', ceiling: 'title', entity: 'agent', title: 'agent', verb: 'connected' },
 agent_disconnected: { category: 'agents', ceiling: 'title', entity: 'agent', title: 'agent', verb: 'disconnected' },
});

/** Every type a policy row may name: the events above plus agent activity. */
const POLICY_EVENT_TYPES = Object.freeze([...Object.keys(PUBLIC_EVENT_TYPES), AGENT_ACTIVITY_TYPE]);

/**
 * Tool name -> activity category. An EXACT match over a closed map, on the
 * tool NAME only. `tool_detail` (the arguments) is never read on this path.
 * A tool that is not here yields no activity rather than a guess.
 */
const TOOL_ACTIVITY = Object.freeze(new Map([
 ['read', 'read'], ['notebookread', 'read'], ['read_file', 'read'], ['view', 'read'], ['webfetch', 'read'],
 ['grep', 'search'], ['glob', 'search'], ['ls', 'search'], ['websearch', 'search'], ['search', 'search'],
 ['list_files', 'search'], ['find', 'search'],
 ['edit', 'edit'], ['multiedit', 'edit'], ['write', 'edit'], ['notebookedit', 'edit'], ['apply_patch', 'edit'],
 ['write_file', 'edit'], ['edit_file', 'edit'],
 ['bash', 'run'], ['shell', 'run'], ['exec', 'run'], ['exec_command', 'run'], ['run_command', 'run'],
]));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

function isUuid(value) {
 return typeof value === 'string' && UUID_RE.test(value);
}

// ----------------------------------------------------------------------------
// The pattern scrub (rule 4, second layer). A hit DROPS the field: a redacted
// substring still says what shape of thing was there, and a scrubber that
// rewrites text is a scrubber somebody tunes until it lets one through.
// ----------------------------------------------------------------------------

const NEVER_LEAVES_PATTERNS = Object.freeze([
 // emails
 /[^\s@]+@[^\s@]+\.[^\s@]+/,
 // URLs and bare hosts with a scheme or www.
 /\b[a-z][a-z0-9+.-]*:\/\//i,
 /\bwww\.[^\s]+/i,
 // bare hostnames: a dotted name ending in a common or private-network TLD,
 // localhost, IPv4 addresses, and host:port
 /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|app|ai|co|me|sh|xyz|cloud|tech|site|online|info|biz|us|uk|de|fr|eu|ca|au|jp|local|localdomain|internal|intranet|lan|corp|home|arpa|test|example|invalid|onion)\b/i,
 /\blocalhost\b/i,
 /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
 /\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*:\d{2,5}\b/i,
 // file paths: absolute, home, relative, Windows
 /(?:^|[\s(`'"])(?:~|\.{1,2})?\/[^\s/]+\/[^\s]*/,
 /(?:^|[\s(`'"])~\//,
 /\b[a-z]:\\/i,
 /(?:^|[\s(`'"])[\w.-]+\/[\w.-]+\.[a-z0-9]{1,6}\b/i,
 // relative paths with no extension: three or more segments, a dot-directory,
 // or two segments under a well-known source/system directory
 /(?:^|[\s(`'"])[\w.-]+\/[\w.-]+\/[\w.-]+/,
 /(?:^|[\s(`'"])\.[\w-]+\/[\w.-]+/,
 /(?:^|[\s(`'"])(?:src|lib|app|apps|packages|pkg|tests?|spec|docs|server|shared|client|components|scripts|bin|dist|build|out|node_modules|vendor|config|public|assets|cmd|internal|etc|usr|var|tmp|opt|home|Users|srv|mnt|Volumes)\/[\w.-]+/,
 // credentials and token shapes
 /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,
 /\b(?:agw|aga|agc|ghp|gho|ghs|ghu|github_pat|xox[abprs])_[A-Za-z0-9_-]{6,}/,
 /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
 /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i,
 /\b[A-Za-z0-9_-]{32,}\b/,
 /\b[a-f0-9]{24,}\b/i,
]);

/** True when the text carries something on the never-leaves list. */
function carriesNeverLeaves(text) {
 const value = String(text || '');
 return NEVER_LEAVES_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * A plain, single-line string of at most `max` characters, or '' when the
 * input is empty or carries anything on the never-leaves list.
 */
function scrubPublicText(value, max) {
 if (typeof value !== 'string') return '';
 // eslint-disable-next-line no-control-regex
 const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
 if (!flat) return '';
 if (carriesNeverLeaves(flat)) return '';
 return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A human actor carries a display name and an OPAQUE id: stable per
 * workspace so a renderer can tell two people apart, and not the user id.
 */
function opaqueActorId(workspaceId, userId) {
 return `h_${crypto.createHash('sha256').update(`agensis-public:${workspaceId}:${userId}`).digest('hex').slice(0, 16)}`;
}

function initials(name) {
 const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
 if (parts.length === 0) return '?';
 if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
 return (parts[0][0] + parts[1][0]).toUpperCase();
}

// ----------------------------------------------------------------------------
// Policy
// ----------------------------------------------------------------------------

/**
 * Validate one policy write. Refuses (never coerces) an unknown event type,
 * level or detail, naming the field.
 */
function normalizePublicPolicyEntry(raw) {
 const errors = [];
 const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
 const eventType = String(input.eventType ?? input.event_type ?? '').trim();
 const level = String(input.level ?? '').trim();
 const detail = String(input.detail ?? 'category').trim();
 if (!POLICY_EVENT_TYPES.includes(eventType)) {
  errors.push(`event_type must be one of ${POLICY_EVENT_TYPES.join(', ')}`);
 }
 if (!POLICY_LEVELS.includes(level)) errors.push(`level must be one of ${POLICY_LEVELS.join(', ')}`);
 if (!DETAIL_LEVELS.includes(detail)) errors.push(`detail must be one of ${DETAIL_LEVELS.join(', ')}`);
 if (errors.length) return { ok: false, errors, entry: null };
 return { ok: true, errors: [], entry: { eventType, level, detail } };
}

/** policy rows -> Map(event_type -> { level, detail }), dropping anything invalid. */
function publicPolicyMap(rows) {
 const map = new Map();
 for (const row of Array.isArray(rows) ? rows : []) {
  const result = normalizePublicPolicyEntry(row);
  if (result.ok) map.set(result.entry.eventType, { level: result.entry.level, detail: result.entry.detail });
 }
 return map;
}

/** The policy entry for one type, from a Map, a plain object, or a single row. */
function policyEntryFor(policy, eventType) {
 if (!policy) return null;
 if (policy instanceof Map) return policy.get(eventType) || null;
 if (typeof policy === 'object' && (policy.event_type || policy.eventType)) {
  const result = normalizePublicPolicyEntry(policy);
  return result.ok && result.entry.eventType === eventType ? result.entry : null;
 }
 if (typeof policy === 'object' && Object.prototype.hasOwnProperty.call(policy, eventType)) {
  const entry = policy[eventType];
  const result = normalizePublicPolicyEntry({ ...entry, eventType });
  return result.ok ? result.entry : null;
 }
 return null;
}

/** The level a type leaves at, or null when it does not leave. */
function effectiveDetail(policy, eventType) {
 const spec = PUBLIC_EVENT_TYPES[eventType];
 const entry = policyEntryFor(policy, eventType);
 if (!spec || !entry || entry.level !== 'public') return null;
 return DETAIL_RANK[entry.detail] <= DETAIL_RANK[spec.ceiling] ? entry.detail : spec.ceiling;
}

/** The comma-joined list of types a policy publishes, for the SQL filter. */
function publishedEventTypes(policy) {
 return Object.keys(PUBLIC_EVENT_TYPES).filter((type) => effectiveDetail(policy, type) !== null);
}

function activityPublished(policy) {
 const entry = policyEntryFor(policy, AGENT_ACTIVITY_TYPE);
 return Boolean(entry && entry.level === 'public');
}

// ----------------------------------------------------------------------------
// Share flags (rule 2)
// ----------------------------------------------------------------------------

/**
 * The agent's EFFECTIVE share flags: the workspace switch
 * (`workspace_agents.sharing`) AND every live connection's declared machine
 * policy (`.agensis-share`). With no live connection the workspace switch
 * decides alone — the same rule connectionSharePolicy applies at ingest.
 */
function effectiveShareFlags(agentRow, liveConnections = []) {
 const policies = (Array.isArray(liveConnections) ? liveConnections : [])
  .map((connection) => normalizeSharePolicyMessage(connection?.share_policy ?? connection?.capabilities?.sharePolicy));
 if (policies.length === 0) policies.push(normalizeSharePolicyMessage(null));
 const out = {};
 for (const channel of SHARING_CHANNELS) {
  out[channel] = policies.every((policy) => effectiveChannel(agentRow, policy, channel));
 }
 return out;
}

// ----------------------------------------------------------------------------
// The projection
// ----------------------------------------------------------------------------

/**
 * One activity row -> one public Event, or null.
 *
 * `row` is the shape the reader below builds (named columns, already joined):
 *   id, at, workspace_id, event_type, entity_type, entity_id, title,
 *   actor_kind ('agent' | 'human' | ''), actor_agent_id, actor_agent_name,
 *   user_id, user_display_name,
 *   session_open (true only when the session resolved and is not private),
 *   task_visible (true only when the task resolved, outside a private project),
 *   message_content (the message body; read only for message_sent at 'full').
 *
 * `policy` is the workspace policy (Map, object, or the single row for this
 * type). `shareFlags` is the effective share flags of the agent the event is
 * about, or null for an event a person caused.
 */
function publicProjection(row, policy, shareFlags) {
 if (!row || typeof row !== 'object') return null;
 const type = String(row.event_type || '');
 const spec = PUBLIC_EVENT_TYPES[type];
 if (!spec) return null;
 const level = effectiveDetail(policy, type);
 if (level === null) return null;

 const isAgentEvent = row.actor_kind === 'agent';
 if (spec.channel && isAgentEvent) {
  if (!shareFlags || shareFlags[spec.channel] !== true) return null;
 }
 if (spec.gate === 'session' && row.session_open !== true) return null;
 if (spec.gate === 'task' && row.task_visible !== true) return null;

 const id = String(row.id || '');
 const at = String(row.at || '');
 if (!id || !at) return null;

 const event = { id, at, type, category: spec.category };
 if (DETAIL_RANK[level] < DETAIL_RANK.title) return event;

 const knownAgent = isAgentEvent && isUuid(String(row.actor_agent_id || ''));
 const title = spec.title === 'agent'
  ? (knownAgent ? scrubPublicText(`${scrubPublicText(row.actor_agent_name, 80) || 'Agent'} ${spec.verb}`, MAX_TITLE) : '')
  : scrubPublicText(row.title, MAX_TITLE);
 if (title) event.title = title;

 if (knownAgent) {
  event.actor = {
   kind: 'agent',
   id: String(row.actor_agent_id),
   name: scrubPublicText(row.actor_agent_name, 80) || 'Agent',
  };
 } else if (row.actor_kind === 'human' && row.user_id && row.workspace_id) {
  event.actor = {
   kind: 'human',
   id: opaqueActorId(String(row.workspace_id), String(row.user_id)),
   name: scrubPublicText(row.user_display_name, 80) || 'Someone',
  };
 }

 if (spec.entity && isUuid(String(row.entity_id || ''))) {
  event.entity = { kind: spec.entity, id: String(row.entity_id) };
 }

 if (level === 'full' && spec.detail === 'message' && row.session_open === true) {
  const detail = scrubPublicText(row.message_content, MAX_DETAIL);
  if (detail) event.detail = detail;
 }
 return event;
}

/**
 * The status rule. A line-for-line mirror of agentStatus in
 * src/components/windows/agentNetworkModel.ts (the network map), pinned to it
 * by tests/unit/publicWorkspaceStatus.test.ts. Note that the Agents window's
 * agentPresenceStatus differs for one case — a builtin agent with no live
 * connection is 'disconnected' there and 'idle' on the map — and the public
 * page renders through the map, so the map rule is the one used.
 */
function publicAgentStatus(agentRow, connections = []) {
 if (agentRow?.enabled === false) return 'inactive';
 const mine = (Array.isArray(connections) ? connections : [])
  .filter((connection) => String(connection?.agent_id || '') === String(agentRow?.id || '') && connection?.status !== 'offline');
 if (mine.length === 0) return publicRunMode(agentRow) === 'builtin' ? 'idle' : 'disconnected';
 return mine.some((connection) => connection.status === 'busy') ? 'busy' : 'idle';
}

function publicRunMode(agentRow) {
 const mode = String(agentRow?.run_mode || '');
 return mode === 'daemon' || mode === 'sandbox' || mode === 'external' ? mode : 'builtin';
}

function activityForTool(toolName) {
 const key = String(toolName || '').trim().toLowerCase();
 return TOOL_ACTIVITY.get(key) || null;
}

/**
 * One agent row -> one public Agent. Named fields only: no prompt, soul,
 * instructions, tools, skills, metadata, handle, model or connect token.
 *
 * `activity` is attached only when the caller passes one, which the reader
 * does only when the policy publishes agent_activity, the agent shares
 * `tools`, the agent is busy and the job's session is open.
 */
function publicAgent(agentRow, connections = [], activity = null) {
 const name = scrubPublicText(agentRow?.name, 80) || 'Agent';
 const rawAvatar = typeof agentRow?.avatar === 'string' ? agentRow.avatar.trim() : '';
 const avatar = rawAvatar && rawAvatar.length <= 16 && !/[/:\\@]/.test(rawAvatar) ? rawAvatar : initials(name);
 const accent = typeof agentRow?.accent_color === 'string' && HEX_COLOR_RE.test(agentRow.accent_color)
  ? agentRow.accent_color
  : '';
 const agent = {
  id: String(agentRow?.id || ''),
  name,
  avatar,
  accentColor: accent,
  runMode: publicRunMode(agentRow),
  status: publicAgentStatus(agentRow, connections),
 };
 if (activity && agent.status === 'busy') agent.activity = activity;
 return agent;
}

/**
 * A marketplace listing as the public routes show it. Goes THROUGH
 * publicMarketplaceListing (so its hire/template split still holds) and then
 * picks the contract's fields from that output into a new object. Dropped:
 * the template body (prompt, soul, instructions, tools, skills),
 * publisher_workspace_id, fingerprint, status and timestamps.
 */
function publicListing(row) {
 const listing = publicMarketplaceListing(row);
 if (!listing) return null;
 return {
  id: String(listing.id || ''),
  slug: String(listing.slug || ''),
  type: listing.listingType === 'hire' ? 'hire' : 'template',
  name: String(listing.name || ''),
  category: String(listing.category || 'Community'),
  description: String(listing.description || ''),
  capabilities: (Array.isArray(listing.capabilities) ? listing.capabilities : []).filter((item) => typeof item === 'string'),
  purpose: listing.purpose === 'resource' ? 'resource' : 'collaborator',
  resourceFacets: (Array.isArray(listing.resourceFacets) ? listing.resourceFacets : []).filter((item) => typeof item === 'string'),
  avatar: String(listing.avatar || ''),
  accentColor: String(listing.accentColor || ''),
  installCount: Number(listing.installCount || 0),
  hireCount: Number(listing.hireCount || 0),
 };
}

function countAgents(agents) {
 const counts = { agents: agents.length, busy: 0, idle: 0, disconnected: 0 };
 for (const agent of agents) {
  if (agent.status === 'busy') counts.busy += 1;
  else if (agent.status === 'idle') counts.idle += 1;
  else if (agent.status === 'disconnected') counts.disconnected += 1;
 }
 return counts;
}

function parseObject(value) {
 if (value && typeof value === 'object' && !Array.isArray(value)) return value;
 if (typeof value === 'string') {
  try {
   const parsed = JSON.parse(value);
   return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
   return {};
  }
 }
 return {};
}

// ----------------------------------------------------------------------------
// The reader. Both backends call this with their own `db(sql, params) -> rows`
// (postgres.js `.unsafe` on Fly, pg `query` on Netlify), so there is one
// implementation of every public read.
// ----------------------------------------------------------------------------

const ISO_AT_SQL = (column) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// entity_id is free text written by clients; cast only what is shaped like a
// uuid so a garbage id joins nothing instead of failing the whole page.
const ENTITY_UUID_SQL = `(case when e.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then e.entity_id::uuid end)`;

function createPublicWorkspaceReader({ db } = {}) {
 if (typeof db !== 'function') throw new Error('createPublicWorkspaceReader requires a db function');

 /** The workspace row, or null when it is missing, malformed or not public. */
 async function loadPublicWorkspace(workspaceId) {
  const id = String(workspaceId || '');
  if (!isUuid(id)) return null;
  const rows = await db(
   `select id, name, description, icon, visibility from workspaces where id = $1 limit 1`,
   [id],
  );
  const row = rows[0];
  if (!row || row.visibility !== 'public') return null;
  return row;
 }

 async function loadPolicy(workspaceId) {
  const rows = await db(
   'select event_type, level, detail from workspace_public_policy where workspace_id = $1',
   [workspaceId],
  );
  return publicPolicyMap(rows);
 }

 async function loadAgents(workspaceId) {
  const agentRows = await db(
   `select id, name, avatar, accent_color, run_mode, enabled, sharing
      from workspace_agents where workspace_id = $1
     order by created_at asc, id asc`,
   [workspaceId],
  );
  const connectionRows = await db(
   `select agent_id, status, capabilities -> 'sharePolicy' as share_policy
      from agent_connections where workspace_id = $1 and status <> 'offline'`,
   [workspaceId],
  );
  return { agentRows, connectionRows };
 }

 /**
  * Running jobs -> the latest tool step's NAME, per agent, for jobs whose
  * session is open. One query. The step's arguments (`tool_detail`) are not
  * selected.
  */
 async function loadActivity(workspaceId) {
  const rows = await db(
   `select j.agent_id::text as agent_id,
           (select m.tool_name from messages m
             where m.session_id = j.session_id
               and m.message_kind = 'tool_step'
               and m.sender_id = j.agent_id::text
               and m.deleted_at is null
               and m.created_at >= coalesce(j.started_at, j.created_at)
             order by m.created_at desc limit 1) as tool_name
      from agent_jobs j
      join chat_sessions s on s.id = j.session_id
     where j.workspace_id = $1
       and j.status = 'running'
       and s.workspace_id = j.workspace_id
       and s.deleted_at is null
       and ${sessionOpenSql('s')}`,
   [workspaceId],
  );
  const byAgent = new Map();
  for (const row of rows) {
   const activity = activityForTool(row.tool_name);
   if (activity && row.agent_id && !byAgent.has(String(row.agent_id))) byAgent.set(String(row.agent_id), activity);
  }
  return byAgent;
 }

 function buildAgents(agentRows, connectionRows, activityByAgent) {
  return agentRows.map((row) => {
   const live = connectionRows.filter((connection) => String(connection.agent_id || '') === String(row.id));
   const flags = effectiveShareFlags(row, live);
   const activity = activityByAgent && flags.tools ? activityByAgent.get(String(row.id)) || null : null;
   return { agent: publicAgent(row, live, activity), flags };
  });
 }

 async function summaryFor(workspace, policy) {
  const { agentRows, connectionRows } = await loadAgents(workspace.id);
  const activityByAgent = activityPublished(policy) ? await loadActivity(workspace.id) : null;
  const agents = buildAgents(agentRows, connectionRows, activityByAgent).map((entry) => entry.agent);
  return {
   id: String(workspace.id),
   name: scrubPublicText(workspace.name, 120) || 'Workspace',
   description: scrubPublicText(workspace.description, 600),
   icon: typeof workspace.icon === 'string' && workspace.icon.length <= 16 && !/[/:\\@]/.test(workspace.icon) ? workspace.icon : '',
   agents,
   counts: countAgents(agents),
  };
 }

 /** The database clock, in the same format as an event's `at`. */
 async function dbNow() {
  const rows = await db(`select ${ISO_AT_SQL('now()')} as now`, []);
  return String(rows[0]?.now || new Date().toISOString());
 }

 /** GET /backend/public/workspaces/:id -> summary, or null (404). */
 async function getSummary(workspaceId) {
  const workspace = await loadPublicWorkspace(workspaceId);
  if (!workspace) return null;
  const policy = await loadPolicy(workspace.id);
  return summaryFor(workspace, policy);
 }

 async function eventsFor(workspace, policy, { since, limit } = {}) {
  const pageSize = Math.min(MAX_EVENTS_PAGE, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_EVENTS_PAGE));
  const sinceText = typeof since === 'string' && since.trim() ? since.trim() : '';
  const sinceMs = sinceText ? Date.parse(sinceText) : NaN;
  if (sinceText && !Number.isFinite(sinceMs)) {
   throw Object.assign(new Error('since must be an ISO timestamp'), { status: 400 });
  }
  const types = publishedEventTypes(policy);
  if (types.length === 0) return { events: [], next: sinceText || new Date().toISOString() };

  const select = `
   select e.id::text as id,
          ${ISO_AT_SQL('e.created_at')} as at,
          e.workspace_id::text as workspace_id,
          e.event_type, e.entity_type, e.entity_id, e.title, e.user_id::text as user_id, e.metadata,
          u.display_name as user_display_name,
          case
           -- Only a PLAIN message leaves. A tool step is logged as message_sent
           -- too, and its title is "<sender>: <tool> · <arguments>".
           when e.event_type = 'message_sent' then (
            m.id is not null and m.deleted_at is null and coalesce(m.message_kind, '') = ''
            and ms.id is not null and ms.workspace_id = e.workspace_id and ms.deleted_at is null
            and ${sessionOpenSql('ms')}
           )
           when e.event_type = 'chat_created' then (
            cs.id is not null and cs.workspace_id = e.workspace_id and cs.deleted_at is null
            and ${sessionOpenSql('cs')}
           )
           else null
          end as session_open,
          case
           when e.entity_type = 'task' then (
            t.id is not null and t.workspace_id = e.workspace_id
            and (p.id is null or coalesce(p.visibility, 'workspace') <> 'private')
           )
           else null
          end as task_visible,
          -- The body is selected only for an open session, so a DM body never
          -- reaches this process, let alone the projection that also refuses it.
          case
           when e.event_type = 'message_sent' and coalesce(m.message_kind, '') = ''
            and m.deleted_at is null and ms.workspace_id = e.workspace_id and ms.deleted_at is null
            and ${sessionOpenSql('ms')}
           then m.content
           else null
          end as message_content
     from activity_events e
     left join app_users u on u.id = e.user_id
     left join messages m on e.event_type = 'message_sent' and e.entity_type = 'message' and m.id = ${ENTITY_UUID_SQL}
     left join chat_sessions ms on ms.id = m.session_id
     left join chat_sessions cs on e.event_type = 'chat_created' and cs.id = ${ENTITY_UUID_SQL}
     left join tasks t on e.entity_type = 'task' and t.id = ${ENTITY_UUID_SQL}
     left join projects p on p.id = t.project_id
    where e.workspace_id = $1
      and e.event_type = any(string_to_array($2, ','))`;
  const rows = sinceText
   ? await db(`${select} and e.created_at > $3::timestamptz order by e.created_at asc, e.id asc limit $4`, [workspace.id, types.join(','), sinceText, pageSize])
   : (await db(`${select} order by e.created_at desc, e.id desc limit $3`, [workspace.id, types.join(','), pageSize])).reverse();

  const { agentRows, connectionRows } = await loadAgents(workspace.id);
  const agentsById = new Map(buildAgents(agentRows, connectionRows, null).map((entry) => [entry.agent.id, entry]));

  const events = [];
  for (const raw of rows) {
   const metadata = parseObject(raw.metadata);
   let actorAgentId = '';
   if (raw.entity_type === 'agent' && (raw.event_type === 'agent_connected' || raw.event_type === 'agent_disconnected')) {
    actorAgentId = String(raw.entity_id || '');
   } else if (metadata.actor_kind === 'agent' && metadata.actor_id) {
    actorAgentId = String(metadata.actor_id);
   }
   const known = actorAgentId ? agentsById.get(actorAgentId) : null;
   const row = {
    id: raw.id,
    at: raw.at,
    workspace_id: raw.workspace_id,
    event_type: raw.event_type,
    entity_type: raw.entity_type,
    entity_id: raw.entity_id,
    title: raw.title,
    // An agent the workspace does not hold is not attributed to anyone; an
    // event that claims an unknown agent still carries rule 2 (no flags ->
    // channel-governed types are refused).
    actor_kind: actorAgentId ? 'agent' : raw.user_id ? 'human' : '',
    actor_agent_id: known ? known.agent.id : '',
    actor_agent_name: known ? known.agent.name : '',
    user_id: raw.user_id,
    user_display_name: raw.user_display_name,
    session_open: raw.session_open === true,
    task_visible: raw.task_visible === true,
    message_content: raw.message_content,
   };
   const event = publicProjection(row, policy, known ? known.flags : null);
   if (event) events.push(event);
  }
  const last = rows[rows.length - 1];
  return { events, next: last ? String(last.at) : (sinceText || new Date().toISOString()) };
 }

 /** GET /backend/public/workspaces/:id/events -> { events, next }, or null (404). */
 async function getEvents(workspaceId, options = {}) {
  const workspace = await loadPublicWorkspace(workspaceId);
  if (!workspace) return null;
  const policy = await loadPolicy(workspace.id);
  return eventsFor(workspace, policy, options);
 }

 /** GET /backend/public/marketplace/listings -> { listings }. */
 async function getListings({ category, q } = {}) {
  const rows = await db(
   `select * from marketplace_listings where status = 'published' order by created_at desc limit $1`,
   [MAX_LISTINGS],
  );
  const wantCategory = String(category || '').trim().toLowerCase();
  const needle = String(q || '').trim().toLowerCase().slice(0, 120);
  const listings = rows
   .map(publicListing)
   .filter(Boolean)
   .filter((listing) => !wantCategory || listing.category.toLowerCase() === wantCategory)
   .filter((listing) => !needle
    || listing.name.toLowerCase().includes(needle)
    || listing.description.toLowerCase().includes(needle)
    || listing.capabilities.some((item) => item.toLowerCase().includes(needle)));
  return { listings };
 }

 return {
  loadPublicWorkspace,
  loadPolicy,
  dbNow,
  summaryFor,
  eventsFor,
  getSummary,
  getEvents,
  getListings,
 };
}

module.exports = {
 WORKSPACE_VISIBILITIES,
 POLICY_LEVELS,
 DETAIL_LEVELS,
 AGENT_ACTIVITY_TYPE,
 PUBLIC_EVENT_TYPES,
 POLICY_EVENT_TYPES,
 TOOL_ACTIVITY,
 MAX_DETAIL,
 MAX_EVENTS_PAGE,
 isUuid,
 carriesNeverLeaves,
 scrubPublicText,
 opaqueActorId,
 normalizePublicPolicyEntry,
 publicPolicyMap,
 effectiveDetail,
 publishedEventTypes,
 activityPublished,
 effectiveShareFlags,
 publicProjection,
 publicAgentStatus,
 publicAgent,
 publicListing,
 activityForTool,
 createPublicWorkspaceReader,
};
