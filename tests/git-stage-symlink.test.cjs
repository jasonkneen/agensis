// ============================================================================
// tests/git-stage-symlink.test.cjs
// ----------------------------------------------------------------------------
// Plan 007: `resolveWithinRoot` is now realpath-validated, so every caller
// (the git-diff route's untracked-file branch AND the git-stage route's
// `resolveStagePaths`) rejects a symlink inside the workspace root that
// points outside it — not just the diff route, which previously had an ad
// hoc inline fix (commit a00f874) that `resolveStagePaths` didn't share.
//
// Exercises the real Express app (`createApp()`) over HTTP against a real
// scratch git repository on disk, with a mocked DB (same style as
// tests/backend-auth.test.cjs) standing in for Postgres.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp, __test } = require('../server/index.cjs');

const WORKSPACE_ID = 'ws-1';
const USER_ID = 'user-owner';

function makeDb({ root, authSecret = 'test-secret' } = {}) {
  const settingRows = {};
  if (authSecret) settingRows.AUTH_SECRET = authSecret;
  return {
    calls: [],
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      this.calls.push({ sql, params });

      if (
        normalized.startsWith('alter table') ||
        normalized.startsWith('create table') ||
        normalized.startsWith('create index') ||
        normalized.startsWith('do $$')
      ) {
        return [];
      }

      if (normalized.startsWith('select value from app_settings')) {
        const value = settingRows[params[0]];
        return value ? [{ value }] : [];
      }

      if (normalized.startsWith('insert into app_settings')) {
        settingRows[params[0]] = params[1];
        return [];
      }

      // Owner check used by getWorkspaceRole (both read and write routes).
      if (normalized.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return params[0] === WORKSPACE_ID && params[1] === USER_ID ? [{ ok: 1 }] : [];
      }

      if (normalized.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
        return [];
      }

      // fetchWorkspaceRow — used by both the diff and stage routes to find
      // the on-disk project root to operate against.
      if (normalized.startsWith('select id, local_path, git_root from workspaces where id = $1')) {
        return params[0] === WORKSPACE_ID ? [{ id: WORKSPACE_ID, local_path: root, git_root: null }] : [];
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

function installDb(config) {
  const fakeDb = makeDb(config);
  __test.setTestDb(fakeDb);
  return fakeDb;
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function authedFetch(baseUrl, token, urlPath, init = {}) {
  return fetch(`${baseUrl}${urlPath}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

// Builds a scratch git repo:
//   <root>/inside.txt              — a normal tracked-able file
//   <root>/insideRoot/escape       — a symlink pointing OUTSIDE root
//   <outsideRoot>/secret.txt       — the file the symlink escapes to
function setupScratchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-stage-test-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-stage-outside-'));

  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });

  fs.writeFileSync(path.join(root, 'inside.txt'), 'hello from inside root\n');

  fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'should never be readable/stageable via root\n');

  fs.mkdirSync(path.join(root, 'insideRoot'));
  fs.symlinkSync(path.join(outsideRoot, 'secret.txt'), path.join(root, 'insideRoot', 'escape'));

  return { root, outsideRoot };
}

function cleanupScratchRepo({ root, outsideRoot }) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
}

test.beforeEach(() => {
  __test.resetTestState();
});

test.afterEach(() => {
  __test.resetTestState();
});

test('POST /backend/workspaces/:id/git/stage rejects a symlink that escapes the workspace root', async () => {
  const scratch = setupScratchRepo();
  try {
    installDb({ root: scratch.root });
    const token = await __test.issueToken(USER_ID);

    await withServer(async (baseUrl) => {
      const response = await authedFetch(baseUrl, token, `/backend/workspaces/${WORKSPACE_ID}/git/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'insideRoot/escape' }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error?.message || '', /path must stay within the workspace project root/);
    });

    // Confirm git add never ran against the symlink target — nothing got staged.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: scratch.root }).toString();
    assert.equal(status.includes('escape'), false);
  } finally {
    cleanupScratchRepo(scratch);
  }
});

test('POST /backend/workspaces/:id/git/stage still stages a normal (non-symlinked) path', async () => {
  const scratch = setupScratchRepo();
  try {
    installDb({ root: scratch.root });
    const token = await __test.issueToken(USER_ID);

    await withServer(async (baseUrl) => {
      const response = await authedFetch(baseUrl, token, `/backend/workspaces/${WORKSPACE_ID}/git/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'inside.txt' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.data.staged, ['inside.txt']);
    });

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: scratch.root }).toString();
    assert.match(status, /^A\s+inside\.txt/m);
  } finally {
    cleanupScratchRepo(scratch);
  }
});

test('GET /backend/workspaces/:id/git/diff rejects a symlink that escapes the workspace root (untracked-file branch)', async () => {
  const scratch = setupScratchRepo();
  try {
    installDb({ root: scratch.root });
    const token = await __test.issueToken(USER_ID);

    await withServer(async (baseUrl) => {
      const response = await authedFetch(
        baseUrl,
        token,
        `/backend/workspaces/${WORKSPACE_ID}/git/diff?path=${encodeURIComponent('insideRoot/escape')}`,
      );
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error?.message || '', /path must stay within the workspace project root/);
    });
  } finally {
    cleanupScratchRepo(scratch);
  }
});

test('GET /backend/workspaces/:id/git/diff still reads a normal untracked file inside root', async () => {
  const scratch = setupScratchRepo();
  try {
    installDb({ root: scratch.root });
    const token = await __test.issueToken(USER_ID);

    await withServer(async (baseUrl) => {
      const response = await authedFetch(
        baseUrl,
        token,
        `/backend/workspaces/${WORKSPACE_ID}/git/diff?path=${encodeURIComponent('inside.txt')}`,
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.untracked, true);
      assert.equal(body.data.content, 'hello from inside root\n');
    });
  } finally {
    cleanupScratchRepo(scratch);
  }
});
