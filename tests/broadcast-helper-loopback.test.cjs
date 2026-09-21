'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { controlPath, request } = require('../electron/broadcast/control.cjs');
const enabled = process.env.AGENSIS_ELECTRON_BROADCAST_TEST === '1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Explicit opt-in: needs a GUI session; no public destination or screen permissions.
test('independent Electron capture + FFmpeg survive controller exits/reconnect; helper restart stays idle', { skip: !enabled, timeout: 65000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-helper-test-'));
  const socket = controlPath(home); const output = path.join(home, 'received.flv');
  let helper; let receiver;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const launch = async () => {
    helper = spawn(require('electron'), [path.join(__dirname, 'helpers/broadcast-electron.cjs'), home], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('helper readiness timed out')), 12000);
      helper.stdout.on('data', data => { if (data.toString().includes('READY')) { clearTimeout(deadline); resolve(); } });
      helper.on('exit', code => { clearTimeout(deadline); reject(new Error(`helper exited ${code}`)); });
      // Electron diagnostics contain no keys in this fixture. Drain without retaining.
      helper.stderr.on('data', () => {});
    });
  };
  const reap = async child => {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM');
    const escalation = setTimeout(() => child.kill('SIGKILL'), 2000); await closed; clearTimeout(escalation);
  };
  const controller = (verb, args = []) => {
    const code = `const {request}=require(${JSON.stringify(path.join(__dirname, '../electron/broadcast/control.cjs'))});const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));request(input.socket,input.verb,...input.args).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exit(1));`;
    const result = spawnSync(process.execPath, ['-e', code], { input: JSON.stringify({ socket, verb, args }), encoding: 'utf8', timeout: 12000 });
    assert.equal(result.status, 0, 'fresh controller exits successfully'); return JSON.parse(result.stdout);
  };
  try {
    await launch(); assert.equal(controller('status').state, 'stopped');
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    receiver = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/synthetic-only`, '-c', 'copy', '-flush_packets', '1', '-f', 'flv', output], { stdio: 'ignore' });
    await wait(400);
    const config = { url: `rtmp://127.0.0.1:${port}/live`, key: 'synthetic-only', audio: false, sourceId: 'screen:1:0', service: 'custom' };
    const initial = controller('start', [config]); assert.equal(initial.state, 'starting');
    let live;
    for (let n = 0; n < 100; n++) { live = await request(socket, 'status'); if (live.state !== 'starting') break; await wait(200); }
    assert.equal(live.state, 'running', live.error || 'production helper encoded output');
    // Receiver probing/file creation is asynchronous and slower under full CI load.
    for (let n = 0; n < 100 && (!fs.existsSync(output) || fs.statSync(output).size === 0); n++) await wait(100);
    assert.ok(fs.existsSync(output), 'loopback receiver created output');
    const size = fs.statSync(output).size;
    // No UI/controller process exists during this interval. The helper owns the
    // actual MediaRecorder and its media source, not just an FFmpeg with dead stdin.
    await wait(2500);
    assert.ok(fs.statSync(output).size > size, 'media continues with all controllers gone');
    const duplicate = spawnSync(require('electron'), [path.join(__dirname, 'helpers/broadcast-electron.cjs'), home], { env, stdio: 'ignore', timeout: 6000 });
    assert.equal(duplicate.status, 0, 'second helper exits without stealing the profile/socket');
    const reconnected = controller('status'); assert.equal(reconnected.id, initial.id); assert.equal(reconnected.state, 'running');
    assert.equal(controller('config').hasKey, true); assert.ok(!JSON.stringify(controller('config')).includes(config.key));
    assert.equal(controller('stop', [initial.id]).state, 'stopped');
    await wait(500); await reap(receiver);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' });
    assert.equal(probe.status, 0);
    const streams = JSON.parse(probe.stdout).streams;
    assert.ok(streams.some(s => s.codec_name === 'h264' && s.width === 1280 && s.height === 720));
    assert.ok(streams.some(s => s.codec_name === 'aac'));
    await reap(helper); await launch();
    assert.equal(controller('status').state, 'stopped'); assert.equal(controller('config').hasKey, true);
    assert.ok(!fs.readFileSync(path.join(home, 'broadcast.enc')).includes(config.key));
  } finally {
    await reap(helper); await reap(receiver); fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(path.dirname(socket), { recursive: true, force: true });
  }
});
