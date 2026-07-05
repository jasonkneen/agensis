const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/connectProfiles.mjs')).href;

async function loadModule() {
  return import(moduleUrl);
}

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agensis-cli-profiles-'));
}

test('daemon profiles persist a complete main agent connect command securely', async () => {
  const {
    daemonProfilePath,
    readDaemonProfile,
    writeDaemonProfile,
  } = await loadModule();
  const home = await tempHome();
  try {
    const filePath = await writeDaemonProfile('default', {
      url: 'http://localhost:61447',
      token: 'aga_secret_token',
      workspace: 'ws-1',
      agent: 'agent-1',
      handle: 'mac',
      name: 'mac',
      cwd: '/Users/jkneen/Documents/GitHub/3Dpet',
      model: 'claude-opus-4-8',
      permissionMode: 'accept_edits',
      exitOnOnce: true,
      onRegistered: () => {},
    }, { homedir: home });

    assert.equal(filePath, daemonProfilePath('default', { homedir: home }));
    const stat = await fs.stat(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
    const cached = await readDaemonProfile('default', { homedir: home });
    assert.deepEqual(cached, {
      url: 'http://localhost:61447',
      token: 'aga_secret_token',
      workspace: 'ws-1',
      agent: 'agent-1',
      handle: 'mac',
      name: 'mac',
      cwd: '/Users/jkneen/Documents/GitHub/3Dpet',
      model: 'claude-opus-4-8',
      permissionMode: 'accept_edits',
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('daemon profile merge lets one-off flags override the cached profile', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'http://localhost:61447',
    token: 'aga_secret_token',
    workspace: 'ws-1',
    agent: 'agent-1',
    cwd: '/old',
    model: 'claude-opus-4-8',
  }, {
    cwd: '/new',
    model: 'claude-fable-5',
    once: true,
  });

  assert.equal(merged.command, 'connect');
  assert.equal(merged.url, 'http://localhost:61447');
  assert.equal(merged.token, 'aga_secret_token');
  assert.equal(merged.cwd, '/new');
  assert.equal(merged.model, 'claude-fable-5');
  assert.equal(merged.once, true);
});

test('daemon profile merge disables CursorBuddy bridge for non-primary saved agents', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'http://localhost:61447',
    token: 'aga_secret_token',
    workspace: 'ws-1',
    agent: 'coder-agent',
    handle: 'coder',
    name: 'Coder',
    cursorBuddyBridge: true,
  }, {});

  assert.equal(merged.cursorBuddyBridge, false);
});

test('daemon profile merge preserves CursorBuddy bridge for the primary daemon', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'http://localhost:61447',
    token: 'aga_secret_token',
    workspace: 'ws-1',
    agent: 'main-agent',
    handle: 'ozbook-m3-4-local',
    name: 'OzBook-M3-4.local',
    primaryDaemon: true,
    cursorBuddyBridge: true,
  }, {});

  assert.equal(merged.primaryDaemon, true);
  assert.equal(merged.cursorBuddyBridge, true);
});

test('explicit CursorBuddy bridge flag can opt a non-primary daemon back in', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'http://localhost:61447',
    token: 'aga_secret_token',
    workspace: 'ws-1',
    agent: 'coder-agent',
    handle: 'coder',
    name: 'Coder',
    cursorBuddyBridge: false,
  }, {
    cursorBuddyBridge: true,
  });

  assert.equal(merged.cursorBuddyBridge, true);
});

test('bare connect setup message points users at Agensis setup first', async () => {
  const { daemonProfileSetupMessage } = await loadModule();
  const message = daemonProfileSetupMessage('default');
  assert.match(message, /No saved Agensis daemon profile/);
  assert.match(message, /Run: agensis setup/);
  assert.match(message, /primary local agent/);
  assert.match(message, /copy a connection command/);
  assert.match(message, /agensis connect/);
});
