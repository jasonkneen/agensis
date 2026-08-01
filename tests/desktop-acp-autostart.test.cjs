'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutostartStore } = require('../electron/acp/autostart.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-acp-autostart-'));
}

test('remember + list + forget round-trip', () => {
  const dir = tempDir();
  try {
    const store = createAutostartStore({
      userDataDir: dir,
      encrypt: (s) => Buffer.from(`enc:${s}`, 'utf8'),
      decrypt: (b) => b.toString('utf8').replace(/^enc:/, ''),
    });
    const saved = store.remember({
      agentId: 'a1',
      harnessId: 'grok',
      workspaceId: 'w1',
      handle: 'bot',
      name: 'Bot',
      model: 'auto',
      baseUrl: 'http://127.0.0.1:3142',
    }, 'aga_test_token');
    assert.equal(saved.saved, true);
    assert.equal(saved.tokenStored, true);
    assert.equal(saved.openAtLogin, true);

    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].agentId, 'a1');
    assert.equal(list[0].harnessId, 'grok');

    const restorable = store.listRestorable();
    assert.equal(restorable[0].token, 'aga_test_token');

    const forgotten = store.forget('a1');
    assert.equal(forgotten.removed, true);
    assert.equal(forgotten.remaining, 0);
    assert.equal(forgotten.openAtLogin, false);
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to persist token without encrypt', () => {
  const dir = tempDir();
  try {
    const store = createAutostartStore({
      userDataDir: dir,
      encrypt: () => null,
      decrypt: () => null,
    });
    const saved = store.remember({
      agentId: 'a2',
      harnessId: 'claude',
      workspaceId: 'w1',
    }, 'aga_secret');
    assert.equal(saved.tokenStored, false);
    assert.equal(store.listRestorable()[0].token, null);
    // Profile is still remembered (process can restore after re-auth).
    assert.equal(store.list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsert replaces same agentId', () => {
  const dir = tempDir();
  try {
    const store = createAutostartStore({
      userDataDir: dir,
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString('utf8'),
    });
    store.remember({ agentId: 'x', harnessId: 'grok', workspaceId: 'w' }, 't1');
    store.remember({ agentId: 'x', harnessId: 'claude', workspaceId: 'w' }, 't2');
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].harnessId, 'claude');
    assert.equal(store.listRestorable()[0].token, 't2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
