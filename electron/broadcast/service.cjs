'use strict';
// Lifecycle owner is the helper, never a control connection or UI webContents.
function createService({ engine, store, sources, capture }) {
  const owner = 'helper';
  let current = { id: '', state: 'stopped', error: null };
  let changing = false;
  let generation = 0;
  function status() {
    if (current.id) current = engine.status(owner, current.id);
    return current;
  }
  function fail(message) {
    if (current.id) engine.fail(owner, current.id, message);
    capture.stop();
  }
  async function dispatch(verb, ...args) {
    if (verb === 'capabilities') return { available: engine.available() && store.available() };
    if (verb === 'sources') return sources();
    if (verb === 'config') return store.publicConfig();
    if (verb === 'status') return status();
    if (verb === 'stop') {
      if (args[0] && args[0] !== current.id) return status();
      generation++; // Cancel a pending source lookup/start as well as active media.
      capture.stop(); engine.stop(owner, current.id); return status();
    }
    if (changing) throw new Error('Broadcast operation in progress.');
    changing = true;
    const attempt = generation;
    try {
      if (['starting', 'running'].includes(status().state)) throw new Error('Stop the ongoing broadcast first.');
      if (verb === 'save') return store.save(args[0]);
      if (verb !== 'start') throw new Error('Unknown operation.');
      store.save(args[0]);
      const config = store.read();
      const list = await sources();
      if (attempt !== generation) return status();
      if (!list.some(source => source.id === config.sourceId)) {
        current = { id: '', state: 'error', error: 'Capture source is no longer available. Select it again; no replacement was captured.' };
        return current;
      }
      current = engine.start(owner, { url: config.url, key: config.key, audio: config.audio });
      capture.start({ id: current.id, sourceId: config.sourceId, audio: config.audio });
      return status();
    } finally { changing = false; }
  }
  return {
    dispatch, status, fail,
    async write(id, bytes) {
      try { return await engine.write(owner, id, bytes); }
      catch { return status(); } // Engine owns the sanitized root cause, not an IPC rejection string.
    },
    close() { capture.stop(); engine.stopAll(true); },
  };
}
module.exports = { createService };
