// ============================================================================
// tests/agent-permission-requests.test.cjs
// ----------------------------------------------------------------------------
// Interactive tool approvals (server/agent-permissions.cjs).
//
// A daemon agent runs headless, so the coding CLI's own permission prompt has
// nobody in front of it, and the settings files an operator would write grants
// into are never read by the daemon. Before this, a tool needing approval just
// errored — and the only working escape was permission_mode 'yolo', full shell,
// to allow one `git clone`.
//
// The invariants pinned here:
//   1. A request is authenticated exactly like a tool step — the job is loaded
//      with `agent_id = $2 and workspace_id = $3` from ws.agentAuth, so one
//      daemon can never raise a prompt against another agent's job.
//   2. A job with nowhere to ask (no session, already finished) is DENIED back
//      down the socket immediately, never parked. Parking holds the daemon's
//      turn open until its own 30-minute timeout for a question no human will
//      ever see.
//   3. `rules` and `scopes` are bound as ARRAYS, not JSON.stringify'd — a
//      stringified bind becomes a jsonb string scalar, the bug this repo has
//      now shipped twice.
//   4. 'always' costs `manage`; once/session and every denial cost `write`.
//      That split is the whole RBAC design: a member who can talk to the agent
//      can unblock the job in front of them, but making a grant permanent
//      writes workspace_agents.metadata, which is MANAGE_ONLY.
//   5. A decision is a durable two-phase command: save intent, PREPARE the exact
//      daemon, finalize only after its receipt, then COMMIT to release the tool.
//      A lost socket may delay either phase but can never create an "Approved"
//      card for a tool call the daemon was not still holding.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { __test } = require('../server/index.cjs');

const AUTH = { agentId: 'agent-1', workspaceId: 'ws-1', name: 'Scout', handle: 'scout' };

function agentWs(auth = AUTH) {
  const sent = [];
  return {
    ws: { agentAuth: auth, agentConnectionId: 'conn-1', readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) },
    sent,
  };
}

const JOB = {
  id: 'job-1',
  agent_id: 'agent-1',
  workspace_id: 'ws-1',
  connection_id: 'conn-1',
  session_id: 'session-1',
  status: 'running',
  agent_name: 'Scout',
  agent_handle: 'scout',
  metadata: { mode: 'daemon', responseMessageId: 'msg-placeholder' },
};

const REQUEST = {
  id: 'req-1',
  workspace_id: 'ws-1',
  agent_id: 'agent-1',
  job_id: 'job-1',
  connection_id: 'conn-1',
  session_id: 'session-1',
  message_id: 'msg-1',
  request_key: 'daemon-req-1',
  tool_name: 'Bash',
  tool_detail: 'git clone https://github.com/x/y',
  rules: ['Bash(git clone:*)'],
  scopes: ['once', 'session', 'always'],
  status: 'pending',
  scope: '',
};

