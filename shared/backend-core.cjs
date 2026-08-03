// ============================================================================
// shared/backend-core.cjs
// ----------------------------------------------------------------------------
// Dependency-light security core shared by BOTH backends:
//   - server/index.cjs        (hardened Express reference; deduped onto this later)
//   - netlify/functions/backend.mjs (serverless; previously UNAUTHENTICATED)
//
// These functions carry NO web-framework coupling. Callers pass in the raw
// inputs (auth header string, table/op/filters, a `db` query function) and the
// core returns a decision or throws an Error with a `.status` (401|403|400).
//
// The `db` argument everywhere is a thin async query function with the shape:
//     db(sqlText, paramsArray) => Promise<rows[]>
// node-postgres (`pool.query(...).rows`) and postgres.js (`sql.unsafe(...)`)
// both reduce to this shape, so the same core drives either backend.
// ============================================================================

const crypto = require('node:crypto');
const {
 WORKSPACE_MAX_DEPTH,
 wouldCreateCycle,
 wouldExceedMaxDepth,
 roleSetHasCapability,
} = require('./workspace-tree.cjs');
const { sanitizeAgentSharingPatch } = require('./agentSharing.cjs');

// ----------------------------------------------------------------------------
// Allow-sets and role/capability tables — lifted VERBATIM from server/index.cjs.
// Do not invent: these are the security contract.
// ----------------------------------------------------------------------------

const ALLOWED_TABLES = new Set([
 'app_users',
 'thread_harvests',
 'workspaces',
 'documents',
 'chat_sessions',
 'messages',
 'memory_facts',
 'uploaded_files',
 'workspace_members',
 'canvas_groups',
 'canvas_layers',
 'canvas_objects',
 'tasks',
 'document_comments',
 'task_comments',
 'document_versions',
 'workspace_agents',
 'agent_webhooks',
 'agent_connections',
 'agent_jobs',
 'agent_registrations',
 'activity_events',
 'agent_memory_files',
 // The daemon-mirrored markdown library. READ through the generic /db path for
 // the same reason agent_memory_files is: the sidebar keeps a live,
 // metadata-only list and subscribes to changes, so a dedicated snapshot route
 // would need a realtime lane of its own to say anything a reload didn't.
 // Bodies never travel that way — `content` is off the projection below and off
 // the realtime fanout, and is fetched one row at a time when a document is
 // opened. Every WRITE is 'manage' (see DB_TABLE_ACCESS): the daemon sync is
 // the only writer, and a browser-forged row would be a document claiming to
 // have come off an agent's disk.
 'agent_documents',
 'memory_file_comments',
 'thread_items',
 'activity_event_comments',
 // Huddles are READ through the generic /db path (and, more importantly,
 // subscribed to over realtime db_changes so the channel card is live). Every
 // write goes through the dedicated /backend/workspaces/:id/.../huddle routes in
 // server/huddles.cjs — see DB_TABLE_ACCESS below, which gates generic writes to
 // 'manage' so the token-minting and webhook-authority paths cannot be bypassed.
 'huddles',
 'huddle_events',
 // In-app feedback reports. READ through the generic /db path on purpose: that
 // routes read authorization through enforceDbOperationAccess -> 'read' on the
 // report's workspace, which is the System workspace — so "only members of the
 // System workspace can read feedback" is enforced by the SAME membership gate
 // as every other table, with no bespoke authorization path to get wrong.
 // Every WRITE is gated to 'manage' below: reports are created only by the
 // dedicated, rate-limited POST /backend/feedback route (any signed-in user),
 // never by a browser reaching /backend/db/insert.
 'feedback_reports',
 // Orb delivery ledger (plans/021). READ through the generic /db path so the
 // delivery list is live over realtime db_changes; every write comes from the
 // trigger route itself, and DB_TABLE_ACCESS gates generic writes to 'manage'
 // so a client cannot forge or erase a delivery record. Same shape as
 // agent_schedule_runs, for the same reason.
 'orb_deliveries',
 // Interactive tool approvals. READ through the generic /db path so the card in
 // the transcript goes live the instant a daemon asks, over the same realtime
 // db_changes subscription every other table uses. Every WRITE is gated to
 // 'manage' below and goes through POST
 // /backend/workspaces/:id/permission-requests/:requestId instead — the answer
 // has to reach the daemon holding the turn open, and a row flipped straight to
 // 'allowed' via /backend/db/update would show "Approved" under a tool call
 // that never ran.
 'agent_permission_requests',
 // Workspace automations. READ through the generic /db path so the list and the
 // run history go live over the same realtime db_changes subscription every
 // other table uses. Every WRITE is gated to 'manage' below and goes through
 // /backend/workspaces/:id/automations instead — that route is the only place a
 // definition is VALIDATED, and an unvalidated row is the whole problem: a
 // forged automation is a standing grant to write into the workspace on an
 // event, available to anyone who could reach /backend/db/insert.
 'automations',
 'automation_runs',
 // Agent templates ("persona packs"). Readable at 'read' and writable at
 // 'write' through the generic path, because a template is prose: a 'write'
 // member can already type a system prompt straight into an agent, so authoring
 // one grants nothing new. What makes that safe is the SHAPE — the table has no
 // column for permission_mode, metadata, sandbox_config or a connect token, so
 // there is nothing privileged for a generic write to reach. See the DDL
 // comment in server/index.cjs and shared/agentTemplates.cjs.
 'workspace_agent_templates',
 // Workspace-authored skills — the app-side skill store. READ through the
 // generic /db path so the Skills window's list goes live over the same realtime
 // db_changes subscription every other table uses. Every WRITE is gated to
 // 'manage' below and goes through /backend/workspaces/:id/skills instead,
 // because that route is the only place shared/workspaceSkills.cjs runs — and
 // the validator is what enforces the name rule, the 64 KiB body cap, and the
 // refusal of a never-carried field. A row written straight through
 // /backend/db/insert would be a skill with a name `read_skill` cannot look up,
 // or a body larger than the loader will ever return.
 //
 // What makes 'read' safe here is the SHAPE, the same argument
 // workspace_agent_templates makes: the table has no column for a base_url, a
 // credential, an mcp server, code or a filesystem path, so there is nothing
 // privileged for a generic select to reach. SELECTABLE_COLUMNS_BY_TABLE still
 // pins the column list, because a table in ALLOWED_TABLES with no allow-list
 // returns every column a later migration adds.
 'workspace_skills',
 // Scheduled agent runs. READ through the generic /db path for one reason: a
 // client cannot subscribe to a table it cannot select (authorizeRealtimeBinding
 // -> ensureTable -> enforceDbOperationAccess('select')), and
 // src/hooks/useSchedules.ts has subscribed to agent_schedules since the day it
 // was written. Without this line that subscription is refused and the error
 // frame is dropped by backendClient, so the schedules list never went live.
 // Every WRITE is explicitly refused below and goes through
 // /backend/workspaces/:id/schedules — the only place agent_id and session_id are
 // checked to belong to this workspace and the interval is clamped. A schedule is
 // a standing "run this agent on a timer" grant, so a forged row is strictly
 // stronger than the 'run_agents' capability its dedicated route asks for.
 'agent_schedules',
 // Workspace inference gateways. Same reason as agent_schedules: src/hooks/
 // useGateways.ts has always subscribed and always been refused. Three
 // protections ride WITH this line and are not optional:
 //   - WORKSPACE_SCOPED_TABLES below (without it enforceDbOperationAccess returns
 //     early and ANY signed-in user reads EVERY workspace's gateway rows),
 //   - SELECTABLE_COLUMNS_BY_TABLE, which keeps api_key_cipher and the
 //     credential-bearing `headers` off the generic select, and
 //   - PRIVILEGED_DB_COLUMNS_BY_TABLE, which keeps base_url off generic writes so
 //     the assertSafeOutboundUrl SSRF guard on the dedicated routes cannot be
 //     stepped around by POSTing to /backend/db/insert.
 'gateway_configs',
 // Read receipts. READ through the generic /db path for the same reason
 // agent_schedules is: a client cannot SUBSCRIBE to a table it cannot select
 // (authorizeRealtimeBinding -> ensureTable -> enforceDbOperationAccess), and the
 // whole point of a receipt is that it appears while you are looking at the
 // conversation. Every WRITE is 'manage' below and goes through POST
 // /backend/sessions/:id/read, which is the ONLY place `user_id` is stamped from
 // req.userId and the marker's timestamp is resolved from the message row — a
 // generic insert would let anyone claim anyone read anything, at any time.
 //
 // The table has NO workspace_id column, ON PURPOSE (see shared/read-receipts.cjs):
 // that makes an unscoped subscription inexpressible, so a receipt can only ever
 // reach a socket that named its session and passed enforceSessionReadAccess for
 // it. DM read state therefore never fans out workspace-wide.
 'session_read_state',
]);

// F4: superset lifted VERBATIM from server/index.cjs (the reference). Both runtimes
// destructure these from here so a table/column can never be exposed on one backend
// but not the other again (netlify was 18 tables, missing agent_connections.capabilities
// -> capability writes not cast ::jsonb). VERSIONED_TABLES + JSON_COLUMNS_BY_TABLE are
// new core exports, added to module.exports (P11b).
const VERSIONED_TABLES = new Set([
 'workspaces',
 'documents',
 'chat_sessions',
 'memory_facts',
 'uploaded_files',
 'canvas_groups',
 'canvas_layers',
 'canvas_objects',
 'tasks',
 'document_comments',
 'task_comments',
 'workspace_agents',
 'agent_webhooks',
 'agent_memory_files',
 'memory_file_comments',
 'activity_event_comments',
]);

const JSON_COLUMNS_BY_TABLE = {
 chat_sessions: new Set(['participants']),
 canvas_objects: new Set(['points']),
 workspace_agents: new Set(['tools', 'skills', 'resource_facets', 'metadata', 'sandbox_config', 'identity', 'sharing']),
 agent_connections: new Set(['metadata', 'capabilities']),
 agent_registrations: new Set(['requested_identity']),
 agent_jobs: new Set(['metadata']),
 activity_events: new Set(['metadata']),
 messages: new Set(['reactions', 'attachments']),
 // Same shape and same rule as messages.attachments: references to
 // uploaded_files rows, never file bytes. See lib/messageAttachments.ts,
 // reused as-is for tasks since the column is generic.
 tasks: new Set(['attachments']),
 feedback_reports: new Set(['page', 'selections', 'diagnostics']),
 workspace_agent_templates: new Set(['tools', 'skills', 'resource_facets', 'origin']),
 workspace_skills: new Set(['origin']),
 automations: new Set(['definition']),
 automation_runs: new Set(['payload', 'definition', 'steps']),
};

// Columns that are Postgres native arrays (NOT jsonb). The generic /backend/db
// insert/update path binds params via node-postgres `.unsafe(sql, params)`,
// which does NOT array-serialize a raw JS array for an untyped ($n) param — it
// coerces with `'' + value`, producing `a,b` instead of the required array
// literal `{a,b}`. So these columns are bound as an explicit PG array literal
// string with a `::<elemType>[]` cast (see toPgArrayLiteral / bindDbParam).
const ARRAY_COLUMNS_BY_TABLE = {
 tasks: { depends_on: 'uuid' },
};

function arrayColumnElemType(table, column) {
 return ARRAY_COLUMNS_BY_TABLE[table]?.[column] || null;
}

