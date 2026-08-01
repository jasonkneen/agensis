'use strict';

// How to spawn each local coding agent as an ACP server (stdio JSON-RPC).
// Prefer ACP adapters when present; fall back to native ACP entrypoints
// (grok agent stdio, goose acp, …). Used only by the Electron desktop host.

const { resolveCommandPath } = require('../../shared/local-agent-discovery.cjs');

/**
 * @typedef {{ id: string, label: string, resolve: (opts?: object) => { command: string, args: string[], path: string } | null, installHint?: string }} AcpHarness
 */

/** @type {AcpHarness[]} */
const ACP_HARNESSES = [
  {
    id: 'grok',
    label: 'Grok Build',
    installHint: 'https://build.x.ai/docs',
    resolve(opts = {}) {
      const path = resolveCommandPath('grok', opts);
      if (!path) return null;
      // Grok Build exposes ACP on `agent --always-approve stdio`.
      return { command: path, args: ['agent', '--always-approve', 'stdio'], path };
    },
  },
  {
    id: 'claude',
    label: 'Claude Code',
    installHint: 'npm install -g @agentclientprotocol/claude-agent-acp',
    resolve(opts = {}) {
      for (const name of ['claude-agent-acp', 'claude-code-acp']) {
        const path = resolveCommandPath(name, opts);
        if (path) return { command: path, args: [], path };
      }
      return null;
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    installHint: 'npm install -g @agentclientprotocol/codex-acp',
    resolve(opts = {}) {
      const path = resolveCommandPath('codex-acp', opts);
      if (!path) return null;
      return { command: path, args: [], path };
    },
  },
  {
    id: 'amp',
    label: 'Amp',
    installHint: 'https://github.com/tao12345666333/amp-acp',
    resolve(opts = {}) {
      const path = resolveCommandPath('amp-acp', opts);
      if (!path) return null;
      return { command: path, args: [], path };
    },
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    installHint: 'https://hermes-agent.nousresearch.com',
    resolve(opts = {}) {
      const path = resolveCommandPath('hermes-acp', opts)
        || resolveCommandPath('hermes', opts);
      if (!path) return null;
      // hermes-acp is a shim; hermes acp is the subcommand form.
      if (path.endsWith('hermes-acp') || path.includes('hermes-acp')) {
        return { command: path, args: [], path };
      }
      return { command: path, args: ['acp'], path };
    },
  },
  {
    id: 'goose',
    label: 'Goose',
    installHint: 'https://goose-docs.ai/docs/getting-started/installation/',
    resolve(opts = {}) {
      const path = resolveCommandPath('goose', opts);
      if (!path) return null;
      return { command: path, args: ['acp'], path };
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    installHint: 'https://cursor.com/downloads',
    resolve(opts = {}) {
      const path = resolveCommandPath('cursor-agent', opts);
      if (!path) return null;
      return { command: path, args: ['acp'], path };
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    installHint: 'https://opencode.ai/docs',
    resolve(opts = {}) {
      const path = resolveCommandPath('opencode', opts);
      if (!path) return null;
      return { command: path, args: ['acp'], path };
    },
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    installHint: 'https://kimi.ai/download',
    resolve(opts = {}) {
      const path = resolveCommandPath('kimi', opts);
      if (!path) return null;
      return { command: path, args: ['acp'], path };
    },
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    installHint: 'https://docs.openclaw.ai/start/getting-started',
    resolve(opts = {}) {
      const path = resolveCommandPath('openclaw', opts);
      if (!path) return null;
      return { command: path, args: ['acp'], path };
    },
  },
];

function listHarnesses(opts = {}) {
  return ACP_HARNESSES.map(h => {
    const resolved = h.resolve(opts);
    return {
      id: h.id,
      label: h.label,
      available: Boolean(resolved),
      path: resolved?.path || null,
      command: resolved ? [resolved.command, ...resolved.args].join(' ') : null,
      installHint: h.installHint || null,
    };
  });
}

function resolveHarness(harnessId, opts = {}) {
  const h = ACP_HARNESSES.find(x => x.id === String(harnessId || '').trim());
  if (!h) return null;
  const resolved = h.resolve(opts);
  if (!resolved) return null;
  return { id: h.id, label: h.label, ...resolved };
}

module.exports = {
  ACP_HARNESSES,
  listHarnesses,
  resolveHarness,
};
