'use strict';

// Host capability detection — which agent CLIs and SDK packages this machine
// has, which skill/agent/command libraries exist on disk, and the TTL cache that
// stops /system/capabilities re-probing all of it on every request.
//
// Moved out of server/index.cjs (Wave 1 of the index.cjs reduction).
// CLI path probing is shared with the Electron desktop shell via
// shared/local-agent-discovery.cjs so desktop and server cannot drift.
//
// It DOES own one piece of module state — `capabilitiesCache`, the TTL cache
// instance — but that state is entirely internal, has no reset seam in
// index.cjs's resetTestState(), and moves here whole along with its only two
// consumers. Nothing outside reaches into it. (Contrast the Wave 4 modules,
// whose Maps are reset from resetTestState and must delegate.)
//
// `config` libraries are detected but their FILES are deliberately not readable
// through the skill-content surface — ~/.gemini/settings.json holds API keys.
// That gate lives with the reader in server/skill-content.cjs, not here.

const fs = require('fs');
const path = require('path');

// CLI path resolution + skill-library scan live in the shared discovery module
// so the Electron desktop shell and this server path cannot drift. Desktop IPC
// calls the shared module on the user's machine; this file still owns packages
// + the TTL cache for /system/capabilities.
const {
 resolveCommandPath,
 probeCommand,
 probeAgentDefinition,
 detectSkillLibraries,
 countDirectoryEntries,
 LOCAL_AGENT_CLI_DEFINITIONS,
} = require('../../shared/local-agent-discovery.cjs');

function packageStatus(name) {
 try {
  const packagePath = require.resolve(`${name}/package.json`, { paths: [process.cwd()] });
  const json = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return { name, available: true, version: json.version || null, path: packagePath };
 } catch {
  return { name, available: false, version: null, path: null };
 }
}

// Merge the slash commands/skills that connected daemons pushed (each in its
// agent_connections.capabilities) into a single deduped SlashItem[] the composer's
// `/` menu can render. Built-ins are client-side, so they're intentionally absent
// here. Shape mirrors src/lib/slashCommands.ts's SlashItem. Pure for unit testing.
function mergeSlashCommands(capabilitiesList) {
 const byId = new Map();
 const put = (item) => {
  if (!item.name || byId.has(item.id)) return;
  byId.set(item.id, item);
 };
 for (const caps of capabilitiesList || []) {
  if (!caps || typeof caps !== 'object') continue;
  const commands = Array.isArray(caps.commands) ? caps.commands : [];
  for (const entry of commands) {
   const name = entry && typeof entry.name === 'string' ? entry.name : '';
   if (!name) continue;
   const parent = entry.parent && typeof entry.parent === 'string' ? entry.parent : null;
   if (parent) {
    put({ id: `skill-command:${parent}:${name}`, name, kind: 'skill-command', parent, run: 'insert', detail: parent });
   } else {
    put({ id: `command:${name}`, name, kind: 'command', run: 'insert', detail: 'Command' });
   }
  }
  const skills = Array.isArray(caps.skills) ? caps.skills : [];
  for (const skill of skills) {
   if (typeof skill !== 'string' || !skill) continue;
   put({ id: `skill:${skill}`, name: skill, kind: 'skill', run: 'insert', detail: 'Skill' });
  }
 }
 return Array.from(byId.values());
}

// NET-08: a small per-key TTL cache that shares an in-flight PROMISE. Used to
// stop /system/capabilities from re-running 12 CLI subprocess probes + package
// resolution + skill-dir scans on EVERY request (the client re-hits it on every
// workspace/layer switch). Caching the promise means a burst of concurrent
// requests shares ONE probe instead of each spawning its own ~10s scan. A
// rejected load is never cached (evicted so the next call retries). Generic +
// pure so it can be unit-tested without spawning any real probe.
function createTtlPromiseCache({ ttlMs, loader, keyFn, now = Date.now, maxEntries = 32 }) {
 const store = new Map(); // key -> { at, promise }
 function get(input) {
  const key = keyFn ? keyFn(input) : String(input ?? '');
  const t = now();
  const cached = store.get(key);
  if (cached && (t - cached.at) < ttlMs) return cached.promise;
  const promise = Promise.resolve()
   .then(() => loader(input))
   .catch((error) => {
    if (store.get(key)?.promise === promise) store.delete(key);
    throw error;
   });
  store.set(key, { at: t, promise });
  if (store.size > maxEntries) {
   for (const [k, v] of store) {
    if (t - v.at > ttlMs * 2) store.delete(k);
   }
  }
  return promise;
 }
 return { get, clear: () => store.clear(), size: () => store.size };
}

const CAPABILITIES_TTL_MS = Number(process.env.AGENSIS_CAPABILITIES_TTL_MS) || 30_000;
const capabilitiesCache = createTtlPromiseCache({
 ttlMs: CAPABILITIES_TTL_MS,
 loader: (workspacePath) => detectCapabilitiesUncached(workspacePath),
 // Normalize to the effective repo path (matches detectSkillLibraries) so '',
 // '.', and equivalent relative/absolute forms share one entry.
 keyFn: (workspacePath) => (workspacePath && path.isAbsolute(String(workspacePath))
  ? path.resolve(String(workspacePath))
  : process.cwd()),
});

function detectCapabilities(workspacePath = '') {
 return capabilitiesCache.get(workspacePath);
}

async function detectCapabilitiesUncached(workspacePath = '') {
 // Global timeout for all CLI probes combined (they run in parallel via Promise.all).
 const CLIPROBE_TIMEOUT_MS = 15000;
 const cliProbePromise = Promise.all(
  LOCAL_AGENT_CLI_DEFINITIONS.map(definition => probeAgentDefinition(definition)),
 );

 const clis = await Promise.race([
  cliProbePromise,
  new Promise(resolve => setTimeout(() => {
   resolve(LOCAL_AGENT_CLI_DEFINITIONS.map(def => ({
    id: def.id,
    label: def.label,
    command: (def.commands && def.commands[0]) || def.id,
    available: false,
    path: null,
    version: null,
    install_hint: def.install_hint || null,
    skill_dir: def.skill_dir || null,
    adapter: null,
    underlying: null,
   })));
  }, CLIPROBE_TIMEOUT_MS)),
 ]);

 const packages = [
  '@anthropic-ai/claude-agent-sdk',
  '@agentclientprotocol/claude-agent-acp',
  '@agentclientprotocol/sdk',
  '@openai/codex',
  '@anthropic-ai/sdk',
 ].map(packageStatus);

 return {
  checkedAt: new Date().toISOString(),
  workspacePath: workspacePath || process.cwd(),
  clis,
  packages,
  skills: detectSkillLibraries(workspacePath),
  codexAppServer: {
   available: clis.some(cli => cli.id === 'codex' && cli.available),
   command: 'codex app-server',
   transports: ['stdio', 'websocket', 'unix'],
  },
 };
}

module.exports = {
 CAPABILITIES_TTL_MS,
 resolveCommandPath,
 probeCommand,
 packageStatus,
 countDirectoryEntries,
 detectSkillLibraries,
 mergeSlashCommands,
 createTtlPromiseCache,
 detectCapabilities,
 detectCapabilitiesUncached,
};
