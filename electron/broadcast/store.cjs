'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { destination } = require('./engine.cjs');
const { privateDirectory } = require('./control.cjs');
const PRESETS = ['restream', 'youtube', 'facebook', 'twitch', 'x', 'custom'];
const DEFAULT = { url: 'rtmps://live.restream.io:443/live', key: '', audio: false, sourceId: '', service: 'restream' };
function validate(config) {
  if (!config || Object.keys(config).some(k => !Object.keys(DEFAULT).includes(k))
    || !PRESETS.includes(config.service) || typeof config.sourceId !== 'string'
    || !/^(screen|window):[\w:-]{1,200}$/.test(config.sourceId)) throw new Error('Choose a valid source and service.');
  destination({ url: config.url, key: config.key, audio: config.audio });
  return { url: config.url, key: config.key, audio: config.audio, sourceId: config.sourceId, service: config.service };
}
function createStore(home, safeStorage) {
  const file = path.join(home, 'broadcast.enc');
  function available() {
    return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }
  function read() {
    if (!available()) throw new Error('OS credential encryption is unavailable. Unlock your keychain or secret service.');
    try { return validate(JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))); }
    catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT }; throw new Error('Saved broadcast settings could not be decrypted. Unlock the original OS keychain.'); }
  }
  function publicConfig() { const { key, ...config } = read(); return { ...config, hasKey: Boolean(key) }; }
  function save(input) {
    const previous = read();
    // Empty input reuses a saved key ONLY for the same destination and preset.
    const key = input?.key || (input?.url === previous.url && input?.service === previous.service ? previous.key : '');
    const config = validate({ ...input, key });
    privateDirectory(home);
    const temp = `${file}.tmp`;
    const encrypted = safeStorage.encryptString(JSON.stringify(config));
    fs.writeFileSync(temp, encrypted, { mode: 0o600, flag: 'w' });
    fs.renameSync(temp, file);
    return publicConfig();
  }
  return { read, publicConfig, save, available };
}
module.exports = { createStore, validate };
