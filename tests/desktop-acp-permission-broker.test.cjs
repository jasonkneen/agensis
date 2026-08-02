'use strict';

// Product auth path for desktop ACP: permission broker + client handler.
// Without this, Ask mode only had a native OS dialog (or silent deny) and never
// raised agent_permission_request — so PermissionRequestCard never appeared.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {
  createPermissionBroker,
  deriveRules,
  normalizeStoredRules,
  jobPermissionRules,
  isAllowedByStoredRules,
} = require('../electron/acp/permissionBroker.cjs');
const { createAcpClient } = require('../electron/acp/client.cjs');

const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');
const ROOT = path.resolve(__dirname, '..');

test('deriveRules builds Bash prefix and whole-tool rules', () => {
  assert.deepEqual(deriveRules({ toolName: 'Edit' }), ['Edit']);
  assert.deepEqual(
    deriveRules({ toolName: 'Bash', rawInput: { command: 'git status' } }),
    ['Bash(git status:*)'],
  );
  // Chaining is refuse-to-suggest (fail closed for Always allow).
  assert.deepEqual(
    deriveRules({ toolName: 'Bash', rawInput: { command: 'git status && rm -rf /' } }),
    [],
  );
});

test('normalizeStoredRules + jobPermissionRules + isAllowedByStoredRules', () => {
  assert.deepEqual(
    normalizeStoredRules(['Bash(git status:*)', 'WebFetch', 'Bash(git status:*)']),
    ['Bash(git status:*)', 'WebFetch'],
  );
  assert.deepEqual(
    jobPermissionRules({
      agent: { metadata: { permission_rules: ['Bash(npx vitest:*)'], host_folders: ['/x'] } },
    }),
    ['Bash(npx vitest:*)'],
  );
  assert.equal(
    isAllowedByStoredRules(['Bash(git status:*)'], {
      toolName: 'Bash',
      rawInput: { command: 'git status' },
    }),
    true,
  );
  assert.equal(
    isAllowedByStoredRules(['WebFetch'], { toolName: 'WebFetch', rawInput: {} }),
    true,
  );
  assert.equal(
    isAllowedByStoredRules(['Bash(git status:*)'], {
      toolName: 'Bash',
      rawInput: { command: 'rm -rf /' },
    }),
    false,
  );
});

test('broker sends agent_permission_request and settles on prepare+commit', async () => {
  const outbound = [];
  const broker = createPermissionBroker({
    send: (frame) => {
      outbound.push(frame);
      return true;
    },
    timeoutMs: 5000,
  });

  const pending = broker.request({
    jobId: 'job-1',
    toolName: 'Bash',
    title: 'Bash(ls)',
    detail: 'ls -la',
    rawInput: { command: 'ls -la' },
  });

  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].action, 'agent_permission_request');
  assert.equal(outbound[0].jobId, 'job-1');
  assert.ok(outbound[0].requestId);
  assert.ok(outbound[0].rules.length >= 1);
  assert.deepEqual(outbound[0].scopes, ['once', 'session', 'always']);
  // Rules must be non-empty so Always allow can persist to metadata.permission_rules.
  assert.ok(outbound[0].rules.every((r) => typeof r === 'string' && r.length > 0));

  const requestId = outbound[0].requestId;
  broker.handleServerFrame({
    type: 'agent_permission_prepare',
    requestId,
    behavior: 'allow',
    scope: 'once',
    decidedBy: 'Jason',
  });
  // Prepare ack must go out before commit.
  assert.equal(outbound[1].action, 'agent_permission_prepared');
  assert.equal(outbound[1].requestId, requestId);
  assert.equal(outbound[1].accepted, true);

  broker.handleServerFrame({ type: 'agent_permission_commit', requestId });
  const result = await pending;
  assert.equal(result.behavior, 'allow');
  assert.equal(result.scope, 'once');
  assert.equal(result.decidedBy, 'Jason');
  // once does not stick
  assert.deepEqual(broker.getSessionRules(), []);
  assert.deepEqual(broker.getPermanentRules(), []);
});

test('session grant is remembered for the rest of the job; always sticks permanently', async () => {
  const outbound = [];
  const broker = createPermissionBroker({
    send: (frame) => {
      outbound.push(frame);
      return true;
    },
    timeoutMs: 5000,
  });

  async function allow(scope, command) {
    const p = broker.request({
      jobId: 'job-s',
      toolName: 'Bash',
      title: `Bash(${command})`,
      rawInput: { command },
    });
    const req = outbound.filter((f) => f.action === 'agent_permission_request').at(-1);
    broker.handleServerFrame({
      type: 'agent_permission_prepare',
      requestId: req.requestId,
      behavior: 'allow',
      scope,
      decidedBy: 'Admin',
    });
    broker.handleServerFrame({ type: 'agent_permission_commit', requestId: req.requestId });
    return p;
  }

  await allow('session', 'git status');
  assert.ok(broker.getSessionRules().includes('Bash(git status:*)'));
  assert.equal(broker.getPermanentRules().length, 0);

  // Second identical call must NOT raise another request.
  const before = outbound.length;
  const second = await broker.request({
    jobId: 'job-s',
    toolName: 'Bash',
    title: 'Bash(git status)',
    rawInput: { command: 'git status' },
  });
  assert.equal(second.behavior, 'allow');
  assert.equal(second.scope, 'session');
  assert.equal(second.decidedBy, 'stored-rule');
  assert.equal(outbound.length, before, 'session grant must short-circuit without a new request');

  await allow('always', 'npx vitest');
  assert.ok(broker.getPermanentRules().includes('Bash(npx vitest:*)'));
  // always also counts as session for this process
  assert.ok(broker.getSessionRules().includes('Bash(npx vitest:*)'));

  const before2 = outbound.length;
  const third = await broker.request({
    jobId: 'job-s',
    toolName: 'Bash',
    title: 'Bash(npx vitest)',
    rawInput: { command: 'npx vitest' },
  });
  assert.equal(third.behavior, 'allow');
  assert.equal(third.scope, 'always');
  assert.equal(outbound.length, before2);
});

