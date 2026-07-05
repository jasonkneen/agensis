const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'agent/agensis-cli/src/cursorbuddyConnect.mjs')).href;
const connectionKey = 'cbk_website_avatar_7K85TL8BBERYVMVF98';

async function loadModule() {
  return import(moduleUrl);
}

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agensis-cursorbuddy-cache-'));
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test('CursorBuddy buddy connect caches a successful daemon claim locally', async () => {
  const { claimCursorBuddyConnectionKey, cursorBuddyKeyCachePath } = await loadModule();
  const home = await tempHome();
  try {
    const calls = [];
    const daemonArgs = await claimCursorBuddyConnectionKey({
      key: connectionKey,
      url: 'http://localhost:61447/',
      cwd: '/Users/jkneen/Documents/GitHub/3Dpet',
      permissionMode: 'accept_edits',
    }, {
      homedir: home,
      hostname: 'OzBook-M3-4.local',
      cwd: '/fallback/cwd',
      version: 'test-version',
      fetchImpl: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return jsonResponse(200, {
          data: {
            token: 'aga_claimed_token',
            workspaceId: 'ws-1',
            agentId: 'agent-1',
            baseUrl: 'http://localhost:61447',
            handle: 'cursorbuddy-website-avatar',
            model: 'claude-opus-4-8',
            permissionMode: 'accept_edits',
            agent: {
              id: 'agent-1',
              workspace_id: 'ws-1',
              name: 'mac',
            },
          },
        });
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:61447/backend/cursorbuddy/connection-keys/claim');
    assert.equal(calls[0].body.host, 'OzBook-M3-4.local');
    assert.equal(calls[0].body.runtimeKind, 'agensis-cli');
    assert.equal(daemonArgs.command, 'connect');
    assert.equal(daemonArgs.url, 'http://localhost:61447');
    assert.equal(daemonArgs.token, 'aga_claimed_token');
    assert.equal(daemonArgs.workspace, 'ws-1');
    assert.equal(daemonArgs.agent, 'agent-1');
    assert.equal(daemonArgs.handle, 'cursorbuddy-website-avatar');
    assert.equal(daemonArgs.name, 'mac');
    assert.equal(daemonArgs.cwd, '/Users/jkneen/Documents/GitHub/3Dpet');
    assert.equal(daemonArgs.cursorBuddyRuntime, true);
    assert.equal(daemonArgs.key, undefined);

    const cachePath = cursorBuddyKeyCachePath(connectionKey, { homedir: home });
    const stat = await fs.stat(cachePath);
    assert.equal(stat.mode & 0o777, 0o600);
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    assert.equal(cached.daemonArgs.token, 'aga_claimed_token');
    assert.equal(cached.daemonArgs.cursorBuddyRuntime, true);
    assert.equal(cached.daemonArgs.key, undefined);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('CursorBuddy buddy connect restarts from cache when a key was already claimed', async () => {
  const {
    claimCursorBuddyConnectionKey,
    writeCachedCursorBuddyDaemonArgs,
  } = await loadModule();
  const home = await tempHome();
  try {
    await writeCachedCursorBuddyDaemonArgs(connectionKey, {
      command: 'connect',
      url: 'http://localhost:61447',
      token: 'aga_cached_token',
      workspace: 'ws-1',
      agent: 'agent-1',
      cwd: '/old/cwd',
      model: 'claude-opus-4-8',
      permissionMode: 'accept_edits',
    }, { homedir: home });

    const daemonArgs = await claimCursorBuddyConnectionKey({
      key: connectionKey,
      url: 'http://localhost:61447',
      cwd: '/Users/jkneen/Documents/GitHub/3Dpet',
      model: 'claude-fable-5',
      permissionMode: 'yolo',
    }, {
      homedir: home,
      fetchImpl: async () => jsonResponse(409, {
        error: { message: 'CursorBuddy connection key has already been claimed' },
      }),
    });

    assert.equal(daemonArgs.command, 'connect');
    assert.equal(daemonArgs.url, 'http://localhost:61447');
    assert.equal(daemonArgs.token, 'aga_cached_token');
    assert.equal(daemonArgs.workspace, 'ws-1');
    assert.equal(daemonArgs.agent, 'agent-1');
    assert.equal(daemonArgs.cwd, '/Users/jkneen/Documents/GitHub/3Dpet');
    assert.equal(daemonArgs.model, 'claude-fable-5');
    assert.equal(daemonArgs.permissionMode, 'yolo');
    assert.equal(daemonArgs.cursorBuddyRuntime, true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('CursorBuddy buddy connect reports a useful error when an old claimed key has no cache', async () => {
  const { claimCursorBuddyConnectionKey } = await loadModule();
  const home = await tempHome();
  try {
    await assert.rejects(
      claimCursorBuddyConnectionKey({
        key: connectionKey,
        url: 'http://localhost:61447',
      }, {
        homedir: home,
        fetchImpl: async () => jsonResponse(409, {
          error: { message: 'CursorBuddy connection key has already been claimed' },
        }),
      }),
      /No cached daemon config was found on this machine/,
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
