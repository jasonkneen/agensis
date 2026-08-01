'use strict';

// Local agent CLI discovery — which coding agents are installed on THIS machine.
//
// Resolve order: process PATH → well-known install dirs (Homebrew, nvm, volta,
// mise, asdf, ~/.local/bin, ~/.grok/bin, …) → login-shell PATH (macOS GUI apps
// inherit a stripped PATH, so without the shell hop installs stay invisible).
//
// Used by:
//   - electron/main.cjs  (desktop IPC: probe the user's laptop, not Fly)
//   - server/lib/capabilities.cjs  (local backend / settings tools panel)
//
// Pure node: no Express, no Electron, no DB. Safe to unit-test with a fake
// HOME + PATH.

const { execFile, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * Desktop agent catalog (display order).
 *
 * Each entry may name:
 *   - commands[]          primary binaries (first hit wins for `path`)
 *   - adapter_commands[]  ACP adapter shims (claude-agent-acp, amp-acp, …)
 *   - underlying_cli      vendor CLI when the harness is adapter-based
 *   - skill_dir           home-relative skills folder
 *
 * `available` is true when ANY of commands / adapter_commands resolves.
 * Adapter-only installs still surface; vendor-only installs do too.
 */
const LOCAL_AGENT_CLI_DEFINITIONS = [
  // ── Core coding agents ────────────────────────────────────────────────────
  {
    id: 'goose',
    label: 'Goose',
    commands: ['goose'],
    skill_dir: '.goose/skills',
    install_hint: 'https://goose-docs.ai/docs/getting-started/installation/',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    commands: ['claude'],
    adapter_commands: ['claude-agent-acp', 'claude-code-acp'],
    underlying_cli: 'claude',
    skill_dir: '.claude/skills',
    install_hint: 'https://code.claude.com/docs/en/getting-started',
  },
  {
    id: 'codex',
    label: 'Codex',
    commands: ['codex'],
    adapter_commands: ['codex-acp'],
    underlying_cli: 'codex',
    skill_dir: '.codex/skills',
    install_hint: 'https://developers.openai.com/codex/cli/',
  },
  // ── Additional harnesses ──────────────────────────────────────────────────
  {
    id: 'cursor',
    label: 'Cursor',
    commands: ['cursor-agent'],
    install_hint: 'https://cursor.com/downloads',
  },
  {
    id: 'omp',
    label: 'Oh My Pi',
    commands: ['omp'],
    install_hint: 'https://github.com/can1357/oh-my-pi',
  },
  {
    id: 'grok',
    label: 'Grok Build',
    commands: ['grok'],
    skill_dir: '.grok/skills',
    install_hint: 'https://build.x.ai/docs',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    commands: ['opencode'],
    install_hint: 'https://opencode.ai/docs',
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    commands: ['kimi'],
    install_hint: 'https://kimi.ai/download',
  },
  {
    id: 'amp',
    label: 'Amp',
    // Prefer the ACP adapter; also accept the vendor CLI binary.
    commands: ['amp-acp', 'amp'],
    adapter_commands: ['amp-acp'],
    underlying_cli: 'amp',
    install_hint: 'https://github.com/tao12345666333/amp-acp',
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    commands: ['hermes-acp', 'hermes'],
    adapter_commands: ['hermes-acp'],
    install_hint: 'https://hermes-agent.nousresearch.com',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    commands: ['openclaw'],
    install_hint: 'https://docs.openclaw.ai/start/getting-started',
  },
  // ── Extra CLIs (tools panel / skills libraries) ───────────────────────────
  {
    id: 'gemini',
    label: 'Gemini CLI',
    commands: ['gemini'],
    install_hint: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    commands: ['qwen'],
  },
  {
    id: 'crush',
    label: 'Charm Crush',
    commands: ['crush'],
  },
  {
    id: 'aider',
    label: 'Aider',
    commands: ['aider'],
  },
];

/** Flat command list used by callers that only need a single `command` string. */
function primaryCommand(definition) {
  if (definition.command) return definition.command;
  const cmds = definition.commands || [];
  return cmds[0] || definition.id;
}

// ── Login-shell PATH cache ──────────────────────────────────────────────────
// GUI-launched Electron on macOS gets /usr/bin:/bin:/usr/sbin:/sbin — not the
// user's shell PATH. Cache one login-shell `echo $PATH` so Rescan stays cheap;
// clear it when the user hits Rescan so a mid-session install becomes visible.

let loginShellPathCache = { state: 'uninit' }; // uninit | probed({ value })

function refreshLoginShellPath() {
  loginShellPathCache = { state: 'uninit' };
}

function fetchLoginShellPath() {
  if (process.platform === 'win32') return null;
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    try {
      if (!fs.existsSync(shell)) continue;
      const result = spawnSync(shell, ['-l', '-c', 'echo $PATH'], {
        encoding: 'utf8',
        timeout: 4000,
        env: process.env,
      });
      if (result.status !== 0) continue;
      const lines = String(result.stdout || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) return last;
    } catch {
      // try next shell
    }
  }
  return null;
}