// Build a Postgres array literal (e.g. `{a,b,c}`) from a JS array. Elements are
// double-quoted and escaped so a stray quote/backslash can't break out of the
// literal. Returns '{}' for null/empty/non-array input.
function toPgArrayLiteral(value) {
 const items = Array.isArray(value) ? value : [];
 if (items.length === 0) return '{}';
 const parts = items
  .filter((item) => item != null)
  .map((item) => `"${String(item).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
 return `{${parts.join(',')}}`;
}

// Tables whose rows are scoped to a workspace and therefore subject to
// membership/role checks. Maps table -> how to find its workspace id.
// MUST stay in lockstep with server/index.cjs (parity test enforces this).
const WORKSPACE_SCOPED_TABLES = new Set([
 'documents', 'chat_sessions', 'memory_facts', 'uploaded_files',
 'canvas_groups', 'canvas_layers', 'canvas_objects', 'tasks', 'document_comments',
 'task_comments', 'document_versions', 'workspace_agents', 'agent_webhooks',
 'agent_connections', 'cursorbuddy_connection_keys', 'agent_jobs', 'agent_registrations',
 'activity_events', 'workspace_members',
 'agent_memory_files', 'agent_documents', 'memory_file_comments', 'thread_items',
 'agent_schedules', 'agent_schedule_runs', 'activity_event_comments',
 'huddles', 'huddle_events', 'feedback_reports', 'orb_deliveries',
 'agent_permission_requests', 'thread_harvests',
 'automations', 'automation_runs',
 'workspace_agent_templates',
 // Without this line a skill body authored in one workspace is selectable by
 // any signed-in user in every other one — enforceDbOperationAccess returns
 // early for a table it does not find here. See the note below.
 'workspace_skills',
 // Load-bearing, not tidy. enforceDbOperationAccess returns EARLY for any table
 // that is not in this set (`if (!WORKSPACE_SCOPED_TABLES.has(table) && table !==
 // 'messages') return;`) — so a table that is in ALLOWED_TABLES but missing here
 // has NO row scoping at all, and one signed-in user reads every other tenant's
 // rows. gateway_configs rows carry an encrypted provider API key, so that would
 // be a cross-tenant leak, not a cosmetic one.
 'gateway_configs',
 // Same rule, and the entry that also switches ON the session gate: the `select`
 // branch of enforceDbOperationAccess (which is what runs enforceSessionReadAccess
 // for a session_id-filtered read) sits BELOW the early return this Set guards.
 // Without this line a read of session_read_state is neither workspace-scoped nor
 // DM-scoped — every signed-in user could read who-read-what in every tenant.
 'session_read_state',
]);

const WORKSPACE_ROLE_CAPABILITIES = {
 owner: new Set(['read', 'write', 'comment', 'run_agents', 'manage']),
 admin: new Set(['read', 'write', 'comment', 'run_agents', 'manage']),
 editor: new Set(['read', 'write', 'comment', 'run_agents']),
 commenter: new Set(['read', 'comment']),
 viewer: new Set(['read']),
};

const DEFAULT_TABLE_ACCESS = {
 select: 'read',
 insert: 'write',
 update: 'write',
 delete: 'write',
};

const DB_TABLE_ACCESS = {
 documents: DEFAULT_TABLE_ACCESS,
 chat_sessions: DEFAULT_TABLE_ACCESS,
 messages: DEFAULT_TABLE_ACCESS,
 memory_facts: DEFAULT_TABLE_ACCESS,
 uploaded_files: DEFAULT_TABLE_ACCESS,
 canvas_groups: DEFAULT_TABLE_ACCESS,
 // A layer is no more privileged than the objects drawn on it: same read/write
 // capabilities as canvas_objects, so anyone who can draw can name a canvas.
 canvas_layers: DEFAULT_TABLE_ACCESS,
 canvas_objects: DEFAULT_TABLE_ACCESS,
 tasks: DEFAULT_TABLE_ACCESS,
 document_versions: DEFAULT_TABLE_ACCESS,
 workspace_agents: DEFAULT_TABLE_ACCESS,
 // Same capabilities as workspace_agents itself, and for the same reason:
 // authoring a template is no more privileged than typing the prompt it holds,
 // which 'write' can already do directly on an agent. The control is the
 // table's SHAPE, not its capability row — it has no privilege-bearing column.
 workspace_agent_templates: DEFAULT_TABLE_ACCESS,
 // SELECT is 'read' — every member needs the skill list, and the row holds
 // nothing privileged (the table has no base_url, credential, mcp, code or path
 // column; that absence is the control, see the DDL comment). Every WRITE is
 // 'manage' to match agent_schedules/automations: authoring is a 'write'
 // capability, but it happens through POST/PATCH/DELETE
 // /backend/workspaces/:id/skills, which is the ONLY place
 // normalizeWorkspaceSkill runs. Gating the generic path harder than the
 // dedicated one is what makes "the validator always ran" true rather than
 // customary — a name that fails the agentskills.io rule is a skill `read_skill`
 // can never look up, and a 100 KiB body is one the loader silently truncates.
 workspace_skills: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 agent_connections: { select: 'read', insert: 'run_agents', update: 'run_agents', delete: 'manage' },
 cursorbuddy_connection_keys: { select: 'manage', insert: 'manage', update: 'manage', delete: 'manage' },
 agent_jobs: { select: 'read', insert: 'run_agents', update: 'run_agents', delete: 'manage' },
 // The browser still appends a small set of UI events, but history is immutable:
 // enforceDbOperationAccess explicitly refuses UPDATE/DELETE below. Keeping the
 // capabilities explicit documents that distinction and makes an accidental
 // removal of the refusal fail closed for ordinary writers.
 activity_events: { select: 'read', insert: 'write', update: 'manage', delete: 'manage' },
 document_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
 task_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
 workspace_members: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 agent_webhooks: { select: 'manage', insert: 'manage', update: 'manage', delete: 'manage' },
 // Kept in sync with server/index.cjs DB_TABLE_ACCESS so a table added to this
 // runtime's ALLOWED_TABLES can't silently fall through to the default
 // read/write mapping (L1, 2026-07 review).
 agent_registrations: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // Writes go through dedicated /backend/.../schedules endpoints (workspace/session
 // validation + interval clamps). Generic /db writes are refused explicitly below;
 // these declarations remain defense in depth. Runs are written by the runner only.
 agent_schedules: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 agent_schedule_runs: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // SELECT is 'read' to MATCH the dedicated route: GET /backend/workspaces/:id/
 // gateways is gated at 'read', and every member who can pick a model in chat
 // needs the list. Nothing is given away by the match, because
 // SELECTABLE_COLUMNS_BY_TABLE projects the generic select down to STRICTLY LESS
 // than that route returns (no api_key_cipher, and no `headers` either — the REST
 // projection does pass headers through, this one does not).
 // Every WRITE is 'manage', matching POST/PATCH/DELETE .../gateways, and the
 // privileged-column strip below removes the columns those routes VALIDATE, so
 // 'manage' here is strictly weaker than 'manage' there rather than a way around.
 gateway_configs: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // Orb deliveries are written ONLY by the trigger route (which is where the
 // dedupe gate lives): a client-forged row would let an attacker pre-claim a
 // delivery id and make the next real delivery look like a duplicate, and a
 // client DELETE would erase the audit trail. Reads stay at 'read'.
 orb_deliveries: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // Read-only to the client, same shape and same reason as orb_deliveries: the
 // rows are written by the daemon socket and settled by the decide route, which
 // is where the "did the answer actually reach the agent?" check lives. The
 // explicit refusal in enforceDbOperationAccess below makes this declaration
 // defense in depth; `manage` must never become a generic write door.
 agent_permission_requests: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // Read-only to the client, same reason as agent_permission_requests above: every
 // row is written by the server's own harvest worker. These are PROPOSALS mined
 // from a discarded thread, so a client-forged row would put words a model never
 // produced in front of a human as a suggestion to accept.
 thread_harvests: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // Read-only to the client, and this one is load-bearing rather than tidy. An
 // automations row is a STANDING grant: whenever its trigger event fires, the
 // server writes into the workspace on the author's behalf, with no human in
 // the loop. A client-forged row would therefore be an automation primitive
 // available to anyone who can reach /backend/db/insert — strictly stronger
 // than the 'write' capability they hold. Writes go through
 // /backend/workspaces/:id/automations, which is the only place the definition
 // is VALIDATED against the field/op/action allowlists.
 automations: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // Written only by the engine. A client-forged run row would claim an
 // automation did something it never did; a client DELETE would erase the
 // record that it did.
 automation_runs: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 agent_memory_files: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // Same rule, same reason: the daemon sync is the only writer. A browser-forged
 // row here would be a document claiming to have come off an agent's disk, in a
 // library whose whole value is that its provenance is true.
 agent_documents: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 memory_file_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
 thread_items: DEFAULT_TABLE_ACCESS,
 activity_event_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
 // Read-only to the client on purpose. Huddle rows are created/ended by the
 // dedicated routes (which mint the LiveKit join token) and huddle_events is
 // APPEND-ONLY, written only by those routes and by the signed LiveKit webhook.
 // If a browser could insert a huddle_events row it could claim someone was in a
 // call, which is exactly the server-side-authority property this feature has.
 // The explicit refusal in enforceDbOperationAccess below makes every generic
 // write unreachable; 'manage' remains here as defense in depth so removing
 // that refusal cannot silently reopen the tables to ordinary editors.
 huddles: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 huddle_events: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // SELECT is the whole point: a member of the System workspace reads the
 // reports filed against the product. 'read' means the generic gate resolves
 // the row's workspace and demands membership of it, so one user can never see
 // another user's report — the reporter is not a member and gets 403.
 // INSERT is 'manage', NOT 'write': submitting must stay on the dedicated
 // rate-limited route, which is the only place that resolves the System
 // workspace server-side and runs the server's own redaction pass. A generic
 // insert would let a client choose the workspace and skip both.
 feedback_reports: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // SELECT is 'read': every member who can read a conversation may see who else
 // has read it, and the session gate below narrows that to members for a DM.
 // Every WRITE is 'manage' as defense in depth, but the explicit refusal in
 // enforceDbOperationAccess below makes it unreachable even to an owner. The
 // dedicated route is the only place two things happen: `user_id` comes from
 // req.userId rather than the body, and `read_at` is resolved from the named
 // message's own created_at rather than from a client clock. Generic INSERT or
 // UPDATE could fabricate a social signal about another person, and generic
 // DELETE could erase one.
 session_read_state: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
};

// Columns that must never be set via generic /backend/db/* write by non-dedicated
// routes (editors could otherwise approve MCP agents, rewrite storage paths, etc.).
const PRIVILEGED_DB_COLUMNS_BY_TABLE = {
 chat_sessions: new Set([
  // Written only by the atomic split command. Letting a browser forge these
  // values would make merge omit real work or close a fork as "empty".
  'split_at',
  'split_baseline_message_id',
  'split_source_boundary_message_id',
 ]),
 // `messages.reactions` is a jsonb MAP the browser used to compute and PUT whole.
 // That is a read-modify-write across a network round trip: two people reacting
 // inside the realtime propagation window each built a full map from a stale base
 // and the second write erased the first. It also accepted an ARBITRARY map, so
 // any client could write any user's id into it — shared/reaction-events.cjs
 // documents that as the reason `userId` and `actorUserId` are separate fields.
 //
 // POST /backend/messages/:id/reactions now owns the mutation: one atomic SQL
 // statement (no stale base) with the reactor bound from req.userId (nothing to
 // forge). Stripping the column here is what makes that the ONLY door — without
 // it the racy path stays open beside the fixed one and the forgeable
 // attribution goes with it. Stripped rather than refused, like every entry
 // here: an ordinary message edit that happens to echo `reactions` back still
 // saves, it just cannot set it.
 messages: new Set([
  'reactions',
  // Browser-authenticated writes are HUMAN writes. These fields are assigned
  // by the generic insert route from the verified session and are never
  // client-editable afterwards. Server/daemon/automation writers bypass the
  // generic browser route and keep writing their own trusted attribution.
  'role',
  'sender_kind',
  'sender_id',
  'sender_name',
  'message_kind',
  'tool_name',
  'tool_detail',
  'source_task_id',
  'huddle_id',
  'permission_request_id',
  'created_at',
  // Soft-delete time is stamped only by /backend/db/delete. If a generic
  // update could set it, the same door could also set it back to null and
  // undelete a row whose content should remain DB-only.
  'deleted_at',
 ]),
 // Server-owned routing provenance for queued agent work. `created_by` is
 // stamped from the authenticated principal on generic task creation, and
 // `dispatch_requested_by` records the human whose private agent conversation
 // must receive a delayed assignment. Letting a browser set either would make
 // attribution forgeable and could steer a later queue drain into another
 // human's DM.
 tasks: new Set([
  'created_by',
  'dispatch_requested_by',
 ]),
 workspace_agents: new Set([
  'mcp_approved',
  'connect_token_hash',
  'connect_token',
  'permission_mode',
  'controller_id',
  // This is the optimistic-concurrency boundary used by identity merges and
  // in-flight AI replies. A browser may never preserve or choose it while
  // changing the model/persona; every real generic edit advances it in SQL.
  'version',
 ]),
 // Provenance, written only by the dedicated routes. A generic write that could
 // set source='authored' on an imported template, or rewrite `origin`, would
 // erase the only record of where an attacker-influenced system prompt came
 // from — which is the question someone will ask when an agent misbehaves.
 workspace_agent_templates: new Set([
  'source',
  'origin',
 ]),
 // Same reason, same two columns. Provenance is written only by the dedicated
 // routes: a generic write that could set source='authored' on a body accepted
 // from a thread harvest, or rewrite `origin`, would erase the only record of
 // where a procedure an agent is about to follow actually came from.
 workspace_skills: new Set([
  'source',
  'origin',
 ]),
 uploaded_files: new Set([
  'storage_path',
  'content_sha256',
  'type',
 ]),
 // M6 (2026-07 review): the generic gate authorizes a workspaces UPDATE on the
 // 'manage' capability, and 'admin' is an invitable role that HAS 'manage' — so
 // without a column guard any admin could POST /backend/db/update
 // {table:'workspaces', values:{user_id:'<their id>'}} and take ownership, or
 // rewrite the MCP client credential. Ownership transfer and MCP credentials
 // have their own dedicated routes; they are never a generic column write.
 workspaces: new Set([
  'user_id',
  'mcp_token_hash',
  'mcp_auto_approve',
 ]),
 // The three columns the dedicated gateway routes exist to VALIDATE or PROTECT.
 // Allowlisting gateway_configs opens /backend/db/insert|update on it, and those
 // routes do not run route-level validation — so without this strip:
 //   base_url        would be settable without assertSafeOutboundUrl, which is the
 //                   live SSRF guard (tests/gateway-ssrf.test.cjs). The row is
 //                   later fetched server-side by the ai-chat gateway branch, so an
 //                   unvalidated base_url is a request from the Fly machine to
 //                   whatever the writer chose — 169.254.169.254 included.
 //   api_key_cipher  would be settable to attacker-chosen ciphertext, and readable
 //                   back only through the vault decryptor — a way to make the
 //                   server hand a chosen credential to a chosen base_url.
 //   headers         is where an Authorization header lives.
 // Stripped rather than refused, matching every other entry here: a generic write
 // that mentions one of these still succeeds, it just cannot set it. The dedicated
 // routes remain the only door, which is the property the SSRF fix depends on.
 gateway_configs: new Set([
  'base_url',
  'api_key_cipher',
  'headers',
 ]),
};

// Columns the browser may provide when CREATING a row but may never move or
// rewrite afterwards. Kept separate from PRIVILEGED_DB_COLUMNS_BY_TABLE because
// messages need id/session/thread_parent to address the insert in the first
// place. Server-owned writers use direct SQL and are unaffected.
const IMMUTABLE_DB_UPDATE_COLUMNS_BY_TABLE = {
 chat_sessions: new Set([
  // Privacy classification is server-owned. Both columns participate in the
  // canonical predicate (`visibility = private OR folder = Direct messages`),
  // so moving either through the generic route could change who may read the
  // session. A public->private transition needs cross-process realtime
  // invalidation; allowing a generic Netlify write would leave Fly sockets and
  // already-rendered activity bodies stale. Folder organisation belongs on a
  // dedicated route that can prove the classification did not change.
 'visibility',
 'folder',
  // Derivation is also authority for close: editors may close a sub-thread or
  // fork they can work in, while a main channel requires manage. If either
  // edge could be rewritten after creation, an editor could reclassify a main
  // channel as a derived shell and close the whole conversation graph.
  'parent_message_id',
  'split_parent_id',
  'split_at',
  'split_baseline_message_id',
  'split_source_boundary_message_id',
 ]),
 messages: new Set([
  'id',
  'session_id',
  'thread_parent_id',
 ]),
};

// Columns a generic /backend/db write MAY still set, but only for a caller who
// has 'manage' on the workspace. Unlike PRIVILEGED_DB_COLUMNS_BY_TABLE (which is
// stripped outright), these back real product features whose ONLY writer is the
// generic db route, so blocking them would break the feature:
//
//   workspace_agents.metadata carries `host_folders`, which dispatch forwards to
//   the daemon and buildAgentCommand turns into `--add-dir <path>` for the coding
//   CLI. A member with only 'write' could otherwise widen an agent's filesystem
//   access to `/` or `~/.ssh` (H3, 2026-07 review). sandbox_provider /
//   sandbox_config likewise choose where and how agent code executes.
const MANAGE_ONLY_DB_COLUMNS_BY_TABLE = {
 chat_sessions: new Set([
  // Closing a session now tears down every participant's retained transcript,
  // active jobs, permission prompts and linked huddle media. It is the same
  // authority as the dedicated clear command, never an ordinary editor write.
  'deleted_at',
 ]),
 workspace_agents: new Set([
  'metadata',
  'sandbox_provider',
  'sandbox_config',
 ]),
};

// True when `values` actually SETS one of the manage-only columns. A key that is
// absent, null, an empty string or an empty object does not count: the Agents
// window sends `sandbox_provider: null` / `sandbox_config: {}` on every agent
// create, and clearing a value is never an escalation. A JSON *string* payload
// (the jsonb columns accept one) is treated as a real value.
function setsManageOnlyDbColumn(table, values) {
 const elevated = MANAGE_ONLY_DB_COLUMNS_BY_TABLE[table];
 if (!elevated) return false;
 if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
 for (const key of elevated) {
  if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
  const value = values[key];
  if (value == null) continue;
  if (typeof value === 'string' && value.trim() === '') continue;
  if (typeof value === 'object' && Object.keys(value).length === 0) continue;
  return true;
 }
 return false;
}

// Columns a generic /backend/db/select may return, per table. Tables with no
// entry are unrestricted (unchanged behaviour). app_users is listed because the
// gate below deliberately allows a self-scoped SELECT, and the select handlers
// honour `columns: "*"` — which returned the caller's scrypt password_hash and
// the token_version that gates session revocation straight to the browser
// (M7, 2026-07 review).
const SELECTABLE_COLUMNS_BY_TABLE = {
 app_users: ['id', 'email', 'display_name', 'accent_color', 'created_at'],
 // Conversations are the root of several security-sensitive joins. Pinning
 // their complete browser shape means a later credential/provenance column is
 // not exposed automatically by the generic `columns: '*'` path. Dedicated
 // creation commands may add an explicitly reviewed public lineage column to
 // this list; until then it remains server-only.
 chat_sessions: [
  'id', 'workspace_id', 'title', 'model', 'folder', 'description', 'icon',
  'intent', 'is_favorite', 'participants', 'conversation_mode',
  'max_agent_turns', 'auto_rounds', 'parent_message_id', 'split_parent_id',
  'split_at', 'archived_at', 'deleted_at', 'canvas_id', 'version',
  'visibility', 'created_at', 'updated_at',
 ],
 // Workspace control is deliberately owner-only and its bearer hash is never
 // workspace metadata. Generic reads and mutation echoes previously returned
 // `mcp_token_hash` to every workspace reader because the table had no
 // projection. Pin the complete public row shape so a future credential column
 // is excluded by default too.
 workspaces: [
  'id', 'name', 'description', 'icon', 'user_id', 'auto_share',
  'local_path', 'project_kind', 'git_root', 'git_remote',
  'background_opacity', 'background_image', 'version', 'parent_id',
  'is_system', 'created_at', 'updated_at',
 ],
 // The dedicated workspace agents route already spells this public shape and
 // omits connect_token_hash/mcp_approved. The generic path must not be wider:
 // the connect hash is the daemon's bearer verifier, and mutation RETURNING
 // used to echo the stored value even after the write guard stripped it from
 // the request.
 workspace_agents: [
  'id', 'workspace_id', 'name', 'avatar', 'openpet_avatar_id',
  'accent_color', 'description', 'system_prompt', 'soul', 'instructions',
  'tools', 'skills', 'purpose', 'resource_facets', 'metadata', 'identity',
  'handle', 'model', 'run_mode', 'sandbox_provider', 'sandbox_config',
  'memory_dir', 'enabled', 'ambient_replies', 'sharing', 'permission_mode', 'version',
  'created_by', 'created_at', 'updated_at',
 ],
 // A webhook URL is a bearer credential and is returned in plaintext exactly
 // once by POST /backend/agent-webhooks. `token` stores its hash for new rows
 // but may still hold legacy plaintext; either form is credential material and
 // neither belongs in list/select/update responses.
 agent_webhooks: [
  'id', 'workspace_id', 'agent_id', 'name', 'enabled',
  'last_triggered_at', 'version', 'created_at', 'updated_at',
 ],
 // A job's prompt is the assembled daemon payload (conversation, system prompt,
 // documents and agent context) and `response` is the full streamed answer.
 // The browser's workspace feed needs neither: it renders only liveness badges.
 // Keep the generic path at that exact metadata shape; transcripts remain the
 // source for human-readable content.
 agent_jobs: [
  'id', 'workspace_id', 'session_id', 'agent_id', 'status',
  'started_at', 'created_at', 'metadata',
 ],
 // Keep internal queue-routing provenance out of the generic task surface. It
 // is an authorization input, not task content, and a future internal task
 // column must not become browser-readable merely because tasks already exist
 // in ALLOWED_TABLES.
 tasks: [
  'id', 'workspace_id', 'created_by', 'assignee_id', 'title', 'description',
  'status', 'priority', 'due_date', 'source_type', 'source_id', 'completed_at',
  'version', 'created_at', 'updated_at', 'parent_id', 'start_date',
  'depends_on', 'attachments',
 ],
 // gateway_configs became selectable so its realtime subscription could work at
 // all (authorizeRealtimeBinding authorizes a db_changes binding as a SELECT), and
 // `columns: '*'` would otherwise hand back api_key_cipher — the encrypted
 // provider key the dedicated route deliberately reduces to a `has_key` boolean,
 // because "the API key is NEVER returned to the client" is the stated contract in
 // server/workspaces-routes.cjs.
 //
 // `headers` is off this list too, and that is a DEPARTURE from publicGatewayConfig
 // rather than a copy of it: the REST projection passes headers through verbatim,
 // and an operator can put an `Authorization: Bearer …` in there. The generic path
 // is new surface with no consumer that needs the value (useGateways refetches over
 // REST and never reads the realtime row), so it gets the smaller set. Same rule as
 // channel_bridges.config: strip the whole column, so a header nobody has thought
 // of yet is excluded by default rather than by review.
 gateway_configs: [
  'id', 'workspace_id', 'name', 'base_url', 'model', 'protocol', 'created_at', 'updated_at',
 ],
 // Pinned even though every column here is currently harmless, because a table
 // in ALLOWED_TABLES with NO entry in this map returns EVERY column to any
 // member with 'read' — including whatever a future migration adds. This table
 // is the one people will be tempted to extend (a `path`, an `agent_id`, a
 // provider hint), so the allow-list is the thing that makes such a column a
 // deliberate exposure rather than an automatic one.
 //
 // `body` IS listed: it is the skill, and the Skills window renders it. What is
 // NOT listed is nothing today — the point is the next column.
 workspace_skills: [
  'id', 'workspace_id', 'name', 'title', 'summary', 'body', 'revision',
  'source', 'origin', 'created_by', 'created_at', 'updated_at',
 ],
 // Pinned for the same reason, and with one asymmetry worth stating. `content`
 // IS selectable — it is the document, and the library renders and diffs it —
 // but the client asks for it ONE ROW AT A TIME (useAgentDocuments keeps a
 // metadata-only list and fetches a body when a document is opened), and it is
 // stripped from the realtime fanout in server/realtime.cjs. So the body is
 // reachable without every UPSERT pushing every body to every subscriber.
 //
 // The next column added to this table is the reason the list exists: an
 // absolute host path, a git remote, a repo-local URL would all be automatic
 // exposures without it.
 agent_documents: [
  'id', 'workspace_id', 'agent_id', 'path', 'title', 'domain', 'summary',
  'content', 'byte_size', 'truncated', 'content_hash', 'source_modified_at',
  'last_synced', 'version', 'created_at', 'updated_at',
 ],
 // Strictly LESS than the dedicated route returns, which is the rule for every
 // entry here. `updated_at` is dropped: it records when a marker last MOVED,
 // which is a finer clock than "read up to this point" and is not a disclosure
 // this feature makes. It stays an operational column, readable only in psql.
 session_read_state: [
  'marker_id', 'event_version', 'session_id', 'user_id', 'agent_id', 'thread_parent_id',
  'last_seen_message_id', 'read_at',
 ],
};

// Some tables must remain in ALLOWED_TABLES so an authenticated realtime
// binding can be authorized, while their snapshot read must go through a
// dedicated route with stricter projection/policy. Keep that distinction
// explicit: removing session_read_state from ALLOWED_TABLES silently breaks the
// live UI; allowing generic SELECT bypasses reciprocity and human opt-out.
const DEDICATED_SELECT_ONLY_TABLES = new Set(['session_read_state']);

function assertGenericSelectAllowed(table) {
 if (DEDICATED_SELECT_ONLY_TABLES.has(table)) {
  throw forbidden(`Table ${table} is readable only through its dedicated route`);
 }
}

/**
 * Project a generic read or mutation RETURNING clause down to what the table
 * allows. Returns a
 * comma-separated column list (the same shape both backends' normalizeColumns
 * already accepts) so callers wrap it: normalizeColumns(safeSelectColumns(...)).
 * Throws 403 when a column outside the allow-list is asked for by name, so the
 * denial is visible rather than a silently missing field.
 */
function safeSelectColumns(table, columns) {
 const allowed = SELECTABLE_COLUMNS_BY_TABLE[table];
 if (!allowed) return columns;
 if (!columns || columns === '*') return allowed.join(', ');
 const requested = String(columns).split(',').map((column) => column.trim()).filter(Boolean);
 if (requested.length === 0) return allowed.join(', ');
 for (const column of requested) {
  if (!allowed.includes(column)) throw forbidden(`Column ${table}.${column} is not selectable`);
 }
 return requested.join(', ');
}

const DELETED_MESSAGE_CONTENT = 'This message was deleted.';
const AI_STREAM_ERROR_MAX_LENGTH = 1_000;

/**
 * Normalize terminal error frames from Anthropic and OpenAI-compatible SSE
 * streams. A provider can return HTTP 200, emit partial text, then end with an
 * error object; that terminal error must win the durable transcript.
 */
function aiStreamErrorText(frame) {
 if (!frame || typeof frame !== 'object') return '';
 const error = frame.error;
 const isErrorFrame = String(frame.type || '').toLowerCase() === 'error' || error != null;
 if (!isErrorFrame) return '';
 const candidate = typeof error === 'string'
  ? error
  : error && typeof error === 'object'
   ? (error.message || error.type || error.code)
   : frame.message;
 const text = String(candidate || 'AI stream failed').trim();
 return (text || 'AI stream failed').slice(0, AI_STREAM_ERROR_MAX_LENGTH);
}

/**
 * Keep a soft-deleted row as a structural thread/sub-thread anchor without
 * returning the payload its author deleted. Only replace fields that were
 * actually selected so a narrow generic projection stays narrow.
 */
function redactDeletedMessageRow(row) {
 if (!row || typeof row !== 'object' || !row.deleted_at) return row;
 const next = { ...row };
 const replacements = {
  content: DELETED_MESSAGE_CONTENT,
  attachments: [],
  message_kind: '',
  tool_name: '',
  tool_detail: '',
  reactions: {},
  pinned: false,
  source_task_id: null,
  huddle_id: null,
  permission_request_id: null,
 };
 for (const [column, value] of Object.entries(replacements)) {
  if (Object.prototype.hasOwnProperty.call(next, column)) next[column] = value;
 }
 return next;
}

function redactDeletedMessageRows(rows) {
 return Array.isArray(rows) ? rows.map(redactDeletedMessageRow) : [];
}

function stripPrivilegedDbValues(table, values) {
 if (!values || typeof values !== 'object' || Array.isArray(values)) return values;
 const privileged = PRIVILEGED_DB_COLUMNS_BY_TABLE[table];
 if (!privileged) return values;
 const next = { ...values };
 for (const key of privileged) {
  if (Object.prototype.hasOwnProperty.call(next, key)) delete next[key];
 }
 return next;
}

/**
 * Narrow a `workspace_agents.sharing` write to the four known booleans.
 *
 * `sharing` is jsonb, which means the generic /backend/db write path would
 * otherwise let anyone with 'write' park arbitrary data — any size, any shape —
 * on an agent row through a column whose readers expect four booleans. Unknown
 * keys are DROPPED rather than rejected so an older client that round-trips a
 * whole agent object cannot fail its save on a key it never chose to send.
 *
 * A patch is MERGED over nothing, not over the stored value: the column holds
 * only the keys someone explicitly set, and every reader applies the fail-open
 * rule (shared/agentSharing.cjs). A partial write therefore means "these are
 * the switches I touched", and the rest stay at whatever the reader's default
 * says — which is the same answer they gave before the write.
 */
function sanitizeAgentSharingValues(table, values) {
 if (table !== 'workspace_agents' || !values || typeof values !== 'object' || Array.isArray(values)) {
  return values;
 }
 if (!Object.prototype.hasOwnProperty.call(values, 'sharing')) return values;
 return { ...values, sharing: sanitizeAgentSharingPatch(values.sharing) };
}

function stripImmutableDbUpdateValues(table, values) {
 if (!values || typeof values !== 'object' || Array.isArray(values)) return values;
 const immutable = IMMUTABLE_DB_UPDATE_COLUMNS_BY_TABLE[table];
 if (!immutable) return { ...values };
 return Object.fromEntries(Object.entries(values).filter(([key]) => !immutable.has(key)));
}

/**
 * Validate the normalized rows used by the generic insert surface and return
 * the SQL column order. PostgreSQL applies one column list to every VALUES
 * tuple, so silently reading each later row through the first row's keys turns
 * a missing field into `undefined` and ignores every extra field. Both backend
 * runtimes call this once per incoming row before normalization (so spreading
 * cannot disguise an array or other non-record), then once on the normalized
 * batch so the shape checked there is the shape that will actually be bound.
 */
function validateUniformInsertRows(rows) {
 if (!Array.isArray(rows) || rows.length === 0) {
  throw badRequest('Insert values are required');
 }

 let columns = null;
 let columnSet = null;
 for (const row of rows) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
   throw badRequest('Insert values must be plain objects');
  }
  const prototype = Object.getPrototypeOf(row);
  if (prototype !== Object.prototype && prototype !== null) {
   throw badRequest('Insert values must be plain objects');
  }

  const keys = Object.keys(row);
  if (keys.length === 0) throw badRequest('Insert values are required');
  if (columns === null) {
   columns = keys;
   columnSet = new Set(keys);
   continue;
  }
  if (keys.length !== columns.length || keys.some((key) => !columnSet.has(key))) {
   throw badRequest('All insert rows must use the same columns');
  }
 }

 return columns;
}

