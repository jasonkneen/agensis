'use strict';

// Resolve the agensis-agent CLI on THIS machine so desktop can manage a local
// Relay daemon without embedding the SDK wire protocol in Electron main.
//
// Important for Electron: never spawnSync a long probe on the main process when
// the UI only needs "is it installed?". Version checks are optional and short.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const {
  loginShellPath,
  mergedPathEnv,
  resolveCommandPath,
} = require('../../shared/local-agent-discovery.cjs');

const CANDIDATES = ['agensis', 'agensis-agent'];

/**
 * Full PATH for desktop probes: process + login-shell, gathered once.
 * Callers pass this into resolveCommandPath with skipLoginShell:true so we do
 * not re-spawn zsh -l for every binary name.
 */
function desktopPathEnv(opts = {}) {
  if (opts.pathEnv) return opts.pathEnv;
  return mergedPathEnv({
    pathEnv: process.env.PATH || '',
    loginShellPath: opts.loginShellPath,
  });
}

/**
 * @param {{ pathEnv?: string }} [opts]
 * @returns {{ command: string, argsPrefix: string[], path: string | null, source: string } | null}
 */
function resolveAgensisBinary(opts = {}) {
  const pathEnv = desktopPathEnv(opts);
  const resolveOpts = { pathEnv, skipLoginShell: true };

  for (const name of CANDIDATES) {
    const resolved = resolveCommandPath(name, resolveOpts);
    if (resolved && isExecutable(resolved)) {
      return { command: resolved, argsPrefix: [], path: resolved, source: 'path' };
    }
  }

  // Last resort: npx (slow cold start — only used when starting a daemon, not
  // when listing runtimes in the UI).
  const npx = resolveCommandPath('npx', resolveOpts);
  if (npx && isExecutable(npx)) {
    return {
      command: npx,
      argsPrefix: ['--yes', '@agensis/agensis-agent'],
      path: npx,
      source: 'npx',
    };
  }

  return null;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }
}

/**
 * Probe whether the resolved binary can at least print help/version.
 * Prefer probeAgensisBinaryLight() from UI list paths — this still spawnSyncs.
 *
 * @returns {{ ok: boolean, version?: string, error?: string, binary?: object }}
 */
function probeAgensisBinary(opts = {}) {
  const binary = resolveAgensisBinary(opts);
  if (!binary) {
    return {
      ok: false,
      error: 'agensis CLI not found. Install with: npm install -g @agensis/agensis-agent',
    };
  }
  // Path-only / light mode: UI list must not block Electron main for 12s on
  // a slow `agensis --version` (or hung npx).
  if (opts.light || opts.skipVersion) {
    return {
      ok: true,
      version: binary.source === 'npx' ? 'npx' : null,
      binary,
    };
  }
  try {
    const result = spawnSync(
      binary.command,
      [...binary.argsPrefix, '--version'],
      {
        encoding: 'utf8',
        timeout: 2000,
        env: { ...process.env, PATH: desktopPathEnv(opts) },
      },
    );
    if (result.error) {
      // Binary exists; version probe failed — still usable for start.
      return { ok: true, version: null, error: result.error.message, binary };
    }
    const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
    return { ok: true, version: out.split('\n')[0] || 'ok', binary };
  } catch (error) {
    return { ok: true, version: null, error: error?.message || String(error), binary };
  }
}

/**
 * Map agent runtime pin → CLI --runtime flag.
 * Only classic pins (claude|codex|amp). Empty means let the daemon infer.
 */
function normalizeRuntime(value) {
  const runtime = String(value || '').trim().toLowerCase();
  if (runtime === 'claude' || runtime === 'codex' || runtime === 'amp') return runtime;
  return '';
}

/**
 * Resolve HTTP backend base (never Vite origin).
 * Copied from the old ACP bridge so desktop always hits :3142 / Fly.
 */
function resolveHttpBackendBase(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return 'http://127.0.0.1:3142';
  try {
    const u = new URL(raw);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const host = u.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
      || host === '::1' || host === '[::1]';
    if (loopback && (port === '5173' || port === '8888' || port === '80')) {
      return 'http://127.0.0.1:3142';
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return raw;
  }
}

module.exports = {
  resolveAgensisBinary,
  probeAgensisBinary,
  normalizeRuntime,
  resolveHttpBackendBase,
  desktopPathEnv,
  CANDIDATES,
};
