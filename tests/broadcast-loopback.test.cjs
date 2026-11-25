'use strict';
// Synthetic media to loopback ONLY. No .env, service account or public egress.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const net = require('node:net');
const { createEngine } = require('../electron/broadcast/engine.cjs');
const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const portBound = port => new Promise(resolve => {
  const probe = net.createServer();
  probe.once('error', error => resolve(error.code === 'EADDRINUSE'));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
});
const waitForBound = async (port, limitMs) => {
  for (let waited = 0; waited < limitMs; waited += 100) {
    if (await portBound(port)) return;
    await wait(100);
  }
};
// Deadlines are wide on purpose: the encodes are real, and on a loaded machine
// (load ~150 on 16 cores) a 10s cap on making the 5s input clip killed ffmpeg
// (exit 255) before the pipeline under test ever ran.

for (const audio of [false, true]) test(`real WebM → FFmpeg → loopback RTMP produces 720p H.264 and AAC (input audio: ${audio})`, { skip: !available, timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agensis-broadcast-test-'));
  const input = join(directory, 'input.webm');
  const output = join(directory, 'received.flv');
  const port = await new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const url = `rtmp://127.0.0.1:${port}/live`;
  let receiver;
  let engine;
  let deadline;
  try {
    const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'libopus'] : []), '-t', '5', '-c:v', 'libvpx', '-deadline', 'realtime', '-f', 'webm', input], { timeout: 40000 });
    assert.equal(generated.status, 0, 'synthetic WebM generated');
    receiver = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `${url}/synthetic-only`, '-t', '2', '-c', 'copy', '-f', 'flv', output], { stdio: 'ignore' });
    const receiverClosed = new Promise(resolve => receiver.once('close', resolve));
    // Wait until the receiver has actually bound the port. A fixed 400ms was
    // not enough on a loaded machine: the engine's ffmpeg dialled a port nobody
    // was listening on, exited, and the next write failed with "Media pipe
    // failed". Probing by CONNECTING would use up `-listen 1`'s only client, so
    // probe by trying to bind the same port: EADDRINUSE means ffmpeg holds it.
    await waitForBound(port, 20000);
    assert.equal(receiver.exitCode, null, 'loopback receiver running');
    engine = createEngine({ resolveBinary: () => 'ffmpeg', startupMs: 30000 });
    const s = engine.start('test', { url, key: 'synthetic-only', audio });
    const bytes = readFileSync(input);
    // The receiver keeps 2s of a 5s clip and then hangs up, which ends the
    // engine's ffmpeg. On a loaded machine that can happen while the clip is
    // still being fed in, and the next write fails with "Media pipe failed".
    // That is the expected end of the stream, not a fault: stop feeding once
    // the receiver has finished, and only fail if it hasn't.
    let receiverDone = false;
    receiverClosed.then(() => { receiverDone = true; });
    for (let i = 0; i < bytes.length && !receiverDone; i += 32768) {
      try {
        await engine.write('test', s.id, bytes.subarray(i, i + 32768));
      } catch (error) {
        const finished = await Promise.race([receiverClosed.then(() => true), wait(5000).then(() => false)]);
        if (!finished) throw error;
        break;
      }
    }
    const closed = await Promise.race([receiverClosed.then(code => ({ code })), new Promise(resolve => { deadline = setTimeout(() => resolve(null), 30000); })]);
    clearTimeout(deadline);
    assert.ok(closed, 'receiver completed before deadline');
    assert.equal(closed.code, 0);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8', timeout: 15000 });
    assert.equal(probe.status, 0);
    const streams = JSON.parse(probe.stdout).streams;
    const video = streams.find(s => s.codec_type === 'video');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, 1280); assert.equal(video.height, 720);
    assert.equal(streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
  } finally {
    clearTimeout(deadline);
    engine?.stopAll();
    receiver?.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});