function loginShellPath() {
  if (loginShellPathCache.state === 'probed') return loginShellPathCache.value;
  const value = fetchLoginShellPath();
  loginShellPathCache = { state: 'probed', value };
  return value;
}

// ── Path resolution ─────────────────────────────────────────────────────────

function isExecutableFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() && !st.isSymbolicLink()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandBasenames(command) {
  const names = [command];
  if (process.platform === 'win32' && !command.includes('.')) {
    names.push(`${command}.exe`, `${command}.cmd`, `${command}.bat`);
  } else if (process.platform !== 'win32' && process.env.PATHEXT) {
    // rare
  } else if (process.platform !== 'win32') {
    // already bare
  }
  return names;
}

function isSafeNvmTag(tag) {
  if (!tag || tag.startsWith('/')) return false;
  for (const part of tag.split('/')) {
    if (part === '..') return false;
  }
  return /^[A-Za-z0-9._/-]+$/.test(tag);
}

function parseSemverTag(s) {
  const m = String(s || '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** nvm default Node bin dir — nvm lives in .zshrc, not login shells. */
function findNvmDefaultBin(home) {
  const nvmRoot = path.join(home, '.nvm');
  const versionsRoot = path.join(nvmRoot, 'versions', 'node');
  const defaultAlias = path.join(nvmRoot, 'alias', 'default');
  try {
    const tag = fs.readFileSync(defaultAlias, 'utf8').trim();
    if (isSafeNvmTag(tag)) {
      const candidate = path.join(versionsRoot, tag, 'bin');
      if (fs.existsSync(candidate)) return candidate;
      const hopFile = path.join(nvmRoot, 'alias', tag);
      try {
        const hop = fs.readFileSync(hopFile, 'utf8').trim();
        if (isSafeNvmTag(hop)) {
          const hopCandidate = path.join(versionsRoot, hop, 'bin');
          if (fs.existsSync(hopCandidate)) return hopCandidate;
        }
      } catch {
        // no hop
      }
    }
  } catch {
    // no default alias
  }
  try {
    let best = null;
    for (const entry of fs.readdirSync(versionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ver = parseSemverTag(entry.name);
      if (!ver) continue;
      if (!best || ver[0] > best.ver[0] || (ver[0] === best.ver[0] && ver[1] > best.ver[1])
        || (ver[0] === best.ver[0] && ver[1] === best.ver[1] && ver[2] > best.ver[2])) {
        best = { ver, name: entry.name };
      }
    }
    if (best) {
      const bin = path.join(versionsRoot, best.name, 'bin');
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    // no nvm
  }
  return null;
}

function nvmBinDirs(home) {
  const dirs = [];
  const preferred = findNvmDefaultBin(home);
  if (preferred) dirs.push(preferred);
  try {
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
    for (const entry of fs.readdirSync(nvmVersions, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bin = path.join(nvmVersions, entry.name, 'bin');
      if (!dirs.includes(bin)) dirs.push(bin);
    }
  } catch {
    // optional
  }
  return dirs;
}

/**
 * Directories to search, in priority order — stock package managers, user
 * toolchains, and known agent install homes (including `.grok/bin`).
 */
function commonBinaryDirs(home = os.homedir()) {
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    // Grok Build CLI installer drops here; not on a stock PATH for GUI apps.
    path.join(home, '.grok', 'bin'),
    ...nvmBinDirs(home),
  ];

  if (process.platform === 'win32') {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'));
    }
  }

  return dirs;
}

function pathDirsFromEnv(pathEnv) {
  if (!pathEnv) return [];
  return String(pathEnv).split(path.delimiter).filter(Boolean);
}

function findInDirs(command, dirs) {
  const basenames = commandBasenames(command);
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const base of basenames) {
      const candidate = path.join(dir, base);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function findViaLoginShell(command) {
  if (process.platform === 'win32') return null;
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    try {
      if (!fs.existsSync(shell)) continue;
      const result = spawnSync(
        shell,
        ['-l', '-c', 'command -v -- "$1"', '_', command],
        { encoding: 'utf8', timeout: 4000, env: process.env },
      );
      if (result.status !== 0) continue;
      const lines = String(result.stdout || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      const resolved = lines[lines.length - 1];
      if (resolved && path.isAbsolute(resolved) && isExecutableFile(resolved)) {
        return resolved;
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Resolve `command` to an absolute executable path on this host.
 * Order: process PATH → common install dirs → login-shell PATH → command -v.
 */
function resolveCommandPath(command, options = {}) {
  if (!command || typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return isExecutableFile(trimmed) ? trimmed : null;
  }

  const home = options.home || os.homedir();
  const processPath = options.pathEnv !== undefined ? options.pathEnv : (process.env.PATH || '');

  const fromProcess = findInDirs(trimmed, pathDirsFromEnv(processPath));
  if (fromProcess) return fromProcess;

  const fromCommon = findInDirs(trimmed, commonBinaryDirs(home));
  if (fromCommon) return fromCommon;

  // Login-shell PATH (macOS GUI gap). Skip when caller injects a path for tests.
  if (options.skipLoginShell) return null;
  const shellPath = options.loginShellPath !== undefined
    ? options.loginShellPath
    : loginShellPath();
  if (shellPath) {
    const fromShell = findInDirs(trimmed, pathDirsFromEnv(shellPath));
    if (fromShell) return fromShell;
  }

  return findViaLoginShell(trimmed);
}

async function probeCommand(command, args = ['--version'], options = {}) {
  const resolvedPath = resolveCommandPath(command, options);
  if (!resolvedPath) return { command, available: false, path: null, version: null };
  let version = null;
  try {
    const { stdout, stderr } = await execFileAsync(resolvedPath, args, {
      timeout: options.timeoutMs || 5000,
      maxBuffer: 1024 * 128,
    });
    version = String(stdout || stderr || '').trim().split('\n')[0] || null;
  } catch (error) {
    // Binary exists but --version failed (auth gate, etc.) — still "available".
    version = String(error.stdout || error.stderr || '').trim().split('\n')[0] || null;
  }
  return { command, available: true, path: resolvedPath, version };
}

/**
 * Probe one catalog entry: try each name in `commands` then `adapter_commands`
 * for a path, and separately record the underlying vendor CLI when declared.
 */
async function probeAgentDefinition(definition, options = {}) {
  const primary = primaryCommand(definition);
  const commandNames = [
    ...(Array.isArray(definition.commands) ? definition.commands : []),
    ...(definition.command ? [definition.command] : []),
    ...(Array.isArray(definition.adapter_commands) ? definition.adapter_commands : []),
  ].filter(Boolean);
  // de-dupe, preserve order
  const seen = new Set();
  const uniqueCommands = commandNames.filter(name => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  if (uniqueCommands.length === 0) uniqueCommands.push(primary);

  let hit = null;
  for (const name of uniqueCommands) {
    const probed = await probeCommand(name, ['--version'], options);
    if (probed.available) {
      hit = probed;
      break;
    }
  }

  let adapter = null;
  if (Array.isArray(definition.adapter_commands) && definition.adapter_commands.length > 0) {
    for (const name of definition.adapter_commands) {
      const probed = await probeCommand(name, ['--version'], options);
      if (probed.available) {
        adapter = { command: name, path: probed.path, version: probed.version };
        break;
      }
    }
    if (!adapter) {
      adapter = { command: definition.adapter_commands[0], path: null, version: null };
    }
  }

  let underlying = null;
  if (definition.underlying_cli) {
    const probed = await probeCommand(definition.underlying_cli, ['--version'], options);
    underlying = {
      command: definition.underlying_cli,
      available: probed.available,
      path: probed.path,
      version: probed.version,
    };
  }

  // Adapter missing but vendor CLI present (or the reverse): still surface as
  // available so Settings → Tools lists the product.
  const available = Boolean(hit?.available || underlying?.available || adapter?.path);

  return {
    id: definition.id,
    label: definition.label,
    command: hit?.command || primary,
    available,
    path: hit?.path || underlying?.path || adapter?.path || null,
    version: hit?.version || underlying?.version || adapter?.version || null,
    install_hint: definition.install_hint || null,
    skill_dir: definition.skill_dir || null,
    adapter,
    underlying,
  };
}

function countDirectoryEntries(dir, predicate = () => true) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(predicate).length;
  } catch {
    return 0;
  }
}

function detectSkillLibraries(workspacePath = '', home = os.homedir()) {
  const repoPath = workspacePath && path.isAbsolute(workspacePath) ? workspacePath : process.cwd();
  // Skill / agent / config homes used by the listed harnesses.
  const candidates = [
    { id: 'goose-skills', label: 'Goose skills', type: 'skills', path: path.join(home, '.goose', 'skills') },
    { id: 'claude-skills', label: 'Claude skills', type: 'skills', path: path.join(home, '.claude', 'skills') },
    { id: 'claude-agents', label: 'Claude agents', type: 'agents', path: path.join(home, '.claude', 'agents') },
    { id: 'claude-commands', label: 'Claude commands', type: 'commands', path: path.join(home, '.claude', 'commands') },
    { id: 'workspace-claude-agents', label: 'Workspace Claude agents', type: 'agents', path: path.join(repoPath, '.claude', 'agents') },
    { id: 'codex-user-skills', label: 'Codex user skills', type: 'skills', path: path.join(home, '.codex', 'skills') },
    { id: 'workspace-codex-skills', label: 'Workspace Codex skills', type: 'skills', path: path.join(repoPath, '.codex', 'skills') },
    { id: 'agents-user-skills', label: 'Local agent skills', type: 'skills', path: path.join(home, '.agents', 'skills') },
    { id: 'grok-skills', label: 'Grok skills', type: 'skills', path: path.join(home, '.grok', 'skills') },
    { id: 'hermes-skills', label: 'Hermes skills', type: 'skills', path: path.join(home, '.hermes', 'skills') },
    { id: 'openclaw-skills', label: 'OpenClaw skills', type: 'skills', path: path.join(home, '.openclaw', 'skills') },
    { id: 'codex-config', label: 'Codex config', type: 'config', path: path.join(home, '.codex', 'config.toml') },
    { id: 'claude-config', label: 'Claude settings', type: 'config', path: path.join(home, '.claude', 'settings.json') },
    { id: 'goose-config', label: 'Goose config', type: 'config', path: path.join(home, '.config', 'goose', 'config.yaml') },
    { id: 'gemini-config', label: 'Gemini settings', type: 'config', path: path.join(home, '.gemini', 'settings.json') },
    { id: 'qwen-config', label: 'Qwen settings', type: 'config', path: path.join(home, '.qwen', 'settings.json') },
    { id: 'opencode-config', label: 'OpenCode config', type: 'config', path: path.join(home, '.config', 'opencode', 'opencode.json') },
  ];

  return candidates.map(candidate => {
    const exists = fs.existsSync(candidate.path);
    let isDirectory = false;
    try {
      isDirectory = exists && fs.statSync(candidate.path).isDirectory();
    } catch {
      isDirectory = false;
    }
    return {
      ...candidate,
      available: exists,
      count: isDirectory
        ? countDirectoryEntries(candidate.path, entry => !entry.name.startsWith('.'))
        : exists ? 1 : 0,
    };
  });
}

/**
 * Full local capabilities snapshot — same shape as SystemCapabilities on the
 * client (minus packages, which the desktop cannot resolve against node_modules
 * the way the server does).
 */
async function detectLocalAgentCapabilities(options = {}) {
  if (options.refresh) refreshLoginShellPath();

  const workspacePath = options.workspacePath || '';
  const home = options.home || os.homedir();
  const resolveOpts = {
    home,
    pathEnv: options.pathEnv,
    loginShellPath: options.loginShellPath,
    skipLoginShell: options.skipLoginShell,
    timeoutMs: 5000,
  };

  const definitions = options.cliDefinitions || LOCAL_AGENT_CLI_DEFINITIONS;
  const CLIPROBE_TIMEOUT_MS = options.probeBudgetMs || 15_000;

  const cliProbePromise = Promise.all(
    definitions.map(definition => probeAgentDefinition(definition, resolveOpts)),
  );

  const clis = await Promise.race([
    cliProbePromise,
    new Promise(resolve => setTimeout(() => {
      resolve(definitions.map(def => ({
        id: def.id,
        label: def.label,
        command: primaryCommand(def),
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

  return {
    checkedAt: new Date().toISOString(),
    workspacePath: workspacePath || process.cwd(),
    source: 'local-desktop',
    clis,
    packages: [],
    skills: detectSkillLibraries(workspacePath, home),
    codexAppServer: {
      available: clis.some(cli => cli.id === 'codex' && cli.available),
      command: 'codex app-server',
      transports: ['stdio', 'websocket', 'unix'],
    },
  };
}

module.exports = {
  LOCAL_AGENT_CLI_DEFINITIONS,
  primaryCommand,
  commonBinaryDirs,
  resolveCommandPath,
  probeCommand,
  probeAgentDefinition,
  detectSkillLibraries,
  detectLocalAgentCapabilities,
  refreshLoginShellPath,
  loginShellPath,
  findNvmDefaultBin,
  isSafeNvmTag,
  countDirectoryEntries,
};
