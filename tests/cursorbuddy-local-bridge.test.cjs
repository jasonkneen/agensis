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
      body: JSON.stringify({ messages: [{ role: 'user', content: 'say hello' }] }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(chat.choices[0].message.content, 'bridge reply');
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