/**
 * Resource agents are explicit-use infrastructure by default. Apply that
 * creation default at the shared HTTP boundary so a future caller cannot
 * accidentally opt a new resource into ambient channel replies by omitting the
 * field. Explicit choices are preserved, and UPDATE never calls this helper, so
 * reclassifying an existing agent cannot silently change its behaviour.
 */
function applyAgentPurposeInsertDefaults(table, values) {
 if (table !== 'workspace_agents' || !values || typeof values !== 'object' || Array.isArray(values)) {
  return values;
 }
 if (values.purpose !== 'resource' || Object.prototype.hasOwnProperty.call(values, 'ambient_replies')) {
  return values;
 }
 return { ...values, ambient_replies: false };
}

/**
 * Stamp task attribution and delayed-dispatch routing from the authenticated
 * human. Both columns are stripped from client payloads first.
 *
 * On creation, `created_by` is always the caller and an initial assignee stores
 * the caller as requester. Updates need the row's OLD assignee to distinguish a
 * real transition from a form re-save, so both backend adapters add the
 * conditional SQL expression at their update chokepoint.
 */
function stampTaskWriteIdentity(table, values, userId, { insert = false } = {}) {
 if (table !== 'tasks' || !values || typeof values !== 'object' || Array.isArray(values)) {
  return values;
 }
 const next = { ...values };
 if (insert) {
  next.created_by = userId || null;
 }
 if (insert && Object.prototype.hasOwnProperty.call(next, 'assignee_id')) {
  const assigned = typeof next.assignee_id === 'string'
   ? next.assignee_id.trim()
   : next.assignee_id;
  next.dispatch_requested_by = assigned ? (userId || null) : null;
 }
 return next;
}

function taskDispatchRequesterSql(assigneeBind, requesterBind) {
 if (!/^\$\d+$/.test(String(assigneeBind)) || !/^\$\d+$/.test(String(requesterBind))) {
  throw new TypeError('taskDispatchRequesterSql requires positional binds');
 }
 return `"dispatch_requested_by" = CASE
    WHEN "assignee_id" IS DISTINCT FROM ${assigneeBind}
    THEN ${requesterBind}
    ELSE "dispatch_requested_by"
   END`;
}

/**
 * Storage path for a workspace-owned upload must live under that workspace's
 * prefix after normalization. Rejects absolute paths and any `..` traversal
 * (e.g. `ws-1/../ws-2/secret.txt` must NOT pass for workspace ws-1).
 */
function storagePathBelongsToWorkspace(workspaceId, storagePath) {
 const ws = String(workspaceId || '').trim();
 if (!ws || ws.includes('/') || ws.includes('\\') || ws === '.' || ws === '..') return false;

 // Normalize separators; do not strip leading slashes yet so we can reject absolutes.
 let sp = String(storagePath || '').replace(/\\/g, '/');
 if (!sp || sp.startsWith('/') || /^[a-zA-Z]:/.test(sp)) return false;

 // Explicitly reject any parent-directory segment before trusting normalize.
 // path.posix.normalize("ws-1/../ws-2/x") => "ws-2/x" which would otherwise
 // look "fine" for a different workspace check if we only prefix-matched
 // the pre-normalized string (or worse, pass a broken prefix check).
 const rawSegments = sp.split('/');
 if (rawSegments.some((seg) => seg === '..')) return false;

 // Collapse "." and empty segments; no ".." remains after the check above.
 const normalized = rawSegments
  .filter((seg) => seg && seg !== '.')
  .join('/');
 if (!normalized) return false;
 // Belt-and-suspenders after join.
 if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return false;

 return normalized === ws || normalized.startsWith(`${ws}/`);
}

// ----------------------------------------------------------------------------
// Error helpers — Errors carry a `.status` so framework adapters can map them to
// the existing `{ data: null, error }` JSON shape with the right HTTP code.
// ----------------------------------------------------------------------------

function httpError(status, message) {
 const err = new Error(message);
 err.status = status;
 return err;
}
function unauthorized(message = 'Authentication required') { return httpError(401, message); }
function forbidden(message) { return httpError(403, message); }
function badRequest(message) { return httpError(400, message); }

// ----------------------------------------------------------------------------
// AUTH: issue + verify a signed session token. The signing secret is passed in
// (no DB/env coupling here).
//
//   token format:
//     `${userId}.${tokenVersion}.${issuedAt}.${base64url(HMAC_SHA256(secret, payload))}`
//
//   where `issuedAt` is unix seconds at mint time. Tokens older than
//   TOKEN_TTL_SEC (default 14d, override via AGENSIS_TOKEN_TTL_SEC) are rejected
//   even if the signature and token_version still match.
//
// `token_version` (plan 005) is a per-user counter on app_users: a token embeds
// the version that was current when it was issued, and is rejected once that
// no longer matches the user's CURRENT version (bumped on sign-out / password
// change) — this is what makes revocation possible at all.
//
// `getTokenVersion(userId) => Promise<string|null>` is REQUIRED once the token
// signature checks out — verifyAuthToken deliberately does not fall back to
// "skip the check" if it's missing, since a caller forgetting to wire it would
// silently defeat revocation. See createTokenVersionCache below for the
// short-TTL cache every real caller should wrap `db` in (this runs on every
// authenticated request — an uncached per-request DB read is not acceptable).
// ----------------------------------------------------------------------------

const DEFAULT_TOKEN_TTL_SEC = 14 * 24 * 60 * 60; // 14 days

function getTokenTtlSec() {
 const raw = Number(process.env.AGENSIS_TOKEN_TTL_SEC);
 if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
 return DEFAULT_TOKEN_TTL_SEC;
}

/**
 * Mint a session token. `options.issuedAt` (unix seconds) is test-only so
 * expiry can be exercised without sleeping.
 */
function issueAuthToken(userId, tokenVersion, secret, options = {}) {
 if (!secret) throw new Error('issueAuthToken requires a signing secret');
 const issuedAt = Number.isFinite(options.issuedAt)
  ? Math.floor(options.issuedAt)
  : Math.floor(Date.now() / 1000);
 const payload = `${userId}.${tokenVersion}.${issuedAt}`;
 const sig = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
 return `${payload}.${sig}`;
}

async function verifyAuthToken(authHeader, secret, getTokenVersion, options = {}) {
 const header = String(authHeader || '');
 const token = header.startsWith('Bearer ') ? header.slice(7) : header;
 if (!token || typeof token !== 'string') return null;
 const dot = token.lastIndexOf('.');
 if (dot <= 0) return null;
 const payload = token.slice(0, dot);
 const sig = token.slice(dot + 1);
 // Require userId.tokenVersion.issuedAt (legacy 2-part payloads no longer verify).
 const parts = payload.split('.');
 if (parts.length !== 3) return null;
 const [userId, tokenVersionStr, issuedAtStr] = parts;
 if (!userId || !tokenVersionStr || !issuedAtStr) return null;
 const issuedAt = Number(issuedAtStr);
 if (!Number.isFinite(issuedAt) || issuedAt < 0) return null;
 if (!secret) return null;
 const expected = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
 const a = Buffer.from(sig);
 const b = Buffer.from(expected);
 if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
 const nowSec = Number.isFinite(options.nowSec) ? Math.floor(options.nowSec) : Math.floor(Date.now() / 1000);
 const ttl = Number.isFinite(options.ttlSec) ? options.ttlSec : getTokenTtlSec();
 if (nowSec - issuedAt > ttl) return null;
 if (typeof getTokenVersion !== 'function') {
  throw new Error('verifyAuthToken requires a getTokenVersion(userId) function to check revocation');
 }
 const currentVersion = await getTokenVersion(userId);
 if (currentVersion === null || currentVersion === undefined || String(currentVersion) !== tokenVersionStr) return null;
 return userId;
}

// Short-TTL in-process cache for token_version lookups, so verifyAuthToken's
// revocation check doesn't turn every authenticated request into a DB round
// trip. Mirrors server/index.cjs's tokenVersionCache/getCachedTokenVersion —
// kept as a separate implementation (this file is ESM, that one CJS; see the
// H4 rate-limiter comment elsewhere in this file for why they aren't shared
// directly) but the two must stay in sync.
//
// State is per-instance/per-warm-container (same caveat as createRateLimiter
// below): a multi-instance deploy only bounds staleness to `ttlMs` on OTHER
// instances; the instance that performs a sign-out/password-change bump should
// update its own cache entry immediately (see netlify/functions/backend.mjs).
function createTokenVersionCache({ ttlMs = 10_000 } = {}) {
 const cache = new Map(); // userId -> { version, expiresAt }
 return {
  async get(userId, db) {
   const now = Date.now();
   const cached = cache.get(userId);
   if (cached && cached.expiresAt > now) return cached.version;
   const rows = await db('select token_version from app_users where id = $1 limit 1', [userId]);
   const version = rows[0] ? String(rows[0].token_version) : null;
   cache.set(userId, { version, expiresAt: now + ttlMs });
   return version;
  },
  // Called right after THIS instance bumps a user's token_version, so
  // revocation is instant here instead of waiting out the stale entry's TTL.
  set(userId, version) {
   cache.set(userId, { version: String(version), expiresAt: Date.now() + ttlMs });
  },
  clear() {
   cache.clear();
  },
 };
}

// ----------------------------------------------------------------------------
// Identifier quoting (defence-in-depth; callers also allow-list table names).
// ----------------------------------------------------------------------------

function quoteIdent(value) {
 if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
  throw new Error(`Invalid identifier: ${value}`);
 }
 return `"${value}"`;
}

// ----------------------------------------------------------------------------
// Workspace resolution + membership / role checks.
// ----------------------------------------------------------------------------

function findFilterValue(filters, column) {
 if (!Array.isArray(filters)) return undefined;
 const f = filters.find((x) => x && x.column === column && x.operator === 'eq');
 return f ? f.value : undefined;
}

function operationRows(values) {
 if (!values) return [];
 return Array.isArray(values) ? values : [values];
}

const MESSAGE_AUTHOR_ONLY_UPDATE_COLUMNS = new Set([
 'content',
 'attachments',
 'thread_parent_id',
 'broadcast_to_channel',
]);

function browserMessageSenderName(user) {
 const displayName = String(user?.display_name || '').trim();
 if (displayName) return displayName.slice(0, 120);
 const email = String(user?.email || '').trim();
 const localPart = email.split('@')[0] || '';
 return localPart.slice(0, 120) || 'You';
}

/**
 * Load the authenticated browser author's identity from the server-owned user
 * row. A caller may choose message content and its destination, never who said
 * it or whether it was an assistant/agent/automation message.
 */
async function loadBrowserMessageAuthor({ userId, db }) {
 if (!userId) throw unauthorized();
 if (typeof db !== 'function') throw new Error('loadBrowserMessageAuthor requires a db function');
 const rows = await db(
  'select id, email, display_name from app_users where id = $1 limit 1',
  [String(userId)],
 );
 const user = rows[0];
 if (!user || String(user.id) !== String(userId)) throw unauthorized();
 return {
  role: 'user',
  sender_kind: 'user',
  sender_id: String(userId),
  sender_name: browserMessageSenderName(user),
 };
}

function stampBrowserMessageInsert(values, author) {
 if (!values || typeof values !== 'object' || Array.isArray(values)) return values;
 const safeValues = { ...values };
 // A browser may delete its own existing message, but it may not CREATE an
 // already-deleted payload that bypasses normal activity/output redaction.
 delete safeValues.deleted_at;
 return {
  ...safeValues,
  role: 'user',
  sender_kind: 'user',
  sender_id: String(author?.sender_id || ''),
  sender_name: String(author?.sender_name || 'You'),
 };
}

function messageUpdateNeedsAuthorship(values) {
 if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
 return Object.keys(values).some(column => MESSAGE_AUTHOR_ONLY_UPDATE_COLUMNS.has(column));
}

async function enforceMessageAuthorship({ userId, op, filters, values, db }) {
 if (op !== 'delete' && !(op === 'update' && messageUpdateNeedsAuthorship(values))) return;
 const messageId = findFilterValue(filters, 'id');
 const sessionId = findFilterValue(filters, 'session_id');
 if (!messageId || !sessionId) {
  throw badRequest('Editing or deleting a message requires exact message and session filters');
 }
 const rows = await db(
  `select role, sender_kind, sender_id
     from messages
    where id = $1 and session_id = $2
    limit 1`,
  [messageId, sessionId],
 );
 const message = rows[0];
 const owned = message
  && String(message.role || '') === 'user'
  && String(message.sender_kind || '') === 'user'
  && String(message.sender_id || '') === String(userId);
 if (!owned) throw forbidden('You can only edit or delete your own messages');
}

/**
 * Repeat the preflight authorship decision in the mutating SQL predicate.
 * Without this, a concurrent trusted writer could change the row's attribution
 * between the SELECT above and the UPDATE. The preflight remains useful for a
 * truthful 403; this clause is the race-safe enforcement.
 */
function appendMessageAuthorshipFilters({
 userId, table, op, filters, values,
}) {
 const current = Array.isArray(filters) ? filters : [];
 const needsAuthorship = table === 'messages'
  && (op === 'delete' || (op === 'update' && messageUpdateNeedsAuthorship(values)));
 if (!needsAuthorship) return current;
 return [
  ...current,
  { column: 'role', operator: 'eq', value: 'user' },
  { column: 'sender_kind', operator: 'eq', value: 'user' },
  { column: 'sender_id', operator: 'eq', value: String(userId || '') },
 ];
}

/**
 * Re-check private-session readability in the SAME statement that mutates a
 * message. The normal guard gives the caller a useful 403 before building SQL,
 * but a membership revoke or public -> private transition can race that
 * preflight. Authorship alone is not enough in the final predicate.
 *
 * Workspace-role checks remain the generic DB gate's responsibility, just as
 * they are for every other workspace-scoped mutation. This helper adds the
 * session granularity that only message rows need.
 */
