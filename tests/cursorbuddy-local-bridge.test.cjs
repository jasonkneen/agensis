const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/cursorbuddyLocalBridge.mjs')).href;
const BRIDGE_TEST_SECRET = 'cbs_test_secret_for_unit_tests_only_xx';

async function loadModule() {
  return import(moduleUrl);
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agensis-cursorbuddy-bridge-'));
}

function bridgeAuthHeaders(extra = {}) {
  return {
    authorization: `Bearer ${BRIDGE_TEST_SECRET}`,
    'x-agensis-bridge-secret': BRIDGE_TEST_SECRET,
    ...extra,
  };
}

const bridgeStartOptions = { port: 0, authSecret: BRIDGE_TEST_SECRET };

test('CursorBuddy local bridge rejects unauthenticated mutating routes and accepts valid secret', async () => {
  const { startCursorBuddyLocalBridge, createBridgeAuthSecret, bridgeRequestAuthorized } = await loadModule();
  assert.match(createBridgeAuthSecret(), /^cbs_/);
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "process.stdout.write(JSON.stringify({ result: 'authed reply' }));\n");

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
  }, bridgeStartOptions);

  try {
    assert.equal(bridge.secret, BRIDGE_TEST_SECRET);
    assert.equal(
      bridgeRequestAuthorized({ headers: { authorization: `Bearer ${BRIDGE_TEST_SECRET}` } }, BRIDGE_TEST_SECRET),
      true,
    );
    assert.equal(
      bridgeRequestAuthorized({ headers: {} }, BRIDGE_TEST_SECRET),
      false,
    );

    const health = await fetch(`${bridge.url}/cursorbuddy/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.authRequired, true);

    const unauthChat = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(unauthChat.status, 401);

    const unauthEdit = await fetch(`${bridge.url}/cursorbuddy/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { selector: '#x' } }),
    });
    assert.equal(unauthEdit.status, 401);

    const unauthControl = await fetch(`${bridge.url}/cursorbuddy/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'wave' }),
    });
    assert.equal(unauthControl.status, 401);

    const authedChat = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(authedChat.status, 200);
    const chat = await authedChat.json();
    assert.equal(chat.choices[0].message.content, 'authed reply');

    const authedControl = await fetch(`${bridge.url}/cursorbuddy/control`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ action: 'wave', text: 'Hi' }),
    });
    assert.equal(authedControl.status, 200);
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

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
  }, bridgeStartOptions);

  try {
    const healthResponse = await fetch(`${bridge.url}/cursorbuddy/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.runtime, 'agensis-cli');
    assert.equal(health.connection.connected, false);
    assert.equal(health.connection.mode, 'agensis-cli-unclaimed');
    assert.equal(health.connection.agentId, 'agent-1');
    assert.equal(health.connection.workspaceId, 'ws-1');
    assert.equal(health.model, 'claude-haiku-4-5');
    assert.equal(health.daemonModel, 'test-model');
    assert.equal(health.chatStream, true);
    assert.equal(health.capabilities.chatStream, true);
    assert.equal(health.capabilities.fastAvatarReplies, false);
    assert.equal(health.capabilities.nativeCursorBuddyControl, true);
    assert.equal(health.latestControlId, 0);
    assert.match(health.endpoints.chatStream, /\/v1\/chat\/completions$/);
    assert.match(health.endpoints.control, /\/cursorbuddy\/control$/);
    assert.match(health.endpoints.controlStream, /\/cursorbuddy\/control\/stream$/);

    const contextResponse = await fetch(`${bridge.url}/cursorbuddy/context`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ url: 'https://example.com/page', title: 'Example', surface: 'browser_extension' }),
    });
    assert.equal(contextResponse.status, 200);
    const contextBody = await contextResponse.json();
    assert.equal(contextBody.context.url, 'https://example.com/page');

    const chatResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
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