function installDb({
  job = JOB,
  request = REQUEST,
  agentMetadata = {},
  role = 'owner',
  session = {
    id: 'session-1',
    visibility: 'workspace',
    folder: 'General',
    participants: [{ kind: 'agent', agent_id: 'agent-1' }],
  },
  sessionMembers = ['user-1'],
  sessionReadError = false,
  decisionSessionLive = true,
  decisionParticipates = true,
  decisionUserCanRead = true,
  decisionRole = role,
  decisionAgentEnabled = true,
  decisionJobStatus = 'running',
  decisionRequestStatus = null,
  decisionRequestExpired = false,
  onDecisionSettle = null,
} = {}) {
  session = session ? { deleted_at: null, ...session } : null;
  let storedRequest = request ? { ...request } : null;
  const calls = [];
  calls.transactions = 0;
  calls.currentRequest = () => storedRequest;
  calls.setRequestStatus = (status) => {
    if (storedRequest) storedRequest = { ...storedRequest, status };
  };
  calls.setDecisionAgentEnabled = (enabled) => {
    decisionAgentEnabled = Boolean(enabled);
  };
  calls.setDecisionRole = (nextRole) => {
    decisionRole = nextRole;
  };
  calls.setDecisionUserCanRead = (canRead) => {
    decisionUserCanRead = Boolean(canRead);
  };
  const db = {
    async begin(callback) {
      calls.transactions += 1;
      return callback(db);
    },
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      const q = n.toLowerCase();
      calls.push({ n, params, sql });
      if (q.startsWith('with recursive permission_workspace_chain')) {
        if (!decisionRole) {
          return [{ id: params[0], user_id: 'another-owner', role: null }];
        }
        return [{
          id: params[0],
          user_id: decisionRole === 'owner' ? params[1] : 'another-owner',
          role: decisionRole === 'owner' ? null : decisionRole,
        }];
      }
      if (n.startsWith('select j.*, a.name as agent_name')) {
        // Mirror the locking proof: token ownership, exact live connection,
        // running state, live same-workspace session, enabled agent, and roster.
        if (!job || params[0] !== job.id || params[1] !== job.agent_id || params[2] !== job.workspace_id) return [];
        if (job.connection_id !== params[3] || job.status !== 'running' || !job.session_id) return [];
        if (!session || session.deleted_at || String(session.id) !== String(job.session_id)) return [];
        const participants = Array.isArray(session.participants) ? session.participants : [];
        if (!participants.some((participant) => String(participant.agent_id || '') === String(job.agent_id))) return [];
        return [job];
      }
      if (n.startsWith('select s.id, s.workspace_id from chat_sessions s')) {
        if (!decisionSessionLive || !session || session.deleted_at) return [];
        if (String(params[0]) !== String(session.id) || String(params[1]) !== String(job?.workspace_id || '')) return [];
        if (!decisionParticipates || String(params[2]) !== String(job?.agent_id || '')) return [];
        const isPrivate = session.visibility === 'private' || session.folder === 'Direct messages';
        if (q.includes('chat_session_members') && isPrivate && !decisionUserCanRead) return [];
        return [{ id: session.id, workspace_id: job.workspace_id }];
      }
      if (n.startsWith('select id, workspace_id, name, handle, metadata from workspace_agents')) {
        if (!decisionAgentEnabled || !job || params[0] !== job.agent_id || params[1] !== job.workspace_id) return [];
        return [{
          id: job.agent_id,
          workspace_id: job.workspace_id,
          name: job.agent_name,
          handle: job.agent_handle,
          metadata: agentMetadata,
        }];
      }
      if (n.startsWith('select id, workspace_id, agent_id, session_id, connection_id, status from agent_jobs')) {
        if (!job
          || decisionJobStatus !== 'running'
          || params[0] !== job.id
          || params[1] !== job.workspace_id
          || params[2] !== job.agent_id
          || params[3] !== job.session_id
          || params[4] !== job.connection_id) return [];
        return [{ ...job, status: decisionJobStatus }];
      }
      if (n.startsWith('select session_id, status from agent_jobs')) {
        if (!job || params[0] !== job.id || params[1] !== job.agent_id || params[2] !== job.workspace_id) return [];
        return [{ session_id: job.session_id, status: job.status }];
      }
      if (n.startsWith('select thread_parent_id from messages')) {
        return params[0] === 'msg-placeholder' ? [{ thread_parent_id: null }] : [];
      }
      if (n.startsWith('insert into agent_permission_requests')) {
        return [{ ...REQUEST, id: params[0], request_key: params[7], rules: params[12], scopes: params[13] }];
      }
      if (n.startsWith('insert into messages')) return [{ id: params[0], session_id: params[1], content: params[2] }];
      if (q.startsWith('select * from agent_permission_requests')
        && q.includes("= 'pending'")
        && q.includes('order by created_at')) {
        assert.match(q, /chat_session_members/, 'the list query must carry the canonical session membership predicate');
        if (!storedRequest) return [];
        if (!storedRequest.session_id) return [storedRequest];
        if (!session || String(session.id) !== String(storedRequest.session_id)) return [];
        const isPrivate = session.visibility === 'private' || session.folder === 'Direct messages';
        return !isPrivate || sessionMembers.includes(String(params[1])) ? [storedRequest] : [];
      }
      if (n.startsWith('select * from agent_permission_requests where request_key')) {
        if (!storedRequest
          || params[0] !== storedRequest.request_key
          || params[1] !== storedRequest.connection_id
          || params[2] !== storedRequest.workspace_id
          || params[3] !== storedRequest.agent_id) return [];
        return [storedRequest];
      }
      if (n.startsWith('select * from agent_permission_requests where id')) {
        if (!storedRequest || params[0] !== storedRequest.id || params[1] !== storedRequest.workspace_id) return [];
        return [storedRequest];
      }
      if (n.startsWith('select *, (expires_at is not null and expires_at <= now()) as request_expired')) {
        if (!storedRequest || params[0] !== storedRequest.id || params[1] !== storedRequest.workspace_id) return [];
        return [{
          ...storedRequest,
          status: decisionRequestStatus || storedRequest.status,
          request_expired: decisionRequestExpired,
        }];
      }
      if (q.startsWith('select id, visibility, folder, deleted_at from chat_sessions where id')) {
        if (sessionReadError) throw new Error('session lookup failed');
        return session && String(params[0]) === String(session.id) ? [session] : [];
      }
      if (q.startsWith('select id, visibility, folder from chat_sessions') && q.includes('id = any')) {
        if (sessionReadError) throw new Error('session lookup failed');
        return session ? [{ id: session.id, visibility: session.visibility, folder: session.folder }] : [];
      }
      if (q.startsWith('select session_id, user_id from chat_session_members') && q.includes('session_id = any')) {
        if (sessionReadError) throw new Error('session membership lookup failed');
        return session
          ? sessionMembers.map((user_id) => ({ session_id: session.id, user_id }))
          : [];
      }
      if (q.startsWith('select 1 from chat_session_members')) {
        return sessionMembers.includes(String(params[1])) ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select user_id from chat_session_members')) {
        return sessionMembers.map((user_id) => ({ user_id }));
      }
      if (n.startsWith("update agent_permission_requests set status = 'expired'")
        && q.includes('jsonb_array_elements_text')) {
        if (!storedRequest
          || params[0] !== storedRequest.workspace_id
          || params[1] !== storedRequest.agent_id
          || storedRequest.status !== 'allowing'
          || storedRequest.scope !== 'always'
          || !storedRequest.rules.map(String).includes(String(params[2]))) return [];
        storedRequest = { ...storedRequest, status: 'expired' };
        return [storedRequest];
      }
      if (n.startsWith("update agent_permission_requests set status = 'expired'")) {
        if (params.length === 0 && q.includes('expires_at < now()')) {
          if (!storedRequest || !['pending', 'allowing', 'denying'].includes(storedRequest.status)) return [];
          storedRequest = { ...storedRequest, status: 'expired' };
          return [storedRequest];
        }
        if (!storedRequest
          || params[0] !== storedRequest.id
          || params[1] !== storedRequest.connection_id
          || !['allowing', 'denying'].includes(storedRequest.status)) return [];
        storedRequest = { ...storedRequest, status: 'expired' };
        return [storedRequest];
      }
      if (n.startsWith('update agent_permission_requests set status = $2')) {
        if (!storedRequest || params[0] !== storedRequest.id) return [];
        const interim = n.includes('scope = $3');
        if (interim) {
          const currentStatus = decisionRequestStatus || storedRequest.status;
          if (currentStatus !== 'pending'
            || params[5] !== storedRequest.job_id
            || params[6] !== storedRequest.session_id
            || params[7] !== storedRequest.agent_id
            || params[8] !== storedRequest.connection_id) return [];
          storedRequest = {
            ...storedRequest,
            status: params[1],
            scope: params[2],
            decided_by: params[3],
            decided_by_name: params[4],
          };
          if (typeof onDecisionSettle === 'function') onDecisionSettle('interim', storedRequest);
          return [storedRequest];
        }
        if (storedRequest.status !== params[2]
          || params[3] !== storedRequest.job_id
          || params[4] !== storedRequest.session_id
          || params[5] !== storedRequest.agent_id
          || params[6] !== storedRequest.connection_id) return [];
        storedRequest = { ...storedRequest, status: params[1] };
        if (typeof onDecisionSettle === 'function') onDecisionSettle('final', storedRequest);
        return [storedRequest];
      }
      if (n.startsWith('select metadata from workspace_agents')) return [{ metadata: agentMetadata }];
      if (n.startsWith('update workspace_agents set metadata')) {
        if (!decisionAgentEnabled) return [];
        return [{
          id: params[0], workspace_id: params[1], name: JOB.agent_name, handle: JOB.agent_handle,
          metadata: params[2], enabled: true,
        }];
      }
      if (n.startsWith('update workspace_agents a set permission_mode')) {
        // Mirror the real WHERE: a mismatched agent or workspace updates nothing.
        if (params[0] !== 'agent-1' || params[1] !== 'ws-1') return [];
        // The statement joins the pre-update row in as `prev` so the audit entry
        // can record what the mode changed FROM; mirror that extra column.
        return [{
          id: params[0], workspace_id: params[1], permission_mode: params[2],
          handle: 'coder', audit_previous_permission_mode: 'default',
        }];
      }
      if (n.startsWith('insert into audit_log')) return [{ id: 'audit-1', seq: 1, entry_hash: params[12] }];
      if (n.startsWith('select display_name, email from app_users')) return [{ display_name: 'Jason', email: 'j@x.io' }];
      if (n.startsWith('update messages set content')) return [{ id: params[0], content: params[1] }];
      // enforceWorkspaceRole, mirrored query for query. Answering these loosely
      // is how an RBAC test passes vacuously: a truthy row for the OWNER lookup
      // grants every capability and the `manage` assertions below stop testing
      // anything at all.
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return role === 'owner' ? [{ '?column?': 1 }] : [];
      }
      if (n.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
        return role === 'owner' ? [] : [{ role }];
      }
      // The ancestor-roles CTE: no parent workspace in this fixture, so no
      // inherited role can quietly supply the capability being asserted.
      if (n.includes('workspace_members') || n.includes('from workspaces')) return [];
      return [];
    },
  };
  __test.setTestDb(db);
  return calls;
}