function appendMessageMutationAccessClause(where, userId, table) {
 if (table !== 'messages') return where;
 const params = [...(where?.params || []), String(userId || '')];
 const userParam = `$${params.length}`;
 const prefix = where?.clause ? `${where.clause} and` : ' where';
 return {
  clause: `${prefix} exists (
    select 1
      from chat_sessions message_session_scope
     where message_session_scope.id = messages.session_id
       and message_session_scope.deleted_at is null
       and ${sessionReadableSql('message_session_scope', userParam, { lockMembership: true })}
     for share
  ) and messages.deleted_at is null`,
  params,
 };
}

// Resolve the workspace id a db operation targets, looking through parent rows
// when the table/filter doesn't carry workspace_id directly. Returns
// { workspaceId } when determinable, or { unscoped: true } when access can't be
// constrained to a single workspace (caller decides how strict to be).
async function resolveOperationWorkspace(table, { values, filters }, db) {
 // Insert: workspace id (or a parent that has one) comes from the row values.
 if (values) {
  if (values.workspace_id) return { workspaceId: values.workspace_id };
  if (table === 'messages' && values.session_id) {
   const rows = await db('select workspace_id from chat_sessions where id = $1 limit 1', [values.session_id]);
   if (rows[0]) return { workspaceId: rows[0].workspace_id };
  }
  return { unscoped: true };
 }
 // Select/update/delete: derive from filters.
 const directWs = findFilterValue(filters, 'workspace_id');
 if (directWs) return { workspaceId: directWs };

 const parentLookups = [
  { col: 'document_id', sql: 'select workspace_id from documents where id = $1 limit 1' },
  { col: 'task_id', sql: 'select workspace_id from tasks where id = $1 limit 1' },
  { col: 'session_id', sql: 'select workspace_id from chat_sessions where id = $1 limit 1' },
  { col: 'group_id', sql: 'select workspace_id from canvas_groups where id = $1 limit 1' },
 ];
 for (const lookup of parentLookups) {
  const v = findFilterValue(filters, lookup.col);
  if (v) {
   const rows = await db(lookup.sql, [v]);
   if (rows[0]) return { workspaceId: rows[0].workspace_id };
  }
 }
 // Row id filter on a workspace-scoped table -> look up that row's workspace.
 const idVal = findFilterValue(filters, 'id');
 if (idVal && WORKSPACE_SCOPED_TABLES.has(table)) {
  const rows = await db(`select workspace_id from ${quoteIdent(table)} where id = $1 limit 1`, [idVal]);
  if (rows[0]) return { workspaceId: rows[0].workspace_id };
 }
 return { unscoped: true };
}

const SESSION_BOUND_TABLES = new Set([
 'chat_sessions',
 'messages',
 'thread_items',
 'thread_harvests',
 'agent_jobs',
 'agent_schedules',
 'agent_schedule_runs',
 'agent_permission_requests',
 'huddles',
 'huddle_events',
]);

async function resolveOperationSession(table, { values, filters }, db) {
 if (values?.session_id) return String(values.session_id);
 if (table === 'chat_sessions' && values?.id) return String(values.id);
 const direct = table === 'chat_sessions'
  ? findFilterValue(filters, 'id')
  : findFilterValue(filters, 'session_id');
 if (direct) return String(direct);
 const id = findFilterValue(filters, 'id');
 if (!id || !SESSION_BOUND_TABLES.has(table)) return null;
 if (table === 'agent_schedule_runs') {
  const rows = await db(
   `select coalesce(run.session_id, schedule.session_id) as session_id
      from agent_schedule_runs run
      join agent_schedules schedule on schedule.id = run.schedule_id
     where run.id = $1 limit 1`,
   [id],
  );
  return rows[0]?.session_id ? String(rows[0].session_id) : null;
 }
 const rows = await db(
  `select ${table === 'chat_sessions' ? 'id' : 'session_id'} as session_id
     from ${quoteIdent(table)} where id = $1 limit 1`,
  [id],
 );
 return rows[0]?.session_id ? String(rows[0].session_id) : null;
}

// True if the user owns the workspace, is a member of it, or holds either in an
// ANCESTOR (members inherit downward — see getInheritedWorkspaceRoles).
async function userCanAccessWorkspace(userId, workspaceId, db) {
 if (!userId || !workspaceId) return false;
 const rows = await db(
  `select 1 from workspaces where id = $1 and user_id = $2
     union all
     select 1 from workspace_members where workspace_id = $1 and user_id = $2
     limit 1`,
  [workspaceId, userId],
 );
 if (rows.length > 0) return true;
 const inherited = await getInheritedWorkspaceRoles(userId, workspaceId, db);
 return inherited.length > 0;
}

