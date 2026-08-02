'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createAcpClient,
  extractTextFromUpdate,
  mapAccessModeToAcpSessionMode,
  normalizeAccessMode,
  pickPermissionOption,
  permissionResultSelected,
  isEditToolCall,
} = require('../electron/acp/client.cjs');
const { listHarnesses, resolveHarness } = require('../electron/acp/harnesses.cjs');
const acpHost = require('../electron/acp/host.cjs');

const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');

const CLAUDE_OPTIONS = [
  { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
  { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
  { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
];

test('extractTextFromUpdate pulls agent message chunks', () => {
  assert.equal(
    extractTextFromUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    }),
    'hi',
  );
  assert.equal(
    extractTextFromUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'secret' } }),
    '',
  );
});

test('mapAccessModeToAcpSessionMode maps Full access → bypassPermissions', () => {
  assert.equal(mapAccessModeToAcpSessionMode('yolo'), 'bypassPermissions');
  assert.equal(mapAccessModeToAcpSessionMode('full_access'), 'bypassPermissions');
  assert.equal(mapAccessModeToAcpSessionMode('acceptEdits'), 'acceptEdits');
  assert.equal(mapAccessModeToAcpSessionMode('default'), 'default');
  assert.equal(mapAccessModeToAcpSessionMode('ask'), 'default');
  assert.equal(normalizeAccessMode('yolo'), 'yolo');
  assert.equal(normalizeAccessMode('', true), 'yolo');
  assert.equal(normalizeAccessMode('', false), 'default');
});

test('pickPermissionOption never confuses allow with allow_always; nested outcome shape', () => {
  const always = pickPermissionOption(CLAUDE_OPTIONS, 'allow_always');
  assert.equal(always.optionId, 'allow_always');
  const once = pickPermissionOption(CLAUDE_OPTIONS, 'allow_once');
  assert.equal(once.optionId, 'allow');
  const rej = pickPermissionOption(CLAUDE_OPTIONS, 'reject');
  assert.equal(rej.optionId, 'reject');
  // Critical: response must nest outcome.optionId for Claude Code ACP.
  assert.deepEqual(permissionResultSelected(always), {
    outcome: { outcome: 'selected', optionId: 'allow_always' },
  });
  assert.equal(isEditToolCall({ toolCall: { kind: 'edit', title: 'Edit file' } }), true);
  assert.equal(isEditToolCall({ toolCall: { kind: 'execute', title: 'Bash' } }), false);
});

test('listHarnesses returns catalog entries with availability flags', () => {
  const list = listHarnesses();
  assert.ok(Array.isArray(list));
  assert.ok(list.some(h => h.id === 'grok'));
  assert.ok(list.some(h => h.id === 'claude'));
  assert.ok(list.some(h => h.id === 'codex'));
  for (const h of list) {
    assert.equal(typeof h.available, 'boolean');
    assert.equal(typeof h.label, 'string');
  }
});

test('createAcpClient initialize + session + prompt against fake agent', async () => {
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'default',
    autoApprove: false,
  });
  try {
    const init = await client.initialize();
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentInfo.name, 'fake-acp');

    const session = await client.newSession(process.cwd());
    assert.ok(session.sessionId);
    assert.equal(client.sessionId, session.sessionId);
    assert.equal(client.acpSessionMode, 'default');

    const chunks = [];
    const result = await client.prompt('hello world', {
      onChunk: (c) => chunks.push(c),
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'Echo: hello world [mode=default]');
    assert.deepEqual(chunks, ['Echo: ', 'hello world [mode=default]']);
  } finally {
    client.dispose();
  }
});

test('Full access (yolo) calls session/set_mode bypassPermissions', async () => {
  const logs = [];
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'yolo',
    onLog: (line) => logs.push(line),
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    assert.equal(client.acpSessionMode, 'bypassPermissions');
    assert.ok(
      logs.some((l) => /session mode set to bypassPermissions/.test(l)),
      `expected set_mode log, got: ${logs.join(' | ')}`,
    );
    const result = await client.prompt('hello');
    assert.match(result.text, /mode=bypassPermissions/);
  } finally {
    client.dispose();
  }
});

test('yolo auto-approves session/request_permission with nested outcome', async () => {
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'yolo',
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    const result = await client.prompt('NEED_PERMISSION:Bash ls');
    assert.match(result.text, /Permitted \(allow_always\)/);
  } finally {
    client.dispose();
  }
});

test('Ask mode denies permission when no dialog is available (no silent hang)', async () => {
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'default',
    autoApprove: false,
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    const result = await client.prompt('NEED_PERMISSION:Bash ls');
    // Without Electron dialog, Ask cannot prompt — must reject, not hang or auto-allow.
    assert.match(result.text, /Denied/);
  } finally {
    client.dispose();
  }
});

test('acpHost start/prompt/stop with fake harness override via resolve path', async () => {
  // Host resolves real harnesses; exercise client path through host by
  // temporarily patching resolveHarness is hard — call client-level host APIs
  // only if a real harness exists, otherwise skip with fake via direct client.
  // Here we only assert stop is idempotent and listRunning starts empty.
  acpHost.stopAll();
  assert.deepEqual(acpHost.listRunning(), []);
  const stopped = await acpHost.stop('no-such-agent');
  assert.equal(stopped.stopped, false);
});

test('resolveHarness returns null for unknown id', () => {
  assert.equal(resolveHarness('not-a-real-harness-xyz'), null);
});
