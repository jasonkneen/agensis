'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/broadcast/capture.js'), 'utf8');
const config = { id: 'one', sourceId: 'screen:1:0', audio: false };
const flush = () => new Promise(resolve => setImmediate(resolve));
function track(kind = 'video') { return { kind, stopped: false, stop() { this.stopped = true; }, addEventListener(_event, fn) { this.ended = fn; } }; }
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
}
function harness(getUserMedia) {
  const recorders = []; const writes = []; const errors = []; let start; let stop;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
    chunk(bytes) { this.ondataavailable({ data: { size: bytes.length, arrayBuffer: async () => bytes.buffer } }); }
  }
  const api = { onStart: fn => { start = fn; }, onStop: fn => { stop = fn; }, failure: (...args) => errors.push(args), write: async (...args) => { writes.push(args); return { state: 'running' }; } };
  vm.runInNewContext(source, { window: { broadcastCapture: api }, navigator: { mediaDevices: { getUserMedia } }, MediaStream: Stream, MediaRecorder: Recorder, Uint8Array });
  return { start: (...args) => start(...args), stop: () => stop(), recorders, writes, errors, api };
}
test('helper owns selected capture, joins mic, and cleans both tracks on explicit stop or source end', async () => {
  const video = track(); const mic = track('audio');
  const h = harness(async options => new Stream([options.audio ? mic : video]));
  await h.start({ ...config, audio: true }); assert.equal(h.recorders[0].stream.getTracks().length, 2);
  video.ended(); assert.equal(video.stopped, true); assert.equal(mic.stopped, true); assert.equal(h.recorders[0].state, 'inactive');
  assert.equal(h.errors[0][1], 'ended');
});
test('stop cancels pending permission without leaking late tracks or starting recorder', async () => {
  let grant; const h = harness(() => new Promise(resolve => { grant = resolve; }));
  const pending = h.start(config); h.stop(); const video = track(); grant(new Stream([video])); await pending;
  assert.equal(video.stopped, true); assert.equal(h.recorders.length, 0); assert.equal(h.errors.length, 0);
});
test('microphone refusal cleans video and sends only a closed error code', async () => {
  const video = track(); const h = harness(async options => { if (options.audio) throw new Error('secret'); return new Stream([video]); });
  await h.start({ ...config, audio: true }); assert.equal(video.stopped, true); assert.deepEqual(h.errors, [['one', 'permission']]);
});
test('writes are ordered and bounded, encoder errors clean capture without replacing its root error', async () => {
  const video = track(); const h = harness(async () => new Stream([video])); await h.start(config);
  let ack; h.api.write = async (...args) => { h.writes.push(args); return new Promise(resolve => { ack = resolve; }); };
  h.recorders[0].chunk(new Uint8Array([1])); h.recorders[0].chunk(new Uint8Array([2])); await flush();
  assert.equal(h.writes.length, 1); ack({ state: 'error' }); await flush();
  assert.equal(h.writes.length, 1); assert.equal(video.stopped, true); assert.equal(h.errors.length, 0);
  const limited = harness(async () => new Stream([track()])); await limited.start(config);
  limited.recorders[0].chunk(new Uint8Array(2 * 1024 * 1024 + 1)); await flush(); assert.equal(limited.errors[0][1], 'queue');
});