// The role held DIRECTLY in this workspace, ignoring the hierarchy. This is the
// role the UI shows on a workspace tile and the one `/backend/workspaces`
// projects — deliberately not the effective role, so "you are a viewer here"
// keeps meaning what it says. Authorization uses the effective set below.
async function getWorkspaceRole(userId, workspaceId, db) {
 if (!userId || !workspaceId) return null;
 const ownerRows = await db('select 1 from workspaces where id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
 if (ownerRows.length > 0) return 'owner';
 const memberRows = await db('select role from workspace_members where workspace_id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
 return memberRows[0]?.role || null;
}

// ----------------------------------------------------------------------------
// Nested workspaces: inherited membership.
//
// THE RULE — a child inherits AGENTS and MEMBERS from its ancestors; CONTENT is
// isolated. Access therefore flows strictly DOWNWARD:
//
//   member of `Work`      -> reaches Work AND every client workspace under it
//   member of `Client A`  -> reaches Client A only. NOT its sibling Client B
//                            (siblings share an ancestor, not membership) and
//                            NOT its parent Work (there is no upward path).
//
// `depth > 0` in the query below is the one-way valve: it excludes the
// workspace itself, so this returns ONLY inherited roles. The direct role is
// still resolved by getWorkspaceRole, which means the common case (a direct
// member acting in their own workspace) issues exactly the queries it always
// did and this walk never runs.
//
// The recursion is capped at WORKSPACE_MAX_DEPTH so a cycle that somehow exists
// in the data terminates instead of spinning to statement_timeout on every
// request. The cycle should be impossible — a CHECK, a trigger and
// assertWorkspaceParentChange all refuse to create one — but this is the path
// where being wrong is a denial of service, so it does not rely on that.
// ----------------------------------------------------------------------------
const ANCESTOR_ROLES_SQL = `with recursive chain as (
   select id, parent_id, 0 as depth from workspaces where id = $1
   union all
   select w.id, w.parent_id, c.depth + 1
     from workspaces w join chain c on w.id = c.parent_id
    where c.depth < $3
 )
 select distinct r.role from (
   select 'owner'::text as role
     from chain c join workspaces w on w.id = c.id
    where c.depth > 0 and w.user_id = $2
   union all
   select wm.role
     from chain c join workspace_members wm on wm.workspace_id = c.id and wm.user_id = $2
    where c.depth > 0
 ) r`;

async function getInheritedWorkspaceRoles(userId, workspaceId, db) {
 if (!userId || !workspaceId) return [];
 const rows = await db(ANCESTOR_ROLES_SQL, [workspaceId, userId, WORKSPACE_MAX_DEPTH]);
 return rows.map((row) => row.role).filter(Boolean);
}

// Direct role first, then every role inherited from an ancestor. Capabilities
// are the UNION of all of them — this repo checks capability membership rather
// than ranking roles, so "owner of the parent, viewer of the child" needs no
// tie-break.
async function getEffectiveWorkspaceRoles(userId, workspaceId, db) {
 const direct = await getWorkspaceRole(userId, workspaceId, db);
 const inherited = await getInheritedWorkspaceRoles(userId, workspaceId, db);
 const roles = direct ? [direct] : [];
 for (const role of inherited) if (!roles.includes(role)) roles.push(role);
 return roles;
}

function roleHasWorkspaceCapability(role, capability) {
 return Boolean(WORKSPACE_ROLE_CAPABILITIES[role]?.has(capability));
}

function capabilityForDbOperation(table, action) {
 const access = DB_TABLE_ACCESS[table];
 return access?.[action] || (action === 'select' ? 'read' : 'write');
}

function throwWorkspaceRoleDenied(hasAnyRole, need) {
 if (!hasAnyRole) throw forbidden('You do not have access to this workspace');
 if (need === 'manage') throw forbidden('You do not have permission to manage this workspace');
 if (need === 'write') throw forbidden('You do not have permission to change this workspace');
 if (need === 'comment') throw forbidden('You do not have permission to comment in this workspace');
 if (need === 'run_agents') throw forbidden('You do not have permission to run agents in this workspace');
 throw forbidden('You do not have permission to access this workspace');
}

// Enforce that `userId` has the required capability in `workspaceId`. Throws 403
// on denial. `capability` is the canonical name (read|write|comment|run_agents|
// manage); `minRole`/`mode` are accepted as aliases for ergonomics, interpreted
// as the same capability strings (matches server's capability-based model — it
// does NOT rank roles, it checks capability membership).
async function assertWorkspaceRole({ userId, workspaceId, capability, minRole, mode, db }) {
 const need = capability || mode || minRole;
 const role = await getWorkspaceRole(userId, workspaceId, db);
 // Fast path, and the only path until a workspace actually has a parent: a
 // direct role that already carries the capability costs exactly the queries it
 // always did. The ancestor walk runs ONLY when the direct role falls short.
 if (role && roleHasWorkspaceCapability(role, need)) return;

 const inherited = await getInheritedWorkspaceRoles(userId, workspaceId, db);
 if (roleSetHasCapability(inherited, need, WORKSPACE_ROLE_CAPABILITIES)) return;

 throwWorkspaceRoleDenied(Boolean(role || inherited.length > 0), need);
}

/**
 * Transactional counterpart to assertWorkspaceRole.
 *
 * Creation and boundary transitions cannot authorize from an unlocked role
 * snapshot: a concurrent member removal/downgrade could otherwise commit after
 * the check and before the protected write. This walks the same downward-only
 * inheritance chain while taking SHARE locks on every workspace row and every
 * direct role row that can contribute authority. Role updates/deletes and
 * parent/owner changes then wait for the protected transaction to finish.
 *
 * Kept separate from the hot read-path helper above: ordinary reads do not need
 * row locks, and turning every capability check into a locking query would
 * serialize unrelated requests.
 */
async function assertWorkspaceRoleLocked({
 userId,
 workspaceId,
 capability,
 minRole,
 mode,
 db,
}) {
 if (typeof db !== 'function') throw new TypeError('assertWorkspaceRoleLocked requires db');
 const need = capability || mode || minRole;
 const roles = [];
 const seen = new Set();
 let current = workspaceId ? String(workspaceId) : '';
 let depth = 0;

 while (current && !seen.has(current) && depth <= WORKSPACE_MAX_DEPTH) {
  seen.add(current);
  const workspaces = await db(
   `select id, parent_id, user_id
      from workspaces
     where id = $1::uuid
       and $2::uuid is not null
     for share`,
   [current, userId],
  );
  const workspace = workspaces[0] || null;
  if (!workspace) break;
  if (String(workspace.user_id || '') === String(userId || '') && !roles.includes('owner')) {
   roles.push('owner');
  }
  const members = await db(
   `select role
      from workspace_members
     where workspace_id = $1::uuid
       and user_id = $2::uuid
     for share`,
   [current, userId],
  );
  const role = members[0]?.role;
  if (role && !roles.includes(role)) roles.push(role);
  current = workspace.parent_id ? String(workspace.parent_id) : '';
  depth += 1;
 }

 if (roleSetHasCapability(roles, need, WORKSPACE_ROLE_CAPABILITIES)) return;
 throwWorkspaceRoleDenied(roles.length > 0, need);
}

// ----------------------------------------------------------------------------
// Session read scope — the SECOND granularity, below the workspace.
//
// Everything above this line answers "may this user read this WORKSPACE". That
// was the only question the codebase asked until now, which meant any member
// holding `read` could read every session in the workspace including other
// people's Direct messages: the SQL narrowed to one session because the caller
// asked for it, not because a permission said they may see it.
//
// This layer only ever NARROWS. A caller must still pass the workspace check
// first; a channel (`visibility` anything but 'private') is unaffected and costs
// one column read that the caller already had in hand.
// ----------------------------------------------------------------------------

/**
 * Is this session row one that only its members may read?
 *
 * TWO independent signals, ORed, and that is the point. `visibility` is the
 * column the product sets and the grant routes manage. The folder check is the
 * backstop: a DM-creating path that forgets to set visibility would otherwise
 * silently produce a world-readable DM, and this feature is worth nothing if it
 * can be switched off by omission. Fail closed.
 *
 * Takes a ROW, not an id, so callers that already selected the session (the
 * transcript route, the realtime resolver) do not pay a second query.
 */
function isPrivateSessionRow(row) {
 if (!row) return false;
 return String(row.visibility || '') === 'private'
  || String(row.folder || '') === 'Direct messages';
}

/**
 * SQL predicate for "user $N may read session `<alias>`", for the aggregate
 * queries that span many sessions at once (the inbox, thread lists, search).
 *
 * Those cannot call the row-at-a-time check without an N+1, and rewriting each
 * of them by hand is how a path gets missed. `userParam` is a bind placeholder
 * ($2, $3 …) chosen by the caller — never interpolated user input.
 *
 * The expiry comparison lives HERE, in SQL, so an expired grant cannot be
 * honoured by a row that was read a moment earlier.
 */
function sessionReadableSql(alias, userParam, { lockMembership = false } = {}) {
 if (!/^[a-z_][a-z0-9_]*$/i.test(String(alias))) throw new Error(`Invalid alias: ${alias}`);
 if (!/^\$\d+$/.test(String(userParam))) throw new Error(`Invalid bind: ${userParam}`);
 // Parenthesised explicitly. `and` binds tighter than `or`, so this reads
 // correctly without them — but "correct by precedence" is how a later edit
 // inserts a third condition in the wrong group and quietly opens every DM.
 return `(
    ${alias}.deleted_at is null
    and (
      (
        coalesce(${alias}.visibility, 'workspace') <> 'private'
        and coalesce(${alias}.folder, '') <> 'Direct messages'
      )
      or exists (
        select 1 from chat_session_members csm
         where csm.session_id = ${alias}.id
           and csm.user_id = ${userParam}::uuid
           and (csm.expires_at is null or csm.expires_at > now())
         ${lockMembership ? 'for share' : ''}
      )
    )
  )`;
}

/**
 * Enforce that `userId` may read `sessionId`. Throws 403 when they may not.
 *
 * Deliberately does NOT do the workspace check — callers have already done it,
 * and folding it in here would double every membership query on the hottest
 * read path in the app. This is an ADDITIONAL gate, never a replacement.
 *
 * `sessionRow` is an optimisation for callers holding the row already; omit it
 * and one query fetches what is needed.
 *
 * NO IMPLICIT OWNER OVERSIGHT, on purpose. A workspace owner holds `manage`, so
 * they can grant themselves access to any session — and that leaves an audit
 * row. Letting them read silently would give the same power with no trace,
 * which is strictly worse for the person whose DM it is.
 */
async function enforceSessionReadAccess({ userId, sessionId, sessionRow = null, db }) {
 if (!sessionId) return;
 let row = sessionRow;
 // A caller may supply a row to avoid a second lookup, but it is only a
 // complete authorization snapshot when it includes every field that decides
 // liveness or privacy. Re-read older/partial projections rather than treating
 // an omitted visibility/folder column as proof that the conversation is open.
 const requiredSessionFields = ['deleted_at', 'visibility', 'folder'];
 if (
  !row
  || requiredSessionFields.some((field) => !Object.prototype.hasOwnProperty.call(row, field))
 ) {
  const rows = await db(
   'select id, visibility, folder, deleted_at from chat_sessions where id = $1 limit 1',
   [sessionId],
  );
  row = rows[0] || null;
 }
 // A session that does not exist is not this gate's problem — the caller's own
 // 404 handling owns that, and throwing 403 here would turn every missing id
 // into a misleading permission error.
 if (!row) return;
 if (row.deleted_at) throw httpError(404, 'Conversation not found');
 if (!isPrivateSessionRow(row)) return;
 if (!userId) throw forbidden('This conversation is private');
 const allowed = await db(
  `select 1 from chat_session_members
     where session_id = $1 and user_id = $2
       and (expires_at is null or expires_at > now())
     limit 1`,
  [sessionId, userId],
 );
 if (allowed.length > 0) return;
 throw forbidden('This conversation is private');
}

// Session-derived rows need a stricter variant than the ordinary transcript
// gate. A missing transcript id naturally returns 404 from a transcript route,
// but a child row with no provable parent must never be treated as workspace
// data. Resolve the canonical row first, then reuse enforceSessionReadAccess so
// the private predicate still has exactly one spelling.
async function enforceKnownSessionReadAccess({ userId, sessionId, db }) {
 if (!sessionId) throw forbidden('This conversation is unavailable');
 const rows = await db(
  'select id, visibility, folder from chat_sessions where id = $1 limit 1',
  [sessionId],
 );
 const sessionRow = rows[0] || null;
 if (!sessionRow) throw forbidden('This conversation is unavailable');
 return enforceSessionReadAccess({ userId, sessionId, sessionRow, db });
}

/**
 * Record `userId` as an intrinsic participant of a session.
 *
 * Called where a human's own action puts them in a conversation: opening a DM,
 * assigning a task to an agent, @mentioning one in a comment. That last pair
 * matters — the dispatch writes into the agent's DM under the actor's name, and
 * an actor who cannot then read the reply their own action produced would be a
 * worse bug than the one this feature fixes.
 *
 * ON CONFLICT DO NOTHING: never demotes an existing row. Someone who holds a
 * 'grant' and then dispatches into the session keeps the grant's provenance.
 * Best-effort — a failure here must not fail the dispatch that triggered it.
 */
async function addSessionParticipant({ sessionId, userId, db }) {
 if (!sessionId || !userId) return false;
 try {
  await db(
   `insert into chat_session_members (session_id, user_id, source)
      values ($1, $2, 'participant')
      on conflict (session_id, user_id) do nothing`,
   [sessionId, userId],
  );
  return true;
 } catch {
  return false;
 }
}

// ----------------------------------------------------------------------------
// Re-parenting: the write that creates the hierarchy, and the one that can
// break it. Nothing in the product sets parent_id yet — the only reachable
// writer is a generic POST /backend/db/update on `workspaces` — so this exists
// so that the day a child is created it is already correct and already safe.
// ----------------------------------------------------------------------------

// Load the child -> parent edges along the ancestor chain above `startId`, as
// the plain map shape shared/workspace-tree.cjs expects. A point-lookup loop
// rather than a recursive CTE ON PURPOSE: it is bounded by `seen` even if the
// stored data is already cyclic, so this diagnostic path can never be the thing
// that hangs. Bounded at WORKSPACE_MAX_DEPTH + 2 lookups.
async function loadAncestorEdges(startId, db) {
 const edges = new Map();
 const seen = new Set();
 let current = startId == null ? null : String(startId);
 let steps = 0;
 while (current !== null && !seen.has(current) && steps <= WORKSPACE_MAX_DEPTH + 1) {
  seen.add(current);
  const rows = await db('select parent_id from workspaces where id = $1 limit 1', [current]);
  if (rows.length === 0) break;
  const parent = rows[0].parent_id == null ? null : String(rows[0].parent_id);
  edges.set(current, parent);
  current = parent;
  steps += 1;
 }
 return edges;
}

// Every edge inside `rootId`'s subtree, so the depth rule can account for the
// fact that a re-parented workspace drags its whole subtree down with it.
async function loadSubtreeEdges(rootId, db) {
 const edges = new Map();
 if (rootId == null) return edges;
 const rows = await db(
  `with recursive sub as (
      select id, parent_id, 0 as depth from workspaces where id = $1
      union all
      select w.id, w.parent_id, s.depth + 1
        from workspaces w join sub s on w.parent_id = s.id
       where s.depth < $2
    )
    select id, parent_id from sub`,
  [rootId, WORKSPACE_MAX_DEPTH],
 );
 for (const row of rows) {
  edges.set(String(row.id), row.parent_id == null ? null : String(row.parent_id));
 }
 return edges;
}

/**
 * Authorize and validate a change to `workspaces.parent_id`.
 *
 * THE RULE:
 *   - Attaching to a parent needs 'manage' on the PROPOSED PARENT. Without it,
 *     anyone could graft their workspace under someone else's group and hand
 *     that group's members a view of their content — and, once nesting is
 *     visible, put an unwanted tile inside another org's rail.
 *   - Moving or detaching an EXISTING workspace needs a DIRECT 'manage' on the
 *     child, not an inherited one. An inherited manager (an agency admin acting
 *     inside a client workspace) must not be able to detach that client from
 *     the parent, which would strip every inherited member's access in one
 *     write, themselves included.
 *   - The result must be acyclic and within WORKSPACE_MAX_DEPTH.
 *
 * `isInsert` skips the child-side check: on INSERT the row does not exist yet
 * and the creator is its owner.
 */
async function assertWorkspaceParentChange({ userId, workspaceId, parentId, db, isInsert = false }) {
 const child = workspaceId == null ? null : String(workspaceId);
 const parent = parentId == null || parentId === '' ? null : String(parentId);

 if (!isInsert) {
  const directRole = await getWorkspaceRole(userId, child, db);
  if (!directRole || !roleHasWorkspaceCapability(directRole, 'manage')) {
   throw forbidden('Only a direct manager of this workspace can change where it sits');
  }
 }

 if (parent === null) return; // detaching to top level needs nothing further
 if (child !== null && parent === child) throw badRequest('A workspace cannot be its own parent');

 await assertWorkspaceRole({ userId, workspaceId: parent, capability: 'manage', db });

 const exists = await db('select id from workspaces where id = $1 limit 1', [parent]);
 if (exists.length === 0) throw badRequest('The parent workspace does not exist');

 const edges = await loadAncestorEdges(parent, db);
 if (child !== null && !isInsert) {
  for (const [id, value] of await loadSubtreeEdges(child, db)) edges.set(id, value);
 }

 if (wouldCreateCycle(edges, child, parent)) {
  throw badRequest('A workspace cannot be its own ancestor');
 }
 if (wouldExceedMaxDepth(edges, child, parent, WORKSPACE_MAX_DEPTH)) {
  throw badRequest(`Workspaces cannot be nested more than ${WORKSPACE_MAX_DEPTH} levels deep`);
 }
}

async function resolveWorkspaceRowById(id, db) {
 if (!id) return null;
 const rows = await db('select id from workspaces where id = $1 limit 1', [id]);
 return rows[0]?.id || null;
}

// Parent-reference columns that define a child row's tenancy. An UPDATE may set
// these (e.g. moving a canvas object between groups) but only to a parent that
// lives in the SAME workspace as the source row.
const UPDATE_PARENT_REF_LOOKUPS = {
 session_id: 'select workspace_id from chat_sessions where id = $1 limit 1',
 document_id: 'select workspace_id from documents where id = $1 limit 1',
 task_id: 'select workspace_id from tasks where id = $1 limit 1',
 group_id: 'select workspace_id from canvas_groups where id = $1 limit 1',
};

// The browser legitimately writes thread rail items through the generic DB
// route. Unlike an INSERT, UPDATE/DELETE normally names only the item id, so the
// session boundary has to be resolved from the stored row before the write.
// Requiring a single session_id or id is intentional: a workspace-wide bulk
// mutation cannot prove one private-session audience and therefore fails closed.
async function filteredSessionId(table, filters, db) {
 const direct = findFilterValue(filters, 'session_id');
 if (direct) return direct;
 const id = findFilterValue(filters, 'id');
 if (!id) return null;
 const rows = await db(
  `select session_id from ${quoteIdent(table)} where id = $1 limit 1`,
  [id],
 );
 return rows[0]?.session_id || null;
}

async function enforceThreadItemSessionMutation({ userId, op, filters, values, db }) {
 if (op === 'insert') {
  for (const row of operationRows(values)) {
   await enforceKnownSessionReadAccess({ userId, sessionId: row?.session_id, db });
  }
  return;
 }

 const sourceSessionId = await filteredSessionId('thread_items', filters, db);
 if (!sourceSessionId) throw badRequest('A thread item session or id filter is required');
 await enforceKnownSessionReadAccess({ userId, sessionId: sourceSessionId, db });

 // A move crosses two boundaries. Passing the source check must not let a user
 // move the row into a private conversation they cannot read (or use that move
 // to learn whether the target exists).
 if (op === 'update'
  && values && typeof values === 'object' && !Array.isArray(values)
  && Object.prototype.hasOwnProperty.call(values, 'session_id')
  && String(values.session_id || '') !== String(sourceSessionId)) {
  await enforceKnownSessionReadAccess({ userId, sessionId: values.session_id, db });
 }
}

// H1 (2026-07 review): reject an UPDATE whose `values` would move/inject the row
// into a workspace other than the one it currently belongs to. Authorizing the
// source workspace alone is not enough — the SET clause could carry
// workspace_id or a cross-tenant parent reference. `sourceWorkspaceId` is the
// row's current workspace (already resolved + authorized by the caller).
async function assertUpdateKeepsTenancy({ sourceWorkspaceId, values, db }) {
 if (!values || typeof values !== 'object' || Array.isArray(values)) return;
 const src = String(sourceWorkspaceId);
 if (values.workspace_id != null && String(values.workspace_id) !== src) {
  throw forbidden('Cannot move a row to another workspace');
 }
 for (const [col, sql] of Object.entries(UPDATE_PARENT_REF_LOOKUPS)) {
  const v = values[col];
  if (v == null) continue; // absent, or explicitly cleared to null, is fine
  const rows = await db(sql, [v]);
  const targetWs = rows[0]?.workspace_id;
  if (!targetWs || String(targetWs) !== src) {
   throw forbidden('Cannot reassign a row to another workspace');
  }
 }
}

// ----------------------------------------------------------------------------
// THE central gate: authorize a generic /backend/db/* operation.
//
//   enforceDbOperationAccess({ userId, table, op, filters, payload, db })
//     op       : 'select' | 'insert' | 'update' | 'delete'
//     filters  : the filters array (for select/update/delete)
//     payload  : { values?, filters? } — values for insert/update
//     db       : async query function (sql, params) => rows
//
// Throws 401/403/400. CRITICAL C1 guarantee: update/delete with EMPTY filters is
// rejected outright (the catastrophic full-table-wipe vector) BEFORE any other
// per-table logic, so it applies to every table including app_users/workspaces.
// ----------------------------------------------------------------------------

async function enforceDbOperationAccess({ userId, table, op, filters, payload, db }) {
 if (!userId) throw unauthorized();
 if (typeof db !== 'function') throw new Error('enforceDbOperationAccess requires a db function');

 const pl = payload || {};
 const flt = filters != null ? filters : (Array.isArray(pl.filters) ? pl.filters : []);
 const values = pl.values;

 // --- C1: refuse an unfiltered update/delete — it would wipe the whole table.
 if (op === 'update' || op === 'delete') {
  if (!Array.isArray(flt) || flt.length === 0) {
   throw badRequest(`${op === 'delete' ? 'Delete' : 'Update'} requires at least one filter`);
  }
 }

 if (table === 'app_users') {
  const idFilter = findFilterValue(flt, 'id');
  if (op === 'select' && idFilter && String(idFilter) === String(userId)) return;
  throw forbidden('Direct user table access is not allowed');
 }

 // Activity is an append-only history feed. In particular, session-derived
 // rows inherit the source session's current audience on SELECT and realtime;
 // allowing a generic UPDATE or DELETE before that gate would expose both an
 // affected-row oracle and the RETURNING row to unrelated workspace members.
 // Server-side redaction/repair uses direct SQL and does not pass this client
 // authorization surface.
 if (table === 'activity_events' && (op === 'update' || op === 'delete')) {
  throw forbidden('Activity history is append-only');
 }

 if (table === 'workspaces') {
  if (op === 'select') return;
  if (op === 'insert') {
   for (const row of operationRows(values)) {
    if (row && row.user_id && String(row.user_id) !== String(userId)) {
     throw forbidden('Cannot create a workspace for another user');
    }
    // Creating a workspace already inside a group: needs 'manage' on the group.
    if (row && row.parent_id != null && row.parent_id !== '') {
     await assertWorkspaceParentChange({
      userId, workspaceId: null, parentId: row.parent_id, db, isInsert: true,
     });
    }
   }
   return;
  }
  const workspaceId = findFilterValue(flt, 'id')
   || await resolveWorkspaceRowById(findFilterValue(flt, 'workspace_id'), db);
  if (!workspaceId) throw badRequest('A workspace id filter is required for this operation');
  await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db });

  if (op === 'delete') {
   // parent_id is ON DELETE RESTRICT, so Postgres would refuse this anyway —
   // but as an opaque foreign-key violation surfaced as a 500. Ask first, so
   // the caller is told what to do about it. Deleting a group must never be a
   // way to silently destroy (CASCADE) or silently orphan (SET NULL) the client
   // workspaces inside it.
   const children = await db('select id from workspaces where parent_id = $1 limit 1', [workspaceId]);
   if (children.length > 0) {
    throw httpError(409, 'This workspace still has workspaces inside it — move or delete those first');
   }
   return;
  }

  if (op === 'update'
   && values && typeof values === 'object' && !Array.isArray(values)
   && Object.prototype.hasOwnProperty.call(values, 'parent_id')) {
   await assertWorkspaceParentChange({ userId, workspaceId, parentId: values.parent_id, db });
  }
  return;
 }

 // Server-authored and server-settled. A generic write would bypass the daemon
 // socket identity check on INSERT and the exact-connection delivery invariant
 // on UPDATE; DELETE would erase a pending question from its private session.
 // Keep SELECT for the live client subscription, but make every write use the
 // dedicated permission flow regardless of workspace role.
 if (table === 'agent_permission_requests' && op !== 'select') {
  throw forbidden('Permission requests can only be changed through the dedicated permission route');
 }
 // Huddle lifecycle rows are server-owned. The dedicated routes are where the
 // host-session privacy check, LiveKit token minting and append-only event
 // authority live; even a workspace manager must not bypass those invariants
 // through a generic write.
 if ((table === 'huddles' || table === 'huddle_events') && op !== 'select') {
  throw forbidden('Huddles can only be changed through the dedicated huddle routes');
 }
 // Job state is server/daemon-authored. Schedules are validated and triggered
 // only by their dedicated routes, and run rows are runner-authored history.
 // None has a legitimate browser generic-write caller; leaving one open would
 // let a workspace role forge execution state before session privacy is even
 // considered.
 if (table === 'agent_jobs' && op !== 'select') {
  throw forbidden('Agent jobs can only be changed by the agent runtime');
 }
 if ((table === 'agent_schedules' || table === 'agent_schedule_runs') && op !== 'select') {
  throw forbidden('Schedules can only be changed through the dedicated schedule routes');
 }
 // Read markers are server-authored social signals. The dedicated route binds
 // the authenticated human identity and resolves read_at from a message in the
 // same live session. No workspace role — including owner — may forge, rewrite,
 // or erase those signals through the generic database surface.
 if (table === 'session_read_state' && op !== 'select') {
  throw forbidden('Read receipts can only be changed through the dedicated read receipt route');
 }
 if (table === 'agent_jobs' && op !== 'select') {
  throw forbidden('Agent jobs can only be changed through the orchestration runtime');
 }
 if (table === 'agent_schedules' && op !== 'select') {
  throw forbidden('Agent schedules can only be changed through the dedicated schedule routes');
 }
 if (table === 'agent_schedule_runs' && op !== 'select') {
  throw forbidden('Schedule runs are server-authored');
 }

 if (!WORKSPACE_SCOPED_TABLES.has(table) && table !== 'messages') return;

 const mode = capabilityForDbOperation(table, op);

 // UPDATE: authorize the SOURCE row's workspace (resolved from filters), then
 // verify `values` can't move the row into a different workspace (H1).
 if (op === 'update') {
  const resolved = await resolveOperationWorkspace(table, { filters: flt }, db);
  if (resolved.unscoped) throw badRequest('A workspace filter is required for this operation');
  await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: mode, db });
  // H3: setting a manage-only column (agent metadata/host_folders, sandbox
  // config) needs 'manage' on top of the table's normal write capability.
  if (setsManageOnlyDbColumn(table, values)) {
   await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: 'manage', db });
  }
  await assertUpdateKeepsTenancy({ sourceWorkspaceId: resolved.workspaceId, values, db });
  if (SESSION_BOUND_TABLES.has(table)) {
   const sessionId = await resolveOperationSession(table, { filters: flt }, db);
   if (!sessionId) throw badRequest('A session filter is required for this operation');
   await enforceSessionReadAccess({ userId, sessionId, db });
   if (values?.session_id && String(values.session_id) !== sessionId) {
    await enforceSessionReadAccess({ userId, sessionId: values.session_id, db });
   }
  }
  if (table === 'messages') {
   await enforceMessageAuthorship({ userId, op, filters: flt, values, db });
  }
  if (table === 'thread_items') {
   await enforceThreadItemSessionMutation({
    userId, op, filters: flt, values, db,
   });
  }
  return;
 }

 for (const row of operationRows(values)) {
  if (!row || typeof row !== 'object') continue;
  const resolved = await resolveOperationWorkspace(table, { values: row }, db);
  if (resolved.unscoped) throw badRequest('A workspace reference is required for this operation');
  await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: mode, db });
  if (SESSION_BOUND_TABLES.has(table) && table !== 'chat_sessions') {
   const sessionId = await resolveOperationSession(table, { values: row }, db);
   if (!sessionId) throw badRequest('A session reference is required for this operation');
   await enforceSessionReadAccess({ userId, sessionId, db });
  }
  // H3: same elevation on INSERT — creating an agent that already carries
  // host_folders (or a sandbox target) is the same escalation as setting them.
  if (setsManageOnlyDbColumn(table, row)) {
   await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: 'manage', db });
  }
  // H1-insert (F7 review): a child INSERT may carry a cross-tenant parent ref
  // (document_id/task_id/session_id/group_id) even when workspace_id is legit —
  // reuse the UPDATE tenancy guard so the parent must live in this workspace.
  await assertUpdateKeepsTenancy({ sourceWorkspaceId: resolved.workspaceId, values: row, db });
  if (table === 'thread_items') {
   await enforceThreadItemSessionMutation({
    userId, op, filters: flt, values: row, db,
   });
  }
 }

 if (operationRows(values).length === 0) {
  const resolved = await resolveOperationWorkspace(table, { filters: flt }, db);
  if (resolved.unscoped) throw badRequest('A workspace filter is required for this operation');
  await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: mode, db });

  // The session gate, layered UNDER the workspace one. Session-derived SELECTs
  // are narrowed here, and message DELETEs use the same canonical gate before
  // the authorship check below. A workspace editor is not thereby a member of
  // somebody else's DM.
  //
  // This is also what closes REALTIME, at no extra cost — realtime subscribe
  // authorizes a binding by calling this same function with op 'select'
  // (server/realtime.cjs authorizeRealtimeBinding), so a client cannot
  // subscribe to `session_id=eq.<someone's DM>` either. Single-sourcing the
  // rule here is the reason there is no second copy to drift.
  if (op === 'select' || SESSION_BOUND_TABLES.has(table)) {
   // Any table filtered by session_id inherits its session's privacy — not
   // just `messages`. thread_items, agent_jobs and the rest hang off a session
   // and would otherwise be a side channel into a private one.
   const sessionId = await resolveOperationSession(table, { filters: flt }, db);
   if (sessionId) {
    if (['thread_items', 'agent_jobs', 'agent_schedules', 'agent_schedule_runs'].includes(table)) {
     await enforceKnownSessionReadAccess({ userId, sessionId, db });
    } else {
     await enforceSessionReadAccess({ userId, sessionId, db });
    }
   }
  }
  if (table === 'thread_items' && op === 'delete') {
   await enforceThreadItemSessionMutation({
    userId, op, filters: flt, values, db,
   });
  }
  if (table === 'messages') {
   await enforceMessageAuthorship({ userId, op, filters: flt, values, db });
  }
 }
}

// Constrain a SELECT on session-bearing tables to rows in a session the user
// may read. The sibling of appendWorkspaceAccessClause, and needed for the same
// reason: enforceDbOperationAccess can only ANSWER "may you", it cannot remove
// rows from a result set. Without this a workspace-filtered select returns every
// DM's title/roster, parked tool request, huddle or huddle event, leaking
// private conversation data without reading one message.
//
// Every table routes through one subquery alias so the cases differ only in the
// join column. Slightly more work than inlining the predicate on
// chat_sessions itself; worth it because there is then exactly ONE spelling of
// the readability rule to keep correct. Legacy permission rows with no session
// retain their workspace visibility; a non-null orphan is withheld.
function appendSessionAccessClause(where, userId, table) {
 if (table === 'activity_events') {
  const params = where.params || [];
  params.push(userId);
  const userParam = `$${params.length}`;
  const sessionId = `case
    when "activity_events"."event_type" = 'message_sent' then nullif("activity_events"."metadata"->>'session_id', '')
    when "activity_events"."event_type" = 'chat_created' then nullif("activity_events"."entity_id", '')
    else null
   end`;
  const sessionExists = `EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.id::text = ${sessionId} AND ${sessionReadableSql('cs', userParam)})`;
  const unscoped = `("activity_events"."event_type" IS DISTINCT FROM 'message_sent' AND "activity_events"."event_type" IS DISTINCT FROM 'chat_created')`;
  const accessClause = `(${unscoped} OR (${sessionId} IS NOT NULL AND ${sessionExists}))`;
  return {
   clause: where.clause ? `${where.clause} AND ${accessClause}` : ` WHERE ${accessClause}`,
   params,
  };
 }
 if (![
  'chat_sessions',
  'messages',
  'agent_permission_requests',
  'huddles',
  'huddle_events',
  'thread_items',
  'thread_harvests',
  'agent_jobs',
  'agent_schedules',
  'agent_schedule_runs',
 ].includes(table)) return where;
 const params = where.params || [];
 params.push(userId);
 const userParam = `$${params.length}`;
 const joinColumn = table === 'chat_sessions' ? `"chat_sessions"."id"` : `"${table}"."session_id"`;
 const sessionExists = `EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.id = ${joinColumn} AND ${sessionReadableSql('cs', userParam)})`;
 const accessClause = table === 'agent_permission_requests'
  ? `("${table}"."session_id" IS NULL OR ${sessionExists})`
  : sessionExists;
 return {
  clause: where.clause ? `${where.clause} AND ${accessClause}` : ` WHERE ${accessClause}`,
  params,
 };
}

