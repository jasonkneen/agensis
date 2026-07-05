const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/cursorbuddyLocalBridge.mjs')).href;

async function loadModule() {
  return import(moduleUrl);
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agensis-cursorbuddy-bridge-'));
}

test('CursorBuddy local bridge exposes daemon health, context, and chat', async () => {
  const { startCursorBuddyLocalBridge } = await loadModule();
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "process.stdout.write(JSON.stringify({ result: 'bridge reply' }));\n");

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

  try {
    const healthResponse = await fetch(`${bridge.url}/cursorbuddy/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.runtime, 'agensis-cli');
    assert.equal(health.connection.connected, true);
    assert.equal(health.connection.agentId, 'agent-1');
    assert.equal(health.connection.workspaceId, 'ws-1');
    assert.equal(health.model, 'claude-haiku-4-5');
    assert.equal(health.daemonModel, 'test-model');
    assert.match(health.endpoints.control, /\/cursorbuddy\/control$/);
    assert.match(health.endpoints.controlStream, /\/cursorbuddy\/control\/stream$/);

    const contextResponse = await fetch(`${bridge.url}/cursorbuddy/context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page', title: 'Example', surface: 'browser_extension' }),
    });
    assert.equal(contextResponse.status, 200);
    const contextBody = await contextResponse.json();
    assert.equal(contextBody.context.url, 'https://example.com/page');

    const chatResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'explain this page' }] }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(chat.choices[0].message.content, 'bridge reply');
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CursorBuddy local bridge answers trivial avatar chat without spawning the coding CLI', async () => {
  const { startCursorBuddyLocalBridge } = await loadModule();
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "throw new Error('CLI should not be called for fast chat');\n");

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

  try {
    const chatResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'tell me a joke' }] }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(chat.model, 'cursorbuddy-local-fast');
    assert.match(chat.choices[0].message.content, /cursor/);
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CursorBuddy local bridge turns avatar commands into queued control actions', async () => {
  const { startCursorBuddyLocalBridge } = await loadModule();
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "throw new Error('CLI should not be called for avatar control');\n");

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

  try {
    const chatResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Can you make him wave?' }] }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(chat.model, 'cursorbuddy-local-control');
    assert.equal(chat.choices[0].message.content, 'Waving now.');

    const pollResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=0`);
    assert.equal(pollResponse.status, 200);
    const poll = await pollResponse.json();
    assert.equal(poll.commands.length, 1);
    assert.equal(poll.commands[0].action, 'wave');
    assert.equal(poll.commands[0].text, 'Hi. How can I help?');
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CursorBuddy local bridge streams OpenAI-compatible chat chunks', async () => {
  const { startCursorBuddyLocalBridge } = await loadModule();
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "process.stdout.write('first '); setTimeout(() => process.stdout.write('second'), 20);\n");

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

  try {
    const chatResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'stream this' }] }),
    });
    assert.equal(chatResponse.status, 200);
    assert.match(chatResponse.headers.get('content-type') || '', /text\/event-stream/);
    const body = await chatResponse.text();
    assert.match(body, /"object":"chat\.completion\.chunk"/);
    assert.match(body, /"content":"first "/);
    assert.match(body, /"content":"second"/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CursorBuddy local bridge queues avatar control commands', async () => {
  const { startCursorBuddyLocalBridge } = await loadModule();
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "process.stdout.write(JSON.stringify({ result: 'ok' }));\n");

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

  try {
    const controlResponse = await fetch(`${bridge.url}/cursorbuddy/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'wave', text: 'hello from agensis' }),
    });
    assert.equal(controlResponse.status, 200);
    const control = await controlResponse.json();
    assert.equal(control.ok, true);
    assert.equal(control.command.action, 'wave');

    const pollResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=0`);
    assert.equal(pollResponse.status, 200);
    const poll = await pollResponse.json();
    assert.equal(poll.commands.length, 1);
    assert.equal(poll.commands[0].text, 'hello from agensis');
    assert.equal(poll.latestId, control.command.id);

    const emptyResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=${control.command.id}`);
    const empty = await emptyResponse.json();
    assert.deepEqual(empty.commands, []);
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CursorBuddy local bridge does not treat daemon commands as model ids', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'agent/agensis-cli/src/cursorbuddyLocalBridge.mjs'), 'utf8');

  assert.match(source, /function modelLooksLikeCommand\(value\)/);
  assert.match(source, /function requestedModelForLocalBridge\(requestedModel, fallbackModel\)/);
  assert.match(source, /modelLooksLikeCommand\(model\)/);
  assert.match(source, /const DEFAULT_CURSORBUDDY_CONVERSATION_MODEL = "claude-haiku-4-5"/);
  assert.match(source, /function normalizeCursorBuddyModel\(value\)/);
  assert.match(source, /model === "haiku-4\.5"/);
  assert.match(source, /function cursorBuddyConversationModel\(config = \{\}\)/);
  assert.match(source, /function fastLocalReply\(payload, context\)/);
  assert.match(source, /function fastAvatarControl\(payload\)/);
  assert.match(source, /function fastBridgeResult\(payload\)/);
  assert.match(source, /record\("chat_control"/);
  assert.match(source, /function createStreamJsonParser\(onDelta = \(\) => \{\}\)/);
  assert.match(source, /payload\.stream === true/);
});
