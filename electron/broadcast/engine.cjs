'use strict';

// Extracted/adapted from stream's local FFmpeg push path. Capture arrives as
// WebM instead of macOS screenshot files; no RTMP ingest server is necessary.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const MAX_CHUNK = 2 * 1024 * 1024;
function hasControlOrSpace(value) {
  return /\s/.test(value) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function destination(config) {
  if (!config || typeof config !== 'object' || Object.keys(config).some(k => !['url', 'key', 'audio'].includes(k))) {
    throw new Error('Invalid broadcast configuration.');
  }
  const { url, key, audio } = config;
  if (typeof url !== 'string' || url.length > 2048 || hasControlOrSpace(url)
    || typeof key !== 'string' || !key || key.length > 1024 || hasControlOrSpace(key) || key.includes('#')
    || typeof audio !== 'boolean') throw new Error('Enter a valid RTMP server URL and stream key.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Enter a valid RTMP server URL.'); }
  if (!['rtmp:', 'rtmps:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Use an RTMP or RTMPS server URL without credentials, query or fragment.');
  }
  return `${url.replace(/\/+$/, '')}/${key}`;
}

function buildArgs(config) {
  const output = destination(config);
  return ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-thread_queue_size', '64', '-f', 'webm', '-i', 'pipe:0',
    ...(!config.audio ? ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'] : []),
    '-map', '0:v:0', '-map', config.audio ? '0:a:0' : '1:a:0',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '9000k', '-r', '30',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-shortest', '-flvflags', 'no_duration_filesize', '-f', 'flv', output];
}

function createEngine({ resolveBinary, spawnProcess = spawn, startupMs = 30000, idleMs = 15000, killMs = 1500 } = {}) {
  const sessions = new Map();
  const children = new Set();
  function snapshot(s) { return { id: s.id, state: s.state, error: s.error }; }
  function stopSession(s, error = null) {
    if (s.stopped) return;
    s.stopped = true;
    s.state = error ? 'error' : 'stopped';
    s.error = error;
    clearTimeout(s.startTimer);
    clearTimeout(s.idleTimer);
    s.child.stdin.destroy();
    s.child.kill('SIGTERM');
    s.killTimer = setTimeout(() => s.child.kill('SIGKILL'), killMs);
    s.killTimer.unref?.();
  }
  function owned(owner, id) {
    const s = sessions.get(owner);
    if (!s || s.id !== id) throw new Error('Broadcast session not found.');
    return s;
  }
  return {
    available: () => Boolean(resolveBinary()),
    start(owner, config) {
      const args = buildArgs(config);
      const previous = sessions.get(owner);
      if (previous && !previous.closed) throw new Error('Stop the current broadcast before starting another.');
      const binary = resolveBinary();
      if (!binary) throw new Error('FFmpeg not found. Install FFmpeg on this computer and reopen Streaming.');
      let child;
      try { child = spawnProcess(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
      catch { throw new Error('Could not launch FFmpeg. Check your installation.'); }
      const s = { id: randomUUID(), child, state: 'starting', error: null, stopped: false, closed: false, busy: false };
      sessions.set(owner, s);
      children.add(s);
      s.startTimer = setTimeout(() => stopSession(s, 'No encoded output. Check the destination, stream key and capture permissions.'), startupMs);
      let progress = '';
      child.stdout.on('data', data => {
        progress = (progress + data.toString()).slice(-4096);
        if (!s.stopped && /frame=\s*[1-9]\d*\s/.test(progress)) {
          s.state = 'running';
          clearTimeout(s.startTimer);
        }
      });
      // FFmpeg diagnostics can contain the entire ingest key. Never retain,
      // log, return, or broadcast stderr (including process error messages).
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => stopSession(s, 'Media pipe failed. Check FFmpeg and restart the broadcast.'));
      child.on('error', () => { stopSession(s, 'Could not run FFmpeg. Check your installation.'); });
      child.on('close', () => {
        if (!s.stopped) stopSession(s, 'FFmpeg disconnected. Check the service dashboard and stream key.');
        s.closed = true;
        children.delete(s);
        clearTimeout(s.killTimer);
      });
      return snapshot(s);
    },
    async write(owner, id, bytes) {
      const s = owned(owner, id);
      if (s.stopped) throw new Error(s.error || 'Broadcast stopped.');
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_CHUNK || s.busy) {
        stopSession(s, 'Media queue exceeded its limit. Restart the broadcast.');
        throw new Error('Invalid or excessive media data.');
      }
      s.busy = true;
      clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => stopSession(s, 'Capture stalled. Restart the broadcast.'), idleMs);
      try {
        await new Promise((resolve, reject) => s.child.stdin.write(bytes, error => error ? reject(new Error('Media pipe failed.')) : resolve()));
      } finally { s.busy = false; }
      return snapshot(s);
    },
    fail(owner, id, message) { stopSession(owned(owner, id), message); },
    status: (owner, id) => snapshot(owned(owner, id)),
    stop(owner, id) {
      const s = sessions.get(owner);
      if (s && s.id === id) stopSession(s);
    },
    dispose(owner) {
      const s = sessions.get(owner);
      if (s) stopSession(s);
      sessions.delete(owner);
    },
    stopAll(force = false) {
      for (const owner of sessions.keys()) this.dispose(owner);
      // Include children whose renderer has already gone: its escalation timer
      // cannot survive main's exit either.
      if (force) for (const s of children) {
        s.child.kill('SIGKILL');
        clearTimeout(s.killTimer);
      }
    },
  };
}
module.exports = { createEngine, buildArgs, destination, MAX_CHUNK };
