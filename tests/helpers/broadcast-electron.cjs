'use strict';
// Foreground fixture only: never spawns a detached helper, never captures real pixels.
const path = require('node:path');
const { boot } = require('../../electron/broadcast/helper.cjs');
const { createCipheriv, createDecipheriv } = require('node:crypto');
const key = Buffer.alloc(32, 7); // Synthetic test encryption, not OS keychain verification.
boot({ home: process.argv[2], capturePage: path.join(__dirname, 'broadcast-canvas.html'),
  sourceProvider: async () => [{ id: 'screen:1:0', name: 'Synthetic canvas only' }],
  storage: {
    isEncryptionAvailable: () => true,
    encryptString: text => { const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16)); return Buffer.concat([cipher.update(text), cipher.final()]); },
    decryptString: bytes => { const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16)); return Buffer.concat([cipher.update(bytes), cipher.final()]).toString(); },
  },
  onReady: () => process.stdout.write('READY\n'),
});