test.afterEach(() => __test.resetTestState());

// --- raising a request ------------------------------------------------------

test('an unregistered socket cannot raise a permission request', async () => {
  installDb();
  await assert.rejects(
    () => __test.handleAgentPermissionRequest({}, { jobId: 'job-1', requestId: 'r1', toolName: 'Bash' }),
    /Agent is not registered/,
  );
});

test('a daemon cannot raise a request against another agent job', async () => {
  installDb();
  const { ws } = agentWs({ ...AUTH, agentId: 'agent-2' });
  await assert.rejects(
    () => __test.handleAgentPermissionRequest(ws, { jobId: 'job-1', requestId: 'r1', toolName: 'Bash' }),
    /Agent job not found/,
  );
});

test('a valid request stores the row and posts a card into the job conversation', async () => {
  const calls = installDb();
  const { ws, sent } = agentWs();

  const result = await __test.handleAgentPermissionRequest(ws, {
    jobId: 'job-1',
    requestId: 'daemon-req-1',
    toolName: 'Bash',
    detail: 'git clone https://github.com/x/y',
    rules: ['Bash(git clone:*)'],
    expiresInMs: 600000,
  });

  assert.equal(result.status, 'pending');
  assert.equal(sent.length, 0, 'a pending request must not answer itself');
  assert.equal(calls.transactions, 1, 'the job proof and both inserts share one transaction');

  const proof = calls.find((call) => call.n.startsWith('select j.*, a.name as agent_name'));
  assert.match(proof.n, /join chat_sessions s/);
  assert.match(proof.n, /s\.deleted_at is null/);
  assert.match(proof.n, /a\.enabled is true/);
  assert.match(proof.n, /j\.connection_id = \$4/);
  assert.match(proof.n, /j\.status = 'running'/);
  assert.match(proof.n, /jsonb_array_elements/);
  assert.match(proof.n, /for update of j, s, a/);

  const insert = calls.find((call) => call.n.startsWith('insert into agent_permission_requests'));
  // Bound as ARRAYS. postgres.js JSON-encodes a value whose parameter Postgres
  // reports as jsonb; pre-stringifying double-encodes it into a string scalar.
  assert.deepEqual(insert.params[12], ['Bash(git clone:*)']);
  assert.deepEqual(insert.params[13], ['once', 'session', 'always']);

  const message = calls.find((call) => call.n.startsWith('insert into messages'));
  assert.equal(message.params[6], 'permission_request');
  // The card must point back at the row it renders, and the row at the card:
  // the id is minted here rather than read back, so a mismatch would leave the
  // buttons wired to nothing.
  assert.equal(message.params[9], insert.params[0]);
  assert.equal(insert.params[6], message.params[0]);
  assert.equal(message.params[2], 'Bash · git clone https://github.com/x/y');
  // The card hangs off the reply's THREAD ROOT, like a tool step: parented to
  // the "Thinking …" placeholder it would be two levels deep and invisible in
  // the thread the human is actually watching.
  assert.equal(message.params[3], 'msg-placeholder');
});

test('a request offering no rule cannot be answered with "always"', async () => {
  const calls = installDb();
  const { ws } = agentWs();
  await __test.handleAgentPermissionRequest(ws, { jobId: 'job-1', requestId: 'r1', toolName: 'Codex command' });
  const insert = calls.find((call) => call.n.startsWith('insert into agent_permission_requests'));
  // Otherwise the button would have to mean "allow this whole tool forever",
  // which is a far bigger grant than the sentence beside it claims.
  assert.deepEqual(insert.params[13], ['once', 'session']);
});

test('a job with no conversation is denied down the socket, never parked', async () => {
  installDb({ job: { ...JOB, session_id: null } });
  const { ws, sent } = agentWs();

  const result = await __test.handleAgentPermissionRequest(ws, { jobId: 'job-1', requestId: 'r1', toolName: 'Bash' });

  assert.equal(result, null);
  assert.equal(sent[0].type, 'agent_permission_decision');
  assert.equal(sent[0].behavior, 'deny');
  assert.equal(sent[0].requestId, 'r1');
  assert.match(sent[0].message, /nowhere to ask/i);
});

test('a request for a job that already finished is denied rather than parked', async () => {
  installDb({ job: { ...JOB, status: 'completed' } });
  const { ws, sent } = agentWs();
  const result = await __test.handleAgentPermissionRequest(ws, { jobId: 'job-1', requestId: 'r1', toolName: 'Bash' });
  assert.equal(result, null);
  assert.equal(sent[0].behavior, 'deny');
});

test('a request with no job id is denied instead of throwing at the socket', async () => {
  installDb();
  const { ws, sent } = agentWs();
  const result = await __test.handleAgentPermissionRequest(ws, { requestId: 'r1', toolName: 'Bash' });
  assert.equal(result, null);
  assert.equal(sent[0].behavior, 'deny');
});

