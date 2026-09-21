'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerBroadcast } = require('../electron/broadcast/ipc.cjs');
const { VERBS } = require('../electron/broadcast/control.cjs');
test('only trusted main frames control the helper; main exit/navigation never stops it', async () => {
  const handlers = new Map(); const calls = []; const app = new EventEmitter();
  registerBroadcast({ app, client: { call: (...args) => calls.push(args) }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedIpcSender: event => event.trusted });
  const owner = new EventEmitter(); owner.mainFrame = {};
  const event = { trusted: true, sender: owner, senderFrame: owner.mainFrame };
  for (const verb of VERBS) {
    const handler = handlers.get(`broadcast:${verb}`);
    await assert.rejects(handler({ ...event, trusted: false }));
    await assert.rejects(handler({ ...event, senderFrame: {} }));
    await handler(event, 'payload'); assert.deepEqual(calls.at(-1), [verb, 'payload']);
  }
  assert.equal(handlers.has('broadcast:write'), false, 'UI cannot provide media');
  const count = calls.length;
  owner.emit('did-start-navigation', {}, 'url', false, true);
  owner.emit('render-process-gone'); owner.emit('destroyed'); app.emit('before-quit');
  assert.equal(calls.length, count);
});
