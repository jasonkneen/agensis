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
//   5. A decision is DELIVERED before it is recorded. Recording an approval
//      that never reached the daemon would show "Approved" under a tool call
//      that never ran.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

function installDb({ job = JOB, request = REQUEST, agentMetadata = {}, role = 'owner' } = {}) {
  const calls = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params, sql });
      if (n.startsWith('select j.*, a.name as agent_name')) {
        // Mirror the real WHERE: a mismatched agent or workspace matches nothing.
        if (!job || params[0] !== job.id || params[1] !== job.agent_id || params[2] !== job.workspace_id) return [];
        return [job];
      }
      if (n.startsWith('select thread_parent_id from messages')) {
        return params[0] === 'msg-placeholder' ? [{ thread_parent_id: null }] : [];
      }
      if (n.startsWith('insert into agent_permission_requests')) {
        return [{ ...REQUEST, id: params[0], request_key: params[7], rules: params[12], scopes: params[13] }];
      }
      if (n.startsWith('insert into messages')) return [{ id: params[0], session_id: params[1], content: params[2] }];
      if (n.startsWith('select * from agent_permission_requests where id')) {
        if (!request || params[0] !== request.id || params[1] !== request.workspace_id) return [];
        return [request];
      }
      if (n.startsWith('update agent_permission_requests set status = $2')) {
        return [{ ...request, status: params[1], scope: params[2], decided_by: params[3], decided_by_name: params[4] }];
      }
      if (n.startsWith('select metadata from workspace_agents')) return [{ metadata: agentMetadata }];
      if (n.startsWith('update workspace_agents set metadata')) return [{ id: params[0], metadata: params[2] }];
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
  });
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

// --- deciding ---------------------------------------------------------------

function connectAgent({ connectionId = 'conn-1', agentId = 'agent-1' } = {}) {
  const frames = [];
  __test.registerTestConnectedAgent({
    connectionId,
    agentId,
    ws: { readyState: 1, send: (raw) => frames.push(JSON.parse(raw)) },
  });
  return frames;
}

test('allowing once pushes the decision to the daemon and settles the row', async () => {
  const calls = installDb();
  const frames = connectAgent();

  const settled = await __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'allow', scope: 'once',
  });

  assert.equal(settled.status, 'allowed');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], {
    type: 'agent_permission_decision',
    // The DAEMON's request id, not ours — it is the key the daemon parked under.
    requestId: 'daemon-req-1',
    behavior: 'allow',
    scope: 'once',
    decidedBy: 'Jason',
    message: '',
  });
  // 'once' must not touch the agent's permanent rules.
  assert.equal(calls.some((call) => call.n.startsWith('update workspace_agents set metadata')), false);
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

test('denying never needs more than write, whatever scope was asked for', async () => {
  installDb({ role: 'editor' });
  const frames = connectAgent();
  const denied = await __test.decideAgentPermissionRequest({
    userId: 'user-1', workspaceId: 'ws-1', requestId: 'req-1', behavior: 'deny', scope: 'always',
  });
  assert.equal(denied.status, 'denied');
  assert.equal(frames[0].behavior, 'deny');
  // Refusing must never wait for an admin.
  assert.match(frames[0].message, /denied this tool call/);
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

// --- revoking ---------------------------------------------------------------

test('revoking a permanent rule leaves the rest of the agent metadata alone', async () => {
  const calls = installDb({ agentMetadata: { host_folders: ['/root'], permission_rules: ['WebFetch', 'Bash(git clone:*)'] } });
  const rules = await __test.revokeAgentPermissionRule({
    userId: 'user-1', workspaceId: 'ws-1', agentId: 'agent-1', rule: 'Bash(git clone:*)',
  });
  assert.deepEqual(rules, ['WebFetch']);
  const update = calls.find((call) => call.n.startsWith('update workspace_agents set metadata'));
  assert.deepEqual(update.params[2], { host_folders: ['/root'], permission_rules: ['WebFetch'] });
});

test('revoking requires manage, like granting', async () => {
  installDb({ role: 'editor', agentMetadata: { permission_rules: ['WebFetch'] } });
  await assert.rejects(
    () => __test.revokeAgentPermissionRule({ userId: 'user-1', workspaceId: 'ws-1', agentId: 'agent-1', rule: 'WebFetch' }),
    /permission|manage|not allowed|forbidden/i,
  );
});
