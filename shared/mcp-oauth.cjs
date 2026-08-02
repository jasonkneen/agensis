'use strict';

// Pure MCP OAuth 2.1 helpers (no Express, no DB). Used by the authorization
// server routes and unit-tested without a full app mount.
//
// Contract: authorization-code + PKCE S256, closed scope set, PRM (RFC 9728)
// and AS metadata (RFC 8414) for any compliant MCP client.

const crypto = require('crypto');

const MCP_OAUTH_SCOPES = Object.freeze(['mcp:tools']);
const DEFAULT_SCOPE = 'mcp:tools';
const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
const TOKEN_PREFIX = 'ago_';
const AUTH_METHODS = Object.freeze(['none', 'client_secret_post', 'client_secret_basic']);

function base64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('base64url');
}

function randomToken(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function createAccessToken() {
  return `${TOKEN_PREFIX}${randomToken(32)}`;
}

function isOauthAccessToken(token) {
  return String(token || '').startsWith(TOKEN_PREFIX);
}

function createAuthorizationCode() {
  return randomToken(32);
}

function createClientId() {
  return `mcp_${randomToken(16)}`;
}

function createClientSecret() {
  return randomToken(32);
}

function hashSecret(value) {
  return sha256Hex(value);
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Normalize space-delimited scope string; only closed allowlist survives. */
function normalizeScopes(input) {
  const raw = Array.isArray(input)
    ? input.map(String)
    : String(input || DEFAULT_SCOPE).split(/[\s+]+/).filter(Boolean);
  const allowed = new Set(MCP_OAUTH_SCOPES);
  const out = [];
  for (const scope of raw) {
    if (allowed.has(scope) && !out.includes(scope)) out.push(scope);
  }
  return out.length ? out : [DEFAULT_SCOPE];
}

function scopesToString(scopes) {
  return normalizeScopes(scopes).join(' ');
}

function verifyPkceS256(codeVerifier, codeChallenge) {
  const verifier = String(codeVerifier || '');
  const challenge = String(codeChallenge || '');
  if (!verifier || !challenge) return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  return sha256Base64Url(verifier) === challenge;
}

function normalizeTokenAuthMethod(value) {
  const method = String(value || 'none').trim();
  return AUTH_METHODS.includes(method) ? method : 'none';
}

function normalizeRedirectUris(input) {
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  for (const raw of list) {
    const uri = String(raw || '').trim();
    if (!uri) continue;
    try {
      const parsed = new URL(uri);
      // Allow https and http loopback for desktop MCP clients (RFC 8252).
      const host = parsed.hostname;
      const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
      if (parsed.protocol === 'https:') {
        out.push(uri);
      } else if (parsed.protocol === 'http:' && loopback) {
        out.push(uri);
      } else if (parsed.protocol === 'http:' && process.env.AGENSIS_TEST === '1') {
        out.push(uri);
      }
    } catch {
      // skip invalid
    }
  }
  return out;
}

function redirectUriAllowed(registered, presented) {
  const want = String(presented || '');
  return normalizeRedirectUris(registered).includes(want);
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function mcpResourceUrl(baseUrl) {
  return `${trimTrailingSlash(baseUrl)}/backend/mcp`;
}

function authorizationServerMetadata(baseUrl) {
  const base = trimTrailingSlash(baseUrl);
  return {
    issuer: base,
    authorization_endpoint: `${base}/backend/oauth/authorize`,
    token_endpoint: `${base}/backend/oauth/token`,
    registration_endpoint: `${base}/backend/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    subject_types_supported: ['public'],
  };
}

function protectedResourceMetadata(baseUrl) {
  const base = trimTrailingSlash(baseUrl);
  const resource = mcpResourceUrl(base);
  return {
    resource,
    authorization_servers: [base],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/backend/skill`,
  };
}

function wwwAuthenticateHeader(baseUrl) {
  const meta = `${trimTrailingSlash(baseUrl)}/.well-known/oauth-protected-resource`;
  return `Bearer realm="agensis-mcp", resource_metadata="${meta}"`;
}

function buildAuthorizeRedirect({ redirectUri, code, state, error, errorDescription }) {
  const url = new URL(redirectUri);
  if (error) {
    url.searchParams.set('error', error);
    if (errorDescription) url.searchParams.set('error_description', errorDescription);
  } else {
    url.searchParams.set('code', code);
  }
  if (state != null && state !== '') url.searchParams.set('state', String(state));
  return url.toString();
}

module.exports = {
  MCP_OAUTH_SCOPES,
  DEFAULT_SCOPE,
  CODE_TTL_MS,
  ACCESS_TOKEN_TTL_SEC,
  TOKEN_PREFIX,
  AUTH_METHODS,
  sha256Hex,
  sha256Base64Url,
  hashSecret,
  timingSafeEqualHex,
  randomToken,
  createAccessToken,
  isOauthAccessToken,
  createAuthorizationCode,
  createClientId,
  createClientSecret,
  normalizeScopes,
  scopesToString,
  verifyPkceS256,
  normalizeTokenAuthMethod,
  normalizeRedirectUris,
  redirectUriAllowed,
  mcpResourceUrl,
  authorizationServerMetadata,
  protectedResourceMetadata,
  wwwAuthenticateHeader,
  buildAuthorizeRedirect,
  trimTrailingSlash,
};