// Constrain a SELECT on `workspaces` to rows the user owns or is a member of.
// Pure string/param builder — appended onto buildWhereClause output by callers.
function appendWorkspaceAccessClause(where, userId) {
 const params = where.params || [];
 params.push(userId);
 const ownerParam = `$${params.length}`;
 params.push(userId);
 const memberParam = `$${params.length}`;
 const accessClause = `("workspaces"."user_id" = ${ownerParam} OR EXISTS (SELECT 1 FROM "workspace_members" wm WHERE wm.workspace_id = "workspaces"."id" AND wm.user_id = ${memberParam}))`;
 return {
  clause: where.clause ? `${where.clause} AND ${accessClause}` : ` WHERE ${accessClause}`,
  params,
 };
}

// ----------------------------------------------------------------------------
// Activity logging — ONE shared logger for both backends.
//
// Logs an `activity_events` row per inserted chat message so it surfaces in the
// Activity feed. Idempotent at the DB level: the insert uses ON CONFLICT DO
// NOTHING against the partial unique index
//   uq_activity_events_message_sent (entity_id) WHERE event_type='message_sent'
//                                                  AND entity_type='message'
// so retried message finalizations (the same message id logged twice) can never
// duplicate the feed row — this is race-safe, unlike a SELECT-then-insert.
//
// The conflict target is intentionally LEFT OFF (plain `ON CONFLICT DO NOTHING`)
// so the statement degrades to a normal insert when the index is absent (e.g. a
// DB that hasn't run the C3 migration yet) instead of erroring 42P10. Since the
// row's `id` is a fresh uuid default, the only realistic conflict is the partial
// index, so this never suppresses a legitimately distinct row.
//
// Defensive: a logging failure NEVER breaks the caller's insert.
// ----------------------------------------------------------------------------

const ACTIVITY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELETED_MESSAGE_ACTIVITY_TITLE = 'Message deleted';
const EDITED_MESSAGE_ACTIVITY_TITLE = 'Message edited';

/**
 * Replace every user-authored carrier in one message's activity row with a
 * minimal server-owned envelope. Rebuilding metadata is deliberate: historical
 * rows include both jsonb objects and jsonb string scalars, and subtracting a
 * key from the latter is a no-op. The trusted session id preserves navigation;
 * title and metadata can no longer reconstruct any part of the deleted body.
 */
async function scrubMessageActivityByMessageIdState({
 db,
 messageId,
 sessionId,
 title,
 state,
}) {
 if (typeof db !== 'function' || !messageId || !sessionId) return [];
 const stateKey = state === 'edited' ? 'edited' : 'deleted';
 return db(
  `update activity_events
      set title = $3,
          metadata = jsonb_build_object(
            'session_id', $2::text,
            '${stateKey}', true
          )
    where event_type = 'message_sent'
      and entity_type = 'message'
      and entity_id = $1::text
      and (
        title is distinct from $3
        or metadata is distinct from jsonb_build_object(
          'session_id', $2::text,
          '${stateKey}', true
        )
      )
  returning *`,
  [String(messageId), String(sessionId), title],
 );
}

async function scrubMessageActivityByMessageId({ db, messageId, sessionId }) {
 return scrubMessageActivityByMessageIdState({
  db,
  messageId,
  sessionId,
  title: DELETED_MESSAGE_ACTIVITY_TITLE,
  state: 'deleted',
 });
}

async function scrubEditedMessageActivityByMessageId({ db, messageId, sessionId }) {
 return scrubMessageActivityByMessageIdState({
  db,
  messageId,
  sessionId,
  title: EDITED_MESSAGE_ACTIVITY_TITLE,
  state: 'edited',
 });
}

/**
 * Set-based companion for closing a conversation. The entity index joins the
 * bounded session message set to its activity rows; no transcript bodies are
 * returned to JavaScript and legacy metadata encoding is irrelevant.
 */
async function scrubMessageActivityBySession({ db, sessionId }) {
 if (typeof db !== 'function' || !sessionId) return [];
 return db(
  `with scrubbed_activity as (
     update activity_events activity_event
        set title = $2,
            metadata = jsonb_build_object(
              'session_id', $1::text,
              'deleted', true
            )
       from messages activity_message
      where activity_message.session_id = $1::uuid
        and activity_message.id::text = activity_event.entity_id
        and activity_event.event_type = 'message_sent'
        and activity_event.entity_type = 'message'
        and (
          activity_event.title is distinct from $2
          or activity_event.metadata is distinct from jsonb_build_object(
            'session_id', $1::text,
            'deleted', true
          )
        )
     returning 1
   )
   select count(*)::integer as scrubbed_activity
     from scrubbed_activity`,
  [String(sessionId), DELETED_MESSAGE_ACTIVITY_TITLE],
 );
}

/**
 * Multi-session form used by conversation teardown. A host and every huddle
 * transcript it owns are one deletion boundary, so scrubbing them in one
 * statement avoids an unbounded query loop and gives the transaction one
 * snapshot over the complete message set.
 */
async function scrubMessageActivityBySessions({ db, sessionIds }) {
 const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
  .map(value => String(value || '').trim())
  .filter(Boolean))];
 if (typeof db !== 'function' || ids.length === 0) return [];
 return db(
  `with scrubbed_activity as (
     update activity_events activity_event
        set title = $2,
            metadata = jsonb_build_object(
              'session_id', activity_message.session_id::text,
              'deleted', true
            )
       from messages activity_message
      where activity_message.session_id = any($1::uuid[])
        and activity_message.id::text = activity_event.entity_id
        and activity_event.event_type = 'message_sent'
        and activity_event.entity_type = 'message'
        and (
          activity_event.title is distinct from $2
          or activity_event.metadata is distinct from jsonb_build_object(
            'session_id', activity_message.session_id::text,
            'deleted', true
          )
        )
     returning 1
   )
   select count(*)::integer as scrubbed_activity
     from scrubbed_activity`,
  [toPgArrayLiteral(ids), DELETED_MESSAGE_ACTIVITY_TITLE],
 );
}

async function logMessageActivityIdempotent(rows, { db }) {
 if (typeof db !== 'function') return;
 for (const message of rows || []) {
  if (!message || typeof message !== 'object') continue;
  try {
   const sessionId = message.session_id;
   if (!sessionId) continue;

   const messageId = message.id != null ? String(message.id) : null;

   // Keep the canonical session privacy signals beside the workspace lookup.
   // The generic SELECT and realtime fanout now re-authorize the session_id in
   // metadata, while this write-time check remains defense in depth so even an
   // authorized participant never receives private message text through the
   // workspace activity row.
   const sessionRows = await db(
    'select workspace_id, visibility, folder, deleted_at from chat_sessions where id = $1 limit 1',
    [sessionId],
   );
   const sessionRow = sessionRows[0] || null;
   const workspaceId = sessionRow?.workspace_id || null;
   if (!workspaceId || sessionRow.deleted_at) continue;
   const isPrivate = isPrivateSessionRow(sessionRow);

   const role = message.role || '';
   const senderName = message.sender_name || (role === 'user' ? 'You' : 'Agent');
   const content = typeof message.content === 'string' ? message.content : '';
   const senderId = typeof message.sender_id === 'string' ? message.sender_id : '';
   const userId = role === 'user' && ACTIVITY_UUID_RE.test(senderId) ? senderId : null;
   // A members-only session contributes that a message happened, never its
   // words. `title` has to go too, not just `metadata.content` — it was the
   // first 80 characters of the same body.
   const title = isPrivate
    ? `${senderName}: (private conversation)`.slice(0, 120)
    : `${senderName}: ${content.slice(0, 80)}`.slice(0, 120);
   const metadata = {
    session_id: sessionId,
    role,
    sender_kind: message.sender_kind || '',
    sender_name: message.sender_name || '',
    ...(isPrivate ? {} : { content }),
   };
   await db(
    `with live_activity_message as materialized (
       select activity_message.id
         from messages activity_message
         join chat_sessions activity_session
           on activity_session.id = activity_message.session_id
        where activity_message.id = $3::uuid
          and activity_message.session_id = $6::uuid
          and activity_message.deleted_at is null
          and activity_session.deleted_at is null
          and activity_session.workspace_id = $1::uuid
          and activity_session.visibility is not distinct from $7
          and activity_session.folder is not distinct from $8
        for share of activity_message, activity_session
     )
     insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
       select $1, $2, 'message_sent', 'message', $3, $4, $5::jsonb, now()
         from live_activity_message
     on conflict do nothing`,
    [
     workspaceId,
     userId,
     messageId,
     title,
     JSON.stringify(metadata),
     String(sessionId),
     sessionRow.visibility ?? null,
     sessionRow.folder ?? null,
    ],
   );
  } catch (error) {
   console.error('logMessageActivityIdempotent failed', error);
  }
 }
}

// ----------------------------------------------------------------------------
// Rate limiter scaffold (in-memory fixed window). Wiring into routes is deferred
// (H4). `check(key)` returns { allowed, remaining, retryAfterMs }.
//
// In-memory state is per-process; on serverless it only limits within a warm
// instance. Good enough as a scaffold; a shared store is a later concern.
// ----------------------------------------------------------------------------

function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
 const hits = new Map(); // key -> { count, resetAt }
 let lastSweep = 0;
 // Evict expired entries so distinct keys cannot grow the Map without bound.
 function sweep(now) {
  if (now - lastSweep < windowMs) return;
  lastSweep = now;
  for (const [key, entry] of hits) {
   if (now >= entry.resetAt) hits.delete(key);
  }
 }
 function check(key) {
  const now = Date.now();
  sweep(now);
  let entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
   entry = { count: 0, resetAt: now + windowMs };
   hits.set(key, entry);
  }
  entry.count += 1;
  const allowed = entry.count <= max;
  return {
   allowed,
   blocked: !allowed,
   remaining: Math.max(0, max - entry.count),
   retryAfterMs: allowed ? 0 : Math.max(0, entry.resetAt - now),
  };
 }
 function reset(key) {
  if (key === undefined) hits.clear();
  else hits.delete(key);
 }
 return { check, reset };
}

// ----------------------------------------------------------------------------
// Cross-instance rate limiter backed by Postgres (H4 follow-up). The in-memory
// createRateLimiter above only bounds a single warm process — useless across
// Fly machines or Netlify lambdas. This variant does an atomic fixed-window
// upsert so every instance shares one counter.
//
// Requires a `rate_limits` table:
//   create table rate_limits (
//     bucket text not null, window_start timestamptz not null,
//     count int not null default 0, primary key (bucket, window_start));
//
// `check(key)` is ASYNC. It FAILS OPEN on any DB error (returns allowed) — a
// limiter that hard-fails would take down the very routes it protects; the
// in-memory limiter in front of it still provides a first bound.
// ----------------------------------------------------------------------------

function createDbRateLimiter({ windowMs = 60_000, max = 60, db, namespace = 'rl' } = {}) {
 async function check(key) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const bucket = `${namespace}:${key}`;
  try {
   // Atomic increment of the current window's counter. The composite PK on
   // (bucket, window_start) means concurrent requests across instances all
   // land on the same row and the RETURNING count is the post-increment total.
   const rows = await db(
    `insert into rate_limits (bucket, window_start, count)
           values ($1, $2, 1)
           on conflict (bucket, window_start)
           do update set count = rate_limits.count + 1
           returning count`,
    [bucket, windowStart],
   );
   // Opportunistic cleanup (~0.5% of calls) so serverless callers with no timer
   // still bound table growth. The long-lived Express server also runs sweep()
   // on an interval; both are best-effort and never block the check.
   if (Math.random() < 0.005) { void sweep(); }
   const count = Number(rows?.[0]?.count || 1);
   const allowed = count <= max;
   const resetAt = windowStart.getTime() + windowMs;
   return {
    allowed,
    blocked: !allowed,
    remaining: Math.max(0, max - count),
    retryAfterMs: allowed ? 0 : Math.max(0, resetAt - now),
   };
  } catch {
   // Fail open: never let a limiter DB hiccup 500 a protected route.
   return { allowed: true, blocked: false, remaining: max, retryAfterMs: 0 };
  }
 }
 // Best-effort cleanup of windows older than now — callers may run this on a timer.
 async function sweep() {
  try {
   await db('delete from rate_limits where window_start < $1', [new Date(Date.now() - windowMs * 2)]);
  } catch { /* ignore */ }
 }
 return { check, sweep };
}

// ----------------------------------------------------------------------------
// Server-side password policy (plan 004 — auth hardening).
// Mirrors src/lib/passwordPolicy.ts's `evaluatePassword` rule (min length +
// character-class count) as a plain-JS, framework-free re-implementation so it
// can run here (ESM, Netlify) and be ported inline into server/index.cjs's CJS
// style (that file keeps its own copies of shared helpers on purpose — see the
// comment above `createRateLimiter` there). Keep both in sync if this changes.
// ----------------------------------------------------------------------------

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MIN_CLASSES = 3; // at least 3 of: lowercase, uppercase, digit, symbol

