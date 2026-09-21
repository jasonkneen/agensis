'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createEngine, buildArgs, destination, MAX_CHUNK } = require('../electron/broadcast/engine.cjs');
const config = { url: 'rtmp://127.0.0.1/live', key: 'synthetic-test-key', audio: false };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function harness(options = {}) {
  const children = [];
  const calls = [];
  const engine = createEngine({
    resolveBinary: () => '/fake/ffmpeg',
    startupMs: 1000, idleMs: 1000, killMs: 5,
    spawnProcess: (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
      child.signals = [];
      child.kill = signal => { child.signals.push(signal); return true; };
      children.push(child);
      return child;
    }, ...options,
  });
  return { engine, children, calls };
}

test('RTMP destination validation refuses input URLs, credentials and command knobs', () => {
  assert.equal(destination(config), `${config.url}/${config.key}`);
  for (const override of [
    { url: 'file:///tmp/output' }, { url: 'https://example.com' },
    { url: 'rtmp://user:password@example.com/live' }, { url: 'rtmp://host/live?secret=x' },
    { key: 'bad\nkey' }, { key: '' }, { audio: 'yes' }, { inputUrl: '/etc/passwd' }, { preset: '-y' },
  ]) assert.throws(() => destination({ ...config, ...override }));
  const args = buildArgs(config);
  assert.ok(args.includes('libx264')); assert.ok(args.includes('aac'));
  assert.equal(args.at(-1), `${config.url}/${config.key}`);
  assert.ok(args.includes('anullsrc=channel_layout=stereo:sample_rate=44100'));
  assert.ok(!buildArgs({ ...config, audio: true }).includes('lavfi'));
});

test('startup requires encoded progress; status/errors never reveal destinations or stderr', async () => {
  const { engine, children, calls } = harness();
  const s = engine.start('owner', config);
  assert.equal(s.state, 'starting');
  assert.equal(calls[0][2].shell, false);
  assert.throws(() => engine.start('owner', config));
  assert.throws(() => engine.status('other', s.id));
  const child = children[0];
  child.stderr.write(`Failure sending to ${config.url}/${config.key}`);
  child.stdout.write('fra'); child.stdout.write('me=1\nfps=30\n');
  assert.equal(engine.status('owner', s.id).state, 'running');
  await engine.write('owner', s.id, new Uint8Array([1, 2]));
  child.emit('close', 1);
  const result = engine.status('owner', s.id);
  assert.equal(result.state, 'error');
  assert.ok(!JSON.stringify(result).includes(config.key));
  assert.ok(!JSON.stringify(result).includes(config.url));
  engine.stopAll();
});

test('missing binary, no progress, idle, excessive chunks and pending writes fail closed', async () => {
  assert.throws(() => harness({ resolveBinary: () => null }).engine.start('o', config), /FFmpeg not found/);
  const h = harness({ startupMs: 10 });
  const s = h.engine.start('o', config);
  await wait(25);
  assert.equal(h.engine.status('o', s.id).state, 'error');
  // Under parallel CI load, the startup and observation timers can run in one
  // turn; escalation is scheduled by startup and needs a subsequent turn.
  for (let attempt = 0; attempt < 100 && !h.children[0].signals.includes('SIGKILL'); attempt++) await wait(10);
  assert.deepEqual(h.children[0].signals, ['SIGTERM', 'SIGKILL']);
  h.engine.stopAll();
  const idle = harness({ idleMs: 10 });
  const i = idle.engine.start('o', config);
  idle.children[0].stdout.write('frame=1\n');
  await idle.engine.write('o', i.id, new Uint8Array([1]));
  await wait(25);
  assert.match(idle.engine.status('o', i.id).error, /stalled/);
  idle.engine.stopAll();
  for (const bytes of [new Uint8Array(MAX_CHUNK + 1), 'not bytes', new Uint8Array()]) {
    const limited = harness(); const session = limited.engine.start('o', config);
    await assert.rejects(limited.engine.write('o', session.id, bytes));
    assert.equal(limited.engine.status('o', session.id).state, 'error');
    limited.engine.stopAll();
  }
});

test('write acknowledgement waits for pipe; stop is idempotent and kills on disposal', async () => {
  const h = harness(); const s = h.engine.start('o', config);
  let ack;
  h.children[0].stdin._write = (_bytes, _enc, done) => { ack = done; };
  let resolved = false;
  const pending = h.engine.write('o', s.id, new Uint8Array([1])).then(() => { resolved = true; });
  await wait(1); assert.equal(resolved, false);
  ack(); await pending; assert.equal(resolved, true);
  h.engine.stop('other', s.id); assert.deepEqual(h.children[0].signals, []);
  h.engine.stop('o', s.id); h.engine.stop('o', s.id);
  assert.deepEqual(h.children[0].signals, ['SIGTERM']);
  h.engine.dispose('o'); assert.throws(() => h.engine.status('o', s.id));
  await wait(15); assert.equal(h.children[0].signals.at(-1), 'SIGKILL');
});

test('quit force-reaps even a child whose renderer was already disposed', () => {
  const h = harness(); h.engine.start('owner', config);
  h.engine.dispose('owner'); h.engine.stopAll(true);
  assert.deepEqual(h.children[0].signals, ['SIGTERM', 'SIGKILL']);
});

test('concurrent writes are rejected and asynchronous process errors are sanitized', async () => {
  const h = harness(); const s = h.engine.start('owner', config);
  let acknowledge;
  h.children[0].stdin._write = (_chunk, _encoding, done) => { acknowledge = done; };
  const pending = h.engine.write('owner', s.id, new Uint8Array([1])).catch(() => {});
  await assert.rejects(h.engine.write('owner', s.id, new Uint8Array([2])));
  acknowledge(); await pending;
  assert.equal(h.engine.status('owner', s.id).state, 'error');
  h.engine.stopAll(true);
  const error = harness(); const e = error.engine.start('owner', config);
  error.children[0].emit('error', new Error(config.key));
  assert.equal(error.engine.status('owner', e.id).state, 'error');
  assert.ok(!JSON.stringify(error.engine.status('owner', e.id)).includes(config.key));
  error.engine.stopAll(true);
});
