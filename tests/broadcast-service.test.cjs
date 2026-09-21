'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { createStore } = require('../electron/broadcast/store.cjs');
const { serve, request, privateDirectory } = require('../electron/broadcast/control.cjs');
const { createService } = require('../electron/broadcast/service.cjs');
const config = { url: 'rtmp://127.0.0.1/live', key: 'synthetic-key-only', audio: false, sourceId: 'screen:1:0', service: 'custom' };
function storage() {
  const key = crypto.randomBytes(32);
  return { isEncryptionAvailable: () => true, encryptString(text) {
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  }, decryptString(bytes) {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
  } };
}
test('encrypted settings round-trip across store recreation, no key in public data, no insecure fallback', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-store-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const encryption = storage(); const store = createStore(home, encryption);
  assert.equal(store.publicConfig().hasKey, false);
  assert.equal(store.save(config).hasKey, true);
  assert.ok(!fs.readFileSync(path.join(home, 'broadcast.enc')).includes(config.key));
  assert.ok(!JSON.stringify(store.publicConfig()).includes(config.key));
  assert.equal(fs.statSync(path.join(home, 'broadcast.enc')).mode & 0o777, 0o600);
  const next = createStore(home, encryption); assert.deepEqual(next.read(), config);
  next.save({ ...config, key: '', sourceId: 'screen:2:0' }); assert.equal(next.read().key, config.key);
  assert.throws(() => next.save({ ...config, key: '', url: 'rtmp://elsewhere/live' }));
  assert.throws(() => next.save({ ...config, key: '', service: 'youtube' }));
  assert.equal(createStore(home, { ...encryption, getSelectedStorageBackend: () => 'basic_text' }).available(), false);
  assert.throws(() => createStore(home, { ...encryption, isEncryptionAvailable: () => false }).save(config));
  fs.chmodSync(home, 0o755); assert.throws(() => privateDirectory(home));
});
test('private control survives disconnected clients; rejects malformed requests and hides raw exceptions', async t => {
  const home = fs.mkdtempSync('/tmp/broadcast-control-'); const socket = path.join(home, 'socket');
  let starts = 0;
  const server = await serve(socket, verb => { if (verb === 'start') { starts++; return { state: 'running' }; } if (verb === 'status') return { starts }; throw new Error(config.key); });
  t.after(async () => { await server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  await request(socket, 'start', config);
  assert.deepEqual(await request(socket, 'status'), { starts: 1 });
  const malformed = data => new Promise(resolve => {
    const client = net.createConnection(socket); let output = ''; client.on('connect', () => client.write(data));
    client.on('data', chunk => { output += chunk; }); client.on('close', () => resolve(output)); client.on('error', () => {});
  });
  for (const data of ['null\n', '{}\n', '{"verb":"write","args":[]}\n', '{bad}\n', 'x'.repeat(65537)]) {
    assert.ok(!String(await malformed(data)).includes(config.key));
  }
  await assert.rejects(request(socket, 'save', config), error => !error.message.includes(config.key));
  assert.deepEqual(await request(socket, 'status'), { starts: 1 });
});
test('service owns one capture, never auto-starts, preserves errors, stops vanished source without replacing it', async () => {
  let state; let captures = 0; let stops = 0; let list = [{ id: config.sourceId }];
  const engine = { available: () => true, start: () => (state = { id: 'one', state: 'starting', error: null }), status: () => state,
    stop: () => { state = { ...state, state: 'stopped' }; }, fail: (_owner, _id, error) => { state = { ...state, state: 'error', error }; }, stopAll: () => { stops++; } };
  const service = createService({ engine, store: { available: () => true, save() {}, read: () => config, publicConfig: () => ({ hasKey: true }) }, sources: async () => list, capture: { start: () => captures++, stop: () => stops++ } });
  assert.equal((await service.dispatch('status')).state, 'stopped'); assert.equal(captures, 0);
  const session = await service.dispatch('start', config); assert.equal(captures, 1);
  await assert.rejects(service.dispatch('start', config));
  await service.dispatch('stop', 'stale-id'); assert.equal(service.status().state, 'starting');
  service.fail('Capture source disappeared.'); assert.equal(service.status().error, 'Capture source disappeared.');
  await service.dispatch('stop', session.id); list = [];
  assert.match((await service.dispatch('start', config)).error, /no longer available/); assert.equal(captures, 1);
  service.close(); assert.ok(stops > 0);
});
test('stop cancels source enumeration before any capture or encoder can start', async () => {
  let resolveSources; let starts = 0;
  const service = createService({
    engine: { stop() {}, start() { starts++; } },
    store: { save() {}, read: () => config },
    sources: () => new Promise(resolve => { resolveSources = resolve; }),
    capture: { stop() {}, start() { starts++; } },
  });
  const pending = service.dispatch('start', config);
  await service.dispatch('stop', ''); resolveSources([{ id: config.sourceId }]);
  assert.equal((await pending).state, 'stopped'); assert.equal(starts, 0);
});