function evaluatePasswordServerSide(password) {
 const value = String(password || '');
 const classesMet =
  (/[a-z]/.test(value) ? 1 : 0) +
  (/[A-Z]/.test(value) ? 1 : 0) +
  (/[0-9]/.test(value) ? 1 : 0) +
  (/[^A-Za-z0-9]/.test(value) ? 1 : 0);
 const longEnough = value.length >= PASSWORD_MIN_LENGTH;
 const valid = longEnough && classesMet >= PASSWORD_MIN_CLASSES;
 const message = valid
  ? ''
  : !longEnough
   ? `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
   : `Password must include at least ${PASSWORD_MIN_CLASSES} of: lowercase, uppercase, number, symbol.`;
 return { valid, classesMet, longEnough, message };
}

// ----------------------------------------------------------------------------
// Workspace secret vault (M5, 2026-07 review).
//
// Both backends write the SAME workspace_secrets rows in the SAME Neon DB, but
// only server/index.cjs encrypted them: it stores AES-256-GCM ciphertext in
// `secret_cipher` with `value = ''`, and PREFERS secret_cipher on read. The
// Netlify mirror wrote the raw key into `value` and never touched
// secret_cipher, so a key rotated through Netlify left plaintext-new next to
// stale-cipher and Fly kept serving the OLD key. One implementation, here, so
// the two can't drift again.
//
// The key material must match on both sides: a dedicated SECRETS_ENCRYPTION_KEY
// if set (so secrets survive an AUTH_SECRET rotation), else the HMAC auth
// secret — which AGENTS.md already requires to be identical on Fly and Netlify.
// `getAuthSecret` is injected (sync or async) because each runtime resolves it
// differently (env-only on Netlify, env-or-DB on Fly).
// ----------------------------------------------------------------------------

async function vaultSecretKey(getAuthSecret) {
 const dedicated = String(process.env.SECRETS_ENCRYPTION_KEY || '').trim();
 const material = dedicated || `auth-fallback:${await getAuthSecret()}`;
 return crypto.createHash('sha256').update(`agensis-workspace-vault:${material}`).digest();
}

async function encryptVaultSecret(value, { getAuthSecret }) {
 const iv = crypto.randomBytes(12);
 const cipher = crypto.createCipheriv('aes-256-gcm', await vaultSecretKey(getAuthSecret), iv);
 const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
 return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

async function decryptVaultSecret(value, { getAuthSecret }) {
 const [iv, tag, encrypted] = String(value || '').split('.').map((part) => Buffer.from(part, 'base64url'));
 if (!iv || !tag || !encrypted) throw new Error('Invalid encrypted vault secret');
 const decipher = crypto.createDecipheriv('aes-256-gcm', await vaultSecretKey(getAuthSecret), iv);
 decipher.setAuthTag(tag);
 return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function getWorkspaceSecretValue(workspaceId, key, { db, getAuthSecret }) {
 if (!workspaceId) return '';
 const rows = await db(
  'select value, secret_cipher from workspace_secrets where workspace_id = $1 and key = $2 limit 1',
  [workspaceId, key],
 );
 if (!rows[0]) return '';
 // Prefer the encrypted column; fall back to the legacy plaintext value for rows
 // written before encryption-at-rest landed (they get re-encrypted on next write).
 if (rows[0].secret_cipher) {
  try { return await decryptVaultSecret(rows[0].secret_cipher, { getAuthSecret }); } catch { return ''; }
 }
 return rows[0].value || '';
}

async function setWorkspaceSecretValue(workspaceId, key, value, { db, getAuthSecret, userId = null, description = null }) {
 const cipher = value ? await encryptVaultSecret(value, { getAuthSecret }) : '';
 await db(
  `insert into workspace_secrets (workspace_id, key, value, secret_cipher, description, updated_by, updated_at)
     values ($1, $2, '', $3, coalesce($4, ''), $5, now())
     on conflict (workspace_id, key)
     do update set value = '', secret_cipher = excluded.secret_cipher,
       description = coalesce($4, workspace_secrets.description),
       updated_by = excluded.updated_by, updated_at = now()`,
  [workspaceId, key, cipher, description ?? null, userId || null],
 );
}

// ----------------------------------------------------------------------------
// THE VAULT SURFACE (2026-07).
//
// One workspace vault, three groups, ONE classification — here, so the Fly
// route and the Netlify mirror cannot disagree about what an entry IS.
//
// Provider keys use the `sandbox:` namespace. Each entry says which GROUP it
// belongs to, which provider owns it, and which write LANE owns it, so a
// namespaced credential cannot be mistaken for a loose shared secret.
//
// Every entry here is WRITE-ONLY. `listWorkspaceVaultEntries` does not select
// `value` or `secret_cipher` at all — not "selects and redacts": a route cannot
// leak a column it never fetched. `configured` and `legacy_plaintext` are SQL
// booleans computed in the database, so the plaintext never crosses the wire
// from Postgres either.
// ----------------------------------------------------------------------------

// User-definable vault keys. The colon is deliberately excluded so a user key can
// never collide with (or overwrite) a `sandbox:` namespaced entry through
// the generic PUT/DELETE routes.
const VAULT_KEY_RE = /^[A-Za-z0-9_.-]{1,128}$/;

// The provider namespace prefix. Duplicated as a literal rather than imported from
// server/sandbox-skills.cjs because the Netlify function must not pull in the Fly
// server's module graph; tests/workspace-vault.test.cjs asserts they agree.
const SANDBOX_VAULT_PREFIX = 'sandbox:';

// The columns that hold secret material. Used by the realtime strip and asserted
// against every vault SELECT projection in tests.
const VAULT_SECRET_COLUMNS = ['value', 'secret_cipher'];

// group -> which route may write it.
const VAULT_WRITE_LANES = {
 managed: 'managed',
 provider: 'provider',
 shared: 'shared',
};

function titleCaseSlug(value) {
 return String(value || '')
  .split(/[-_]/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');
}

// 'api_key' -> 'API key'. Credential names are lowercase snake by construction
// (sandboxCredentialKey enforces it), so this is presentation only.
function credentialLabel(value) {
 const slug = String(value || '').trim();
 if (!slug) return 'Credential';
 if (slug === 'api_key') return 'API key';
 const words = slug.split('_').filter(Boolean);
 return words.map((word, index) => (index === 0
  ? word.charAt(0).toUpperCase() + word.slice(1)
  : word)).join(' ');
}

/**
 * What IS this vault key? Pure string work — no DB, no secret.
 *
 * `managedKeys` is the platform-managed list (ANTHROPIC_API_KEY and friends),
 * passed in because each backend owns its own MANAGED_SECRET_KEYS constant.
 */
function classifyVaultKey(key, { managedKeys = [] } = {}) {
 const raw = String(key || '');
 if (managedKeys.includes(raw)) {
  return {
   key: raw,
   group: 'managed',
   lane: VAULT_WRITE_LANES.managed,
   owner: '',
   ownerLabel: 'Platform',
   label: raw === 'ANTHROPIC_API_KEY' ? 'Anthropic API key' : raw,
   provider: '',
   credential: '',
  };
 }
 if (raw.startsWith(SANDBOX_VAULT_PREFIX)) {
  const [provider, credential, ...rest] = raw.slice(SANDBOX_VAULT_PREFIX.length).split(':');
  // A malformed namespaced key (extra colons, empty halves) is reported as
  // unknown rather than guessed at: it has no write lane and no owner, so the
  // surface shows it as an orphan instead of offering to overwrite the wrong row.
  if (!provider || !credential || rest.length > 0) {
   return { key: raw, group: 'unknown', lane: 'none', owner: '', ownerLabel: '', label: raw, provider: '', credential: '' };
  }
  return {
   key: raw,
   group: 'provider',
   lane: VAULT_WRITE_LANES.provider,
   owner: provider,
   ownerLabel: titleCaseSlug(provider),
   label: credentialLabel(credential),
   provider,
   credential,
  };
 }
 // Unknown namespaced rows may remain after an integration is removed. Never
 // present one as a writable shared secret: the generic route deliberately
 // cannot address keys containing a colon.
 if (raw.includes(':')) {
  return { key: raw, group: 'unknown', lane: 'none', owner: '', ownerLabel: '', label: raw, provider: '', credential: '' };
 }
 return {
  key: raw,
  group: 'shared',
  lane: VAULT_WRITE_LANES.shared,
  owner: '',
  ownerLabel: '',
  label: raw,
  provider: '',
  credential: '',
 };
}

// The metadata projection. `value` and `secret_cipher` are NOT selected; whether
// a value exists is answered by the database as a boolean. `legacy_plaintext`
// marks a row written before encryption-at-rest landed — it is a state flag, not
// a value, and drives the re-encryption backfill.
const VAULT_META_SELECT = `select key, description, updated_at, updated_by,
        (coalesce(secret_cipher, '') <> '' or coalesce(value, '') <> '') as configured,
        (coalesce(value, '') <> '') as legacy_plaintext
   from workspace_secrets where workspace_id = $1 order by key asc`;

async function listWorkspaceSecretMeta(workspaceId, { db }) {
 if (!workspaceId) return [];
 const rows = await db(VAULT_META_SELECT, [String(workspaceId)]);
 return Array.isArray(rows) ? rows : [];
}

/**
 * Every credential this workspace has stored, as write-only entries.
 *
 * Includes namespaced provider entries and safely classifies unknown namespaces.
 */
async function listWorkspaceVaultEntries(workspaceId, { db, managedKeys = [] }) {
 const rows = await listWorkspaceSecretMeta(workspaceId, { db });
 const entries = rows.map((row) => ({
  ...classifyVaultKey(row.key, { managedKeys }),
  description: row.description || '',
  configured: row.configured === true || row.configured === 't' || row.configured === 1,
  legacy_plaintext: row.legacy_plaintext === true || row.legacy_plaintext === 't' || row.legacy_plaintext === 1,
  updated_at: row.updated_at || null,
 }));

 return entries;
}

// ----------------------------------------------------------------------------
// IN-APP FEEDBACK (System workspace).
//
// Shape of the feature, so the security properties are readable in one place:
//
//   SUBMIT  any authenticated user, rate limited, via POST /backend/feedback.
//           The client never chooses the destination workspace — the server
//           resolves the single System workspace itself. A report becomes an
//           ordinary `tasks` row (source_type='feedback') plus a
//           `feedback_reports` row holding the bulky diagnostics, so the
//           existing task list, assignment and agent dispatch work on it for
//           free and no parallel todo system exists.
//
//   READ    members of the System workspace only, through the generic /db
//           gate (DB_TABLE_ACCESS.feedback_reports.select = 'read', and
//           feedback_reports is workspace-scoped) — the same membership check
//           every other table uses. The reporter is NOT a member, so they
//           cannot read their own report back, and definitely not anyone
//           else's.
//
// The System workspace is an ORDINARY workspace with `is_system = true`. It has
// an owner, members, roles and invites like any other, so "add someone to it"
// is the normal Users flow rather than something new.
// ----------------------------------------------------------------------------

const SYSTEM_WORKSPACE_NAME = 'System';
const SYSTEM_WORKSPACE_ICON = '🛟';
const SYSTEM_WORKSPACE_DESCRIPTION = 'Product feedback filed from inside the app.';

const FEEDBACK_DESCRIPTION_MAX_CHARS = 4000;
const FEEDBACK_MAX_SELECTIONS = 5;
const FEEDBACK_MAX_CONSOLE_ENTRIES = 300;
const FEEDBACK_CONSOLE_ENTRY_MAX_CHARS = 800;
const FEEDBACK_MAX_ERROR_ENTRIES = 30;
/** Hard ceiling on the stored diagnostics blob, enforced by dropping the OLDEST console lines. */
const FEEDBACK_DIAGNOSTICS_MAX_BYTES = 256_000;

// CJS twin of src/lib/feedbackRedaction.ts's REDACTION_PATTERNS.
//
// The client redacts before sending; this redacts again on arrival. Both are
// needed for different reasons: the client one keeps secrets out of the network
// request at all, this one is the version that still holds when the request did
// NOT come from our client. A feedback endpoint that trusts the browser to have
// scrubbed its own console is not a security control.
//
// tests/feedback-redaction-parity.test.cjs asserts the two lists carry the same
// pattern NAMES, so adding a shape on one side and forgetting the other fails
// the suite instead of silently halving the protection.
const REDACTED_PLACEHOLDER = '[redacted]';

const FEEDBACK_REDACTION_PATTERNS = [
 { name: 'agensis-session-token', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+\.\d+\.[A-Za-z0-9_-]{16,}/gi, replacement: REDACTED_PLACEHOLDER },
 { name: 'agensis-agent-token', pattern: /\b(?:aga|agw|agx|agf|agc|ago|cbk)_[A-Za-z0-9_-]{8,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'bearer-header', pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED_PLACEHOLDER}` },
 { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'openai-style-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'github-token', pattern: /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{20,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'connection-string-credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: `$1${REDACTED_PLACEHOLDER}@` },
 { name: 'secret-assignment', pattern: /(["']?\b(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|session[-_]?token|connect[-_]?token|client[-_]?secret|private[-_]?key|secret|password|passwd|pwd|authorization|cookie|set-cookie)\b["']?\s*[:=]\s*)(["']?)([^\s"',;)}\]&]{3,})\2/gi, replacement: `$1$2${REDACTED_PLACEHOLDER}$2` },
];

// Matched against the key with separators stripped, so `accessToken`,
// `access_token` and `access-token` all hit the same rule. Deliberately omits
// bare `auth` (matches `author`) and bare `session` (matches `sessionId`, not a
// credential and genuinely useful in a bug report) — both are covered by their
// compound forms. Mirrors SENSITIVE_KEY_WORDS in src/lib/feedbackRedaction.ts.
const FEEDBACK_SENSITIVE_KEY_WORDS = /token|secret|password|passwd|pwd|authorization|cookie|credential|apikey|privatekey/;

function isFeedbackSensitiveKey(key) {
 return FEEDBACK_SENSITIVE_KEY_WORDS.test(String(key).replace(/[-_.\s]/g, '').toLowerCase());
}

function redactSecretsText(value) {
 let text = typeof value === 'string' ? value : String(value == null ? '' : value);
 for (const { pattern, replacement } of FEEDBACK_REDACTION_PATTERNS) {
  pattern.lastIndex = 0;
  text = text.replace(pattern, replacement);
 }
 return text;
}

function redactSecretsDeep(value, depth = 6) {
 if (depth <= 0) return REDACTED_PLACEHOLDER;
 if (typeof value === 'string') return redactSecretsText(value);
 if (value === null || typeof value !== 'object') return value;
 if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, depth - 1));
 const out = {};
 for (const [key, entry] of Object.entries(value)) {
  out[key] = isFeedbackSensitiveKey(key) ? REDACTED_PLACEHOLDER : redactSecretsDeep(entry, depth - 1);
 }
 return out;
}

function clampString(value, max) {
 return redactSecretsText(String(value == null ? '' : value)).slice(0, max);
}

/**
 * Validate + clamp + redact a submitted report. Throws 400 when there is no
 * usable description. Everything else degrades to a safe default rather than
 * rejecting — a bug report is worth having even if its diagnostics were
 * malformed.
 */
function normalizeFeedbackSubmission(body) {
 const raw = body && typeof body === 'object' ? body : {};
 const description = clampString(raw.description, FEEDBACK_DESCRIPTION_MAX_CHARS).trim();
 if (description.length < 3) throw badRequest('Please describe the problem before submitting');

 const page = raw.page && typeof raw.page === 'object' ? raw.page : {};
 const normalizedPage = {
  path: clampString(page.path, 400),
  hash: clampString(page.hash, 200),
  label: clampString(page.label, 200),
 };

 const selections = (Array.isArray(raw.selections) ? raw.selections : [])
  .slice(0, FEEDBACK_MAX_SELECTIONS)
  .filter((entry) => entry && typeof entry === 'object')
  .map((entry) => {
   const rect = entry.rect && typeof entry.rect === 'object' ? entry.rect : {};
   const num = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0);
   return {
    selector: clampString(entry.selector, 500),
    tag: clampString(entry.tag, 40),
    role: clampString(entry.role, 40),
    text: clampString(entry.text, 200),
    rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
   };
  });

 const diagnostics = normalizeFeedbackDiagnostics(raw.diagnostics);

 return { description, page: normalizedPage, selections, diagnostics };
}

function normalizeFeedbackDiagnostics(input) {
 if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
 const viewport = input.viewport && typeof input.viewport === 'object' ? input.viewport : {};
 const dimension = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 100_000) : 0;
 };

 const consoleEntries = (Array.isArray(input.console) ? input.console : [])
  .slice(-FEEDBACK_MAX_CONSOLE_ENTRIES)
  .filter((entry) => entry && typeof entry === 'object')
  .map((entry) => ({
   level: clampString(entry.level, 10) || 'log',
   message: clampString(entry.message, FEEDBACK_CONSOLE_ENTRY_MAX_CHARS),
   at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
  }));

 const errors = (Array.isArray(input.errors) ? input.errors : [])
  .slice(-FEEDBACK_MAX_ERROR_ENTRIES)
  .filter((entry) => entry && typeof entry === 'object')
  .map((entry) => ({
   kind: clampString(entry.kind, 30) || 'error',
   message: clampString(entry.message, FEEDBACK_CONSOLE_ENTRY_MAX_CHARS),
   source: clampString(entry.source, 300),
   at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
  }));

 const diagnostics = {
  buildId: clampString(input.buildId, 120),
  userAgent: clampString(input.userAgent, 400),
  url: clampString(input.url, 600),
  language: clampString(input.language, 40),
  capturedAt: clampString(input.capturedAt, 40),
  viewport: { width: dimension(viewport.width), height: dimension(viewport.height) },
  console: consoleEntries,
  errors,
  truncated: Boolean(input.truncated),
 };

 // Size ceiling. Drop from the OLDEST console line inward — the lines nearest
 // the moment the user hit "report" are the ones that explain the bug.
 while (
  diagnostics.console.length > 0
  && JSON.stringify(diagnostics).length > FEEDBACK_DIAGNOSTICS_MAX_BYTES
 ) {
  diagnostics.console.shift();
  diagnostics.truncated = true;
 }

 return diagnostics;
}

