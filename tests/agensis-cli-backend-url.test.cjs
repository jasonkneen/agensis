const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/agensis.mjs')).href;

async function loadModule() {
  return import(moduleUrl);
}

test('local frontend URLs resolve to the local daemon websocket backend', async () => {
  const { agentBackendUrl } = await loadModule();

  assert.equal(agentBackendUrl('http://localhost:61447').href, 'http://127.0.0.1:3142/');
  assert.equal(agentBackendUrl('http://localhost:5173').href, 'http://127.0.0.1:3142/');
  assert.equal(agentBackendUrl('http://127.0.0.1:8888').href, 'http://127.0.0.1:3142/');
  assert.equal(agentBackendUrl('http://127.0.0.1:3142').href, 'http://127.0.0.1:3142/');
  assert.equal(agentBackendUrl('http://127.0.0.1:4000').href, 'http://127.0.0.1:4000/');
});