test('a daemon cannot persist an unbounded permission request id', async () => {
  const calls = installDb();
  const { ws } = agentWs();

  await assert.rejects(
    () => __test.handleAgentPermissionRequest(ws, {
      jobId: 'job-1', requestId: 'r'.repeat(201), toolName: 'Bash',
    }),
    /requestId is too long/,
  );

  assert.equal(calls.transactions, 0);
  assert.equal(calls.some((call) => call.n.startsWith('insert into agent_permission_requests')), false);
});

// --- listing ---------------------------------------------------------------

test('a workspace reader outside a private session cannot list its permission request, but a member can', async () => {
  const privateSession = {
    id: 'session-1',
    visibility: 'private',
    folder: 'Direct messages',
  };

  installDb({ role: 'viewer', session: privateSession, sessionMembers: ['member-1'] });
  const hidden = await __test.listAgentPermissionRequests({
    userId: 'outsider-1',
    workspaceId: 'ws-1',
  });
  assert.deepEqual(hidden, [], 'workspace read alone must not reveal a DM tool request');

  installDb({ role: 'viewer', session: privateSession, sessionMembers: ['member-1'] });
  const visible = await __test.listAgentPermissionRequests({
    userId: 'member-1',
    workspaceId: 'ws-1',
  });
  assert.deepEqual(visible.map((entry) => entry.id), ['req-1']);
});

test('a workspace reader can still list a request from a workspace-visible session', async () => {
  installDb({
    role: 'viewer',
    session: { id: 'session-1', visibility: 'workspace', folder: 'General' },
    sessionMembers: [],
  });

  const visible = await __test.listAgentPermissionRequests({
    userId: 'reader-1',
    workspaceId: 'ws-1',
  });

  assert.deepEqual(visible.map((entry) => entry.id), ['req-1']);
});

test('both generic DB backends route selects through the shared session access clause', () => {
  const root = path.resolve(__dirname, '..');
  for (const relative of ['server/index.cjs', 'netlify/functions/backend.mjs']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(
      source,
      /appendSessionAccessClause\(buildWhereClause\(filters, \[\]\), (?:req\.userId|userId), table\)/,
      `${relative} must keep generic selects behind the shared session clause`,
    );
  }
});

test('no workspace role can forge, settle, or delete a permission request through generic DB writes', async () => {
  installDb({ role: 'owner' });
  const attempts = [
    {
      op: 'insert',
      payload: { values: { ...REQUEST } },
    },
    {
      op: 'update',
      payload: {
        values: { status: 'allowed', scope: 'always' },
        filters: [{ column: 'id', operator: 'eq', value: 'req-1' }],
      },
    },
    {
      op: 'delete',
      payload: { filters: [{ column: 'id', operator: 'eq', value: 'req-1' }] },
    },
  ];

  for (const { op, payload } of attempts) {
    await assert.rejects(
      () => __test.enforceDbOperationAccess(
        'user-1',
        'agent_permission_requests',
        op,
        payload,
      ),
      /dedicated permission route/i,
      `${op} must remain server-only even for a workspace owner`,
    );
  }
});

// --- deciding ---------------------------------------------------------------

function connectAgent({
  connectionId = 'conn-1',
  agentId = 'agent-1',
  workspaceId = 'ws-1',
  supportsReceipts = true,
  autoPrepareAck = true,
  prepareAccepted = true,
} = {}) {
  const frames = [];
  const ws = {
    readyState: 1,
    agentAuth: { agentId, workspaceId },
    agentConnectionId: connectionId,
    send: (raw) => {
      const frame = JSON.parse(raw);
      frames.push(frame);
      if (frame.type === 'agent_permission_prepare' && autoPrepareAck) {
        queueMicrotask(() => {
          void __test.handleAgentPermissionPrepared(ws, {
            requestId: frame.requestId,
            accepted: prepareAccepted,
          });
        });
      }
    },
  };
  __test.registerTestConnectedAgent({
    connectionId,
    agentId,
    workspaceId,
    metadata: { permissionDecisionReceipts: supportsReceipts },
    ws,
  });
  Object.defineProperty(frames, 'ws', { value: ws });
  return frames;
}

const permissionDecisionFrames = (frames) => frames.filter((frame) => [
  'agent_permission_prepare',
  'agent_permission_commit',
  'agent_permission_abort',
  'agent_permission_decision',
].includes(frame.type));

test('allowing once pushes the decision to the daemon and settles the row', async () => {
  let frames;
  const calls = installDb({
    onDecisionSettle(phase) {
      if (phase === 'interim') {
        assert.equal(frames.length, 0, 'durable prepare intent must commit before any daemon frame');
      } else {
        assert.equal(frames.length, 1, 'prepare is acknowledged before final approval commits');
        assert.equal(frames[0].type, 'agent_permission_prepare');
      }
    },
  });
  frames = connectAgent();

  const settled = await __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
  });
  assert.equal(calls.transactions, 2, 'durable prepare intent and receipt-driven finalization are separate transactions');

  const workspaceLock = calls.findIndex((call) => call.n.startsWith('with recursive permission_workspace_chain'));
  const sessionLock = calls.findIndex((call) => call.n.startsWith('select s.id, s.workspace_id from chat_sessions s'));
  const agentLock = calls.findIndex((call) => call.n.startsWith('select id, workspace_id, name, handle, metadata from workspace_agents'));
  const jobLock = calls.findIndex((call) => call.n.startsWith('select id, workspace_id, agent_id, session_id, connection_id, status from agent_jobs'));
  const requestLock = calls.findIndex((call) => call.n.startsWith('select *, (expires_at is not null'));
  assert.ok(workspaceLock >= 0 && workspaceLock < sessionLock
    && sessionLock < agentLock && agentLock < jobLock && jobLock < requestLock,
  'decision follows clear-compatible workspace lineage -> session -> agent -> job -> request lock order');
  assert.match(calls[workspaceLock].n, /permission_locked_workspaces as materialized/);
  assert.match(calls[workspaceLock].n, /for share of workspace/);
  assert.match(calls[workspaceLock].n, /permission_locked_memberships as materialized/);
  assert.match(calls[workspaceLock].n, /for share of membership/);
  assert.match(calls[sessionLock].n, /s\.deleted_at is null/);
  assert.match(calls[sessionLock].n, /jsonb_array_elements/);
  assert.match(calls[sessionLock].n, /chat_session_members/);
  assert.match(calls[sessionLock].n, /for share/);
  assert.match(calls[sessionLock].n, /for update of s$/);
  assert.match(calls[agentLock].n, /enabled is true for update$/);
  assert.match(calls[jobLock].n, /connection_id = \$5 and status = 'running' for update$/);
  assert.match(calls[requestLock].n, /for update$/);

  assert.equal(settled.status, 'allowed');
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], {
    type: 'agent_permission_prepare',
    // The DAEMON's request id, not ours — it is the key the daemon parked under.
    requestId: 'daemon-req-1',
    behavior: 'allow',
    scope: 'once',
    decidedBy: 'Jason',
    message: '',
  });
  assert.deepEqual(frames[1], {
    type: 'agent_permission_commit',
    requestId: 'daemon-req-1',
  });
  // 'once' must not touch the agent's permanent rules.
  assert.equal(calls.some((call) => call.n.startsWith('update workspace_agents set metadata')), false);
});

