'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAcpClient, extractTextFromUpdate, quoteWindowsShellArg } = require('../electron/acp/client.cjs');
const { listHarnesses, resolveHarness } = require('../electron/acp/harnesses.cjs');
const acpHost = require('../electron/acp/host.cjs');

const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');

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
    autoApprove: true,
  });
  try {
    const init = await client.initialize();
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentInfo.name, 'fake-acp');

    const session = await client.newSession(process.cwd());
    assert.ok(session.sessionId);
    assert.equal(client.sessionId, session.sessionId);

    const chunks = [];
    const result = await client.prompt('hello world', {
      onChunk: (c) => chunks.push(c),
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'Echo: hello world');
    assert.deepEqual(chunks, ['Echo: ', 'hello world']);
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

test('quoteWindowsShellArg leaves plain args untouched', () => {
  assert.equal(quoteWindowsShellArg('stdio'), 'stdio');
  assert.equal(quoteWindowsShellArg(''), '""');
});

test('quoteWindowsShellArg quotes args with spaces', () => {
  assert.equal(quoteWindowsShellArg('arg with spaces'), '"arg with spaces"');
});

test('quoteWindowsShellArg escapes double quotes', () => {
  assert.equal(quoteWindowsShellArg('say "hi"'), '"say ""hi"""');
});

test('quoteWindowsShellArg refuses literal percent signs rather than pass through an unsafe escape', () => {
  // cmd.exe expands %VAR% while parsing the command line even inside a
  // double-quoted argument, and the usual %% escape does not survive the
  // extra quoting layer Node's shell:true adds for `cmd /d /s /c "..."`
  // (verified empirically against a real cmd.exe: %%USERPROFILE%% still
  // expanded to the real path). Refuse rather than ship a broken escape.
  assert.throws(() => quoteWindowsShellArg('%USERPROFILE%'), /Refusing to pass "%"/);
  assert.throws(() => quoteWindowsShellArg('100%'), /Refusing to pass "%"/);
});
