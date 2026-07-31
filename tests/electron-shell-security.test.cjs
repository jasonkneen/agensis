'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8');

test('the Electron main frame cannot navigate away with privileged preload access', () => {
  assert.match(source, /function trustedRendererUrl\(/);
  assert.match(source, /webContents\.on\('will-navigate'/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /path\.resolve\(fileURLToPath\(url\)\) === rendererFile/);
  assert.doesNotMatch(source, /return \{ action: 'allow' \}/);
});

test('PTY IPC is both origin-bound and owned by the sending window', () => {
  for (const channel of ['pty:spawn', 'pty:write', 'pty:resize', 'pty:kill']) {
    const start = source.indexOf(`ipcMain.handle('${channel}'`);
    const end = source.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start, `missing ${channel} handler`);
    const handler = source.slice(start, end);
    assert.match(handler, /trustedIpcSender\(event\)/, `${channel} must reject an untrusted frame`);
    if (channel !== 'pty:spawn') {
      assert.match(
        handler,
        /ptyOwners\.get\(event\.sender\)\?\.has\(id\)/,
        `${channel} must reject a session owned by another window`,
      );
    }
  }
});

test('the folder picker is unavailable to untrusted frames', () => {
  const start = source.indexOf("ipcMain.handle('pick-folder'");
  const end = source.indexOf('\n});', start);
  assert.match(source.slice(start, end), /if \(!trustedIpcSender\(event\)\) return null/);
});
