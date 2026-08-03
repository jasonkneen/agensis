'use strict';

// Restore local-runtime daemons after desktop relaunch / reboot.

const supervisor = require('./supervisor.cjs');

/**
 * @param {ReturnType<import('./autostart.cjs').createAutostartStore>} store
 * @param {{ maxAttempts?: number, attemptDelayMs?: number, log?: (line: string) => void }} [opts]
 */
async function restoreAutostartAgents(store, opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 6);
  const attemptDelayMs = Math.max(200, Number(opts.attemptDelayMs) || 3000);
  const log = opts.log || ((line) => console.log(line));

  // Do not force-refresh PATH here: restore runs on launch and a sync zsh -l
  // on the main thread beachballs the window. Use the warm/cached PATH.
  const pending = store.listRestorable();
  const results = [];

  for (const entry of pending) {
    const agentId = entry.agentId;
    const token = entry.token;
    if (!token) {
      results.push({
        agentId,
        ok: false,
        error: 'No stored connect token — open the agent and Start on this Mac once to re-save credentials.',
      });
      log(`[desktop-local] restore skip ${agentId}: no token`);
      continue;
    }

    let lastError = '';
    let ok = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        log(`[desktop-local] restore start agent=${agentId} runtime=${entry.runtime || 'claude'} attempt=${attempt}`);
        await supervisor.start({
          agentId,
          workspaceId: entry.workspaceId,
          token,
          baseUrl: entry.baseUrl,
          handle: entry.handle,
          name: entry.name,
          model: entry.model,
          cwd: entry.cwd || undefined,
          runtime: entry.runtime || 'claude',
          permissionMode: entry.permissionMode || 'default',
          onLog: (line) => log(`[desktop-local:${agentId}] ${line}`),
        });
        ok = true;
        log(`[desktop-local] restore ok agent=${agentId} attempt=${attempt}`);
        break;
      } catch (error) {
        lastError = error?.message || String(error);
        log(`[desktop-local] restore failed agent=${agentId} attempt=${attempt}: ${lastError}`);
        if (attempt < maxAttempts) {
          await sleep(attemptDelayMs);
        }
      }
    }
    results.push(ok
      ? { agentId, ok: true }
      : { agentId, ok: false, error: lastError || 'restore failed' });
  }

  return {
    attempted: pending.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  restoreAutostartAgents,
};
