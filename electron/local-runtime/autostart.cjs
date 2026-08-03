'use strict';

// Persist desktop local-runtime agents that should come back after quit / reboot.
//
// Non-secret fields live in userData/local-runtime-autostart.json.
// Connect tokens are encrypted with Electron safeStorage when available
// (OS keychain-backed on macOS), otherwise stored only in-memory for the
// session (we refuse to write plaintext aga_ tokens to disk).
//
// Also migrates leftover ACP autostart files (acp-autostart.*) once.

const fs = require('fs');
const path = require('path');

const MANIFEST_NAME = 'local-runtime-autostart.json';
const TOKENS_NAME = 'local-runtime-autostart.tokens';
const LEGACY_MANIFEST_NAME = 'acp-autostart.json';
const LEGACY_TOKENS_NAME = 'acp-autostart.tokens';

/**
 * @param {{
 *   userDataDir: string,
 *   encrypt?: (plain: string) => Buffer | null,
 *   decrypt?: (buf: Buffer) => string | null,
 * }} deps
 */
function createAutostartStore(deps) {
  const userDataDir = deps.userDataDir;
  const encrypt = deps.encrypt || (() => null);
  const decrypt = deps.decrypt || (() => null);
  let migrated = false;

  function manifestPath() {
    return path.join(userDataDir, MANIFEST_NAME);
  }

  function tokensPath() {
    return path.join(userDataDir, TOKENS_NAME);
  }

  function ensureDir() {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  function migrateFromAcpOnce() {
    if (migrated) return;
    migrated = true;
    const nextManifest = path.join(userDataDir, MANIFEST_NAME);
    const legacyManifest = path.join(userDataDir, LEGACY_MANIFEST_NAME);
    if (!fs.existsSync(nextManifest) && fs.existsSync(legacyManifest)) {
      try {
        const raw = JSON.parse(fs.readFileSync(legacyManifest, 'utf8'));
        const agents = Array.isArray(raw.agents) ? raw.agents : [];
        const migratedAgents = agents
          .filter((a) => a && a.agentId && a.workspaceId)
          .map((a) => ({
            agentId: a.agentId,
            // Old ACP harness id → classic runtime when possible.
            runtime: normalizeStoredRuntime(a.requiredRuntime || a.harnessId || 'claude'),
            workspaceId: a.workspaceId,
            handle: a.handle || '',
            name: a.name || '',
            model: a.model || 'auto',
            cwd: a.cwd || '',
            baseUrl: a.baseUrl || 'http://127.0.0.1:3142',
            permissionMode: a.permissionMode || 'default',
            autoStart: a.autoStart !== false,
            savedAt: a.savedAt || new Date().toISOString(),
          }));
        ensureDir();
        fs.writeFileSync(
          nextManifest,
          `${JSON.stringify({ version: 1, openAtLogin: raw.openAtLogin === true, agents: migratedAgents }, null, 2)}\n`,
          'utf8',
        );
      } catch {
        // leave legacy in place if unreadable
      }
    }
    const nextTokens = path.join(userDataDir, TOKENS_NAME);
    const legacyTokens = path.join(userDataDir, LEGACY_TOKENS_NAME);
    if (!fs.existsSync(nextTokens) && fs.existsSync(legacyTokens)) {
      try {
        ensureDir();
        fs.copyFileSync(legacyTokens, nextTokens);
        try { fs.chmodSync(nextTokens, 0o600); } catch { /* windows */ }
      } catch {
        // ignore
      }
    }
  }

  function normalizeStoredRuntime(value) {
    const runtime = String(value || '').trim().toLowerCase();
    if (!runtime) return 'claude';
    // Accept classic pins and any desktop catalog id (grok, hermes, omp, …).
    // Unknown ids are kept so a future catalog entry still restores.
    if (runtime === 'pi' || runtime === 'oh-my-pi' || runtime === 'oh_my_pi') return 'omp';
    return runtime;
  }

  function readManifest() {
    migrateFromAcpOnce();
    try {
      const raw = fs.readFileSync(manifestPath(), 'utf8');
      const parsed = JSON.parse(raw);
      const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
      return {
        version: 1,
        openAtLogin: parsed.openAtLogin === true,
        agents: agents
          .filter((a) => a && a.agentId && a.workspaceId)
          .map((a) => ({
            ...a,
            runtime: normalizeStoredRuntime(a.runtime || a.harnessId || 'claude'),
          })),
      };
    } catch {
      return { version: 1, openAtLogin: false, agents: [] };
    }
  }

  function writeManifest(manifest) {
    ensureDir();
    const tmp = `${manifestPath()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, manifestPath());
  }

  function readTokenMap() {
    migrateFromAcpOnce();
    try {
      const raw = fs.readFileSync(tokensPath());
      const parsed = JSON.parse(raw.toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeTokenMap(map) {
    ensureDir();
    const tmp = `${tokensPath()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(map)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, tokensPath());
    try {
      fs.chmodSync(tokensPath(), 0o600);
    } catch {
      // windows
    }
  }

  function saveToken(agentId, token) {
    const id = String(agentId || '');
    const plain = String(token || '');
    if (!id || !plain) return false;
    const encrypted = encrypt(plain);
    if (!encrypted || !Buffer.isBuffer(encrypted)) {
      // Refuse plaintext persistence.
      return false;
    }
    const map = readTokenMap();
    map[id] = encrypted.toString('base64');
    writeTokenMap(map);
    return true;
  }

  function loadToken(agentId) {
    const id = String(agentId || '');
    const map = readTokenMap();
    const b64 = map[id];
    if (!b64) return null;
    try {
      const buf = Buffer.from(b64, 'base64');
      return decrypt(buf);
    } catch {
      return null;
    }
  }

  function clearToken(agentId) {
    const id = String(agentId || '');
    const map = readTokenMap();
    if (!(id in map)) return;
    delete map[id];
    writeTokenMap(map);
  }

  /**
   * Upsert an agent for reboot/restart restore.
   * @returns {{ saved: boolean, tokenStored: boolean, openAtLogin: boolean, openAtLoginChanged?: boolean }}
   */
  function remember(profile, token) {
    const agentId = String(profile.agentId || '').trim();
    if (!agentId) throw new Error('agentId required');
    const entry = {
      agentId,
      runtime: normalizeStoredRuntime(profile.runtime || profile.requiredRuntime || 'claude'),
      workspaceId: String(profile.workspaceId || '').trim(),
      handle: String(profile.handle || '').trim(),
      name: String(profile.name || '').trim(),
      model: String(profile.model || 'auto').trim() || 'auto',
      cwd: profile.cwd ? String(profile.cwd) : '',
      baseUrl: String(profile.baseUrl || 'http://127.0.0.1:3142').trim(),
      permissionMode: profile.permissionMode
        ? String(profile.permissionMode).trim()
        : (profile.permission_mode ? String(profile.permission_mode).trim() : 'default'),
      autoStart: profile.autoStart !== false,
      savedAt: new Date().toISOString(),
    };
    if (!entry.workspaceId) {
      throw new Error('workspaceId required for autostart');
    }

    const manifest = readManifest();
    const idx = manifest.agents.findIndex((a) => a.agentId === agentId);
    if (idx >= 0) manifest.agents[idx] = entry;
    else manifest.agents.push(entry);

    const hadLogin = manifest.openAtLogin;
    if (manifest.agents.some((a) => a.autoStart !== false)) {
      manifest.openAtLogin = true;
    }
    writeManifest(manifest);

    const tokenStored = token ? saveToken(agentId, token) : Boolean(loadToken(agentId));
    return {
      saved: true,
      tokenStored,
      openAtLogin: manifest.openAtLogin,
      openAtLoginChanged: !hadLogin && manifest.openAtLogin,
    };
  }

  function forget(agentId) {
    const id = String(agentId || '');
    const manifest = readManifest();
    const next = manifest.agents.filter((a) => a.agentId !== id);
    const removed = next.length !== manifest.agents.length;
    manifest.agents = next;
    if (manifest.agents.length === 0) {
      manifest.openAtLogin = false;
    }
    writeManifest(manifest);
    clearToken(id);
    return {
      removed,
      openAtLogin: manifest.openAtLogin,
      remaining: manifest.agents.length,
    };
  }

  function list() {
    return readManifest().agents.slice();
  }

  function listRestorable() {
    return list()
      .filter((a) => a.autoStart !== false)
      .map((a) => ({
        ...a,
        token: loadToken(a.agentId),
      }));
  }

  function shouldOpenAtLogin() {
    return readManifest().openAtLogin === true;
  }

  return {
    remember,
    forget,
    list,
    listRestorable,
    shouldOpenAtLogin,
    loadToken,
    saveToken,
    manifestPath,
  };
}

module.exports = {
  createAutostartStore,
  MANIFEST_NAME,
  TOKENS_NAME,
  LEGACY_MANIFEST_NAME,
  LEGACY_TOKENS_NAME,
};
