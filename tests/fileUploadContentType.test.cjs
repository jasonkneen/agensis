// ============================================================================
// tests/fileUploadContentType.test.cjs
// ----------------------------------------------------------------------------
// Plan 002 — harden file upload/serving against stored-XSS.
//
// Exercises the REAL Express routes (`/backend/files/upload` and
// `/backend/files/:id/content`) over HTTP via `createApp`, following the
// pattern in tests/backend-auth.test.cjs (fake DB + `withServer` + `fetch`).
// The upload handler's `fs.writeFileSync`/`createReadStream` calls are real —
// AGENSIS_UPLOAD_ROOT is pointed at a scratch temp directory for the
// duration of this suite so no test artifacts land in the repo.
//
// Covered:
//   - a spoofed `.html` upload (claimed type: image/png) is stored with the
//     server's own normalized type, not the client's claim
//   - fetching that upload's content returns Content-Disposition: attachment
//     and X-Content-Type-Options: nosniff
//   - a legitimate `.png` upload is unaffected: stays `inline`, correct type
//   - an extension outside the server-side allowlist (`.exe`) is rejected 400
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, __test } = require('../server/index.cjs');

function makeDb({ owners = {}, roles = {}, authSecret = 'test-secret' } = {}) {
  const settingRows = {};
  if (authSecret) settingRows.AUTH_SECRET = authSecret;
  const uploadedFiles = new Map();
  return {
    uploadedFiles,
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

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

      if (normalized.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
      }

      if (normalized.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }

      if (normalized.startsWith('insert into uploaded_files')) {
        const [id, workspaceId, name, size, type, storagePath, contentSha256] = params;
        const row = {
          id, workspace_id: workspaceId, name, size, type,
          storage_path: storagePath, content_sha256: contentSha256,
        };
        uploadedFiles.set(id, row);
        return [row];
      }

      if (normalized.startsWith('select workspace_id, name, type, storage_path from uploaded_files where id = $1')) {
        const row = uploadedFiles.get(params[0]);
        return row ? [row] : [];
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
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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

let uploadRoot;
let prevUploadRoot;

test.before(() => {
  prevUploadRoot = process.env.AGENSIS_UPLOAD_ROOT;
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-upload-test-'));
  process.env.AGENSIS_UPLOAD_ROOT = uploadRoot;
});

test.after(() => {
  if (prevUploadRoot === undefined) delete process.env.AGENSIS_UPLOAD_ROOT;
  else process.env.AGENSIS_UPLOAD_ROOT = prevUploadRoot;
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

test.beforeEach(() => {
  __test.resetTestState();
});

test.afterEach(() => {
  __test.resetTestState();
});

test('a spoofed .html upload (claimed type image/png) is stored with the server allowlist type, not the client claim', async () => {
  installDb({
    authSecret: 'fixed-test-secret',
    roles: { 'ws-1:user-editor': 'editor' },
  });

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-editor');
    const response = await authedFetch(baseUrl, token, '/backend/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: 'ws-1',
        name: 'payload.html',
        type: 'image/png', // spoofed — must be ignored server-side
        contentBase64: Buffer.from('<script>alert(1)</script>').toString('base64'),
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.type, 'text/plain');
    assert.notEqual(body.data.type, 'image/png');
  });
});

test('fetching an .html-named upload returns Content-Disposition: attachment and X-Content-Type-Options: nosniff', async () => {
  installDb({
    authSecret: 'fixed-test-secret',
    roles: { 'ws-1:user-editor': 'editor' },
  });

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-editor');
    const uploadResponse = await authedFetch(baseUrl, token, '/backend/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: 'ws-1',
        name: 'payload.html',
        type: 'text/html',
        contentBase64: Buffer.from('<script>alert(1)</script>').toString('base64'),
      }),
    });
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200);

    const contentResponse = await authedFetch(baseUrl, token, `/backend/files/${uploadBody.data.id}/content`);
    assert.equal(contentResponse.status, 200);
    assert.match(contentResponse.headers.get('content-disposition') || '', /^attachment;/);
    assert.equal(contentResponse.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('fetching an .svg-named upload also returns Content-Disposition: attachment and nosniff', async () => {
  installDb({
    authSecret: 'fixed-test-secret',
    roles: { 'ws-1:user-editor': 'editor' },
  });

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-editor');
    const uploadResponse = await authedFetch(baseUrl, token, '/backend/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: 'ws-1',
        name: 'payload.svg',
        type: 'image/svg+xml',
        contentBase64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),
      }),
    });
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200);
    assert.equal(uploadBody.data.type, 'text/plain');

    const contentResponse = await authedFetch(baseUrl, token, `/backend/files/${uploadBody.data.id}/content`);
    assert.equal(contentResponse.status, 200);
    assert.match(contentResponse.headers.get('content-disposition') || '', /^attachment;/);
    assert.equal(contentResponse.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('a legitimate .png upload is unaffected — stays inline with Content-Type: image/png', async () => {
  installDb({
    authSecret: 'fixed-test-secret',
    roles: { 'ws-1:user-editor': 'editor' },
  });

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-editor');
    const uploadResponse = await authedFetch(baseUrl, token, '/backend/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: 'ws-1',
        name: 'photo.png',
        type: 'image/png',
        contentBase64: Buffer.from('not-really-a-png-but-fine-for-this-test').toString('base64'),
      }),
    });
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200);
    assert.equal(uploadBody.data.type, 'image/png');

    const contentResponse = await authedFetch(baseUrl, token, `/backend/files/${uploadBody.data.id}/content`);
    assert.equal(contentResponse.status, 200);
    assert.match(contentResponse.headers.get('content-disposition') || '', /^inline;/);
    assert.equal(contentResponse.headers.get('content-type'), 'image/png');
    assert.equal(contentResponse.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('an upload with an extension outside the server-side allowlist (.exe) is rejected 400', async () => {
  installDb({
    authSecret: 'fixed-test-secret',
    roles: { 'ws-1:user-editor': 'editor' },
  });

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-editor');
    const response = await authedFetch(baseUrl, token, '/backend/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: 'ws-1',
        name: 'malware.exe',
        type: 'application/octet-stream',
        contentBase64: Buffer.from('MZ...').toString('base64'),
      }),
    });

    assert.equal(response.status, 400);
  });
});

test('a non-owner/editor (no workspace access) cannot upload', async () => {
  installDb({ authSecret: 'fixed-test-secret' }); // no roles at all

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-stranger');
    const response = await authedFetch(baseUrl, token, '/backend/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: 'ws-1',
        name: 'photo.png',
        type: 'image/png',
        contentBase64: Buffer.from('hi').toString('base64'),
      }),
    });

    assert.equal(response.status, 403);
  });
});
