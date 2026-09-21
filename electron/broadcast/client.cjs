'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { controlPath, privateDirectory, request } = require('./control.cjs');
const STOPPED = { id: '', state: 'stopped', error: null };
function createClient({ app, spawnProcess = spawn }) {
  let launching;
  const home = path.join(app.getPath('userData'), 'broadcast-helper');
  const supported = process.platform !== 'win32';
  const socket = supported ? controlPath(home) : '';
  async function ensure() {
    try { await request(socket, 'status'); return; } catch { /* probe only; never replay a start */ }
    if (!launching) launching = (async () => {
      privateDirectory(home);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
      const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--agensis-broadcast-helper', `--broadcast-home=${home}`];
      // Application-owned independence is intentional: no stdio or IPC pipe to main,
      // no parent-death cleanup. All capture/media belong to this separate app.
      const child = spawnProcess(process.execPath, args, { detached: true, stdio: 'ignore', shell: false, env });
      let failed = false;
      child.once('error', () => { failed = true; }); child.unref();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (failed) break;
        await new Promise(resolve => setTimeout(resolve, 100));
        try { await request(socket, 'status'); return; } catch { /* wait for local readiness */ }
      }
      throw new Error('Broadcast helper could not start. Check desktop permissions.');
    })().finally(() => { launching = null; });
    await launching;
  }
  return {
    async call(verb, ...args) {
      if (!supported) {
        if (verb === 'status') return STOPPED;
        if (verb === 'capabilities') return { available: false };
        throw new Error('Independent broadcasting currently requires macOS or Linux.');
      }
      // Passive global polling must not launch an idle helper (or resume media).
      if (verb === 'status' && !fs.existsSync(socket)) return STOPPED;
      if (['capabilities', 'sources', 'config', 'save', 'start'].includes(verb)) await ensure();
      return request(socket, verb, ...args);
    },
  };
}
module.exports = { createClient };
