const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/agensis.mjs')).href;

async function loadTestApi() {
  const mod = await import(moduleUrl);
  return mod.__test;
}

test('daemon recognizes simple CursorBuddy control requests without invoking shell', async () => {
  const { parseCursorBuddyControlIntent } = await loadTestApi();

  assert.deepEqual(parseCursorBuddyControlIntent('Can you make him wave?'), {
    action: 'wave',
    text: '',
    source: 'agensis-native-control',
  });
  assert.deepEqual(parseCursorBuddyControlIntent('make the avatar say hello Jason'), {
    action: 'say',
    text: 'hello Jason',
    source: 'agensis-native-control',
  });
  assert.deepEqual(parseCursorBuddyControlIntent('open his options bubble'), {
    action: 'open',
    source: 'agensis-native-control',
  });
  assert.deepEqual(parseCursorBuddyControlIntent('hide the buddy dialog'), {
    action: 'hush',
    source: 'agensis-native-control',
  });
});

test('daemon recognizes wrapped CursorBuddy control requests from Agensis jobs', async () => {
  const { parseCursorBuddyControlIntent } = await loadTestApi();
  const wrapped = [
    'Conversation context follows.',
    'Previous assistant text mentioned command routing and local runtime setup.',
    'Diagnostic notes: '.repeat(40),
    'Latest user message: Can you make him wave?',
    'Return a useful response to the user.',
  ].join(' ');

  assert.deepEqual(parseCursorBuddyControlIntent(wrapped), {
    action: 'wave',
    text: '',
    source: 'agensis-native-control',
  });
});

test('daemon does not mistake discussion about control for a control command', async () => {
  const { parseCursorBuddyControlIntent } = await loadTestApi();

  assert.equal(parseCursorBuddyControlIntent("why can't it control the avatar?"), null);
  assert.equal(parseCursorBuddyControlIntent('review the avatar control architecture'), null);
  assert.equal(parseCursorBuddyControlIntent('tell me a joke'), null);
});

test('CursorBuddy daemon instructions do not route avatar control through curl', async () => {
  const { cursorBuddyControlInstructions } = await loadTestApi();
  const instructions = cursorBuddyControlInstructions({ cursorBuddyPort: 8787, cursorBuddyRuntime: true });

  assert.match(instructions, /handled by this daemon before the coding CLI starts/);
  assert.doesNotMatch(instructions, /\bcurl\b/);
  assert.doesNotMatch(instructions, /from the shell/);
  assert.doesNotMatch(instructions, /approval prompts/);
});

test('normal coding agents do not advertise CursorBuddy native control', async () => {
  const { cursorBuddyControlInstructions } = await loadTestApi();
  const instructions = cursorBuddyControlInstructions({
    cursorBuddyBridge: true,
    cursorBuddyRuntime: false,
    primaryDaemon: false,
    cursorBuddyPort: 8787,
  });

  assert.equal(instructions, '');
});

test('daemon reuses an existing CursorBuddy bridge on port collisions', async () => {
  const source = await require('node:fs/promises').readFile(path.join(repoRoot, 'agent/agensis-cli/src/agensis.mjs'), 'utf8');

  assert.match(source, /function isAddressInUseError\(error\)/);
  assert.match(source, /function probeExistingCursorBuddyBridge\(port\)/);
  assert.match(source, /CursorBuddy local bridge already running on http:\/\/127\.0\.0\.1:\$\{config\.cursorBuddyPort\}/);
  assert.doesNotMatch(source, /EADDRINUSE[\s\S]{0,220}CursorBuddy local bridge unavailable/);
});

test('daemon job runner queues CursorBuddy control before spawning the coding CLI', async () => {
  const [{ startCursorBuddyLocalBridge }, { __test }] = await Promise.all([
    import(pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/cursorbuddyLocalBridge.mjs')).href),
    import(moduleUrl),
  ]);
  const dir = await require('node:fs/promises').mkdtemp(path.join(require('node:os').tmpdir(), 'agensis-native-control-'));
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await require('node:fs/promises').writeFile(scriptPath, "throw new Error('coding CLI should not run for native CursorBuddy control');\n");
  const bridge = await startCursorBuddyLocalBridge({
    url: 'https://agensis.io',
    token: 'aga_test',
    workspace: 'ws-1',
    agent: 'agent-1',
    handle: 'mac',
    name: 'mac',
    cwd: dir,
    codingCmd: `${process.execPath} ${scriptPath}`,
    model: 'test-model',
    timeoutMs: 5000,
    heartbeatMs: 1000,
  }, { port: 0 });
  const ws = {
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(JSON.parse(data));
    },
  };

  try {
    await __test.runAgentJob({
      cwd: dir,
      codingCmd: `${process.execPath} ${scriptPath}`,
      model: 'test-model',
      permissionMode: 'default',
      timeoutMs: 5000,
      heartbeatMs: 1000,
      cursorBuddyBridge: true,
      cursorBuddyRuntime: true,
      cursorBuddyPort: bridge.port,
      once: false,
    }, {
      id: 'job-1',
      prompt: 'Can you make him wave?',
      ws,
    }, { signal: null });

    const pollResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=0`);
    const poll = await pollResponse.json();
    assert.equal(poll.commands.length, 1);
    assert.equal(poll.commands[0].action, 'wave');
    assert.equal(poll.commands[0].source, 'agensis-native-control');

    const result = ws.sent.find((message) => message.action === 'agent_job_result');
    assert.equal(result?.model, 'cursorbuddy-control');
    assert.equal(result?.permissionMode, 'native');
    assert.equal(result?.error, '');
    assert.match(result?.response || '', /wave command/);
  } finally {
    await bridge.close();
    await require('node:fs/promises').rm(dir, { recursive: true, force: true });
  }
});

test('normal coding agent does not turn avatar requests into CursorBuddy controls', async () => {
  const [{ startCursorBuddyLocalBridge }, { __test }] = await Promise.all([
    import(pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/cursorbuddyLocalBridge.mjs')).href),
    import(moduleUrl),
  ]);
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-coder-control-'));
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "process.stdout.write('coder stayed coder');\n");
  const bridge = await startCursorBuddyLocalBridge({
    url: 'https://agensis.io',
    token: 'aga_test',
    workspace: 'ws-1',
    agent: 'agent-1',
    handle: 'coder',
    name: 'Coder',
    cwd: dir,
    codingCmd: `${process.execPath} ${scriptPath}`,
    model: 'test-model',
    timeoutMs: 5000,
    heartbeatMs: 1000,
  }, { port: 0 });
  const ws = {
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(JSON.parse(data));
    },
  };

  try {
    await __test.runAgentJob({
      cwd: dir,
      codingCmd: `${process.execPath} ${scriptPath}`,
      model: 'test-model',
      permissionMode: 'default',
      timeoutMs: 5000,
      heartbeatMs: 1000,
      cursorBuddyBridge: true,
      cursorBuddyRuntime: false,
      primaryDaemon: false,
      cursorBuddyPort: bridge.port,
      once: false,
    }, {
      id: 'job-2',
      prompt: 'Can you make him wave?',
      ws,
    }, { signal: null });

    const pollResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=0`);
    const poll = await pollResponse.json();
    assert.equal(poll.commands.length, 0);

    const result = ws.sent.find((message) => message.action === 'agent_job_result');
    assert.equal(result?.model, 'test-model');
    assert.equal(result?.response, 'coder stayed coder');
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