test('prepare leaves the daemon parked and a permanent grant absent until its receipt', async () => {
  const calls = installDb({ agentMetadata: { host_folders: ['/srv/code'] } });
  const frames = connectAgent({ autoPrepareAck: false });
  let settled = false;
  const decision = __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'always',
  }).then((row) => {
    settled = true;
    return row;
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.currentRequest().status, 'allowing', 'phase one is the durable delivery outbox');
  assert.deepEqual(frames.map((frame) => frame.type), ['agent_permission_prepare']);
  assert.equal(settled, false, 'PREPARE alone must not settle the HTTP decision');
  assert.equal(
    calls.some((call) => call.n.startsWith('update workspace_agents set metadata')),
    false,
    'an always grant does not exist before the daemon proves it still holds the tool call',
  );

  assert.equal(await __test.handleAgentPermissionPrepared(frames.ws, {
    requestId: 'daemon-req-1', accepted: true,
  }), true);
  const result = await decision;

  assert.equal(result.status, 'allowed');
  assert.equal(settled, true);
  assert.deepEqual(permissionDecisionFrames(frames).map((frame) => frame.type), [
    'agent_permission_prepare',
    'agent_permission_commit',
  ]);
  assert.equal(
    calls.filter((call) => call.n.startsWith('update workspace_agents set metadata')).length,
    1,
    'the permanent grant is written once, inside receipt-driven finalization',
  );
});

test('a daemon that rejects prepare expires the intent without a grant or commit', async () => {
  const calls = installDb();
  const frames = connectAgent({ autoPrepareAck: false });
  const decision = __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'always',
  });
  const rejected = assert.rejects(
    decision,
    (error) => error.code === 'permission_prepare_rejected',
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await __test.handleAgentPermissionPrepared(frames.ws, {
    requestId: 'daemon-req-1', accepted: false,
  }), false);
  await rejected;

  assert.equal(calls.currentRequest().status, 'expired');
  assert.deepEqual(frames.map((frame) => frame.type), ['agent_permission_prepare']);
  assert.equal(calls.some((call) => call.n.startsWith('update workspace_agents set metadata')), false);
});

test('conversation clear between prepare and receipt wins without releasing the stale allow', async () => {
  const calls = installDb();
  const frames = connectAgent({ autoPrepareAck: false });
  const decision = __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
  });
  const rejected = assert.rejects(decision, (error) => error.code === 'permission_scope_changed');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.currentRequest().status, 'allowing');
  calls.setRequestStatus('expired');

  assert.equal(await __test.handleAgentPermissionPrepared(frames.ws, {
    requestId: 'daemon-req-1', accepted: true,
  }), false);
  await rejected;

  assert.deepEqual(frames.map((frame) => frame.type), [
    'agent_permission_prepare',
    'agent_permission_abort',
  ]);
  assert.match(frames[1].message, /conversation changed/i);
  assert.equal(frames.some((frame) => frame.type === 'agent_permission_commit'), false);
  assert.equal(calls.some((call) => call.n.startsWith('update workspace_agents set metadata')), false);
});

test('the stale sweep aborts an interim decision instead of leaving its promise parked', async () => {
  const calls = installDb({ request: {
    ...REQUEST,
    expires_at: '2026-07-31T00:00:00.000Z',
  } });
  const frames = connectAgent({ autoPrepareAck: false });
  const decision = __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
  });
  const rejected = assert.rejects(decision, (error) => error.code === 'permission_scope_changed');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.currentRequest().status, 'allowing');
  assert.equal(await __test.expireStalePermissionRequests(), 1);
  await rejected;

  assert.equal(calls.currentRequest().status, 'expired');
  assert.deepEqual(permissionDecisionFrames(frames).map((frame) => frame.type), [
    'agent_permission_prepare',
    'agent_permission_abort',
  ]);
  assert.match(frames[1].message, /expired/i);
});

test('a phase-two scope failure aborts the prepared daemon instead of waiting for reconnect', async () => {
  const calls = installDb();
  const frames = connectAgent({ autoPrepareAck: false });
  const decision = __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
  });
  const rejected = assert.rejects(decision, (error) => error.code === 'permission_scope_changed');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.currentRequest().status, 'allowing');
  calls.setDecisionAgentEnabled(false);

  assert.equal(await __test.handleAgentPermissionPrepared(frames.ws, {
    requestId: 'daemon-req-1', accepted: true,
  }), false);
  await rejected;

  assert.deepEqual(permissionDecisionFrames(frames).map((frame) => frame.type), [
    'agent_permission_prepare',
    'agent_permission_abort',
  ]);
  assert.equal(calls.currentRequest().status, 'expired', 'the failed phase is closed durably before abort');
  assert.equal(calls.some((call) => call.n.startsWith('update workspace_agents set metadata')), false);
});

test('a prepared receipt is bound to the authenticated agent connection', async () => {
  const calls = installDb();
  const frames = connectAgent({ autoPrepareAck: false });
  const impostorFrames = connectAgent({ connectionId: 'conn-2', autoPrepareAck: false });
  const decision = __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await __test.handleAgentPermissionPrepared(impostorFrames.ws, {
    requestId: 'daemon-req-1', accepted: true,
  }), false);
  assert.equal(calls.currentRequest().status, 'allowing');
  assert.deepEqual(impostorFrames, []);
  assert.deepEqual(frames.map((frame) => frame.type), ['agent_permission_prepare']);

  assert.equal(await __test.handleAgentPermissionPrepared(frames.ws, {
    requestId: 'daemon-req-1', accepted: true,
  }), true);
  assert.equal((await decision).status, 'allowed');
});

