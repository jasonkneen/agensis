'use strict';

// Persist desktop ACP agents that should come back after app quit / reboot.
//
// Non-secret fields live in userData/acp-autostart.json.
// Connect tokens are encrypted with Electron safeStorage when available
// (OS keychain-backed on macOS), otherwise stored only in-memory for the
// session (we refuse to write plaintext aga_ tokens to disk).

const fs = require('fs');
const path = require('path');

const MANIFEST_NAME = 'acp-autostart.json';
const TOKENS_NAME = 'acp-autostart.tokens';

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

  function manifestPath() {
    return path.join(userDataDir, MANIFEST_NAME);
  }

  function tokensPath() {
    return path.join(userDataDir, TOKENS_NAME);
  }

  function ensureDir() {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  function readManifest() {
    try {
      const raw = fs.readFileSync(manifestPath(), 'utf8');
      const parsed = JSON.parse(raw);
      const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
      return {
        version: 1,
        openAtLogin: parsed.openAtLogin === true,
        agents: agents.filter((a) => a && a.agentId && a.harnessId && a.workspaceId),
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
    try {
      const raw = fs.readFileSync(tokensPath());
      // Format: JSON map of agentId -> base64 ciphertext
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
   * @returns {{ saved: boolean, tokenStored: boolean, openAtLogin: boolean }}
   */
  function remember(profile, token) {
    const agentId = String(profile.agentId || '').trim();
    if (!agentId) throw new Error('agentId required');
    const entry = {
      agentId,
      harnessId: String(profile.harnessId || '').trim(),
      workspaceId: String(profile.workspaceId || '').trim(),
      handle: String(profile.handle || '').trim(),
      name: String(profile.name || '').trim(),
      model: String(profile.model || 'auto').trim() || 'auto',
      cwd: profile.cwd ? String(profile.cwd) : '',
      baseUrl: String(profile.baseUrl || 'http://127.0.0.1:3142').trim(),
      requiredRuntime: profile.requiredRuntime ? String(profile.requiredRuntime).trim() : '',
      autoStart: profile.autoStart !== false,
      savedAt: new Date().toISOString(),
    };
    if (!entry.harnessId || !entry.workspaceId) {
      throw new Error('harnessId and workspaceId required for autostart');
    }

    const manifest = readManifest();
    const idx = manifest.agents.findIndex((a) => a.agentId === agentId);
    if (idx >= 0) manifest.agents[idx] = entry;
    else manifest.agents.push(entry);

    // Request login-item while any autostart agent is remembered.
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
};
