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
const {
 sessionReadableSql: canonicalSessionReadableSql,
 roleHasWorkspaceCapability: canonicalRoleHasWorkspaceCapability,
} = require('../shared/backend-core.cjs');

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
// A human decision is a two-phase command, not a best-effort websocket send:
// `allowing|denying` is the durable outbox record, then the daemon ACKs prepare
// while its tool promise is still parked, and only a post-commit `commit` frame
// may release it. These strings also appear in session-close.cjs: keep the set
// identical there so clear wins cleanly against an in-flight prepare.
const PREPARING_PERMISSION_STATUSES = new Set(['allowing', 'denying']);
const FINAL_PERMISSION_STATUSES = new Set(['allowed', 'denied']);
const DEFAULT_PREPARE_ACK_TIMEOUT_MS = 5_000;

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
    -- The transcript anchor. Nullable for legacy rows; current writes create the
    -- request and anchor atomically, so neither half can survive alone.
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
  appendSessionAccessClause,
  badRequest,
  enforceSessionRead,
  forbidden,
  enforceWorkspaceRole,
  normalizeAgentPermissionMode,
  // Deliberately NOT findConnectedAgent: a decision goes to the EXACT connection
  // that raised the request, never to "some live socket for this agent" — the
  // two-phase helpers below treat that exact connection as protocol identity.
  getConnectedAgents,
  getDb,
  notifyDbSubscribers,
  parseJsonObject,
  // Default to the canonical shared helpers. Keeping these injectable is useful
  // for focused factory tests, while the defaults prevent a second spelling of
  // either private-session access or workspace capability semantics here.
  sessionReadableSql = canonicalSessionReadableSql,
  roleHasWorkspaceCapability = canonicalRoleHasWorkspaceCapability,
  sendWs,
  prepareAckTimeoutMs = DEFAULT_PREPARE_ACK_TIMEOUT_MS,
  // The audit writer (server/index.cjs recordAudit). Never rejects. Optional so
  // the existing unit tests can construct this factory without one.
  recordAudit = async () => null,
 } = deps;

 /**
  * Authenticate a permanent-rule management call and return its audit actor.
  *
  * HTTP callers arrive with a verified user id and still pass through the
  * canonical manage-capability check. MCP's workspace credential is itself the
  * owner-level control-plane secret, so it has no user id to check; accepting it
  * requires the verified identity object, pinned to this exact workspace. Agent,
  * invite, integration, and controller identities never pass this boundary.
  */
 async function authorizePermissionRuleManagement({ userId, workspaceId, actor } = {}) {
  const targetWorkspaceId = String(workspaceId || '');
  const actorWorkspaceId = String(actor?.workspaceId || '');
  if (actorWorkspaceId && actorWorkspaceId !== targetWorkspaceId) {
   throw forbidden('The authenticated identity belongs to a different workspace');
  }
  const actorUserId = String(userId || (actor?.kind === 'user' ? actor.userId : '') || '');
  if (actorUserId) {
   await enforceWorkspaceRole(actorUserId, targetWorkspaceId, 'manage');
   return { userId: actorUserId };
  }
  if (actor?.kind === 'workspace' && actorWorkspaceId === targetWorkspaceId && targetWorkspaceId) {
   return { label: `workspace:${targetWorkspaceId}` };
  }
  throw forbidden('You do not have permission to manage this workspace');
 }

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

 // HTTP decision calls wait briefly for the daemon's prepare receipt. The map is
 // only a response rendezvous — correctness lives in the database statuses, so
 // a server restart loses no decision and reconnect replay can finish it.
 const decisionWaiters = new Map(); // request row id -> { resolve, reject, timer }

 async function lockPermissionDecisionActor({
  tx,
  workspaceId,
  userId,
  requiredCapability,
 }) {
  const workspaceAccessRows = await tx.unsafe(
   `with recursive permission_workspace_chain as (
      select id, parent_id, 0 as depth
        from workspaces
       where id = $1
      union all
      select parent.id, parent.parent_id, chain.depth + 1
        from workspaces parent
        join permission_workspace_chain chain on parent.id = chain.parent_id
       where chain.depth < 10
    ),
    permission_locked_workspaces as materialized (
      select workspace.id, workspace.user_id
        from workspaces workspace
        join permission_workspace_chain chain on chain.id = workspace.id
       for share of workspace
    ),
    permission_locked_memberships as materialized (
      select membership.workspace_id, membership.role
        from workspace_members membership
        join permission_locked_workspaces workspace
          on workspace.id = membership.workspace_id
       where membership.user_id = $2
       for share of membership
    )
    select workspace.id, workspace.user_id, membership.role
      from permission_locked_workspaces workspace
      left join permission_locked_memberships membership
        on membership.workspace_id = workspace.id`,
   [workspaceId, String(userId)],
  );
  const currentRoles = new Set();
  for (const row of workspaceAccessRows) {
   if (String(row.user_id || '') === String(userId)) currentRoles.add('owner');
   if (row.role) currentRoles.add(String(row.role));
  }
  if (![...currentRoles].some((role) =>
   roleHasWorkspaceCapability(role, requiredCapability))) {
   throw forbidden('Workspace access changed before this permission decision completed');
  }
 }

 function exactPermissionConnection(row, expectedWs = null) {
  const exact = getConnectedAgents().get(String(row?.connection_id || ''));
  if (!exact
   || exact.ws?.readyState !== 1
   || String(exact.agentId || '') !== String(row?.agent_id || '')
   || String(exact.workspaceId || '') !== String(row?.workspace_id || '')
   || (expectedWs && exact.ws !== expectedWs)) return null;
  return exact;
 }

 function connectionSupportsDecisionReceipts(connection) {
  return connection?.metadata?.permissionDecisionReceipts === true;
 }

 function permissionPrepareFrame(row) {
  const allowing = row.status === 'allowing';
  return {
   type: 'agent_permission_prepare',
   requestId: String(row.request_key || ''),
   behavior: allowing ? 'allow' : 'deny',
   scope: allowing ? String(row.scope || 'once') : '',
   decidedBy: String(row.decided_by_name || ''),
   message: allowing ? '' : `${String(row.decided_by_name || 'The workspace')} denied this tool call.`,
  };
 }

 function permissionCommitFrame(row) {
  return {
   type: 'agent_permission_commit',
   requestId: String(row.request_key || ''),
  };
 }

 function permissionAbortFrame(row, message) {
  return {
   type: 'agent_permission_abort',
   requestId: String(row.request_key || ''),
   message: String(message || 'This permission request can no longer be approved.'),
  };
 }

 function sendExactPermissionFrame(row, frame, { expectedWs = null, requireReceipts = true } = {}) {
  const exact = exactPermissionConnection(row, expectedWs);
  if (!exact || (requireReceipts && !connectionSupportsDecisionReceipts(exact))) return false;
  return sendWs(exact.ws, frame);
 }

 function sendPermissionAbort(row, message, { expectedWs = null } = {}) {
  const exact = exactPermissionConnection(row, expectedWs);
  if (!exact) return false;
  // Receipt-capable daemons may already have cached an ALLOW prepare. Their
  // legacy decision handler intentionally refuses to replace that decision, so
  // only the explicit abort frame can release the parked promise safely. Older
  // daemons never received PREPARE and retain the one-frame denial fallback.
  if (connectionSupportsDecisionReceipts(exact)) {
   return sendWs(exact.ws, permissionAbortFrame(row, message));
  }
  return sendWs(exact.ws, {
   type: 'agent_permission_decision',
   requestId: String(row.request_key || ''),
   behavior: 'deny',
   message: String(message || 'This permission request can no longer be approved.'),
  });
 }

 function createDecisionWaiter(requestId) {
  const key = String(requestId || '');
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
   resolvePromise = resolve;
   rejectPromise = reject;
  });
  const timer = setTimeout(() => {
   const current = decisionWaiters.get(key);
   if (!current || current.promise !== promise) return;
   decisionWaiters.delete(key);
   current.reject(Object.assign(
    new Error('The decision was saved, but the agent has not acknowledged it yet'),
    { status: 409, code: 'permission_prepare_pending' },
   ));
  }, Math.max(100, Number(prepareAckTimeoutMs) || DEFAULT_PREPARE_ACK_TIMEOUT_MS));
  timer.unref?.();
  const entry = { promise, timer, resolve: resolvePromise, reject: rejectPromise };
  decisionWaiters.set(key, entry);
  return entry;
 }

 function settleDecisionWaiter(requestId, error, row = null) {
  const key = String(requestId || '');
  const waiter = decisionWaiters.get(key);
  if (!waiter) return false;
  decisionWaiters.delete(key);
  clearTimeout(waiter.timer);
  if (error) waiter.reject(error);
  else waiter.resolve(row);
  return true;
 }

 function permissionScopeChanged() {
  return Object.assign(
   new Error('This permission request is no longer attached to an active conversation turn'),
   { status: 409, code: 'permission_scope_changed' },
  );
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
  if (requestKey.length > MAX_RULE_LENGTH) throw badRequest('requestId is too long');

  const deny = (reason) => {
   sendWs(ws, { type: 'agent_permission_decision', requestId: requestKey, behavior: 'deny', message: reason });
  };
  if (!jobId) {
   deny('This tool call is not attached to a job, so nobody can be asked about it.');
   return null;
  }

  const rules = normalizeRules(message.rules);
  const toolName = line(message.toolName, 60);
  const toolDetail = line(message.detail ?? message.toolDetail, 160);
  const ttlMs = Math.min(
   MAX_REQUEST_TTL_MS,
   Math.max(30_000, Number(message.expiresInMs) || DEFAULT_REQUEST_TTL_MS),
  );

  // The job proof, request row, and transcript anchor are one transaction. The
  // live session is locked before either insert, so clear cannot close it in the
  // gap and leave a pending row whose card never existed. Conversely, if clear
  // already won, the proof returns no row and nothing is parked.
  const outcome = await getDb().begin(async (tx) => {
   const rows = await tx.unsafe(
    `select j.*, a.name as agent_name, a.handle as agent_handle
       from agent_jobs j
       join chat_sessions s
         on s.id = j.session_id
        and s.workspace_id = j.workspace_id
        and s.deleted_at is null
       join workspace_agents a
         on a.id = j.agent_id
        and a.workspace_id = j.workspace_id
        and a.enabled is true
      where j.id = $1
        and j.agent_id = $2
        and j.workspace_id = $3
        and j.connection_id = $4
        and j.status = 'running'
        and exists (
          select 1
            from jsonb_array_elements(
              case when jsonb_typeof(s.participants) = 'array'
                   then s.participants else '[]'::jsonb end
            ) participant
           where participant->>'agent_id' = a.id::text
        )
      limit 1
      for update of j, s, a`,
    [jobId, auth.agentId, auth.workspaceId, ws.agentConnectionId],
   );
   const job = rows[0];
   if (!job) {
    // Explain a failed present-tense proof without letting the diagnostic read
    // authorize anything. Another agent/workspace remains indistinguishable
    // from a missing job; a known but no-longer-runnable job gets an immediate
    // denial down the socket instead of a generic websocket error.
    const diagnosticRows = await tx.unsafe(
     `select session_id, status from agent_jobs
        where id = $1 and agent_id = $2 and workspace_id = $3 limit 1`,
     [jobId, auth.agentId, auth.workspaceId],
    );
    const diagnostic = diagnosticRows[0];
    if (!diagnostic) throw forbidden('Agent job not found');
    return {
     denyReason: !diagnostic.session_id
      ? 'This job runs outside a conversation, so there is nowhere to ask for approval.'
      : diagnostic.status !== 'running'
       ? 'The job had already finished before this could be approved.'
       : 'This job is no longer active in that conversation, so the tool call was denied.',
    };
   }

   const metadata = parseJsonObject(job.metadata);
   const responseMessageId = metadata.responseMessageId || null;
   // Same resolution as handleAgentJobStep, and for the same reason: existence
   // and parentage are ONE question, because a stale id answered "no parent"
   // identically to a missing row and was written into a foreign key.
   let threadParentId = null;
   if (responseMessageId) {
    const parentRows = await tx.unsafe(
     'select thread_parent_id from messages where id = $1 and session_id = $2 and deleted_at is null limit 1',
     [responseMessageId, job.session_id],
    );
    if (parentRows[0]) threadParentId = parentRows[0].thread_parent_id || responseMessageId;
   }

   const requestId = crypto.randomUUID();
   const messageId = crypto.randomUUID();
   const requestRows = await tx.unsafe(
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
   if (!request || request.id !== requestId) {
    return { request, requestRows: [], messageRows: [] };
   }

   const messageRows = await tx.unsafe(
    `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, message_kind, tool_name, tool_detail, permission_request_id)
       values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6, $7, $8, $9, $10) returning *`,
    [
     messageId, job.session_id, requestContent(request), threadParentId,
     String(job.agent_id || ''), job.agent_name || auth.name || auth.handle || 'Agent',
     PERMISSION_REQUEST_KIND, toolName, toolDetail, requestId,
    ],
   );
   if (messageRows.length !== 1) {
    throw new Error('Permission request anchor message was not created');
   }
   return { request, requestRows, messageRows };
  });
  if (outcome.denyReason) {
   deny(outcome.denyReason);
   return null;
  }
  // Realtime only after commit. Broadcasting either half from inside the
  // transaction would let a client observe a card whose companion row can
  // still roll back.
  if (outcome.messageRows.length) notifyDbSubscribers('messages', 'INSERT', outcome.messageRows);
  if (outcome.requestRows.length) notifyDbSubscribers('agent_permission_requests', 'INSERT', outcome.requestRows);
  return publicPermissionRequest(outcome.request);
 }

 /**
  * Add rules to an agent's permanent allowlist.
  *
  * `workspace_agents.metadata` is a wholesale jsonb write, so it is read and
  * merged here rather than patched: another key (host_folders, sandbox_skills)
  * living in the same column must survive a permission grant untouched.
  */
 async function grantPermanentRulesLocked({ tx, agent, rules }) {
  if (!rules.length) return { rows: [], granted: [] };
  const metadata = parseJsonObject(agent.metadata);
  const existing = Array.isArray(metadata.permission_rules) ? metadata.permission_rules.map(String) : [];
  const merged = [...existing];
  for (const rule of rules) if (!merged.includes(rule)) merged.push(rule);
  if (merged.length === existing.length) return { rows: [], granted: [] };
  const updated = await tx.unsafe(
   `update workspace_agents set metadata = $3::jsonb, updated_at = now()
      where id = $1 and workspace_id = $2 and enabled is true returning *`,
   [agent.id, agent.workspace_id, { ...metadata, permission_rules: merged }],
  );
  if (updated.length !== 1) {
   throw Object.assign(new Error('The agent is no longer available for this permission grant'), {
    status: 409,
    code: 'permission_scope_changed',
   });
  }
  // Returned to the caller for fanout and audit only AFTER the transaction
  // commits. Publishing here would expose a permanent grant that can still roll
  // back if the request settlement fails.
  const granted = merged.filter((rule) => !existing.includes(rule));
  return { rows: updated, granted };
 }

 /**
  * Pending requests this human may actually answer.
  *
  * Workspace `read` remains the first gate. The shared session clause is the
  * second: a workspace-wide list must remove requests parked inside private
  * conversations the caller does not belong to.
  */
 async function listAgentPermissionRequests({ userId, workspaceId } = {}) {
  const targetWorkspaceId = String(workspaceId || '').trim();
  if (!targetWorkspaceId) throw badRequest('workspace id is required');
  await enforceWorkspaceRole(userId, targetWorkspaceId, 'read');
  const where = appendSessionAccessClause(
   {
    clause: ` WHERE "agent_permission_requests"."workspace_id" = $1
       AND "agent_permission_requests"."status" = 'pending'
       AND ("agent_permission_requests"."expires_at" IS NULL OR "agent_permission_requests"."expires_at" > now())`,
    params: [targetWorkspaceId],
   },
   String(userId || ''),
   'agent_permission_requests',
  );
  const rows = await getDb().unsafe(
   `select * from agent_permission_requests${where.clause}
      order by created_at desc limit 50`,
   where.params,
  );
  return rows.map(publicPermissionRequest);
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
  await enforceSessionRead(userId, request.session_id);
  if (permanent && !(Array.isArray(request.rules) && request.rules.length)) {
   throw badRequest('This request has no rule that can be granted permanently');
  }
  if (request.status !== 'pending') {
   throw Object.assign(new Error(`This request was already ${request.status}`), { status: 409, code: 'already_decided' });
  }

  const userRows = await getDb().unsafe('select display_name, email from app_users where id = $1 limit 1', [String(userId)]);
  const decidedByName = String(userRows[0]?.display_name || userRows[0]?.email || '').trim() || 'A workspace member';

  const requiredCapability = permanent ? 'manage' : 'write';
  const initialConnection = exactPermissionConnection(request);
  if (!initialConnection) {
   throw Object.assign(
    new Error('That agent is no longer connected, so this decision could not be delivered'),
    { status: 409, code: 'agent_offline' },
   );
  }
  if (!connectionSupportsDecisionReceipts(initialConnection)) {
   throw Object.assign(
    new Error('That agent must be updated before it can receive durable permission decisions'),
    { status: 409, code: 'permission_receipt_unsupported' },
   );
  }

  // Global closure order begins with workspace lineage, then session -> job ->
  // permission request (see server/sessions-routes.cjs and
  // shared/session-close.cjs). Use that same order here so a clear/revoke and a
  // click cannot deadlock, and so exactly one can win. This transaction records
  // only an INTERIM outbox state; no websocket frame and no permanent grant can
  // happen until that durable intent commits.
  //
  //   clear/revoke wins a scope lock -> the fresh authorization proof fails and
  //   this path sends nothing;
  //   decision wins every scope lock -> its interim outbox state commits first;
  //   clear/revoke may then win phase two, which aborts rather than releasing a
  //   stale allow to the daemon.
  //
  // The agent row sits between session and job only to serialize disable/grant;
  // session closure never locks it, so it introduces no inverse edge.
  const outcome = await getDb().begin(async (tx) => {
   // The friendly preflight above is stale the instant it returns. Lock the
   // entire current -> ancestor lineage and every membership row for THIS human,
   // then derive the effective capability from those locked rows using the
   // canonical capability table. A direct role revoke, ancestor-role revoke,
   // owner transfer, or workspace reparent therefore either commits before this
   // proof and is observed, or waits until the decision transaction commits.
   await lockPermissionDecisionActor({
    tx,
    workspaceId: request.workspace_id,
    userId,
    requiredCapability,
   });

   const sessionRows = await tx.unsafe(
    `select s.id, s.workspace_id
       from chat_sessions s
      where s.id = $1
        and s.workspace_id = $2
        and s.deleted_at is null
        and exists (
          select 1
            from jsonb_array_elements(
              case when jsonb_typeof(s.participants) = 'array'
                   then s.participants else '[]'::jsonb end
            ) participant
           where participant->>'agent_id' = $3
        )
        and ${sessionReadableSql('s', '$4', { lockMembership: true })}
      for update of s`,
    [request.session_id, request.workspace_id, String(request.agent_id), String(userId)],
   );
   if (sessionRows.length !== 1) throw permissionScopeChanged();

   const agentRows = await tx.unsafe(
    `select id, workspace_id, name, handle, metadata
       from workspace_agents
      where id = $1 and workspace_id = $2 and enabled is true
      for update`,
    [request.agent_id, request.workspace_id],
   );
   const currentAgent = agentRows[0];
   if (!currentAgent) throw permissionScopeChanged();

   const jobRows = await tx.unsafe(
    `select id, workspace_id, agent_id, session_id, connection_id, status
       from agent_jobs
      where id = $1
        and workspace_id = $2
        and agent_id = $3
        and session_id = $4
        and connection_id = $5
        and status = 'running'
      for update`,
    [request.job_id, request.workspace_id, request.agent_id, request.session_id, request.connection_id],
   );
   const currentJob = jobRows[0];
   if (!currentJob) throw permissionScopeChanged();

   const currentRows = await tx.unsafe(
    `select *, (expires_at is not null and expires_at <= now()) as request_expired
       from agent_permission_requests
      where id = $1 and workspace_id = $2
      for update`,
    [request.id, request.workspace_id],
   );
   const current = currentRows[0];
   if (!current) throw Object.assign(new Error('Permission request was not found'), { status: 404 });
   if (current.status !== 'pending') {
    throw Object.assign(new Error(`This request was already ${current.status}`), { status: 409, code: 'already_decided' });
   }
   if (current.request_expired) {
    throw Object.assign(new Error('This permission request has expired'), { status: 409, code: 'already_decided' });
   }
   if (String(current.job_id || '') !== String(currentJob.id)
    || String(current.session_id || '') !== String(request.session_id)
    || String(current.agent_id || '') !== String(currentAgent.id)
    || String(current.connection_id || '') !== String(currentJob.connection_id)) {
    throw permissionScopeChanged();
   }

   const preparing = await tx.unsafe(
    `update agent_permission_requests
       set status = $2, scope = $3, decided_by = $4, decided_by_name = $5, decided_at = now(), updated_at = now()
       where id = $1
         and status = 'pending'
         and job_id = $6
         and session_id = $7
         and agent_id = $8
         and connection_id = $9
       returning *`,
    [
     current.id,
     decision === 'allow' ? 'allowing' : 'denying',
     decision === 'allow' ? requestedScope : '',
     String(userId),
     decidedByName,
     currentJob.id,
     request.session_id,
     currentAgent.id,
     currentJob.connection_id,
    ],
   );
   if (preparing.length !== 1) {
    throw Object.assign(new Error('This request was already decided'), { status: 409, code: 'already_decided' });
   }
   return preparing[0];
  });

  // Register the waiter BEFORE send: a loopback test daemon can receipt the
  // prepare in the same event-loop turn. The daemon remains parked after that
  // receipt; handleAgentPermissionPrepared commits the final row and only then
  // sends the release frame.
  const waiter = createDecisionWaiter(outcome.id);
  if (!sendExactPermissionFrame(outcome, permissionPrepareFrame(outcome))) {
   const error = Object.assign(
    new Error('The decision was saved for delivery, but that agent is no longer connected'),
    { status: 409, code: 'permission_prepare_pending' },
   );
   settleDecisionWaiter(outcome.id, error);
   throw error;
  }
  const settled = await waiter.promise;
  return publicPermissionRequest(settled);
 }

 async function publishFinalPermissionDecision({ request, grant }) {
  if (grant.rows.length) notifyDbSubscribers('workspace_agents', 'UPDATE', grant.rows);
  notifyDbSubscribers('agent_permission_requests', 'UPDATE', [request]);
  if (grant.granted.length) {
   const agentRow = grant.rows[0];
   await recordAudit({
    workspaceId: String(request.workspace_id || ''),
    actor: { userId: String(request.decided_by || '') },
    action: 'agent.permission_rule_granted',
    target: {
     type: 'agent',
     id: String(request.agent_id || ''),
     label: String(agentRow?.handle || agentRow?.name || ''),
    },
    after: grant.granted.join(', '),
    detail: { rules: grant.granted, rule_count: grant.granted.length },
   });
  }
  await rewriteAnchorMessage(request).catch(() => {});
 }

 /**
  * The daemon accepted a PREPARE while the tool promise is still parked.
  *
  * Payload identity is deliberately tiny: the request key. Agent/workspace and
  * connection come from the authenticated socket, then every one is matched
  * again against the durable row and the still-running job. The daemon does not
  * get to echo behavior/scope back and thereby change what the human chose.
  */
 async function handleAgentPermissionPrepared(ws, message = {}) {
  const auth = ws?.agentAuth;
  const connectionId = String(ws?.agentConnectionId || '');
  const requestKey = String(message.requestId || '').trim();
  if (!auth || !connectionId || !requestKey || requestKey.length > MAX_RULE_LENGTH) return false;

  const connectionShape = {
   connection_id: connectionId,
   agent_id: String(auth.agentId || ''),
   workspace_id: String(auth.workspaceId || ''),
  };
  const exact = exactPermissionConnection(connectionShape, ws);
  if (!exact || !connectionSupportsDecisionReceipts(exact)) return false;

  const rows = await getDb().unsafe(
   `select * from agent_permission_requests
      where request_key = $1
        and connection_id = $2
        and workspace_id = $3
        and agent_id = $4
      limit 1`,
   [requestKey, connectionId, String(auth.workspaceId || ''), String(auth.agentId || '')],
  );
  const snapshot = rows[0];
  if (!snapshot) return false;

  // Duplicate receipts are idempotent. A final row means the first receipt was
  // committed but its release frame may have been lost; replay the release on
  // this same authenticated connection and do nothing else.
  if (FINAL_PERMISSION_STATUSES.has(snapshot.status)) {
   sendExactPermissionFrame(snapshot, permissionCommitFrame(snapshot), { expectedWs: ws });
   settleDecisionWaiter(snapshot.id, null, snapshot);
   return true;
  }

  if (message.accepted !== true) {
   const expired = await getDb().unsafe(
    `update agent_permission_requests
        set status = 'expired', updated_at = now()
      where id = $1
        and connection_id = $2
        and status in ('allowing', 'denying')
      returning *`,
    [snapshot.id, connectionId],
   );
   const error = Object.assign(
    new Error('The agent no longer holds this permission request'),
    { status: 409, code: 'permission_prepare_rejected' },
   );
   settleDecisionWaiter(snapshot.id, error);
   if (expired.length) {
    notifyDbSubscribers('agent_permission_requests', 'UPDATE', expired);
    await rewriteAnchorMessage(expired[0]).catch(() => {});
   }
   return false;
  }
  if (!PREPARING_PERMISSION_STATUSES.has(snapshot.status)) {
   const error = permissionScopeChanged();
   settleDecisionWaiter(snapshot.id, error);
   sendPermissionAbort(
    snapshot,
    'The conversation changed before this permission decision completed.',
    { expectedWs: ws },
   );
   return false;
  }

  try {
   // Same clear-compatible order and same actor proof as phase one: workspace
   // lineage -> session/private membership -> agent -> job -> request. PREPARE
   // parks the daemon; it does not release authority. A role or private-member
   // revoke that commits before this final transaction must therefore win and
   // abort the parked allow before the tool (or permanent grant) is released.
   const outcome = await getDb().begin(async (tx) => {
    const decisionUserId = String(snapshot.decided_by || '');
    const requiredCapability = snapshot.status === 'allowing' && snapshot.scope === 'always'
     ? 'manage'
     : 'write';
    if (!decisionUserId) throw permissionScopeChanged();
    await lockPermissionDecisionActor({
     tx,
     workspaceId: snapshot.workspace_id,
     userId: decisionUserId,
     requiredCapability,
    });

    const sessionRows = await tx.unsafe(
     `select s.id, s.workspace_id
        from chat_sessions s
       where s.id = $1
         and s.workspace_id = $2
         and s.deleted_at is null
         and exists (
           select 1
             from jsonb_array_elements(
               case when jsonb_typeof(s.participants) = 'array'
                    then s.participants else '[]'::jsonb end
             ) participant
            where participant->>'agent_id' = $3
         )
         and ${sessionReadableSql('s', '$4', { lockMembership: true })}
       for update of s`,
     [
      snapshot.session_id,
      snapshot.workspace_id,
      String(snapshot.agent_id),
      decisionUserId,
     ],
    );
    if (sessionRows.length !== 1) throw permissionScopeChanged();

    const agentRows = await tx.unsafe(
     `select id, workspace_id, name, handle, metadata
        from workspace_agents
       where id = $1 and workspace_id = $2 and enabled is true
       for update`,
     [snapshot.agent_id, snapshot.workspace_id],
    );
    const currentAgent = agentRows[0];
    if (!currentAgent) throw permissionScopeChanged();

    const jobRows = await tx.unsafe(
     `select id, workspace_id, agent_id, session_id, connection_id, status
        from agent_jobs
       where id = $1
         and workspace_id = $2
         and agent_id = $3
         and session_id = $4
         and connection_id = $5
         and status = 'running'
       for update`,
     [snapshot.job_id, snapshot.workspace_id, snapshot.agent_id, snapshot.session_id, connectionId],
    );
    const currentJob = jobRows[0];
    if (!currentJob) throw permissionScopeChanged();

    const currentRows = await tx.unsafe(
     `select * from agent_permission_requests
        where id = $1 and workspace_id = $2
        for update`,
     [snapshot.id, snapshot.workspace_id],
    );
    const current = currentRows[0];
    if (!current
     || String(current.request_key || '') !== requestKey
     || String(current.job_id || '') !== String(currentJob.id)
     || String(current.session_id || '') !== String(snapshot.session_id)
     || String(current.agent_id || '') !== String(currentAgent.id)
     || String(current.connection_id || '') !== connectionId) {
     throw permissionScopeChanged();
    }
    // Two receipts can be in flight when the daemon retries a receipt whose
    // socket write looked lost. If the other receipt finalized while this one
    // waited on the row lock, replay COMMIT; never turn that harmless duplicate
    // into an ABORT that could race ahead of the first handler's commit frame.
    if (FINAL_PERMISSION_STATUSES.has(current.status)) {
     return { request: current, grant: { rows: [], granted: [] }, duplicate: true };
    }
    if (!PREPARING_PERMISSION_STATUSES.has(current.status)) throw permissionScopeChanged();

    const permanent = current.status === 'allowing' && current.scope === 'always';
    const grant = permanent
     ? await grantPermanentRulesLocked({
       tx,
       agent: currentAgent,
       rules: Array.isArray(current.rules) ? current.rules.map(String) : [],
      })
     : { rows: [], granted: [] };

    const finalStatus = current.status === 'allowing' ? 'allowed' : 'denied';
    const settled = await tx.unsafe(
     `update agent_permission_requests
         set status = $2, updated_at = now()
       where id = $1
         and status = $3
         and job_id = $4
         and session_id = $5
         and agent_id = $6
         and connection_id = $7
       returning *`,
     [
      current.id,
      finalStatus,
      current.status,
      currentJob.id,
      current.session_id,
      currentAgent.id,
      connectionId,
     ],
    );
    if (settled.length !== 1) throw permissionScopeChanged();
    return { request: settled[0], grant, duplicate: false };
   });

   // Commit is the ONLY frame that releases the daemon's parked tool promise.
   // It is sent strictly after the final row (and any permanent grant) commits.
   // If this socket vanished, the daemon still has the prepared promise and its
   // reconnect assertion lets replayPermissionDecisions send the commit later.
   sendExactPermissionFrame(outcome.request, permissionCommitFrame(outcome.request), { expectedWs: ws });
   if (!outcome.duplicate) await publishFinalPermissionDecision(outcome);
   settleDecisionWaiter(outcome.request.id, null, outcome.request);
   return true;
  } catch (error) {
   // A clear/disable/cancel that won phase two must unpark the daemon safely.
   // This MUST be the explicit abort frame: once a daemon has cached PREPARE it
   // rejects legacy decisions, because letting one overwrite a prepared ALLOW
   // would make COMMIT ambiguous.
   let abortRow = snapshot;
   try {
    const expired = await getDb().unsafe(
     `update agent_permission_requests
         set status = 'expired', updated_at = now()
       where id = $1
         and connection_id = $2
         and status in ('allowing', 'denying')
       returning *`,
     [snapshot.id, connectionId],
    );
    if (expired.length) {
     [abortRow] = expired;
     notifyDbSubscribers('agent_permission_requests', 'UPDATE', expired);
     await rewriteAnchorMessage(abortRow).catch(() => {});
    }
   } catch {
    // The abort itself is still valuable when the database failure that caused
    // phase two also prevents cleanup. The durable interim row remains an
    // outbox for reconnect and the stale sweep will close it later.
   }
   sendPermissionAbort(
    abortRow,
    'The conversation changed before this permission decision completed.',
    { expectedWs: ws },
   );
   settleDecisionWaiter(snapshot.id, error);
   return false;
  }
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
  * The daemon owns an independent deadline too, but a human decision may already
  * be prepared there. Expiring all open phases and sending ABORT closes both
  * sources of truth; a prompt left open forever is a button that does nothing.
  */
 async function expireStalePermissionRequests() {
  const rows = await getDb().unsafe(
   `update agent_permission_requests
      set status = 'expired', updated_at = now()
      where status in ('pending', 'allowing', 'denying')
        and expires_at is not null
        and expires_at < now()
      returning *`,
  );
  if (!rows.length) return 0;
  notifyDbSubscribers('agent_permission_requests', 'UPDATE', rows);
  for (const row of rows) {
   settleDecisionWaiter(row.id, permissionScopeChanged());
   sendPermissionAbort(row, 'This permission request expired before it could be completed.');
   await rewriteAnchorMessage(row).catch(() => {});
  }
  return rows.length;
 }

 /**
  * Replay the durable permission outbox after a socket BLIP.
  *
  * The daemon names only request keys whose promises this SAME process still
  * holds. rehomePendingPermissionRequests moves exactly those rows onto the new
  * connection, then this resumes the phase indicated by durable status:
  * preparing -> re-send prepare; final -> re-send commit. A restarted daemon
  * asserts no keys and therefore receives neither.
  */
 async function replayPermissionDecisions(ws, rows) {
  let sent = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
   if (String(row.connection_id || '') !== String(ws?.agentConnectionId || '')
    || String(row.agent_id || '') !== String(ws?.agentAuth?.agentId || '')
    || String(row.workspace_id || '') !== String(ws?.agentAuth?.workspaceId || '')) continue;

   if (PREPARING_PERMISSION_STATUSES.has(row.status)) {
    if (sendExactPermissionFrame(row, permissionPrepareFrame(row), { expectedWs: ws })) sent += 1;
    continue;
   }
   if (!FINAL_PERMISSION_STATUSES.has(row.status)) continue;

   if (sendExactPermissionFrame(row, permissionCommitFrame(row), { expectedWs: ws })) sent += 1;
   // Recover the narrow server-crash gap after final commit but before the UI
   // side effects. Rewriting is idempotent; a duplicate UPDATE is preferable to
   // a transcript that forever says the already-decided request is pending.
   notifyDbSubscribers('agent_permission_requests', 'UPDATE', [row]);
   await rewriteAnchorMessage(row).catch(() => {});
  }
  return sent;
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
  * "approved under a tool call that never ran" failure the receipt protocol
  * prevents. So the daemon has to NAME the requests it is still parked on, and
  * only those move. A daemon that re-asserts a key is, by construction, one that
  * can still act on the answer.
  *
  * Fail-closed everywhere: an unknown key matches no row and an old/restarted
  * daemon that re-asserts nothing keeps today's behaviour (everything open
  * expires). Preparing/final rows are included ONLY when this process names
  * their key, which is the proof needed to replay their prepare/commit phase.
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
       where workspace_id = $2
         and agent_id = $3
         and status in ('pending', 'allowing', 'denying', 'allowed', 'denied')
         and (status <> 'pending' or expires_at is null or expires_at > now())
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
      where connection_id = $1 and status in ('pending', 'allowing', 'denying')
      returning *`,
   [id],
  );
  if (!rows.length) return 0;
  notifyDbSubscribers('agent_permission_requests', 'UPDATE', rows);
  for (const row of rows) {
   settleDecisionWaiter(row.id, permissionScopeChanged());
   sendPermissionAbort(row, 'The agent disconnected before this permission decision completed.');
   await rewriteAnchorMessage(row).catch(() => {});
  }
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
 async function revokeAgentPermissionRule({ userId, workspaceId, agentId, rule, actor } = {}) {
  const target = line(rule, MAX_RULE_LENGTH);
  if (!target) throw badRequest('rule is required');
  const auditActor = await authorizePermissionRuleManagement({ userId, workspaceId, actor });
  // `metadata` is one jsonb document shared with host_folders, sandbox_skills,
  // identity hints and permanent permission grants. Read/merge/write without a
  // row lock loses whichever concurrent change commits first. Permanent grants
  // already take this same agent lock in grantPermanentRulesLocked's caller;
  // revocation must join that serialization point rather than racing it.
  //
  // The same lock also orders revocation against the two-phase approval path.
  // PREPARE deliberately does not write the permanent rule, so "the rule is not
  // in metadata" is NOT a no-op while an `allowing/always` request is parked.
  // Expire matching prepared grants under this lock. Whichever transaction wins
  // has a complete result: either finalization adds the rule first and this
  // transaction removes it, or this transaction expires the request and the
  // later receipt can only receive ABORT.
  const outcome = await getDb().begin(async (tx) => {
   const agentRows = await tx.unsafe(
    `select id, workspace_id, name, handle, metadata
       from workspace_agents
      where id = $1 and workspace_id = $2
      for update`,
    [String(agentId || ''), String(workspaceId || '')],
   );
   const agent = agentRows[0];
   if (!agent) throw Object.assign(new Error('Agent was not found'), { status: 404 });
   const metadata = parseJsonObject(agent.metadata);
   const existing = Array.isArray(metadata.permission_rules) ? metadata.permission_rules.map(String) : [];
   const next = existing.filter((entry) => entry !== target);
   const cancelled = await tx.unsafe(
    `update agent_permission_requests
        set status = 'expired', updated_at = now()
      where workspace_id = $1
        and agent_id = $2
        and status = 'allowing'
        and scope = 'always'
        and exists (
          select 1
            from jsonb_array_elements_text(
              case when jsonb_typeof(rules) = 'array' then rules else '[]'::jsonb end
            ) pending_rule
           where pending_rule = $3
        )
      returning *`,
    [String(workspaceId), String(agentId), target],
   );
   let updated = [];
   if (next.length !== existing.length) {
    updated = await tx.unsafe(
     `update workspace_agents set metadata = $3::jsonb, updated_at = now()
        where id = $1 and workspace_id = $2 returning *`,
     [String(agentId), String(workspaceId), { ...metadata, permission_rules: next }],
    );
    if (updated.length !== 1) {
     throw Object.assign(new Error('The agent changed before the permission rule could be revoked'), {
      status: 409,
      code: 'permission_scope_changed',
     });
    }
   }
   return {
    changed: updated.length > 0 || cancelled.length > 0,
    rules: next,
    rows: updated,
    cancelled,
   };
  });
  if (!outcome.changed) return outcome.rules;
  if (outcome.rows.length > 0) notifyDbSubscribers('workspace_agents', 'UPDATE', outcome.rows);
  if (outcome.cancelled.length > 0) {
   notifyDbSubscribers('agent_permission_requests', 'UPDATE', outcome.cancelled);
   for (const request of outcome.cancelled) {
    settleDecisionWaiter(request.id, permissionScopeChanged());
    sendPermissionAbort(
     request,
     'This permission rule was revoked before the permanent grant completed.',
    );
    await rewriteAnchorMessage(request).catch(() => {});
   }
  }
  await recordAudit({
   workspaceId: String(workspaceId || ''),
   actor: auditActor,
   action: 'agent.permission_rule_revoked',
   target: {
    type: 'agent',
    id: String(agentId || ''),
    label: String(outcome.rows[0]?.handle || outcome.rows[0]?.name || agentId || ''),
   },
   before: target,
   detail: { rules: [target], rule_count: 1 },
  });
  return outcome.rules;
 }

 /**
  * Manually grant a permanent permission rule.
  * Manage-only, same capability as making one via the approval card.
  */
 async function grantAgentPermissionRule({ userId, workspaceId, agentId, rule, actor } = {}) {
  const target = line(rule, MAX_RULE_LENGTH);
  if (!target) throw badRequest('rule is required');
  const auditActor = await authorizePermissionRuleManagement({ userId, workspaceId, actor });
  const outcome = await getDb().begin(async (tx) => {
   const agentRows = await tx.unsafe(
    `select id, workspace_id, name, handle, metadata
       from workspace_agents
      where id = $1 and workspace_id = $2
      for update`,
    [String(agentId || ''), String(workspaceId || '')],
   );
   const agent = agentRows[0];
   if (!agent) throw Object.assign(new Error('Agent was not found'), { status: 404 });
   const metadata = parseJsonObject(agent.metadata);
   const existing = Array.isArray(metadata.permission_rules) ? metadata.permission_rules.map(String) : [];
   // If the rule already exists, return current list
   if (existing.includes(target)) {
    return { rows: [agent], rules: existing, added: false };
   }
   const next = [...existing, target];
   const updated = await tx.unsafe(
    `update workspace_agents set metadata = $3::jsonb, updated_at = now()
       where id = $1 and workspace_id = $2 returning *`,
    [String(agentId), String(workspaceId), { ...metadata, permission_rules: next }],
   );
   if (updated.length !== 1) {
    throw Object.assign(new Error('The agent changed before the permission rule could be added'), {
     status: 409,
     code: 'permission_scope_changed',
    });
   }
   return { rows: updated, rules: next, added: true };
  });
  if (outcome.rows.length) {
   notifyDbSubscribers('workspace_agents', 'UPDATE', outcome.rows);
  }
  if (outcome.added) {
   await recordAudit({
    workspaceId: String(workspaceId || ''),
    actor: auditActor,
    action: 'agent.permission_rule_granted',
    target: {
     type: 'agent',
     id: String(agentId || ''),
     label: String(outcome.rows[0]?.handle || outcome.rows[0]?.name || agentId || ''),
    },
    after: target,
    detail: { rules: [target], rule_count: 1 },
   });
  }
  return outcome.rules;
 }

 /** Read an agent's standing permission rules. Manage-only, like mutations. */
 async function listAgentPermissionRules({ userId, workspaceId, agentId, actor } = {}) {
  await authorizePermissionRuleManagement({ userId, workspaceId, actor });
  const rows = await getDb().unsafe(
   `select id, metadata
      from workspace_agents
     where id = $1 and workspace_id = $2
     limit 1`,
   [String(agentId || ''), String(workspaceId || '')],
  );
  if (!rows[0]) throw Object.assign(new Error('Agent was not found'), { status: 404 });
  const metadata = parseJsonObject(rows[0].metadata);
  return Array.isArray(metadata.permission_rules) ? metadata.permission_rules.map(String) : [];
 }

 return {
  decideAgentPermissionRequest,
  expireConnectionPermissionRequests,
  expireStalePermissionRequests,
  grantAgentPermissionRule,
  handleAgentPermissionPrepared,
  handleAgentPermissionRequest,
  listAgentPermissionRequests,
  listAgentPermissionRules,
  publicPermissionRequest,
  replayPermissionDecisions,
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
  requireAuth, jsonError,
  decideAgentPermissionRequest, grantAgentPermissionRule, revokeAgentPermissionRule,
  setAgentPermissionMode, listAgentPermissionRequests,
 } = deps;

 // Everything still awaiting an answer in this workspace. The card in the
 // transcript reads the row it was inserted with; this is what a badge counts.
 app.get('/backend/workspaces/:workspaceId/permission-requests', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   const requests = await listAgentPermissionRequests({ userId: req.userId, workspaceId });
   res.json({ data: requests, error: null });
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

 app.post('/backend/workspaces/:workspaceId/agents/:agentId/permission-rules', requireAuth, async (req, res) => {
  try {
   const rules = await grantAgentPermissionRule({
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
