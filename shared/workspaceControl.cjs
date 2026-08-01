'use strict';

// Workspace controllers are deliberately narrower than the legacy `agw_`
// workspace bearer. A controller may enrol and operate only the agents and
// resources attributed to it. It is not a workspace member, cannot inherit a
// human role, and is never admitted to generic database, private-session, vault,
// member, or audit-log surfaces.

const crypto = require('node:crypto');

const CONTROLLER_TOKEN_PREFIX = 'agc_';
const CONTROLLER_SCOPES = Object.freeze([
 'agents:register',
 'agents:manage_own',
 'resources:create',
 'resources:manage_own',
]);
const CONTROLLER_SCOPE_SET = new Set(CONTROLLER_SCOPES);
const CONTROLLER_DEFAULT_SCOPES = Object.freeze([
 'agents:register',
 'agents:manage_own',
 'resources:create',
 'resources:manage_own',
]);

const CONTROLLER_NAME_MAX = 120;
const CONTROL_JOIN_DEFAULT_TTL_MS = 5 * 60_000;
const CONTROL_JOIN_MIN_TTL_MS = 60_000;
const CONTROL_JOIN_MAX_TTL_MS = 15 * 60_000;
const CONTROLLER_CREDENTIAL_DEFAULT_TTL_MS = 90 * 24 * 60 * 60_000;
const CONTROLLER_CREDENTIAL_MIN_TTL_MS = 24 * 60 * 60_000;
const CONTROLLER_CREDENTIAL_MAX_TTL_MS = 365 * 24 * 60 * 60_000;

function createControllerToken() {
 return `${CONTROLLER_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function isControllerToken(value) {
 return /^agc_[A-Za-z0-9_-]{32,128}$/.test(String(value || ''));
}

function controllerJoinTtlMs(env = process.env) {
 const raw = Number(env?.AGENSIS_WORKSPACE_CONTROL_JOIN_TTL_MS);
 if (!Number.isFinite(raw) || raw <= 0) return CONTROL_JOIN_DEFAULT_TTL_MS;
 return Math.min(CONTROL_JOIN_MAX_TTL_MS, Math.max(CONTROL_JOIN_MIN_TTL_MS, Math.round(raw)));
}

function controllerCredentialTtlMs(env = process.env) {
 const raw = Number(env?.AGENSIS_CONTROLLER_CREDENTIAL_TTL_MS);
 if (!Number.isFinite(raw) || raw <= 0) return CONTROLLER_CREDENTIAL_DEFAULT_TTL_MS;
 return Math.min(
  CONTROLLER_CREDENTIAL_MAX_TTL_MS,
  Math.max(CONTROLLER_CREDENTIAL_MIN_TTL_MS, Math.round(raw)),
 );
}

function normalizeControllerName(value) {
 return String(value || '').trim().replace(/\s+/g, ' ').slice(0, CONTROLLER_NAME_MAX);
}

function normalizeControllerScopes(value, { defaultScopes = CONTROLLER_DEFAULT_SCOPES } = {}) {
 const source = value === undefined || value === null ? defaultScopes : value;
 if (!Array.isArray(source)) {
  return { ok: false, scopes: [], errors: ['scopes must be an array of strings'] };
 }

 const errors = [];
 const seen = new Set();
 for (const item of source) {
  if (typeof item !== 'string') {
   errors.push('scopes must contain strings only');
   continue;
  }
  const scope = item.trim();
  if (!CONTROLLER_SCOPE_SET.has(scope)) {
   errors.push(`unsupported controller scope: ${scope || '(empty)'}`);
   continue;
  }
  seen.add(scope);
 }

 const scopes = CONTROLLER_SCOPES.filter((scope) => seen.has(scope));
 if (scopes.length === 0) errors.push('at least one controller scope is required');
 return { ok: errors.length === 0, scopes, errors: [...new Set(errors)] };
}

function controllerHasScope(identity, scope) {
 if (!identity || identity.kind !== 'controller' || !CONTROLLER_SCOPE_SET.has(scope)) return false;
 return Array.isArray(identity.scopes) && identity.scopes.includes(scope);
}

function controllerScopesAreSubset(requested, parent) {
 const child = normalizeControllerScopes(requested, { defaultScopes: [] });
 const ancestor = normalizeControllerScopes(parent, { defaultScopes: [] });
 if (!child.ok || !ancestor.ok) return false;
 const allowed = new Set(ancestor.scopes);
 return child.scopes.every((scope) => allowed.has(scope));
}

function publicController(row) {
 if (!row || typeof row !== 'object') return null;
 const parsed = normalizeControllerScopes(row.scopes, { defaultScopes: [] });
 return {
  id: row.id,
  workspace_id: row.workspace_id,
  name: normalizeControllerName(row.name),
  scopes: parsed.ok ? parsed.scopes : [],
  status: row.status === 'revoked' ? 'revoked' : 'active',
  parent_controller_id: row.parent_controller_id || null,
  expires_at: row.expires_at || null,
  last_used_at: row.last_used_at || null,
  created_by: row.created_by || null,
  created_at: row.created_at || null,
  updated_at: row.updated_at || null,
  revoked_at: row.revoked_at || null,
 };
}

module.exports = {
 CONTROLLER_TOKEN_PREFIX,
 CONTROLLER_SCOPES,
 CONTROLLER_DEFAULT_SCOPES,
 CONTROLLER_NAME_MAX,
 CONTROL_JOIN_DEFAULT_TTL_MS,
 CONTROL_JOIN_MIN_TTL_MS,
 CONTROL_JOIN_MAX_TTL_MS,
 CONTROLLER_CREDENTIAL_DEFAULT_TTL_MS,
 CONTROLLER_CREDENTIAL_MIN_TTL_MS,
 CONTROLLER_CREDENTIAL_MAX_TTL_MS,
 createControllerToken,
 isControllerToken,
 controllerJoinTtlMs,
 controllerCredentialTtlMs,
 normalizeControllerName,
 normalizeControllerScopes,
 controllerHasScope,
 controllerScopesAreSubset,
 publicController,
};