test('initialRules from agent.metadata.permission_rules auto-allow without a card', async () => {
  const outbound = [];
  const broker = createPermissionBroker({
    send: (frame) => {
      outbound.push(frame);
      return true;
    },
    initialRules: ['Bash(npx vitest:*)', 'Edit'],
  });
  const r = await broker.request({
    jobId: 'job-seed',
    toolName: 'Bash',
    rawInput: { command: 'npx vitest run' },
  });
  // deriveRules for "npx vitest run" → Bash(npx vitest:*) — prefix match on stored key
  // Wait - our isAllowedByStoredRules uses exact match on deriveRules keys, not prefix.
  // "npx vitest run" → body is "npx vitest" (two tokens) → Bash(npx vitest:*)
  assert.equal(r.behavior, 'allow');
  assert.equal(r.decidedBy, 'stored-rule');
  assert.equal(outbound.length, 0);

  const edit = await broker.request({ jobId: 'job-seed', toolName: 'Edit', title: 'Edit file' });
  assert.equal(edit.behavior, 'allow');
  assert.equal(outbound.length, 0);

  // Unrelated command still asks.
  const pending = broker.request({
    jobId: 'job-seed',
    toolName: 'Bash',
    rawInput: { command: 'curl evil.com' },
  });
  assert.equal(outbound.length, 1);
  // cleanup
  broker.handleServerFrame({
    type: 'agent_permission_prepare',
    requestId: outbound[0].requestId,
    behavior: 'deny',
  });
  broker.handleServerFrame({ type: 'agent_permission_commit', requestId: outbound[0].requestId });
  await pending;
});

test('broker deny on prepare+commit and abort path', async () => {
  const outbound = [];
  const broker = createPermissionBroker({
    send: (frame) => {
      outbound.push(frame);
      return true;
    },
    timeoutMs: 5000,
  });

  const pending = broker.request({
    jobId: 'job-2',
    toolName: 'Bash',
    title: 'Bash',
    rawInput: { command: 'echo hi' },
  });
  const requestId = outbound[0].requestId;
  broker.handleServerFrame({
    type: 'agent_permission_prepare',
    requestId,
    behavior: 'deny',
    message: 'Nope',
  });
  broker.handleServerFrame({ type: 'agent_permission_commit', requestId });
  const denied = await pending;
  assert.equal(denied.behavior, 'deny');
  assert.match(denied.message, /Nope/);

  const pending2 = broker.request({
    jobId: 'job-2',
    toolName: 'Edit',
    title: 'Edit',
  });
  const id2 = outbound.find((f) => f.action === 'agent_permission_request' && f.toolName === 'Edit').requestId;
  broker.handleServerFrame({
    type: 'agent_permission_abort',
    requestId: id2,
    message: 'Conversation closed',
  });
  const aborted = await pending2;
  assert.equal(aborted.behavior, 'deny');
  assert.match(aborted.message, /Conversation closed/);
});

test('Ask mode with onPermissionRequest allow/deny maps to nested ACP outcome', async () => {
  let callCount = 0;
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'default',
    autoApprove: false,
    onPermissionRequest: async () => {
      callCount += 1;
      return callCount === 1
        ? { behavior: 'allow', scope: 'once' }
        : { behavior: 'deny', message: 'blocked' };
    },
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    const allowed = await client.prompt('NEED_PERMISSION:Bash ls');
    assert.match(allowed.text, /Permitted/);
    const denied = await client.prompt('NEED_PERMISSION:Bash rm');
    assert.match(denied.text, /Denied/);
    assert.equal(callCount, 2);
  } finally {
    client.dispose();
  }
});

test('bridge register metadata advertises permissionDecisionReceipts and seeds rules', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron/acp/agentBridge.cjs'), 'utf8');
  assert.match(src, /permissionDecisionReceipts:\s*true/);
  assert.match(src, /agent_permission_request/);
  assert.match(src, /onPermissionRequest/);
  assert.match(src, /jobPermissionRules/);
  assert.match(src, /initialRules/);
  assert.match(src, /PermissionRequestCard|permissionBroker/);
});

test('client prefers onPermissionRequest over silent cancel', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron/acp/client.cjs'), 'utf8');
  assert.match(src, /permissionRequestHandler/);
  assert.match(src, /onPermissionRequest/);
  // Must not reintroduce silent cancel as the only Ask path.
  assert.match(src, /askPermissionViaDialog/);
});
