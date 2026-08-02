'use strict';

// Restore remembered ACP agents after app launch (including post-reboot when
// the desktop app opens at login).

const acpHost = require('./host.cjs');
const acpBridge = require('./agentBridge.cjs');
const { resolveHttpBackendBase } = require('./agentBridge.cjs');
const { refreshLoginShellPath } = require('../../shared/local-agent-discovery.cjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backendReachable(baseUrl, timeoutMs = 2000) {
  const base = resolveHttpBackendBase(baseUrl || 'http://127.0.0.1:3142');
  const url = `${base.replace(/\/+$/, '')}/backend/health`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until the bridge reports registered=true, or surface lastError / timeout.
 */
function waitForRegistration(agentId, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const st = acpBridge.bridgeStatus(agentId);
      if (st?.registered) {
        resolve(st);
        return;
      }
      if (st?.stopped && st.lastError) {
        reject(new Error(st.lastError));
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(st?.lastError || `ACP register timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

/**
 * @param {ReturnType<import('./autostart.cjs').createAutostartStore>} store
 * @param {{ onLog?: (line: string) => void, maxAttempts?: number, attemptDelayMs?: number }} [opts]
 */
async function restoreAutostartAgents(store, opts = {}) {
  const log = typeof opts.onLog === 'function' ? opts.onLog : (line) => console.log(line);
  const maxAttempts = opts.maxAttempts ?? 5;
  const attemptDelayMs = opts.attemptDelayMs ?? 2500;

  // GUI launches have a stripped PATH; login-shell probe fills Homebrew/nvm/.local.
  refreshLoginShellPath();

  const entries = store.listRestorable();
  log(`[desktop-acp] restore begin count=${entries.length}`);

  const results = [];

  for (const entry of entries) {
    const agentId = entry.agentId;
    let lastError = null;
    let succeeded = false;

    if (!entry.token) {
      results.push({
        agentId,
        ok: false,
        error: 'No stored connect token — open the agent and Start on this Mac once to re-save credentials.',
        needsToken: true,
      });
      log(`[desktop-acp] restore skip ${agentId}: no token`);
      continue;
    }

    if (acpHost.status(agentId)?.running && acpBridge.bridgeStatus(agentId)?.registered) {
      results.push({ agentId, ok: true, skipped: true, reason: 'already_running' });
      continue;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // Wait for backend when restoring right after reboot (backend may lag).
        const base = entry.baseUrl || 'http://127.0.0.1:3142';
        const up = await backendReachable(base);
        if (!up) {
          lastError = `backend not reachable at ${resolveHttpBackendBase(base)}`;
          log(`[desktop-acp] restore wait backend agent=${agentId} attempt=${attempt}/${maxAttempts}`);
          if (attempt < maxAttempts) await sleep(attemptDelayMs);
          continue;
        }

        // Clean partial state from a previous failed attempt.
        try {
          acpBridge.stopBridge(agentId);
          if (acpHost.status(agentId)?.running) await acpHost.stop(agentId);
        } catch {
          // ignore
        }

        log(`[desktop-acp] restore start agent=${agentId} harness=${entry.harnessId} attempt=${attempt}`);
        const { isElevatedAccessMode } = require('./client.cjs');
        const permissionMode = String(entry.permissionMode || entry.permission_mode || 'yolo');
        await acpHost.start({
          agentId,
          harnessId: entry.harnessId,
          cwd: entry.cwd || process.cwd(),
          permissionMode,
          // accept_edits (product) and acceptEdits (legacy) both elevate.
          autoApprove: isElevatedAccessMode(permissionMode),
          // Autostart has the stored connect token — wire authenticated MCP too.
          token: entry.token,
          baseUrl: entry.baseUrl || 'http://127.0.0.1:3142',
          onLog: (line) => log(`[desktop-acp:${agentId}] ${line}`),
        });

        acpBridge.startBridge({
          agentId,
          workspaceId: entry.workspaceId,
          token: entry.token,
          baseUrl: entry.baseUrl || 'http://127.0.0.1:3142',
          handle: entry.handle,
          name: entry.name,
          harnessId: entry.harnessId,
          cwd: entry.cwd || process.cwd(),
          model: entry.model || 'auto',
          requiredRuntime: entry.requiredRuntime || undefined,
        });

        const registered = await waitForRegistration(agentId, 20_000);
        results.push({
          agentId,
          ok: true,
          session: acpHost.status(agentId),
          bridge: registered,
          attempt,
        });
        log(`[desktop-acp] restore ok agent=${agentId} attempt=${attempt}`);
        succeeded = true;
        break;
      } catch (error) {
        lastError = error?.message || String(error);
        log(`[desktop-acp] restore failed agent=${agentId} attempt=${attempt}: ${lastError}`);
        try {
          acpBridge.stopBridge(agentId);
          await acpHost.stop(agentId);
        } catch {
          // ignore cleanup
        }
        // Permanent auth/runtime errors: do not burn all retries.
        if (/runtime|token|disabled|auth|401|403|not a claude|pinned/i.test(lastError)) {
          break;
        }
        if (attempt < maxAttempts) await sleep(attemptDelayMs);
      }
    }

    if (!succeeded) {
      results.push({
        agentId,
        ok: false,
        error: lastError || 'restore failed',
        needsToken: /token/i.test(String(lastError || '')),
      });
    }
  }

  return {
    attempted: entries.length,
    results,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

module.exports = {
  restoreAutostartAgents,
  waitForRegistration,
  backendReachable,
};