test('an old daemon fails closed before a durable decision is written', async () => {
  const calls = installDb();
  const frames = connectAgent({ supportsReceipts: false });

  await assert.rejects(
    () => __test.decideAgentPermissionRequest({
      userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
    }),
    (error) => error.code === 'permission_receipt_unsupported',
  );

  assert.equal(calls.transactions, 0);
  assert.equal(calls.currentRequest().status, 'pending');
  assert.deepEqual(frames, []);
});

test('a duplicate prepared receipt only replays commit and never repeats the grant', async () => {
  const calls = installDb();
  const frames = connectAgent();
  const result = await __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'always',
  });
  assert.equal(result.status, 'allowed');

  const transactions = calls.transactions;
  const grantWrites = calls.filter((call) => call.n.startsWith('update workspace_agents set metadata')).length;
  assert.equal(await __test.handleAgentPermissionPrepared(frames.ws, {
    requestId: 'daemon-req-1', accepted: true,
  }), true);

  assert.equal(calls.transactions, transactions, 'a duplicate receipt never opens another finalization transaction');
  assert.equal(
    calls.filter((call) => call.n.startsWith('update workspace_agents set metadata')).length,
    grantWrites,
    'a duplicate receipt cannot widen the permanent rule twice',
  );
  assert.deepEqual(permissionDecisionFrames(frames).map((frame) => frame.type), [
    'agent_permission_prepare',
    'agent_permission_commit',
    'agent_permission_commit',
  ]);
});

test('a clear or scope revoke that wins after preflight prevents every stale decision frame', async (t) => {
  const losers = [
    ['workspace role revoke', { role: 'editor', decisionRole: 'viewer' }],
    ['private-session member revoke', {
      role: 'editor',
      session: { id: 'session-1', visibility: 'private', folder: 'Direct messages' },
      sessionMembers: ['user-1'],
      decisionUserCanRead: false,
    }],
    ['conversation clear', { decisionSessionLive: false }],
    ['agent roster revoke', { decisionParticipates: false }],
    ['agent disable', { decisionAgentEnabled: false }],
    ['job cancellation', { decisionJobStatus: 'cancelled' }],
    ['request expiration', { decisionRequestStatus: 'expired' }],
    ['request deadline', { decisionRequestExpired: true }],
  ];

  for (const [label, options] of losers) {
    await t.test(label, async () => {
      const calls = installDb(options);
      const frames = connectAgent();
      await assert.rejects(
        () => __test.decideAgentPermissionRequest({
          userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
        }),
        /no longer attached|already expired|has expired|access changed/,
      );
      assert.equal(frames.length, 0, 'the daemon must not receive a stale allow');
      assert.equal(
        calls.some((call) => call.n.startsWith('update agent_permission_requests set status')),
        false,
        'the losing decision does not settle the request',
      );
      assert.equal(
        calls.some((call) => call.n.startsWith('update workspace_agents set metadata')),
        false,
        'the losing decision does not persist a grant',
      );
    });
  }
});

test('allowing always merges the rule into the agent without clobbering its other metadata', async () => {
  const calls = installDb({ agentMetadata: { host_folders: ['/root'], permission_rules: ['WebFetch'] } });
  connectAgent();

  await __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'always',
  });

  const update = calls.find((call) => call.n.startsWith('update workspace_agents set metadata'));
  // metadata is a wholesale jsonb write, so host_folders (and anything else
  // living in the same column) has to survive a permission grant untouched.
  assert.deepEqual(update.params[2], {
    host_folders: ['/root'],
    permission_rules: ['WebFetch', 'Bash(git clone:*)'],
  });
});

test('a member with only write cannot make a grant permanent, but can allow once and deny', async () => {
  installDb({ role: 'editor' });
  connectAgent();

  await assert.rejects(
    () => __test.decideAgentPermissionRequest({
      userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'always',
    }),
    // Permanent grants write workspace_agents.metadata, which is MANAGE_ONLY.
    /permission|manage|not allowed|forbidden/i,
  );

  const once = await __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
  });
  assert.equal(once.status, 'allowed');
});

test('a workspace editor outside a private session cannot decide its permission request', async () => {
  const calls = installDb({
    role: 'editor',
    session: { id: 'session-1', visibility: 'private', folder: 'Direct messages' },
    sessionMembers: ['member-1'],
  });
  const frames = connectAgent();

  for (const behavior of ['allow', 'deny']) {
    await assert.rejects(
      () => __test.decideAgentPermissionRequest({
        userId: 'outsider-1',
        workspaceId: 'ws-1',
        requestId: 'req-1',
        behavior,
        scope: 'once',
      }),
      /private/i,
      `a non-member must not ${behavior} the private request`,
    );
  }
  assert.equal(frames.length, 0, 'an unauthorized decision must never reach the daemon');
  assert.equal(
    calls.some((call) => call.n.startsWith('update agent_permission_requests set status')),
    false,
    'an unauthorized decision must not settle the request',
  );
});

test('workspace ownership does not grant silent permission to decide a private-session request', async () => {
  const calls = installDb({
    role: 'owner',
    session: { id: 'session-1', visibility: 'private', folder: 'Direct messages' },
    sessionMembers: ['member-1'],
  });
  const frames = connectAgent();

  await assert.rejects(
    () => __test.decideAgentPermissionRequest({
      userId: 'owner-outside-dm',
      workspaceId: 'ws-1',
      requestId: 'req-1',
      behavior: 'allow',
      scope: 'always',
    }),
    /private/i,
  );
  assert.equal(frames.length, 0);
  assert.equal(
    calls.some((call) => call.n.startsWith('update workspace_agents set metadata')),
    false,
    'the private-session gate must run before a permanent rule is written',
  );
});

test('an editor who belongs to the private session can decide its permission request', async () => {
  installDb({
    role: 'editor',
    session: { id: 'session-1', visibility: 'private', folder: 'Direct messages' },
    sessionMembers: ['member-1'],
  });
  const frames = connectAgent();

  const settled = await __test.decideAgentPermissionRequest({
    userId: 'member-1',
    workspaceId: 'ws-1',
    requestId: 'req-1',
    behavior: 'allow',
    scope: 'once',
  });

  assert.equal(settled.status, 'allowed');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, 'agent_permission_prepare');
  assert.equal(frames[0].behavior, 'allow');
  assert.equal(frames[1].type, 'agent_permission_commit');
});