/** First line of the description, as the task title. Falls back to a generic label. */
function feedbackTaskTitle(description) {
 const firstLine = String(description || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
 if (!firstLine) return 'Feedback report';
 return firstLine.length <= 90 ? firstLine : `${firstLine.slice(0, 89)}…`;
}

/**
 * Resolve (creating on first use) the single System workspace.
 *
 * Auto-creating means the feature has no manual setup step, and the partial
 * unique index `uq_workspaces_system` makes it race-safe: two concurrent first
 * submissions cannot produce two System workspaces, the loser just re-reads.
 *
 * Owner selection: AGENSIS_SYSTEM_OWNER_EMAIL when set, else the oldest account
 * (on a single-owner deployment that is the person who installed it). Ownership
 * is a normal `workspaces.user_id`, so it can be transferred with the existing
 * flow if that guess is wrong.
 */
async function ensureSystemWorkspace(db) {
 const existing = await db('select id from workspaces where is_system = true order by created_at asc limit 1', []);
 if (existing[0]) return existing[0].id;

 const configuredEmail = String(process.env.AGENSIS_SYSTEM_OWNER_EMAIL || '').trim().toLowerCase();
 let ownerId = null;
 if (configuredEmail) {
  const rows = await db('select id from app_users where lower(email) = $1 limit 1', [configuredEmail]);
  ownerId = rows[0]?.id || null;
 }
 if (!ownerId) {
  const rows = await db('select id from app_users order by created_at asc limit 1', []);
  ownerId = rows[0]?.id || null;
 }

 await db(
  `insert into workspaces (name, description, icon, user_id, is_system)
     values ($1, $2, $3, $4, true)
     on conflict do nothing`,
  [SYSTEM_WORKSPACE_NAME, SYSTEM_WORKSPACE_DESCRIPTION, SYSTEM_WORKSPACE_ICON, ownerId],
 );

 const created = await db('select id from workspaces where is_system = true order by created_at asc limit 1', []);
 if (!created[0]) throw httpError(500, 'Could not resolve the System workspace');
 return created[0].id;
}

/**
 * Persist one report: a `tasks` row (the reviewable, assignable artifact) and a
 * `feedback_reports` row (the payload). Returns { taskId, reportId }.
 *
 * `jsonParam` is the ONLY thing the two backends must supply differently, and
 * it is the trap this repo has been bitten by before. Verified against the live
 * Neon database, 2026-07-26:
 *
 *   postgres.js (Fly)          bind object -> jsonb object     JSON.stringify -> jsonb STRING (wrong)
 *   @netlify/database (Neon)   bind object -> jsonb object     JSON.stringify -> jsonb object
 *                              bind ARRAY  -> ERROR            JSON.stringify -> jsonb array (right)
 *
 * So Fly passes identity and Netlify passes JSON.stringify; that combination is
 * the only one correct for BOTH objects and arrays on BOTH drivers. Get it
 * backwards and Fly silently stores `"{\"console\":[...]}"` as a jsonb string
 * scalar — every `diagnostics->>'buildId'` then returns NULL and nothing errors.
 */
async function insertFeedbackReport({ db, jsonParam, userId, sourceWorkspaceId, submission }) {
 if (typeof db !== 'function') throw new Error('insertFeedbackReport requires a db function');
 if (typeof jsonParam !== 'function') throw new Error('insertFeedbackReport requires a jsonParam binder');

 const systemWorkspaceId = await ensureSystemWorkspace(db);
 const title = feedbackTaskTitle(submission.description);

 const pageRef = [submission.page.path, submission.page.hash].filter(Boolean).join('');
 const descriptionLines = [
  submission.description,
  '',
  `Page: ${pageRef || '(unknown)'}${submission.page.label ? ` — ${submission.page.label}` : ''}`,
 ];
 if (submission.selections.length > 0) {
  descriptionLines.push('', 'Elements:');
  for (const selection of submission.selections) {
   descriptionLines.push(`- \`${selection.selector}\`${selection.text ? ` — "${selection.text}"` : ''}`);
  }
 }

 const taskRows = await db(
  `insert into tasks (workspace_id, created_by, title, description, status, priority, source_type, source_id)
     values ($1, $2, $3, $4, 'todo', 'normal', 'feedback', null)
     returning id`,
  [systemWorkspaceId, userId || null, title, descriptionLines.join('\n')],
 );
 const taskId = taskRows[0]?.id;
 if (!taskId) throw httpError(500, 'Could not record the feedback task');

 const reportRows = await db(
  `insert into feedback_reports
       (workspace_id, task_id, reporter_id, source_workspace_id, description, page, selections, diagnostics, build_id, user_agent)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
     returning id`,
  [
   systemWorkspaceId,
   taskId,
   userId || null,
   sourceWorkspaceId || null,
   submission.description,
   jsonParam(submission.page),
   jsonParam(submission.selections),
   submission.diagnostics ? jsonParam(submission.diagnostics) : null,
   submission.diagnostics?.buildId || '',
   submission.diagnostics?.userAgent || '',
  ],
 );
 const reportId = reportRows[0]?.id;

 // source_id points back at the report so the task row alone is enough to find
 // the diagnostics. Written as a follow-up UPDATE because the report id is only
 // known after its insert, and the task must exist first for the FK.
 if (reportId) {
  await db('update tasks set source_id = $1, updated_at = now() where id = $2', [String(reportId), taskId]);
 }

 return { taskId, reportId: reportId || null, systemWorkspaceId };
}

// ============================================================================
// The audit log
// ----------------------------------------------------------------------------
// A durable, SERVER-AUTHORED record of the privileged actions that previously
// left no trace anywhere: role changes, member removal, invites, permission-mode
// flips (including 'yolo', which is unrestricted shell on the daemon host),
// permanent tool grants, connect-token mints, and vault writes.
//
// This is NOT activity_events, and the distinction is structural rather than a
// matter of taste. activity_events is written by the BROWSER through the generic
// /backend/db/insert route (src/hooks/useActivity.ts), the client picks its own
// event_type/title/user_id, and DB_TABLE_ACCESS gives it insert/update/delete at
// 'write' — so any editor can forge a row and delete a real one. That is fine
// for a feed and disqualifies it as an audit record permanently.
//
// So `audit_log` is deliberately ABSENT from ALLOWED_TABLES and from
// DB_TABLE_ACCESS. ensureTable() rejects unknown tables before any /backend/db/*
// handler runs, so there is no generic read, write or realtime-subscribe path to
// this table at all — a stronger guarantee than {insert:'manage'}, which would
// still leave a route for a future manage-holder or a bug in the gate to travel.
// The only doors are recordAuditEntry (in) and the manage-gated
// GET /backend/workspaces/:id/audit route (out). tests/audit-log-append-only
// fails if anyone allowlists it.
//
// WHAT THIS IS WORTH, stated honestly so nobody over-claims it: entries are
// attested by the SERVER, not signed by the actor, and the app connects to
// Postgres as a role that can DROP the immutability trigger. It is tamper-
// EVIDENT against application-level actors — a member, an agent, a bug, a SQL
// injection reaching a DELETE. It is not tamper-PROOF against whoever holds
// DATABASE_URL, and no design available in this architecture would be.
//
// v1 stores a per-row `entry_hash` and a bigserial `seq`, and deliberately does
// NOT chain rows with a prev_hash. A chain's real cost is serialisation: every
// entry must read the current tail before it can write, turning an independent
// INSERT into a lock-taking read-modify-write on paths (role changes, token
// mints, secret writes) that must never stall. And a chain is only evidence if
// its head is anchored where the adversary cannot reach — agensis has one
// Postgres and one operator, so a chain written by the operator, anchored in the
// operator's database, verified by the operator, against the operator, proves
// nothing. The per-row hash detects EDITS and the sequence flags GAPS, at no
// lock and two columns. Add prev_hash going forward the day an external anchor
// exists; do not pretend the historical rows were ever sealed.

/**
 * Every action this log will record. An `action` outside this set is a typo, and
 * a typo must not silently produce a row nobody can filter for.
 */
const AUDIT_ACTIONS = Object.freeze(new Set([
 'member.role_changed',
 'member.removed',
 'invite.created',
 'invite.revoked',
 'agent.permission_mode_changed',
 'agent.permission_rule_granted',
 'agent.permission_rule_revoked',
 'agent.connect_token_minted',
 'chat_session.cleared',
 // The workspace MCP token (agw_) is the control-plane secret for the whole
 // workspace: a bearer reaches its full allowed MCP surface, can register_agent,
 // and can mint an agent's daemon connect token via get_connect_command. Minting it
 // ROTATES it, which silently breaks every MCP client still holding the old
 // one — so "who reissued this, and when" is exactly the question this log
 // exists to answer. Its sibling agent.connect_token_minted was recorded from
 // the start; this one was not, which is the only reason it is a separate line.
 'workspace.mcp_token_minted',
 // Static OAuth client for MCP (authorization-code + PKCE). Secret shown once.
 'workspace.mcp_oauth_client_created',
 // Named workspace-control credentials. Issuance and redemption are separate
 // events: the owner may create a five-minute grant that is never redeemed.
 'controller.enrollment_created',
 'controller.enrolled',
 'controller.revoked',
 // Agent-stewarded resources. Operation requests are intentionally audited
 // because they cross a host/agent trust boundary; settlement records whether
 // the steward applied, published, rejected, or failed the request.
 'resource.created',
 'resource.updated',
 'resource.deleted',
 'resource.restored',
 'resource.operation_requested',
 'resource.operation_settled',
 // A human's ORDINARY SESSION TOKEN was used to authenticate at /backend/mcp
 // (the verifyUserAuthMcpToken tail of verifyMcpToken). Recorded to answer one
 // question with data instead of a guess — "is anyone actually using this
 // path?" — before deciding whether to stop accepting login tokens there. See
 // AGENTS.md "Login tokens at the MCP door".
 //
 // MCP AUTH RUNS ON EVERY REQUEST, so this is the one action in this registry
 // that could flood the table. It does not, because it is emitted at most ONCE
 // PER USER PER 24h PER PROCESS via createFirstUseWindow below. Never remove
 // that dedup and leave the call site in place.
 'mcp.login_token_used',
 // An OAuth MCP access token retains kind=user to share the existing tool RBAC
 // surface, but its use must remain distinguishable from an ordinary agensis
 // login token. Emitted under the same bounded first-use window.
 'mcp.oauth_access_token_used',
 'vault.secret_set',
 'vault.secret_deleted',
 // Authoring an automation is a STANDING grant to write into the workspace
 // whenever an event matches — the same class of thing as an agent_webhook, and
 // the reason both are manage-gated. "Who turned this on" is a different
 // question from "who edited it", so enable/disable is its own action.
 'automation.created',
 'automation.updated',
 'automation.deleted',
 'automation.enabled',
 'automation.disabled',
 // Reading into someone else's private conversation. The DENIAL of a read is
 // deliberately NOT audited — it fires on ordinary sidebar rendering and would
 // bury the entries that matter. The GRANT is the decision worth keeping: a
 // silent grant is worse than no grant at all, because it looks like privacy.
 'chat_session.access_granted',
 'chat_session.access_revoked',
 // A persona arriving from OUTSIDE this workspace. Authoring one is deliberately
 // not audited: a template has no privilege-bearing column, so writing prose
 // into one is a non-event and logging every edit would bury the rows above.
 // Crossing a workspace boundary is not a non-event — nobody here wrote that
 // prose, and a teammate's agent will later speak it.
 'agent_template.imported',
]));

/** What an unrecognised action records as, rather than throwing in production. */
const AUDIT_UNKNOWN_ACTION = 'unknown';

const FIRST_USE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_USE_MAX_KEYS = 5000;

/**
 * First-use-per-key-per-window, so a per-request code path can emit an audit row
 * WITHOUT flooding the log.
 *
 * The audit table is built for rare, human-attributable, privileged actions, and
 * it is a tamper-evident chain (entry_hash over the previous row). One row per
 * MCP request would bury the privileged actions it exists for and make the
 * manage-gated audit view unusable — the log would technically contain more and
 * answer less.
 *
 * So the call site asks this first. `shouldRecord(key)` returns true the first
 * time it sees a key in a 24h window and false for every repeat, which turns
 * "every request from this credential" into "this credential appeared today".
 * That is the signal the question actually needs, and it is the same rate class
 * as the other actions in the registry.
 *
 * Bounded in BOTH directions on purpose:
 *   - time — an entry expires after `windowMs`, so a key seen once a year
 *     records once a year rather than never again;
 *   - memory — at most `maxKeys` entries. Map preserves insertion order, so the
 *     oldest is evicted in O(1). Worst case when a cap eviction happens is one
 *     extra row, never unbounded growth.
 *
 * PROCESS-LOCAL, like the MCP presence map. On a multi-instance deploy the
 * ceiling is one row per key per window PER INSTANCE. That is fine for "did this
 * happen at all", and it is not a counter — do not read row counts as request
 * volume.
 *
 * `now` is injectable so the window can be tested without waiting a day.
 */
function createFirstUseWindow({
 windowMs = FIRST_USE_WINDOW_MS,
 maxKeys = FIRST_USE_MAX_KEYS,
 now = Date.now,
} = {}) {
 const seen = new Map();

 function shouldRecord(key) {
  const id = String(key || '');
  if (!id) return false;
  const at = now();

  const expiresAt = seen.get(id);
  if (expiresAt !== undefined) {
   if (expiresAt > at) return false;
   // Expired: drop it so the re-insert below lands at the END of the insertion
   // order. Without this the key keeps its original position and would be
   // evicted first despite having just been used.
   seen.delete(id);
  }

  seen.set(id, at + windowMs);

  // Evict from the front (oldest inserted) until back under the cap.
  while (seen.size > maxKeys) {
   const oldest = seen.keys().next();
   if (oldest.done) break;
   seen.delete(oldest.value);
  }
  return true;
 }

 return { shouldRecord, size: () => seen.size };
}

/** Ceilings on what one row may carry. Bounded so a row can never become a dump. */
const AUDIT_MAX_TEXT = 200;
const AUDIT_MAX_LABEL = 160;
const AUDIT_MAX_DETAIL_KEYS = 24;
const AUDIT_MAX_DETAIL_ITEMS = 24;

function auditText(value, max = AUDIT_MAX_TEXT) {
 if (value === null || value === undefined) return '';
 return String(value).slice(0, max);
}

/**
 * The email DOMAIN, never the local-part.
 *
 * "someone invited an external address" is the thing an owner actually needs to
 * see; who exactly it was is already in the invite row. This log has a 400-day
 * horizon and a different erasure path from the user record, so a deleted user's
 * address must not outlive them in here.
 */
function auditEmailDomain(email) {
 const at = String(email || '').lastIndexOf('@');
 if (at < 0) return '';
 return auditText(String(email).slice(at + 1).toLowerCase(), 80);
}

/**
 * Reduce `detail` to bounded scalars at depth 1.
 *
 * This is a STRUCTURAL guard against the highest-severity failure this feature
 * has: someone writing `detail: agentRow`, which would carry connect_token_hash
 * into a table with a longer retention than the row it came from. It cannot tell
 * a secret from a rule string — only the call sites and their tests do that (see
 * the audit redaction contract) — but it
 * does make "dump the whole row in" impossible rather than merely discouraged.
 */
function sanitizeAuditDetail(detail) {
 if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
 const out = {};
 let keys = 0;
 for (const key of Object.keys(detail).sort()) {
  if (keys >= AUDIT_MAX_DETAIL_KEYS) break;
  const value = detail[key];
  if (value === null || value === undefined) continue;
  if (typeof value === 'string') out[key] = auditText(value);
  else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  else if (typeof value === 'boolean') out[key] = value;
  else if (Array.isArray(value)) {
   out[key] = value
    .slice(0, AUDIT_MAX_DETAIL_ITEMS)
    .filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
    .map((item) => (typeof item === 'string' ? auditText(item) : item));
  } else continue; // objects and everything else are dropped, not stringified
  keys += 1;
 }
 return out;
}

/** Key-sorted deep copy, so two equal payloads always hash the same. */
function auditCanonicalValue(value) {
 if (value === null || typeof value !== 'object') return value;
 if (Array.isArray(value)) return value.map(auditCanonicalValue);
 const out = {};
 for (const key of Object.keys(value).sort()) out[key] = auditCanonicalValue(value[key]);
 return out;
}

/**
 * SHA-256 over the row's canonical content — no prev_hash, no read of the tail,
 * no lock. Detects an EDIT to a stored row; says nothing about ordering.
 *
 * created_at is part of the hash and is generated in JS by the writer, so the
 * hash covers the same instant the row stores (now() would be a different one).
 */
function auditEntryHash(row = {}) {
 const payload = JSON.stringify([
  String(row.workspace_id || ''),
  String(row.actor_user_id || ''),
  String(row.actor_agent_id || ''),
  String(row.action || ''),
  String(row.target_type || ''),
  String(row.target_id || ''),
  String(row.before_value || ''),
  String(row.after_value || ''),
  auditCanonicalValue(row.detail || {}),
  String(row.created_at || ''),
 ]);
 return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Write one audit entry. Returns the row's { id, seq, entry_hash } or null.
 *
 * FIRE-AND-FORGET, in the same sense as logProviderCallActivity: awaited so an
 * ordinary failure reaches the server log, but it NEVER rejects. An audit write
 * that throws inside a role-change handler would turn a working privileged
 * action into a 500 — the log must not be able to break the thing it observes.
 *
 * `actor` is { userId, agentId, label }. A user action sets actor_user_id from
 * the VERIFIED session (req.userId), never from a request body; an agent-
 * initiated one sets actor_agent_id from the token-resolved agent. Never both.
 *
 * `jsonParam` is the two-driver seam described on insertFeedbackReport above. It
 * defaults to identity, which is correct for postgres.js on Fly, where every v1
 * call site lives. A Netlify caller must pass JSON.stringify.
 */
async function recordAuditEntry({
 db,
 workspaceId = null,
 actor = {},
 action,
 target = {},
 before = '',
 after = '',
 detail = {},
 requestIp = '',
 jsonParam = (value) => value,
} = {}) {
 try {
  if (typeof db !== 'function') throw new Error('recordAuditEntry requires a db function');
  let resolvedAction = String(action || '').trim();
  if (!AUDIT_ACTIONS.has(resolvedAction)) {
   // Loud in development so a typo is caught at the desk; recorded as 'unknown'
   // in production so the ACTION still leaves a row even when its name is wrong.
   if (process.env.NODE_ENV !== 'production') {
    throw new Error(`recordAuditEntry: unknown action ${JSON.stringify(resolvedAction)}`);
   }
   resolvedAction = AUDIT_UNKNOWN_ACTION;
  }

  const actorUserId = actor?.userId ? String(actor.userId) : null;
  // Never both: an action has one actor. A user session wins if a caller
  // somehow supplies each, because req.userId is the verified one.
  const actorAgentId = !actorUserId && actor?.agentId ? String(actor.agentId) : null;

  const row = {
   workspace_id: workspaceId ? String(workspaceId) : null,
   actor_user_id: actorUserId,
   actor_agent_id: actorAgentId,
   actor_label: auditText(actor?.label, AUDIT_MAX_LABEL),
   action: resolvedAction,
   target_type: auditText(target?.type, 60),
   target_id: target?.id ? auditText(target.id, 120) : null,
   target_label: auditText(target?.label, AUDIT_MAX_LABEL),
   before_value: auditText(before),
   after_value: auditText(after),
   detail: sanitizeAuditDetail(detail),
   request_ip: auditText(requestIp, 60),
   created_at: new Date().toISOString(),
  };
  row.entry_hash = auditEntryHash(row);

  const inserted = await db(
   `insert into audit_log
        (workspace_id, actor_user_id, actor_agent_id, actor_label, action,
         target_type, target_id, target_label, before_value, after_value,
         detail, request_ip, entry_hash, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
      returning id, seq, entry_hash`,
   [
    row.workspace_id, row.actor_user_id, row.actor_agent_id, row.actor_label, row.action,
    row.target_type, row.target_id, row.target_label, row.before_value, row.after_value,
    jsonParam(row.detail), row.request_ip, row.entry_hash, row.created_at,
   ],
  );
  return inserted?.[0] ?? null;
 } catch (error) {
  console.error('recordAuditEntry failed', error);
  return null;
 }
}

module.exports = {
 verifyAuthToken,
 issueAuthToken,
 getTokenTtlSec,
 DEFAULT_TOKEN_TTL_SEC,
 enforceDbOperationAccess,
 assertWorkspaceRole,
 assertWorkspaceRoleLocked,
 // Session read scope — the granularity below the workspace.
 enforceSessionReadAccess,
 isPrivateSessionRow,
 sessionReadableSql,
 addSessionParticipant,
 ALLOWED_TABLES,
 VERSIONED_TABLES,
 JSON_COLUMNS_BY_TABLE,
 ARRAY_COLUMNS_BY_TABLE,
 arrayColumnElemType,
 toPgArrayLiteral,
 WORKSPACE_SCOPED_TABLES,
 WORKSPACE_ROLE_CAPABILITIES,
 DB_TABLE_ACCESS,
 PRIVILEGED_DB_COLUMNS_BY_TABLE,
 MANAGE_ONLY_DB_COLUMNS_BY_TABLE,
 setsManageOnlyDbColumn,
 SELECTABLE_COLUMNS_BY_TABLE,
 DEDICATED_SELECT_ONLY_TABLES,
 assertGenericSelectAllowed,
 safeSelectColumns,
 AI_STREAM_ERROR_MAX_LENGTH,
 aiStreamErrorText,
 DELETED_MESSAGE_CONTENT,
 redactDeletedMessageRow,
 redactDeletedMessageRows,
 stripPrivilegedDbValues,
 sanitizeAgentSharingValues,
 validateUniformInsertRows,
 applyAgentPurposeInsertDefaults,
 stampTaskWriteIdentity,
 taskDispatchRequesterSql,
 stripImmutableDbUpdateValues,
 loadBrowserMessageAuthor,
 stampBrowserMessageInsert,
 messageUpdateNeedsAuthorship,
 enforceMessageAuthorship,
 appendMessageAuthorshipFilters,
 appendMessageMutationAccessClause,
 encryptVaultSecret,
 decryptVaultSecret,
 getWorkspaceSecretValue,
 setWorkspaceSecretValue,
 // The vault surface. One classification for both backends.
 VAULT_KEY_RE,
 VAULT_SECRET_COLUMNS,
 VAULT_META_SELECT,
 VAULT_WRITE_LANES,
 SANDBOX_VAULT_PREFIX,
 classifyVaultKey,
 credentialLabel,
 listWorkspaceSecretMeta,
 listWorkspaceVaultEntries,
 storagePathBelongsToWorkspace,
 // The audit log. Note what is NOT here: audit_log appears in neither
 // ALLOWED_TABLES nor DB_TABLE_ACCESS, on purpose — see the block above.
 AUDIT_ACTIONS,
 AUDIT_UNKNOWN_ACTION,
 auditEmailDomain,
 auditEntryHash,
 recordAuditEntry,
 createFirstUseWindow,
 FIRST_USE_WINDOW_MS,
 sanitizeAuditDetail,
 createTokenVersionCache,
 appendWorkspaceAccessClause,
 appendSessionAccessClause,
 DELETED_MESSAGE_ACTIVITY_TITLE,
 EDITED_MESSAGE_ACTIVITY_TITLE,
 logMessageActivityIdempotent,
 scrubEditedMessageActivityByMessageId,
 scrubMessageActivityByMessageId,
 scrubMessageActivityBySession,
 scrubMessageActivityBySessions,
 createRateLimiter,
 createDbRateLimiter,
 evaluatePasswordServerSide,
 findFilterValue,
 resolveOperationWorkspace,
 userCanAccessWorkspace,
 getWorkspaceRole,
 // Nested workspaces (shared/workspace-tree.cjs holds the pure rules).
 getInheritedWorkspaceRoles,
 getEffectiveWorkspaceRoles,
 assertWorkspaceParentChange,
 WORKSPACE_MAX_DEPTH,
 roleHasWorkspaceCapability,
 assertUpdateKeepsTenancy,
 httpError,
 unauthorized,
 forbidden,
 badRequest,
 PASSWORD_MIN_LENGTH,
 PASSWORD_MIN_CLASSES,
 // In-app feedback / System workspace
 SYSTEM_WORKSPACE_NAME,
 SYSTEM_WORKSPACE_ICON,
 SYSTEM_WORKSPACE_DESCRIPTION,
 FEEDBACK_REDACTION_PATTERNS,
 FEEDBACK_DESCRIPTION_MAX_CHARS,
 FEEDBACK_MAX_SELECTIONS,
 FEEDBACK_MAX_CONSOLE_ENTRIES,
 FEEDBACK_DIAGNOSTICS_MAX_BYTES,
 redactSecretsText,
 redactSecretsDeep,
 normalizeFeedbackSubmission,
 normalizeFeedbackDiagnostics,
 feedbackTaskTitle,
 ensureSystemWorkspace,
 insertFeedbackReport,
};
