'use strict';

// Host capability detection — which agent CLIs and SDK packages this machine
// has, which skill/agent/command libraries exist on disk, and the TTL cache that
// stops /system/capabilities re-probing all of it on every request.
//
// Moved verbatim out of server/index.cjs (Wave 1 of the index.cjs reduction).
// A leaf: fs, os, path, child_process. No database, no request objects.
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

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function resolveCommandPath(command) {
 const pathEnv = process.env.PATH || '';
 const home = os.homedir();
 const nvmBinDirs = [];
 try {
  const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
  fs.readdirSync(nvmVersions, { withFileTypes: true })
   .filter(entry => entry.isDirectory())
   .forEach(entry => nvmBinDirs.push(path.join(nvmVersions, entry.name, 'bin')));
 } catch {
  // optional
 }
 const candidates = [
  ...pathEnv.split(path.delimiter).filter(Boolean),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(home, '.local', 'bin'),
  path.join(home, 'bin'),
  path.join(home, '.bun', 'bin'),
  path.join(home, '.cargo', 'bin'),
  ...nvmBinDirs,
 ];
 const seen = new Set();
 for (const dir of candidates) {
  if (seen.has(dir)) continue;
  seen.add(dir);
  const candidate = path.join(dir, command);
  try {
   fs.accessSync(candidate, fs.constants.X_OK);
   return candidate;
  } catch {
   // keep looking
  }
 }
 return null;
}

async function probeCommand(command, args = ['--version']) {
 const resolvedPath = resolveCommandPath(command);
 if (!resolvedPath) return { command, available: false, path: null, version: null };
 let version = null;
 try {
  const { stdout, stderr } = await execFileAsync(resolvedPath, args, { timeout: 5000, maxBuffer: 1024 * 128 });
  version = String(stdout || stderr || '').trim().split('\n')[0] || null;
 } catch (error) {
  version = String(error.stdout || error.stderr || '').trim().split('\n')[0] || null;
 }
 return { command, available: true, path: resolvedPath, version };
}

function packageStatus(name) {
 try {
  const packagePath = require.resolve(`${name}/package.json`, { paths: [process.cwd()] });
  const json = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return { name, available: true, version: json.version || null, path: packagePath };
 } catch {
  return { name, available: false, version: null, path: null };
 }
}

function countDirectoryEntries(dir, predicate = () => true) {
 try {
  return fs.readdirSync(dir, { withFileTypes: true }).filter(predicate).length;
 } catch {
  return 0;
 }
}

function detectSkillLibraries(workspacePath = '') {
 const home = os.homedir();
 const repoPath = workspacePath && path.isAbsolute(workspacePath) ? workspacePath : process.cwd();
 const candidates = [
  { id: 'codex-user-skills', label: 'Codex user skills', type: 'skills', path: path.join(home, '.codex', 'skills') },
  { id: 'agents-user-skills', label: 'Local agent skills', type: 'skills', path: path.join(home, '.agents', 'skills') },
  { id: 'workspace-codex-skills', label: 'Workspace Codex skills', type: 'skills', path: path.join(repoPath, '.codex', 'skills') },
  { id: 'claude-agents', label: 'Claude agents', type: 'agents', path: path.join(home, '.claude', 'agents') },
  { id: 'workspace-claude-agents', label: 'Workspace Claude agents', type: 'agents', path: path.join(repoPath, '.claude', 'agents') },
  { id: 'claude-commands', label: 'Claude commands', type: 'commands', path: path.join(home, '.claude', 'commands') },
  { id: 'codex-config', label: 'Codex config', type: 'config', path: path.join(home, '.codex', 'config.toml') },
  { id: 'gemini-config', label: 'Gemini settings', type: 'config', path: path.join(home, '.gemini', 'settings.json') },
  { id: 'qwen-config', label: 'Qwen settings', type: 'config', path: path.join(home, '.qwen', 'settings.json') },
  { id: 'opencode-config', label: 'OpenCode config', type: 'config', path: path.join(home, '.config', 'opencode', 'opencode.json') },
 ];

 return candidates.map(candidate => {
  const exists = fs.existsSync(candidate.path);
  const isDirectory = exists && fs.statSync(candidate.path).isDirectory();
  return {
   ...candidate,
   available: exists,
   count: isDirectory ? countDirectoryEntries(candidate.path, entry => !entry.name.startsWith('.')) : exists ? 1 : 0,
  };
 });
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
 const cliDefinitions = [
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
  { id: 'qwen', label: 'Qwen Code', command: 'qwen' },
  { id: 'goose', label: 'Goose', command: 'goose' },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent' },
  { id: 'amp', label: 'Amp', command: 'amp' },
  { id: 'crush', label: 'Charm Crush', command: 'crush' },
  { id: 'grok', label: 'Grok', command: 'grok' },
  { id: 'aider', label: 'Aider', command: 'aider' },
  { id: 'kimi', label: 'Kimi', command: 'kimi' },
 ];

 // Global timeout for all CLI probes combined (they run in parallel via Promise.all).
 const CLIPROBE_TIMEOUT_MS = 10000;
 const cliProbePromise = Promise.all(cliDefinitions.map(async definition => ({
  ...definition,
  ...(await probeCommand(definition.command)),
 })));

 const clis = await Promise.race([
  cliProbePromise,
  new Promise(resolve => setTimeout(() => {
   resolve(cliDefinitions.map(def => ({ ...def, command: def.command, available: false, path: null, version: null })));
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
