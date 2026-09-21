'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createClient } = require('../electron/broadcast/client.cjs');
const { controlPath, serve } = require('../electron/broadcast/control.cjs');
test('UI client passive status never spawns; launch is deduped and a new client reconnects without restart', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-client-'));
  const home = path.join(root, 'broadcast-helper'); const socket = controlPath(home);
  const app = { isPackaged: false, getPath: () => root, getAppPath: () => path.resolve(__dirname, '..') };
  const calls = []; let server;
  const spawnProcess = (...args) => {
    calls.push(args);
    server = serve(socket, verb => verb === 'status' ? { id: 'existing', state: 'running', error: null } : { available: true });
    const child = new EventEmitter(); child.unref = () => {}; return child;
  };
  t.after(async () => { if (server) await (await server).close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(path.dirname(socket), { recursive: true, force: true }); });
  const client = createClient({ app, spawnProcess });
  assert.equal((await client.call('status')).state, 'stopped'); assert.equal(calls.length, 0);
  await Promise.all([client.call('capabilities'), client.call('sources')]); assert.equal(calls.length, 1);
  assert.equal(calls[0][2].detached, true); assert.equal(calls[0][2].stdio, 'ignore'); assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][1], [app.getAppPath(), '--agensis-broadcast-helper', `--broadcast-home=${home}`]);
  const reopened = createClient({ app, spawnProcess });
  assert.equal((await reopened.call('status')).id, 'existing'); await reopened.call('capabilities'); assert.equal(calls.length, 1);
});
