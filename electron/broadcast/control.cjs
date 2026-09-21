'use strict';
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const LIMIT = 64 * 1024;
const VERBS = ['capabilities', 'sources', 'config', 'save', 'start', 'status', 'stop'];
function controlPath(home) {
  const hash = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 20);
  // macOS per-user TMPDIR exceeds sockaddr_un's 104-byte limit with our suffix.
  return path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `agensis-broadcast-${process.getuid()}-${hash}`, 'control.sock');
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Broadcast storage must be a private directory owned by this user.');
  }
}
// Unix socket protected by a 0700 directory + 0600 socket. No browser/TCP listener,
// bearer files, shell commands, or credentials in process arguments for control.
function serve(socketPath, dispatch) {
  privateDirectory(path.dirname(socketPath));
  // Caller MUST hold the helper-profile single-instance lock before removing stale sockets.
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sockets = new Set();
  const server = net.createServer(socket => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    socket.setEncoding('utf8');
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {}); socket.setTimeout(45000, () => socket.destroy());
    let data = ''; let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      data += chunk.toString();
      if (Buffer.byteLength(data) > LIMIT) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      handled = true;
      void (async () => {
        let request;
        try { request = JSON.parse(data); } catch { socket.end('{"error":"Invalid control request."}\n'); return; }
        if (!request || !VERBS.includes(request.verb) || !Array.isArray(request.args) || request.args.length > 1) { socket.end('{"error":"Invalid control request."}\n'); return; }
        try { socket.end(JSON.stringify({ result: await dispatch(request.verb, ...request.args) }) + '\n'); }
        catch { socket.end('{"error":"Broadcast control failed. Reopen Streaming to check service status."}\n'); }
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve({ close: () => new Promise(done => { for (const socket of sockets) socket.destroy(); server.close(done); }) });
    });
  });
}
function request(socketPath, verb, ...args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let data = '';
    const fail = () => { socket.destroy(); reject(new Error('Broadcast helper unavailable. Reopen Streaming to reconnect; an ongoing broadcast may still be running.')); };
    socket.setEncoding('utf8');
    socket.setTimeout(verb === 'status' ? 1500 : 40000, fail); socket.on('error', fail);
    socket.on('connect', () => socket.write(JSON.stringify({ verb, args }) + '\n'));
    socket.on('data', chunk => { data += chunk.toString(); if (Buffer.byteLength(data) > LIMIT) fail(); });
    socket.on('end', () => {
      try { const response = JSON.parse(data); if (response.error) reject(new Error(response.error)); else resolve(response.result); }
      catch { fail(); }
    });
  });
}
module.exports = { controlPath, privateDirectory, serve, request, VERBS };