test('denying never needs more than write, whatever scope was asked for', async () => {
  installDb({ role: 'editor' });
  const frames = connectAgent();
  const denied = await __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'deny', scope: 'always',
  });
  assert.equal(denied.status, 'denied');
  assert.equal(frames[0].type, 'agent_permission_prepare');
  assert.equal(frames[0].behavior, 'deny');
  // Refusing must never wait for an admin.
  assert.match(frames[0].message, /denied this tool call/);
  assert.equal(frames[1].type, 'agent_permission_commit');
});

test('a decision that cannot reach the daemon is refused, not recorded', async () => {
  const calls = installDb();
  // No connected agent: the daemon reconnected or died holding the turn.

  await assert.rejects(
    () => __test.decideAgentPermissionRequest({
      userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
    }),
    /no longer connected/,
  );
  // Otherwise the card would read "Approved by Jason" over a tool call that
  // never ran, and the turn would still be sitting there.
  assert.equal(calls.some((call) => call.n.startsWith('update agent_permission_requests set status')), false);
});

test('a decision is only delivered to the connection that raised it', async () => {
  installDb();
  // A different connection for the same agent — i.e. the daemon reconnected, so
  // this is a NEW process with no memory of the request id.
  const frames = connectAgent({ connectionId: 'conn-2' });
  await assert.rejects(
    () => __test.decideAgentPermissionRequest({
      userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
    }),
    /no longer connected/,
  );
  assert.equal(frames.length, 0);
});

test('an already-decided request cannot be answered twice', async () => {
  installDb({ request: { ...REQUEST, status: 'allowed' } });
  connectAgent();
  await assert.rejects(
    () => __test.decideAgentPermissionRequest({
      userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'deny',
    }),
    /already allowed/,
  );
});

test('a request from another workspace is not found', async () => {
  installDb();
  connectAgent();
  await assert.rejects(
    () => __test.decideAgentPermissionRequest({
      userId: 'user-1', workspaceId: 'ws-other', requestId: 'req-1', behavior: 'allow', scope: 'once',
    }),
    /not found/,
  );
});

test('behavior and scope are validated before anything is written', async () => {
  installDb();
  connectAgent();
  await assert.rejects(
    () => __test.decideAgentPermissionRequest({ userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'maybe' }),
    /behavior must be/,
  );
  await assert.rejects(
    () => __test.decideAgentPermissionRequest({ userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'forever' }),
    /scope must be/,
  );
});

// --- realtime --------------------------------------------------------------

test('a private-session request is broadcast only to a session member', async () => {
  installDb({
    session: { id: 'session-1', visibility: 'private', folder: 'Direct messages' },
    sessionMembers: ['member-1'],
  });

  const client = (userId) => __test.registerTestWebsocketClient({
    userId,
    readyState: 1,
    subscriptions: [{
      type: 'db_changes',
      table: 'agent_permission_requests',
      event: '*',
      schema: 'public',
      filter: 'workspace_id=eq.ws-1',
    }],
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
  });
  const member = client('member-1');
  const reader = client('reader-1');
  const editor = client('editor-1');

  __test.notifyDbSubscribers('agent_permission_requests', 'INSERT', [REQUEST]);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(member.sent.length, 1, 'the DM member must receive the live request');
  assert.equal(reader.sent.length, 0, 'a workspace reader outside the DM must receive nothing');
  assert.equal(editor.sent.length, 0, 'a workspace editor outside the DM must receive nothing');

  for (const socket of [member, reader, editor]) socket.sent.length = 0;
  __test.notifyDbSubscribers('agent_permission_requests', 'UPDATE', [{
    ...REQUEST,
    status: 'allowed',
    scope: 'once',
  }]);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(member.sent.length, 1, 'the DM member must receive a settled private request');
  assert.equal(reader.sent.length, 0, 'a workspace reader outside the DM must not receive its settlement');
  assert.equal(editor.sent.length, 0, 'a workspace editor outside the DM must not receive its settlement');

  for (const socket of [member, reader, editor]) socket.sent.length = 0;
  installDb({
    session: { id: 'session-1', visibility: 'workspace', folder: 'General' },
    sessionMembers: [],
  });
  __test.notifyDbSubscribers('agent_permission_requests', 'UPDATE', [REQUEST]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    [member, reader, editor].map((socket) => socket.sent.length),
    [1, 1, 1],
    'a request in a workspace-visible session must keep its existing fanout',
  );
});

test('permission-request fanout fails closed when its session audience cannot be resolved', async () => {
  installDb({ sessionReadError: true });
  const socket = __test.registerTestWebsocketClient({
    userId: 'user-1',
    readyState: 1,
    subscriptions: [{
      type: 'db_changes',
      table: 'agent_permission_requests',
      event: '*',
      schema: 'public',
      filter: 'workspace_id=eq.ws-1',
    }],
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
  });

  __test.notifyDbSubscribers('agent_permission_requests', 'INSERT', [REQUEST]);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(socket.sent.length, 0, 'lookup failure must withhold rather than guess workspace-wide');
});

// --- the seam that carries a permanent grant to the daemon -------------------

test('permanent rules ride the job payload, so a grant survives into later jobs', () => {
  // The daemon reads `job.agent.metadata.permission_rules` and short-circuits
  // canUseTool on a match. If metadata is dropped anywhere between the agent row
  // and the dispatch frame, "Always allow" silently degrades to "ask me again on
  // every new job" — the same class of bug that shipped host_folders and
  // canvas_id broken, both times by a select or a payload that omitted a field.
  const payload = __test.agentRuntimePayload({
    id: 'agent-1',
    workspace_id: 'ws-1',
    name: 'Scout',
    run_mode: 'daemon',
    permission_mode: 'default',
    metadata: { permission_rules: ['Bash(git clone:*)'], host_folders: ['/root'] },
  });
  assert.deepEqual(payload.metadata.permission_rules, ['Bash(git clone:*)']);
  assert.deepEqual(payload.metadata.host_folders, ['/root']);
});

// --- permission mode --------------------------------------------------------

