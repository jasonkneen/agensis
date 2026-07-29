'use strict';

// Interactive tool approvals: the human-facing half of the daemon's
// `agent_permission_request` frame.
//
// A daemon agent runs headless on someone else's machine, so the coding CLI's
// own terminal prompt has nobody in front of it, and the settings files an
// operator would normally write grants into are not read at all (the daemon
// runs Claude with `settingSources: []`). Before this, a tool that needed
// approval simply errored, and the model narrated an approval prompt that
// existed nowhere — leaving `permission_mode: 'yolo'`, unrestricted shell, as
// the only way to let an agent run one `git clone`.
//
// So the request comes here instead. It lands in the conversation the job is
// already running in, as a message the human answers with a button, and the
// answer goes back down the same socket.
//
// Three things this module holds to:
//
//  - THE DAEMON IS NEVER TRUSTED FOR IDENTITY. workspace/agent come off the
//    socket's own token, and the job is re-read by (id, agent_id, workspace_id)
//    exactly like handleAgentJobStep does, so a daemon cannot raise a request
//    against somebody else's job.
//
//  - 'always' COSTS MORE THAN 'once'. Once and session need `write` — the
//    capability that already lets a member talk to the agent, and the only way
//    to unblock a running job without an admin present. Permanent grants are
//    stored on `workspace_agents.metadata`, which is MANAGE_ONLY in
//    backend-core's column rules, so they need `manage` and this route enforces
//    the same thing rather than writing around it.
//
//  - THE RULES STORED ARE THE ONES THE HUMAN SAW. The daemon sends the exact
//    rule strings its "always allow" button would grant; the decide route
//    stores those and nothing derived from them, so what is persisted can never
//    be broader than what was on screen.

const crypto = require('crypto');

/** `messages.message_kind` for a permission request. Anything else is a real message. */
const PERMISSION_REQUEST_KIND = 'permission_request';

const PERMISSION_SCOPES = new Set(['once', 'session', 'always']);
const MAX_RULES_PER_REQUEST = 12;
const MAX_RULE_LENGTH = 200;
/**
 * Ceiling on how many parked request ids a reconnecting daemon may re-assert.
 * A daemon can only be parked on as many requests as it has concurrent turns,
 * so this is generous — it exists so an unbounded daemon-supplied array cannot
 * become an unbounded `= any($4::text[])`.
 */
const MAX_RESUMED_REQUESTS = 64;
/** Ceiling on a daemon-proposed park, so a bad `expiresInMs` cannot pin a row open forever. */
const MAX_REQUEST_TTL_MS = 60 * 60 * 1000;
const DEFAULT_REQUEST_TTL_MS = 10 * 60 * 1000;

async function ensureAgentPermissionsSchema(db) {
 await db.unsafe(`
    CREATE TABLE IF NOT EXISTS agent_permission_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
      job_id uuid,
      connection_id uuid,
      session_id uuid,
      message_id uuid,
      request_key text NOT NULL,
      tool_name text NOT NULL DEFAULT '',
      tool_detail text NOT NULL DEFAULT '',
      title text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      rules jsonb NOT NULL DEFAULT '[]'::jsonb,
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'pending',
      scope text NOT NULL DEFAULT '',
      decided_by uuid,
      decided_by_name text NOT NULL DEFAULT '',
      decided_at timestamptz,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- One row per (connection, request id): the daemon's ids are unique per
    -- process, and a socket that redelivers a frame must update the row it
    -- already made rather than stack a second prompt on the human.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_permission_requests_key
      ON agent_permission_requests(connection_id, request_key);
    CREATE INDEX IF NOT EXISTS idx_agent_permission_requests_pending
      ON agent_permission_requests(workspace_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_permission_requests_job
      ON agent_permission_requests(job_id);
    -- The transcript anchor. Nullable: a request whose message insert failed is
    -- still a real pending request, and losing it would wedge the turn.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS permission_request_id uuid;
    CREATE INDEX IF NOT EXISTS idx_messages_permission_request
      ON messages(permission_request_id) WHERE permission_request_id IS NOT NULL;
  `);
}

