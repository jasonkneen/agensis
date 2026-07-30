// Credential and endpoint resolution.
//
// THIS FILE INTRODUCES NO NEW CREDENTIAL TYPE. Every token it accepts is one the
// MCP door already accepts today (server/index.cjs `verifyMcpToken`), and the
// only credential store it reads is the daemon's existing 0600 profile file. It
// never writes a token, never caches one, and never creates one.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The MCP door is mounted at three paths (server/mcp-doors-routes.cjs) on the
// Fly backend only — it is NOT in netlify/functions/backend.mjs, so pointing at
// agensis.io returns the SPA's HTML. rpc.mjs turns that into a named error.
export const MCP_PATH = '/backend/mcp';
const MCP_PATHS = ['/backend/mcp', '/api/mcp', '/mcp'];
export const DEFAULT_BASE_URL = 'https://agensis-backend.fly.dev';

const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Local dev-port rewrite, in ~10 lines.
 *
 * A local `npm run dev:full` puts vite on 5173 (or netlify dev on 8888) and the
 * real backend on 3142. Somebody who exports AGENSIS_URL=http://localhost:5173
 * and runs a CLI command would otherwise get the vite dev server's index.html.
 *
 * The daemon applies the same rule in `agentBackendUrl()`. The CLI carries its
 * own ten lines because the two ship as separate packages with no shared module.
 */
function rewriteLocalDevPort(url) {
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (isLocal && (url.port === '5173' || url.port === '8888')) {
    const next = new URL(url.toString());
    next.hostname = '127.0.0.1';
    next.port = '3142';
    return next;
  }
  return url;
}

/** Turn whatever the operator supplied into the exact URL to POST to. */
export function normalizeMcpUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, message: 'No backend URL resolved.' };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { ok: false, message: `Not a URL: ${value}` };
  }
  url = rewriteLocalDevPort(url);
  const trimmed = url.pathname.replace(/\/+$/, '');
  if (!MCP_PATHS.includes(trimmed)) {
    url.pathname = `${trimmed}${MCP_PATH}`;
  }
  url.search = '';
  url.hash = '';
  return { ok: true, url: url.toString() };
}

export function daemonProfilePath(name, homedir = os.homedir()) {
  return path.join(homedir, '.agensis', 'daemon-profiles', `${name}.json`);
}

/**
 * Read the daemon's saved profile. Deliberately a READER only — the daemon owns
 * this file's format and lifecycle (packages/agensis-cli/src/connectProfiles.mjs
 * in the agensis-agent repo); a second writer would be a second source of truth
 * for a credential.
 */
export async function readDaemonProfile(name, { homedir = os.homedir(), readFile = fs.readFile } = {}) {
  if (!PROFILE_NAME_RE.test(String(name || ''))) return null;
  const filePath = daemonProfilePath(name, homedir);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const config = parsed?.config;
  if (!config?.url || !config?.token) return null;
  return { url: config.url, token: config.token, path: filePath };
}

/**
 * Resolution order, most explicit first. `--token` is accepted for parity with
 * the daemon and DISCOURAGED in the README: unlike `connect --token`, which runs
 * once at setup, an operator CLI runs per-invocation, so the token lands in `ps`
 * output and in shell history every single time.
 *
 * `source` is a label for diagnostics — "which credential did you actually use",
 * which is the question a 401 needs answered. It never contains the token.
 */
export async function resolveAuth(flags, io = {}) {
  const env = io.env || {};
  const profileName = flags.profile || env.AGENSIS_PROFILE || 'default';

  let token = '';
  let tokenSource = '';
  let baseUrl = '';
  let urlSource = '';

  if (flags.token) { token = flags.token; tokenSource = '--token flag'; }
  else if (env.AGENSIS_TOKEN) { token = env.AGENSIS_TOKEN; tokenSource = 'env AGENSIS_TOKEN'; }
  else if (env.AGENSIS_MCP_TOKEN) { token = env.AGENSIS_MCP_TOKEN; tokenSource = 'env AGENSIS_MCP_TOKEN'; }

  if (flags.url) { baseUrl = flags.url; urlSource = '--url flag'; }
  else if (env.AGENSIS_MCP_URL) { baseUrl = env.AGENSIS_MCP_URL; urlSource = 'env AGENSIS_MCP_URL'; }
  else if (env.AGENSIS_URL) { baseUrl = env.AGENSIS_URL; urlSource = 'env AGENSIS_URL'; }

  if (!token || !baseUrl) {
    const profile = await readDaemonProfile(profileName, io).catch(() => null);
    if (profile) {
      if (!token) { token = profile.token; tokenSource = `daemon profile ${profile.path}`; }
      if (!baseUrl) { baseUrl = profile.url; urlSource = `daemon profile ${profile.path}`; }
    }
  }

  if (!baseUrl) { baseUrl = DEFAULT_BASE_URL; urlSource = 'built-in default'; }

  if (!token) {
    return {
      ok: false,
      message: 'No token. Set AGENSIS_TOKEN, or run `agensis connect` to save a daemon '
        + `profile (looked for ${daemonProfilePath(profileName, io.homedir || os.homedir())}).`,
    };
  }

  const normalized = normalizeMcpUrl(baseUrl);
  if (!normalized.ok) return { ok: false, message: `${normalized.message} (from ${urlSource})` };

  return { ok: true, url: normalized.url, token, tokenSource, urlSource };
}
