'use strict';
const { createClient } = require('./client.cjs');
const { VERBS } = require('./control.cjs');
function registerBroadcast({ ipcMain, app, trustedIpcSender, client = createClient({ app }) }) {
  for (const verb of VERBS) {
    ipcMain.handle(`broadcast:${verb}`, async (event, ...args) => {
      if (!trustedIpcSender(event) || event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Untrusted broadcast sender.');
      }
      return client.call(verb, ...args);
    });
  }
  // Deliberately no navigation, renderer-destroy, before-quit or signal handlers.
  // Losing a controller never stops the helper's capture or encoder.
  return client;
}
module.exports = { registerBroadcast };
