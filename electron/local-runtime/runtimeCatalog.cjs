'use strict';

// Desktop "Start on this Mac" runtime catalog.
//
// Each entry uses the best path that tool actually supports:
//   - claude  → @anthropic-ai/claude-agent-sdk (warm connection) via --no-acp
//   - codex   → codex app-server via --no-acp --runtime codex
//   - amp     → Amp runtime flag (--runtime amp)
//   - others  → ACP harness when the CLI knows one (grok, hermes, goose, …)
//   - omp/pi  → coding-cmd / best available CLI (Oh My Pi has no ACP harness yet)
//
// Availability is PATH-probed on THIS machine. The agensis-agent CLI still owns
// job execution; desktop only picks flags and lifecycle.

const {
  LOCAL_AGENT_CLI_DEFINITIONS,
  resolveCommandPath,
  mergedPathEnv,
} = require('../../shared/local-agent-discovery.cjs');

/**
 * @typedef {'sdk' | 'app-server' | 'amp' | 'acp' | 'cli'} RuntimeMode
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   mode: RuntimeMode,
 *   detail: string,
 *   probeCommands: string[],
 *   installHint?: string | null,
 *   acpHarness?: string,
 *   classicRuntime?: 'claude' | 'codex' | 'amp',
 *   codingCmd?: string,
 * }} DesktopRuntimeDef
 */

/** @type {DesktopRuntimeDef[]} */
const DESKTOP_RUNTIME_CATALOG = [
  {
    id: 'claude',
    label: 'Claude (Agent SDK)',
    mode: 'sdk',
    detail: 'Warm @anthropic-ai/claude-agent-sdk connection',
    probeCommands: ['claude'],
    classicRuntime: 'claude',
    installHint: 'Install Claude Code CLI (`claude`)',
  },
  {
    id: 'codex',
    label: 'Codex (app-server)',
    mode: 'app-server',
    detail: 'Persistent `codex app-server` JSON-RPC process',
    probeCommands: ['codex'],
    classicRuntime: 'codex',
    installHint: 'Install Codex CLI (`codex`)',
  },
  {
    id: 'amp',
    label: 'Amp',
    mode: 'amp',
    detail: 'Amp managed runtime (or amp-acp when preferred by the CLI)',
    probeCommands: ['amp', 'amp-acp'],
    classicRuntime: 'amp',
    acpHarness: 'amp',
    installHint: 'https://github.com/tao12345666333/amp-acp',
  },
  {
    id: 'grok',
    label: 'Grok Build',
    mode: 'acp',
    detail: 'Grok agent over ACP (`grok agent … stdio`)',
    probeCommands: ['grok'],
    acpHarness: 'grok',
    installHint: 'https://build.x.ai/docs',
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    mode: 'acp',
    detail: 'Hermes over ACP (`hermes-acp` or `hermes acp`)',
    probeCommands: ['hermes-acp', 'hermes'],
    acpHarness: 'hermes',
    installHint: 'https://hermes-agent.nousresearch.com',
  },
  {
    id: 'omp',
    label: 'Oh My Pi',
    mode: 'cli',
    detail: 'Oh My Pi CLI (`omp`) as coding command',
    probeCommands: ['omp'],
    codingCmd: 'omp',
    installHint: 'https://github.com/can1357/oh-my-pi',
  },
  {
    id: 'goose',
    label: 'Goose',
    mode: 'acp',
    detail: 'Goose over ACP (`goose acp`)',
    probeCommands: ['goose'],
    acpHarness: 'goose',
    installHint: 'https://goose-docs.ai/docs/getting-started/installation/',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    mode: 'acp',
    detail: 'Cursor agent over ACP (`cursor-agent acp`)',
    probeCommands: ['cursor-agent'],
    acpHarness: 'cursor',
    installHint: 'https://cursor.com/downloads',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    mode: 'acp',
    detail: 'OpenCode over ACP (`opencode acp`)',
    probeCommands: ['opencode'],
    acpHarness: 'opencode',
    installHint: 'https://opencode.ai/docs',
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    mode: 'acp',
    detail: 'Kimi over ACP (`kimi acp`)',
    probeCommands: ['kimi'],
    acpHarness: 'kimi',
    installHint: 'https://kimi.ai/download',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    mode: 'acp',
    detail: 'OpenClaw over ACP (`openclaw acp`)',
    probeCommands: ['openclaw'],
    acpHarness: 'openclaw',
    installHint: 'https://docs.openclaw.ai/start/getting-started',
  },
];

/**
 * Resolve a catalog entry (or synthesize from discovery) by id.
 * Accepts aliases: pi → omp, claude-code → claude.
 */
function getRuntimeDef(id) {
  const raw = String(id || '').trim().toLowerCase();
  if (!raw) return null;
  const alias = raw === 'pi' || raw === 'oh-my-pi' || raw === 'oh_my_pi'
    ? 'omp'
    : raw === 'claude-code' || raw === 'claude_code'
      ? 'claude'
      : raw;
  return DESKTOP_RUNTIME_CATALOG.find((r) => r.id === alias) || null;
}