test('CursorBuddy local bridge sends normal chat to the configured local command', async () => {
  const { startCursorBuddyLocalBridge } = await loadModule();
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "process.stdout.write(JSON.stringify({ result: 'local command reply' }));\n");

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
  }, bridgeStartOptions);

  try {
    const wrapped = `${'page context '.repeat(16)} user typed: tell me a joke`;
    const chatResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: wrapped }] }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(chat.model, 'claude-haiku-4-5');
    assert.equal(chat.choices[0].message.content, 'local command reply');

    const siteResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'what site am I on?' }] }),
    });
    assert.equal(siteResponse.status, 200);
    const site = await siteResponse.json();
    assert.equal(site.model, 'claude-haiku-4-5');
    assert.equal(site.choices[0].message.content, 'local command reply');
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CursorBuddy local bridge does not treat bare wave as an avatar control', async () => {
  const { startCursorBuddyLocalBridge } = await loadModule();
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "process.stdout.write(JSON.stringify({ result: 'chat handled wave text' }));\n");

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
  }, bridgeStartOptions);

  try {
    const chatResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'wave' }] }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(chat.model, 'claude-haiku-4-5');
    assert.equal(chat.choices[0].message.content, 'chat handled wave text');

    const pollResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=0`, { headers: bridgeAuthHeaders() });
    assert.equal(pollResponse.status, 200);
    const poll = await pollResponse.json();
    assert.deepEqual(poll.commands, []);
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
  }, bridgeStartOptions);

  try {
    const chatResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Can you make him wave?' }] }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(chat.model, 'cursorbuddy-local-control');
    assert.equal(chat.choices[0].message.content, 'Waving now.');

    const pollResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=0`, { headers: bridgeAuthHeaders() });
    assert.equal(pollResponse.status, 200);
    const poll = await pollResponse.json();
    assert.equal(poll.commands.length, 1);
    assert.equal(poll.commands[0].action, 'wave');
    assert.equal(poll.commands[0].text, 'Hi. How can I help?');

    const sayResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'say hello' }] }),
    });
    assert.equal(sayResponse.status, 200);
    const say = await sayResponse.json();
    assert.equal(say.model, 'cursorbuddy-local-control');
    assert.equal(say.choices[0].message.content, 'Saying it now.');

    const secondPollResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=1`, { headers: bridgeAuthHeaders() });
    assert.equal(secondPollResponse.status, 200);
    const secondPoll = await secondPollResponse.json();
    assert.equal(secondPoll.commands.length, 1);
    assert.equal(secondPoll.commands[0].action, 'say');
    assert.equal(secondPoll.commands[0].text, 'hello');
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
  }, bridgeStartOptions);

  try {
    const chatResponse = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
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
  }, bridgeStartOptions);

  try {
    const controlResponse = await fetch(`${bridge.url}/cursorbuddy/control`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ action: 'wave', text: 'hello from agensis' }),
    });
    assert.equal(controlResponse.status, 200);
    const control = await controlResponse.json();
    assert.equal(control.ok, true);
    assert.equal(control.command.action, 'wave');

    const pollResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=0`, { headers: bridgeAuthHeaders() });
    assert.equal(pollResponse.status, 200);
    const poll = await pollResponse.json();
    assert.equal(poll.commands.length, 1);
    assert.equal(poll.commands[0].text, 'hello from agensis');
    assert.equal(poll.latestId, control.command.id);

    const emptyResponse = await fetch(`${bridge.url}/cursorbuddy/control?after=${control.command.id}`, { headers: bridgeAuthHeaders() });
    const empty = await emptyResponse.json();
    assert.deepEqual(empty.commands, []);
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CursorBuddy local bridge claims account connection keys for the local site', async () => {
  const { startCursorBuddyLocalBridge } = await loadModule();
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "process.stdout.write(JSON.stringify({ result: 'ok' }));\n");
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      data: {
        workspaceId: 'ws-claimed',
        agentId: 'agent-claimed',
        handle: 'cursorbuddy',
        command: 'agensis connect --profile cursorbuddy --url https://agensis.io --token aga_claimed',
        agent: {
          id: 'agent-claimed',
          workspace_id: 'ws-claimed',
          handle: 'cursorbuddy',
          name: 'CursorBuddy Extension',
        },
      },
      error: null,
    }), {
      status: 200,
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
    });
  };

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
  }, { ...bridgeStartOptions, fetchImpl });

  try {
    const connectResponse = await fetch(`${bridge.url}/cursorbuddy/connect`, {
      method: 'POST',
      headers: bridgeAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        key: 'cbk_website_avatar_ABCDEFGHJKLMNPQRST',
        agensisUrl: 'https://agensis.io',
        workspaceId: 'ws-claimed',
        surface: 'browser_extension',
        name: 'CursorBuddy Extension',
        metadata: {
          websiteSource: 'https://example.com/app',
          page: { url: 'https://example.com/app', hostname: 'example.com', title: 'Example app' },
          client: { userAgent: 'Chrome CursorBuddy Test', platform: 'macOS' },
          runtime: { surface: 'extension', instanceId: 'cb-ext-test' },
          manifest: { name: 'Example Buddy', version: '1' },
        },
      }),
    });
    assert.equal(connectResponse.status, 200);
    const connect = await connectResponse.json();
    assert.equal(connect.ok, true);
    assert.equal(connect.connection.mode, 'agensis-claimed');
    assert.equal(connect.connection.agentId, 'agent-claimed');
    assert.equal(connect.connection.workspaceId, 'ws-claimed');
    assert.equal(connect.connection.handle, 'cursorbuddy');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://agensis.io/backend/cursorbuddy/connection-keys/claim');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.key, 'cbk_website_avatar_ABCDEFGHJKLMNPQRST');
    assert.equal(body.runtimeKind, 'agensis-cli-local-bridge');
    assert.equal(body.surface, 'browser_extension');
    assert.equal(body.websiteSource, 'https://example.com/app');
    assert.equal(body.metadata.page.hostname, 'example.com');
    assert.equal(body.client.userAgent, 'Chrome CursorBuddy Test');

    const healthResponse = await fetch(`${bridge.url}/cursorbuddy/health`);
    const health = await healthResponse.json();
    assert.equal(health.connection.mode, 'agensis-claimed');
    assert.equal(health.connection.agentId, 'agent-claimed');
    assert.equal(health.context.url, 'https://example.com/app');
    assert.equal(health.context.client.userAgent, 'Chrome CursorBuddy Test');
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CursorBuddy local bridge health follows the live daemon registration heartbeat', async () => {
  const { startCursorBuddyLocalBridge } = await loadModule();
  const dir = await tempDir();
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  await fs.writeFile(scriptPath, "process.stdout.write(JSON.stringify({ result: 'ok' }));\n");
  let registered = true;

  const bridge = await startCursorBuddyLocalBridge({
    url: 'https://agensis.io',
    token: 'aga_test',
    workspace: 'ws-1',
    agent: 'agent-1',
    handle: 'cursorbuddy',
    name: 'CursorBuddy',
    cwd: dir,
    codingCmd: `${process.execPath} ${scriptPath}`,
    model: 'test-model',
    cursorBuddyRuntime: true,
    timeoutMs: 5000,
    heartbeatMs: 1000,
  }, {
    port: 0,
    connectionProvider: () => ({
      connected: registered,
      mode: 'agensis-cli',
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      handle: 'cursorbuddy',
    }),
  });

  try {
    const readyResponse = await fetch(`${bridge.url}/cursorbuddy/health`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json();
    assert.equal(ready.connection.connected, true);
    assert.equal(ready.connection.mode, 'agensis-cli');

    registered = false;
    const staleResponse = await fetch(`${bridge.url}/cursorbuddy/health`);
    assert.equal(staleResponse.status, 200);
    const stale = await staleResponse.json();
    assert.equal(stale.connection.connected, false);
    assert.equal(stale.connection.mode, 'agensis-cli');
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
  assert.match(source, /function fastAvatarControl\(payload\)/);
  assert.match(source, /function compactFastIntentText\(payload/);
  assert.match(source, /nativeCursorBuddyControl: true/);
  assert.match(source, /fastAvatarReplies: false/);
  assert.match(source, /function fastBridgeResult\(payload\)/);
  assert.match(source, /record\("chat_control"/);
  assert.doesNotMatch(source, /FAST_CHAT_PATTERNS/);
  assert.doesNotMatch(source, /cursorbuddy-local-fast/);
  assert.match(source, /function createStreamJsonParser\(onDelta = \(\) => \{\}\)/);
  assert.match(source, /payload\.stream === true/);
});
