const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/connectProfiles.mjs')).href;
const agentModuleUrl = pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/agensis.mjs')).href;

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
      share: true,
      sharedModelsFile: '/Users/jkneen/models.json',
      noCoding: true,
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
      share: true,
      sharedModelsFile: '/Users/jkneen/models.json',
      noCoding: true,
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

test('full CLI context opt-out survives the saved-profile merge path', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const { __test: agentTest } = await import(agentModuleUrl);
  const merged = mergeDaemonProfile({
    url: 'https://agensis.test', token: 'aga_secret', workspace: 'workspace-1', agent: 'agent-1', leanCli: true,
  }, { fullCliContext: true });
  const normalized = agentTest.normalizeConfig(merged);
  assert.equal(normalized.leanCli, false);
});

test('legacy profiles migrate the old persisted concurrency default from eight to two', async () => {
  const { daemonProfilePath, readDaemonProfile } = await loadModule();
  const home = await tempHome();
  try {
    const filePath = daemonProfilePath('legacy', { homedir: home });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      config: {
        url: 'https://agensis.test',
        token: 'aga_secret',
        workspace: 'workspace-1',
        agent: 'agent-1',
        maxConcurrency: 8,
      },
    }));
    const profile = await readDaemonProfile('legacy', { homedir: home });
    assert.equal(profile.maxConcurrency, 2);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('an explicit coding command re-enables a saved no-coding profile', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'https://agensis.test', token: 'aga_secret', workspace: 'workspace-1', agent: 'agent-1', noCoding: true,
  }, { codingCmd: 'codex exec' });
  assert.equal(merged.codingCmd, 'codex exec');
  assert.equal(merged.noCoding, false);
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

test('normalized no-coding state survives the real profile write and read path', async () => {
  const { readDaemonProfile, writeDaemonProfile } = await loadModule();
  const { __test: agentTest } = await import(agentModuleUrl);
  const home = await tempHome();
  try {
    const config = agentTest.normalizeConfig({
      url: 'https://agensis.test', token: 'aga_secret', workspace: 'workspace-1', agent: 'agent-1', noCoding: true,
    });
    await writeDaemonProfile('shared-only', config, { homedir: home });
    const stored = await readDaemonProfile('shared-only', { homedir: home });
    assert.equal(stored.noCoding, true);
    assert.equal(stored.codingCmd, undefined);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