/**
 * Probe PATH for a runtime. Returns first matching path or null.
 * Must NOT re-spawn login shells per command — pass a merged pathEnv once.
 * @param {DesktopRuntimeDef} def
 * @param {string} [pathEnv]
 */
function probeRuntimePath(def, pathEnv) {
  const env = pathEnv || mergedPathEnv();
  const resolveOpts = { pathEnv: env, skipLoginShell: true };
  for (const name of def.probeCommands || []) {
    const resolved = resolveCommandPath(name, resolveOpts);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * List runtimes for the UI, with live availability.
 * @param {{ pathEnv?: string }} [opts]
 */
function listDesktopRuntimes(opts = {}) {
  // Gather login-shell PATH once; all probes skip further shell spawns.
  const pathEnv = opts.pathEnv || mergedPathEnv();
  return DESKTOP_RUNTIME_CATALOG.map((def) => {
    const resolvedPath = probeRuntimePath(def, pathEnv);
    return {
      id: def.id,
      label: def.label,
      mode: def.mode,
      detail: def.detail,
      available: Boolean(resolvedPath),
      path: resolvedPath || null,
      installHint: def.installHint || null,
      acpHarness: def.acpHarness || null,
      classicRuntime: def.classicRuntime || null,
    };
  });
}

/**
 * Human label for a mode + id (status line).
 */
function runtimeStatusLabel(runtimeId) {
  const def = getRuntimeDef(runtimeId);
  if (!def) return String(runtimeId || 'local');
  if (def.mode === 'sdk') return 'Claude Agent SDK';
  if (def.mode === 'app-server') return 'Codex app-server';
  if (def.mode === 'amp') return 'Amp';
  if (def.mode === 'acp') return `${def.label} (ACP)`;
  if (def.mode === 'cli') return `${def.label} (CLI)`;
  return def.label;
}

/**
 * Build `agensis connect` argv extras + env for a chosen runtime.
 * Does NOT include base connect flags (url/token/workspace/agent).
 *
 * @param {string} runtimeId
 * @returns {{
 *   args: string[],
 *   env: Record<string, string | undefined>,
 *   def: DesktopRuntimeDef,
 *   classicRuntime: string,
 *   acpHarness: string | null,
 * }}
 */
function buildConnectFlags(runtimeId) {
  const def = getRuntimeDef(runtimeId) || getRuntimeDef('claude');
  if (!def) {
    throw new Error(`Unknown local runtime: ${runtimeId}`);
  }

  /** @type {string[]} */
  const args = [];
  /** @type {Record<string, string | undefined>} */
  const env = {
    // Warm SDK / app-server when those paths are used.
    AGENSIS_FAST_CONNECTION: '1',
  };

  if (def.mode === 'sdk' || def.mode === 'app-server') {
    // Best native path for Claude / Codex — never prefer ACP adapters.
    args.push('--no-acp');
    if (def.classicRuntime) args.push('--runtime', def.classicRuntime);
    env.AGENSIS_ACP = '0';
  } else if (def.mode === 'amp') {
    // Amp has a dedicated runtime lane; still allow ACP if the CLI prefers it.
    if (def.classicRuntime) args.push('--runtime', def.classicRuntime);
    if (def.acpHarness) {
      args.push('--acp-harness', def.acpHarness);
      env.AGENSIS_ACP_HARNESS = def.acpHarness;
    }
    // Do not set AGENSIS_ACP=0 — Amp may use acp or its own path.
  } else if (def.mode === 'acp') {
    const harness = def.acpHarness || def.id;
    args.push('--acp-harness', harness);
    env.AGENSIS_ACP_HARNESS = harness;
    // Explicitly allow ACP (override any parent-shell AGENSIS_ACP=0).
    env.AGENSIS_ACP = '1';
  } else if (def.mode === 'cli') {
    // No ACP harness in the CLI catalog yet — coding-cmd subprocess path.
    args.push('--no-acp');
    env.AGENSIS_ACP = '0';
    if (def.codingCmd) args.push('--coding-cmd', def.codingCmd);
  }

  return {
    args,
    env,
    def,
    classicRuntime: def.classicRuntime || '',
    acpHarness: def.acpHarness || (def.mode === 'acp' ? def.id : null),
  };
}

/**
 * Whether this id is a classic server pin (claude|codex|amp).
 */
function isClassicRuntime(id) {
  return id === 'claude' || id === 'codex' || id === 'amp';
}

module.exports = {
  DESKTOP_RUNTIME_CATALOG,
  getRuntimeDef,
  listDesktopRuntimes,
  runtimeStatusLabel,
  buildConnectFlags,
  isClassicRuntime,
  probeRuntimePath,
  // Re-export discovery defs for tests / callers that want the full CLI list.
  LOCAL_AGENT_CLI_DEFINITIONS,
};