/** Trim a daemon-supplied string to one clipped line. */
function line(value, max = 200) {
 const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
 return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The rule strings an "always allow" would grant.
 *
 * Bounded in both count and length because they are daemon input rendered into
 * a human's approval prompt: a request offering fifty rules is not a decision
 * anyone can make, and it is not one this stores.
 */
function normalizeRules(raw) {
 const rules = [];
 for (const entry of Array.isArray(raw) ? raw : []) {
  const rule = line(entry, MAX_RULE_LENGTH);
  if (rule && !rules.includes(rule)) rules.push(rule);
  if (rules.length >= MAX_RULES_PER_REQUEST) break;
 }
 return rules;
}

/**
 * Which scopes this request may be answered with.
 *
 * 'always' is offered only when there is a concrete rule to make permanent —
 * without one the button would have to mean "allow this whole tool forever",
 * which is a far bigger grant than the sentence next to it says.
 */
function allowedScopes(rules) {
 return rules.length > 0 ? ['once', 'session', 'always'] : ['once', 'session'];
}

/** The one-line label the transcript shows, e.g. `Bash · git clone https://…`. */
function requestContent({ tool_name: toolName, tool_detail: detail }) {
 if (toolName && detail) return `${toolName} · ${detail}`;
 return toolName || detail || 'a tool call';
}

function createAgentPermissions(deps = {}) {
 const {
  badRequest,
  forbidden,
  enforceWorkspaceRole,
  normalizeAgentPermissionMode,
  // Deliberately NOT findConnectedAgent: a decision goes to the EXACT connection
  // that raised the request, never to "some live socket for this agent" — see
  // deliverDecision.
  getConnectedAgents,
  getDb,
  notifyDbSubscribers,
  parseJsonObject,
  sendWs,
  // The audit writer (server/index.cjs recordAudit). Never rejects. Optional so
  // the existing unit tests can construct this factory without one.
  recordAudit = async () => null,
 } = deps;

 /** The shape any route hands back — never a raw row, so a column added later is a deliberate exposure. */
 function publicPermissionRequest(row) {
  if (!row) return null;
  return {
   id: row.id,
   workspaceId: row.workspace_id,
   agentId: row.agent_id,
   jobId: row.job_id || null,
   sessionId: row.session_id || null,
   messageId: row.message_id || null,
   toolName: row.tool_name || '',
   toolDetail: row.tool_detail || '',
   title: row.title || '',
   description: row.description || '',
   rules: Array.isArray(row.rules) ? row.rules : [],
   scopes: Array.isArray(row.scopes) ? row.scopes : [],
   status: row.status || 'pending',
   scope: row.scope || '',
   decidedBy: row.decided_by || null,
   decidedByName: row.decided_by_name || '',
   decidedAt: row.decided_at || null,
   expiresAt: row.expires_at || null,
   createdAt: row.created_at || null,
  };
 }

 /**
  * Send a decision to the daemon that raised the request.
  *
  * Prefers the exact connection the request came in on. A daemon that
  * reconnected has a NEW process with no memory of the request id, so falling
  * back to "any live socket for this agent" would deliver an answer nobody is
  * waiting for — which is harmless but never useful, and would let the UI claim
  * a grant took effect when it did not. Hence: exact socket, or nothing.
  */
 function deliverDecision(row, frame) {
  const exact = getConnectedAgents().get(row.connection_id);
  if (!exact || exact.ws?.readyState !== 1 || String(exact.agentId) !== String(row.agent_id)) return false;
  return sendWs(exact.ws, frame);
 }

 /**
  * A daemon asks whether a tool call may run.
  *
  * Mirrors handleAgentJobStep's ownership check exactly: the job must belong to
  * the agent and workspace on this socket's token. Steps hang off the reply's
  * THREAD ROOT for the same reason they do there — a request parented to the
  * "Thinking …" placeholder lands two levels deep and is invisible in the very
  * thread the human is watching.
  */
 async function handleAgentPermissionRequest(ws, message) {
  const auth = ws.agentAuth;
  if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
  const jobId = String(message.jobId || '');
  const requestKey = String(message.requestId || '').trim();
  if (!requestKey) throw badRequest('requestId is required');

  const deny = (reason) => {
   sendWs(ws, { type: 'agent_permission_decision', requestId: requestKey, behavior: 'deny', message: reason });
  };
  if (!jobId) {
   deny('This tool call is not attached to a job, so nobody can be asked about it.');
   return null;
  }

  const rows = await getDb().unsafe(
   `select j.*, a.name as agent_name, a.handle as agent_handle
      from agent_jobs j
      left join workspace_agents a on a.id = j.agent_id
      where j.id = $1 and j.agent_id = $2 and j.workspace_id = $3
      limit 1`,
   [jobId, auth.agentId, auth.workspaceId],
  );
  const job = rows[0];
  if (!job) throw forbidden('Agent job not found');
  // Farm / control-plane jobs have no conversation. Denying immediately is the
  // only honest answer: parking would hold the turn until its own timeout for a
  // question that could never be displayed.
  if (!job.session_id) {
   deny('This job runs outside a conversation, so there is nowhere to ask for approval.');
   return null;
  }
  if (!['queued', 'running'].includes(job.status)) {
   deny('The job had already finished before this could be approved.');
   return null;
  }

  const rules = normalizeRules(message.rules);
  const toolName = line(message.toolName, 60);
  const toolDetail = line(message.detail ?? message.toolDetail, 160);
  const ttlMs = Math.min(
   MAX_REQUEST_TTL_MS,
   Math.max(30_000, Number(message.expiresInMs) || DEFAULT_REQUEST_TTL_MS),
  );

  const metadata = parseJsonObject(job.metadata);
  const responseMessageId = metadata.responseMessageId || null;
  // Same resolution as handleAgentJobStep, and for the same reason: existence
  // and parentage are ONE question, because a stale id answered "no parent"
  // identically to a missing row and was written into a foreign key.
  let threadParentId = null;
  if (responseMessageId) {
   const parentRows = await getDb().unsafe(
    'select thread_parent_id from messages where id = $1 and session_id = $2 limit 1',
    [responseMessageId, job.session_id],
   );
   if (parentRows[0]) threadParentId = parentRows[0].thread_parent_id || responseMessageId;
  }

  const requestId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const requestRows = await getDb().unsafe(
   `insert into agent_permission_requests
      (id, workspace_id, agent_id, job_id, connection_id, session_id, message_id, request_key,
       tool_name, tool_detail, title, description, rules, scopes, status, expires_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, 'pending', now() + ($15::text || ' milliseconds')::interval)
    on conflict (connection_id, request_key) do update
      set updated_at = now()
    returning *`,
   [
    requestId, auth.workspaceId, auth.agentId, job.id, ws.agentConnectionId, job.session_id, messageId, requestKey,
    toolName, toolDetail, line(message.title, 200), line(message.description, 300),
    // Bind the ARRAY, never JSON.stringify — a stringified bind lands as a jsonb
    // string scalar, which is the bug this repo has shipped twice.
    rules, allowedScopes(rules),
    String(ttlMs),
   ],
  );
  const request = requestRows[0];
  // A redelivered frame updated the existing row; its prompt is already on
  // screen and must not be posted twice.
  if (!request || request.id !== requestId) return publicPermissionRequest(request);

  const messageRows = await getDb().unsafe(
   `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, message_kind, tool_name, tool_detail, permission_request_id)
      values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6, $7, $8, $9, $10) returning *`,
   [
    messageId, job.session_id, requestContent(request), threadParentId,
    String(job.agent_id || ''), job.agent_name || auth.name || auth.handle || 'Agent',
    PERMISSION_REQUEST_KIND, toolName, toolDetail, requestId,
   ],
  );
  notifyDbSubscribers('messages', 'INSERT', messageRows);
  notifyDbSubscribers('agent_permission_requests', 'INSERT', requestRows);
  return publicPermissionRequest(request);
 }

 /**
  * Add rules to an agent's permanent allowlist.
  *
  * `workspace_agents.metadata` is a wholesale jsonb write, so it is read and
  * merged here rather than patched: another key (host_folders, sandbox_skills)
  * living in the same column must survive a permission grant untouched.
  */
 async function grantPermanentRules({ workspaceId, agentId, rules, actorUserId = '' }) {
  if (!rules.length) return [];
  const agentRows = await getDb().unsafe(
   'select metadata from workspace_agents where id = $1 and workspace_id = $2 limit 1',
   [agentId, workspaceId],
  );
  if (!agentRows[0]) throw badRequest('Agent not found');
  const metadata = parseJsonObject(agentRows[0].metadata);
  const existing = Array.isArray(metadata.permission_rules) ? metadata.permission_rules.map(String) : [];
  const merged = [...existing];
  for (const rule of rules) if (!merged.includes(rule)) merged.push(rule);
  if (merged.length === existing.length) return merged;
  const updated = await getDb().unsafe(
   `update workspace_agents set metadata = $3::jsonb, updated_at = now()
      where id = $1 and workspace_id = $2 returning *`,
   [agentId, workspaceId, { ...metadata, permission_rules: merged }],
  );
  notifyDbSubscribers('workspace_agents', 'UPDATE', updated);
  // The rules NEWLY added, not the whole merged list: the audit answer to "what
  // did this grant widen" is the delta, and re-listing rules granted months ago
  // on every row would bury it. The rule strings themselves are recorded because
  // they ARE the grant — they are the exact strings the human saw on the button.
  const granted = merged.filter((rule) => !existing.includes(rule));
  await recordAudit({
   workspaceId: String(workspaceId || ''),
   actor: { userId: String(actorUserId || '') },
   action: 'agent.permission_rule_granted',
   target: { type: 'agent', id: String(agentId || ''), label: String(updated[0]?.handle || updated[0]?.name || '') },
   after: granted.join(', '),
   detail: { rules: granted, rule_count: granted.length },
  });
  return merged;
 }

 /**
  * A human answers. Returns the settled request.
  *
  * The RBAC split is the point: `write` is what already lets a member @mention
  * the agent, so it is enough to unblock the job in front of them. `manage` is
  * required to make a grant permanent, because that outlives this conversation
  * and matches the capability metadata writes already need.
  */
 async function decideAgentPermissionRequest({ userId, workspaceId, requestId, behavior, scope = 'once' } = {}) {
  const id = String(requestId || '').trim();
  if (!id) throw badRequest('requestId is required');
  const decision = String(behavior || '').trim().toLowerCase();
  if (!['allow', 'deny'].includes(decision)) throw badRequest('behavior must be allow or deny');
  const requestedScope = String(scope || 'once').trim().toLowerCase();
  if (!PERMISSION_SCOPES.has(requestedScope)) throw badRequest('scope must be once, session, or always');

  const rows = await getDb().unsafe(
   'select * from agent_permission_requests where id = $1 and workspace_id = $2 limit 1',
   [id, String(workspaceId || '')],
  );
  const request = rows[0];
  if (!request) throw Object.assign(new Error('Permission request was not found'), { status: 404 });

  // A denial is always just `write`: refusing costs nothing and must never need
  // an admin. Only a permanent ALLOW escalates.
  const permanent = decision === 'allow' && requestedScope === 'always';
  await enforceWorkspaceRole(userId, request.workspace_id, permanent ? 'manage' : 'write');
  if (permanent && !(Array.isArray(request.rules) && request.rules.length)) {
   throw badRequest('This request has no rule that can be granted permanently');
  }
  if (request.status !== 'pending') {
   throw Object.assign(new Error(`This request was already ${request.status}`), { status: 409, code: 'already_decided' });
  }

  const userRows = await getDb().unsafe('select display_name, email from app_users where id = $1 limit 1', [String(userId)]);
  const decidedByName = String(userRows[0]?.display_name || userRows[0]?.email || '').trim() || 'A workspace member';

  // Deliver BEFORE settling the row. The daemon holding the turn is the thing
  // that actually has to act on this; recording an approval we could not
  // deliver would show "Approved" under a tool call that never ran.
  const delivered = deliverDecision(request, {
   type: 'agent_permission_decision',
   requestId: request.request_key,
   behavior: decision,
   scope: requestedScope,
   decidedBy: decidedByName,
   message: decision === 'deny' ? `${decidedByName} denied this tool call.` : '',
  });
  if (!delivered) {
   throw Object.assign(
    new Error('That agent is no longer connected, so this decision could not be delivered'),
    { status: 409, code: 'agent_offline' },
   );
  }

  if (permanent) {
   await grantPermanentRules({
    workspaceId: request.workspace_id,
    agentId: request.agent_id,
    rules: request.rules.map(String),
    actorUserId: String(userId || ''),
   });
  }

  const settled = await getDb().unsafe(
   `update agent_permission_requests
      set status = $2, scope = $3, decided_by = $4, decided_by_name = $5, decided_at = now(), updated_at = now()
      where id = $1 and status = 'pending'
      returning *`,
   [request.id, decision === 'allow' ? 'allowed' : 'denied', decision === 'allow' ? requestedScope : '', String(userId), decidedByName],
  );
  if (!settled.length) throw Object.assign(new Error('This request was already decided'), { status: 409, code: 'already_decided' });
  notifyDbSubscribers('agent_permission_requests', 'UPDATE', settled);
  await rewriteAnchorMessage(settled[0]);
  return publicPermissionRequest(settled[0]);
 }

 /**
  * Keep the transcript honest once a request is settled.
  *
  * The card reads its state from the request row, but `content` is the fallback
  * every client that predates this feature renders — so a decided request must
  * not still read as an open question there.
  */
 async function rewriteAnchorMessage(request) {
  if (!request?.message_id) return;
  const verb = request.status === 'allowed'
   ? (request.scope === 'always' ? 'Always allowed' : request.scope === 'session' ? 'Allowed for this session' : 'Allowed')
   : request.status === 'expired' ? 'Expired' : 'Denied';
  const who = request.decided_by_name ? ` by ${request.decided_by_name}` : '';
  const rows = await getDb().unsafe(
   'update messages set content = $2 where id = $1 returning *',
   [request.message_id, `${verb}${who}: ${requestContent(request)}`],
  );
  if (rows.length) notifyDbSubscribers('messages', 'UPDATE', rows);
 }

 /**
  * Close out requests nobody answered.
  *
  * The daemon expires its own park independently and has already told the model
  * it was refused, so this is about the row and the card, not about the turn: a
  * prompt left "pending" forever is a button that does nothing.
  */
 async function expireStalePermissionRequests() {
  const rows = await getDb().unsafe(
   `update agent_permission_requests
      set status = 'expired', updated_at = now()
      where status = 'pending' and expires_at is not null and expires_at < now()
      returning *`,
  );
  if (!rows.length) return 0;
  notifyDbSubscribers('agent_permission_requests', 'UPDATE', rows);
  for (const row of rows) await rewriteAnchorMessage(row).catch(() => {});
  return rows.length;
 }

 /**
  * Move a reconnecting daemon's still-parked requests onto its new connection.
  *
  * A socket blip does NOT mean the daemon stopped: it keeps executing the turn
  * and reconnects ~2s later on a fresh connection id, exactly like the running
  * jobs rehomeRunningJobs already re-adopts. Before this, socket close expired
  * every pending request outright, so a request raised at 07:42:30 with ten
  * minutes of TTL was dead by 07:43:59 with eight minutes left, and the human's
  * click landed on an expired row.
  *
  * WHY THIS TAKES A LIST OF REQUEST KEYS RATHER THAN MOVING EVERYTHING.
  * "Same agent reconnected" is not the same claim as "the process still holding
  * that parked tool call is back". The register frame carries no process
  * identity, so a daemon RESTART and a daemon BLIP look identical here — and
  * re-homing blindly would point the row at a process with no memory of the
  * request. Its `decide()` drops the frame on the floor while the server has
  * already recorded "Allowed" and rewritten the transcript, which is the exact
  * "approved under a tool call that never ran" failure deliverDecision exists to
  * prevent. So the daemon has to NAME the requests it is still parked on, and
  * only those move. A daemon that re-asserts a key is, by construction, one that
  * can still act on the answer.
  *
  * Fail-closed everywhere: an unknown key matches no row, an old daemon that
  * re-asserts nothing keeps today's behaviour (everything expires), and a row
  * already decided or past its TTL is never revived.
  *
  * No realtime fanout: `connection_id` is not in publicPermissionRequest, so
  * nothing a client can see has changed — the card is still the same open
  * question it was a second ago.
  */
 async function rehomePendingPermissionRequests({ workspaceId, agentId, connectionId, requestKeys } = {}) {
  const keys = [];
  for (const entry of Array.isArray(requestKeys) ? requestKeys : []) {
   const key = String(entry == null ? '' : entry).trim();
   if (key && key.length <= MAX_RULE_LENGTH && !keys.includes(key)) keys.push(key);
   if (keys.length >= MAX_RESUMED_REQUESTS) break;
  }
  if (!workspaceId || !agentId || !connectionId || keys.length === 0) return [];
  try {
   // Scoped by workspace AND agent, so the keys a daemon asserts can only ever
   // reach rows raised by that same agent in that same workspace — the identity
   // this socket's own token proved at register. A daemon naming another agent's
   // request key matches nothing.
   return await getDb().unsafe(
    `update agent_permission_requests
       set connection_id = $1, updated_at = now()
       where workspace_id = $2 and agent_id = $3 and status = 'pending'
         and (expires_at is null or expires_at > now())
         and request_key = any($4::text[])
         and connection_id is distinct from $1
       returning *`,
    [connectionId, String(workspaceId), String(agentId), keys],
   );
  } catch {
   // The (connection_id, request_key) unique index is the only realistic
   // failure, and losing the re-home degrades to the old behaviour: the request
   // expires and the human is told so. Never the other way round.
   return [];
  }
 }

 /**
  * A disconnecting daemon's parked requests can never be answered — the process
  * that would act on the answer is gone. Called from the same place job failure
  * is handled on socket close.
  *
  * Deliberately NOT called inline on close any more: see
  * scheduleConnectionJobFailure. It runs after the reconnect grace window, or
  * immediately from a registration that has already re-homed the survivors.
  */
 async function expireConnectionPermissionRequests(connectionId) {
  const id = String(connectionId || '');
  if (!id) return 0;
  const rows = await getDb().unsafe(
   `update agent_permission_requests
      set status = 'expired', updated_at = now()
      where connection_id = $1 and status = 'pending'
      returning *`,
   [id],
  );
  if (!rows.length) return 0;
  notifyDbSubscribers('agent_permission_requests', 'UPDATE', rows);
  for (const row of rows) await rewriteAnchorMessage(row).catch(() => {});
  return rows.length;
 }

 /**
  * Set an agent's permission mode.
  *
  * Needs its OWN route because `permission_mode` is in
  * PRIVILEGED_DB_COLUMNS_BY_TABLE — the generic /backend/db/update path deletes
  * it silently, so the Agents window's radio buttons appeared to work and
  * persisted nothing. The strip is right: without it any member holding `write`
  * could flip an agent to 'yolo' and hand themselves unrestricted shell on the
  * daemon host. So this route exists at `manage`, matching the capability every
  * other widening of an agent's reach already costs.
  */
 async function setAgentPermissionMode({ userId, workspaceId, agentId, permissionMode } = {}) {
  const mode = normalizeAgentPermissionMode(permissionMode);
  // normalize maps anything unrecognised to 'default'. Silently downgrading a
  // typo'd 'yolo' to 'default' is safe, but silently ACCEPTING it as a
  // deliberate choice is not — reject what we did not understand.
  if (!['default', 'accept_edits', 'yolo'].includes(String(permissionMode || '').trim())) {
   throw badRequest('permission_mode must be default, accept_edits, or yolo');
  }
  await enforceWorkspaceRole(userId, workspaceId, 'manage');
  // The pre-update mode, read in the same statement rather than by a preceding
  // SELECT: the audit row's whole value is "from WHAT to what", and a separate
  // read could observe a different value than the one this UPDATE overwrote.
  const rows = await getDb().unsafe(
   `update workspace_agents a set permission_mode = $3, updated_at = now()
      from (select id, permission_mode from workspace_agents where id = $1 and workspace_id = $2) prev
      where a.id = prev.id
      returning a.*, prev.permission_mode as audit_previous_permission_mode`,
   [String(agentId || ''), String(workspaceId || ''), mode],
  );
  if (!rows.length) throw Object.assign(new Error('Agent was not found'), { status: 404 });
  const previousMode = String(rows[0].audit_previous_permission_mode || '');
  // The joined-in audit column must not ride the realtime fanout or land in a
  // client's agent row — it exists only for the line below.
  const publicRows = rows.map(({ audit_previous_permission_mode: _prev, ...agent }) => agent);
  notifyDbSubscribers('workspace_agents', 'UPDATE', publicRows);
  // THE highest-value row in this log. 'yolo' is unrestricted shell on whatever
  // machine the daemon runs on; PRIVILEGED_DB_COLUMNS_BY_TABLE exists so a
  // `write` holder cannot reach this column at all. When an admin legitimately
  // does it, this is the only place that records who, and when.
  await recordAudit({
   workspaceId: String(workspaceId || ''),
   actor: { userId: String(userId || '') },
   action: 'agent.permission_mode_changed',
   target: { type: 'agent', id: String(agentId || ''), label: String(rows[0].handle || rows[0].name || '') },
   before: previousMode,
   after: mode,
  });
  return mode;
 }

 /** Drop a permanent grant. Manage-only, same as making one. */
 async function revokeAgentPermissionRule({ userId, workspaceId, agentId, rule } = {}) {
  const target = line(rule, MAX_RULE_LENGTH);
  if (!target) throw badRequest('rule is required');
  await enforceWorkspaceRole(userId, workspaceId, 'manage');
  const agentRows = await getDb().unsafe(
   'select metadata from workspace_agents where id = $1 and workspace_id = $2 limit 1',
   [String(agentId || ''), String(workspaceId || '')],
  );
  if (!agentRows[0]) throw Object.assign(new Error('Agent was not found'), { status: 404 });
  const metadata = parseJsonObject(agentRows[0].metadata);
  const existing = Array.isArray(metadata.permission_rules) ? metadata.permission_rules.map(String) : [];
  const next = existing.filter((entry) => entry !== target);
  if (next.length === existing.length) return existing;
  const updated = await getDb().unsafe(
   `update workspace_agents set metadata = $3::jsonb, updated_at = now()
      where id = $1 and workspace_id = $2 returning *`,
   [String(agentId), String(workspaceId), { ...metadata, permission_rules: next }],
  );
  notifyDbSubscribers('workspace_agents', 'UPDATE', updated);
  await recordAudit({
   workspaceId: String(workspaceId || ''),
   actor: { userId: String(userId || '') },
   action: 'agent.permission_rule_revoked',
   target: { type: 'agent', id: String(agentId || ''), label: String(updated[0]?.handle || updated[0]?.name || '') },
   before: target,
   detail: { rules: [target], rule_count: 1 },
  });
  return next;
 }

 return {
  decideAgentPermissionRequest,
  expireConnectionPermissionRequests,
  expireStalePermissionRequests,
  handleAgentPermissionRequest,
  publicPermissionRequest,
  rehomePendingPermissionRequests,
  revokeAgentPermissionRule,
  setAgentPermissionMode,
  // Exported for tests: the rule/scope normalisation is the part that decides
  // what a button is allowed to grant.
  __internals: { allowedScopes, normalizeRules, requestContent },
 };
}

function mountAgentPermissionRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb,
  decideAgentPermissionRequest, revokeAgentPermissionRule, setAgentPermissionMode,
  publicPermissionRequest,
 } = deps;

 // Everything still awaiting an answer in this workspace. The card in the
 // transcript reads the row it was inserted with; this is what a badge counts.
 app.get('/backend/workspaces/:workspaceId/permission-requests', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rows = await getDb().unsafe(
    `select * from agent_permission_requests
       where workspace_id = $1 and status = 'pending' and (expires_at is null or expires_at > now())
       order by created_at desc limit 50`,
    [workspaceId],
   );
   res.json({ data: rows.map(publicPermissionRequest), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:workspaceId/permission-requests/:requestId', requireAuth, async (req, res) => {
  try {
   const request = await decideAgentPermissionRequest({
    userId: req.userId,
    workspaceId: String(req.params.workspaceId || '').trim(),
    requestId: String(req.params.requestId || '').trim(),
    behavior: req.body?.behavior,
    scope: req.body?.scope,
   });
   res.json({ data: request, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.put('/backend/workspaces/:workspaceId/agents/:agentId/permission-mode', requireAuth, async (req, res) => {
  try {
   const permissionMode = await setAgentPermissionMode({
    userId: req.userId,
    workspaceId: String(req.params.workspaceId || '').trim(),
    agentId: String(req.params.agentId || '').trim(),
    permissionMode: req.body?.permission_mode ?? req.body?.permissionMode,
   });
   res.json({ data: { permission_mode: permissionMode }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:workspaceId/agents/:agentId/permission-rules', requireAuth, async (req, res) => {
  try {
   const rules = await revokeAgentPermissionRule({
    userId: req.userId,
    workspaceId: String(req.params.workspaceId || '').trim(),
    agentId: String(req.params.agentId || '').trim(),
    rule: req.body?.rule,
   });
   res.json({ data: { rules }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = {
 PERMISSION_REQUEST_KIND,
 createAgentPermissions,
 ensureAgentPermissionsSchema,
 mountAgentPermissionRoutes,
};