test('setting the permission mode writes the column the generic db path strips', async () => {
  // `permission_mode` is in PRIVILEGED_DB_COLUMNS_BY_TABLE, so a
  // /backend/db/update carrying it is silently emptied. The Agents window's
  // radio buttons shipped pointed at that path: they moved, the optimistic
  // state made it look saved, and a reload showed the old value. This route is
  // the reason they now persist.
  const calls = installDb();
  const mode = await __test.setAgentPermissionMode({
    userId: 'user-1', workspaceId: 'ws-1', agentId: 'agent-1', permissionMode: 'yolo',
  });
  assert.equal(mode, 'yolo');
  const update = calls.find((call) => call.n.startsWith('update workspace_agents a set permission_mode'));
  assert.ok(update, 'the column must be written directly');
  assert.deepEqual(update.params, ['agent-1', 'ws-1', 'yolo']);

  // The same change is now recorded in the audit log, with the mode it came
  // from — this is the highest-value row in that log, because 'yolo' is
  // unrestricted shell on the daemon host and nothing used to record who
  // granted it. (tests/audit-log-call-sites.test.cjs covers it end to end.)
  const audit = calls.find((call) => call.n.startsWith('insert into audit_log'));
  assert.ok(audit, 'a permission mode change must leave an audit row');
  assert.equal(audit.params[4], 'agent.permission_mode_changed');
  assert.equal(audit.params[8], 'default', 'the mode it changed FROM');
  assert.equal(audit.params[9], 'yolo');
});

test('changing an agent’s access needs manage, not write', async () => {
  installDb({ role: 'editor' });
  // Otherwise a member holding only `write` could flip an agent to Full access
  // and hand themselves unrestricted shell on the daemon host — which is
  // exactly what the privileged-column strip exists to prevent.
  await assert.rejects(
    () => __test.setAgentPermissionMode({
      userId: 'user-1', workspaceId: 'ws-1', agentId: 'agent-1', permissionMode: 'yolo',
    }),
    /permission|manage|not allowed|forbidden/i,
  );
});

test('an unrecognised mode is rejected rather than quietly downgraded to default', async () => {
  installDb();
  // normalizeAgentPermissionMode maps anything unknown to 'default'. Accepting
  // a typo'd 'yolo!' as a deliberate choice would report success for a setting
  // the human did not make.
  await assert.rejects(
    () => __test.setAgentPermissionMode({
      userId: 'user-1', workspaceId: 'ws-1', agentId: 'agent-1', permissionMode: 'yolo!',
    }),
    /permission_mode must be/,
  );
});

// --- revoking ---------------------------------------------------------------

test('revoking a permanent rule leaves the rest of the agent metadata alone', async () => {
  const calls = installDb({ agentMetadata: { host_folders: ['/root'], permission_rules: ['WebFetch', 'Bash(git clone:*)'] } });
  const rules = await __test.revokeAgentPermissionRule({
    userId: 'user-1', workspaceId: 'ws-1', agentId: 'agent-1', rule: 'Bash(git clone:*)',
  });
  assert.deepEqual(rules, ['WebFetch']);
  const update = calls.find((call) => call.n.startsWith('update workspace_agents set metadata'));
  assert.deepEqual(update.params[2], { host_folders: ['/root'], permission_rules: ['WebFetch'] });
  const lock = calls.find((call) => call.n.startsWith('select id, workspace_id, name, handle, metadata from workspace_agents'));
  assert.ok(lock, 'revocation must read the current whole metadata document under the agent row lock');
  assert.match(lock.n, /for update$/i);
  assert.equal(calls.transactions, 1);
});

test('revoking an absent rule is an atomic no-op with no metadata write or audit row', async () => {
  const calls = installDb({
    agentMetadata: { host_folders: ['/srv/project'], permission_rules: ['WebFetch'] },
  });
  const rules = await __test.revokeAgentPermissionRule({
    userId: 'user-1', workspaceId: 'ws-1', agentId: 'agent-1', rule: 'Bash(git clone:*)',
  });
  assert.deepEqual(rules, ['WebFetch']);
  assert.equal(calls.transactions, 1);
  assert.ok(calls.some((call) => /for update$/i.test(call.n)), 'the no-op result still comes from locked current state');
  assert.equal(calls.some((call) => call.n.startsWith('update workspace_agents set metadata')), false);
  assert.equal(calls.some((call) => call.n.startsWith('insert into audit_log')), false);
});

test('revoking between PREPARE and COMMIT expires the pending permanent grant', async () => {
  const calls = installDb({
    agentMetadata: { host_folders: ['/srv/project'], permission_rules: ['WebFetch'] },
  });
  const frames = connectAgent({ autoPrepareAck: false });
  const decision = __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'always',
  });
  const rejected = assert.rejects(
    decision,
    (error) => error.code === 'permission_scope_changed',
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.currentRequest().status, 'allowing');
  assert.deepEqual(frames.map((frame) => frame.type), ['agent_permission_prepare']);

  const rules = await __test.revokeAgentPermissionRule({
    userId: 'user-1', workspaceId: 'ws-1', agentId: 'agent-1', rule: 'Bash(git clone:*)',
  });
  await rejected;

  assert.deepEqual(rules, ['WebFetch']);
  assert.equal(calls.currentRequest().status, 'expired');
  assert.deepEqual(permissionDecisionFrames(frames).map((frame) => frame.type), [
    'agent_permission_prepare',
    'agent_permission_abort',
  ]);
  assert.equal(frames.some((frame) => frame.type === 'agent_permission_commit'), false);
  assert.equal(calls.some((call) => call.n.startsWith('update workspace_agents set metadata')), false);
  assert.ok(
    calls.some((call) => call.n.includes('jsonb_array_elements_text')),
    'revocation must match in-flight prepared grants, not only metadata that already exists',
  );

  assert.equal(await __test.handleAgentPermissionPrepared(frames.ws, {
    requestId: 'daemon-req-1', accepted: true,
  }), false);
  assert.equal(frames.some((frame) => frame.type === 'agent_permission_commit'), false);
});

test('revoking requires manage, like granting', async () => {
  installDb({ role: 'editor', agentMetadata: { permission_rules: ['WebFetch'] } });
  await assert.rejects(
    () => __test.revokeAgentPermissionRule({ userId: 'user-1', workspaceId: 'ws-1', agentId: 'agent-1', rule: 'WebFetch' }),
    /permission|manage|not allowed|forbidden/i,
  );
});
