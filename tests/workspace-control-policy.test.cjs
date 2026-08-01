'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
 CONTROLLER_SCOPES,
 CONTROLLER_DEFAULT_SCOPES,
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
} = require('../shared/workspaceControl.cjs');

test('controller credentials use their own greppable token class', () => {
 const token = createControllerToken();
 assert.match(token, /^agc_[A-Za-z0-9_-]{43}$/);
 assert.equal(isControllerToken(token), true);
 assert.equal(isControllerToken(token.replace(/^agc_/, 'agw_')), false);
 assert.equal(isControllerToken('agc_too-short'), false);
});

test('controller scope normalization is closed, ordered, and non-empty', () => {
 assert.deepEqual(normalizeControllerScopes(undefined), {
  ok: true,
  scopes: [...CONTROLLER_DEFAULT_SCOPES],
  errors: [],
 });
 assert.deepEqual(
  normalizeControllerScopes(['resources:create', 'agents:register', 'resources:create']).scopes,
  ['agents:register', 'resources:create'],
 );
 const invalid = normalizeControllerScopes(['agents:register', 'roles:grant', 42]);
 assert.equal(invalid.ok, false);
 assert.deepEqual(invalid.scopes, ['agents:register']);
 assert.match(invalid.errors.join(' '), /roles:grant/);
 assert.match(invalid.errors.join(' '), /strings only/);
 assert.equal(normalizeControllerScopes([]).ok, false);
 assert.deepEqual(CONTROLLER_SCOPES, [
  'agents:register',
  'agents:manage_own',
  'resources:create',
  'resources:manage_own',
]);
});

test('controller authority cannot escalate beyond a parent scope set', () => {
 const parent = ['agents:register', 'agents:manage_own'];
 assert.equal(controllerScopesAreSubset(['agents:register'], parent), true);
 assert.equal(controllerScopesAreSubset(parent, parent), true);
 assert.equal(controllerScopesAreSubset(['resources:create'], parent), false);
 assert.equal(controllerScopesAreSubset(['roles:grant'], CONTROLLER_SCOPES), false);
});

test('controller scope checks require a controller identity', () => {
 const identity = { kind: 'controller', scopes: ['agents:register'] };
 assert.equal(controllerHasScope(identity, 'agents:register'), true);
 assert.equal(controllerHasScope(identity, 'resources:create'), false);
 assert.equal(controllerHasScope({ kind: 'workspace', scopes: CONTROLLER_SCOPES }, 'agents:register'), false);
 assert.equal(controllerHasScope(identity, 'vault:read_raw'), false);
});

test('workspace-control join TTL is shorter than an individual join and clamped', () => {
 assert.equal(controllerJoinTtlMs({}), CONTROL_JOIN_DEFAULT_TTL_MS);
 assert.equal(controllerJoinTtlMs({ AGENSIS_WORKSPACE_CONTROL_JOIN_TTL_MS: '1' }), CONTROL_JOIN_MIN_TTL_MS);
 assert.equal(
  controllerJoinTtlMs({ AGENSIS_WORKSPACE_CONTROL_JOIN_TTL_MS: String(60 * 60_000) }),
  CONTROL_JOIN_MAX_TTL_MS,
 );
 assert.ok(CONTROL_JOIN_DEFAULT_TTL_MS < 15 * 60_000);
});

test('controller credentials expire and deployment overrides are bounded', () => {
 assert.equal(controllerCredentialTtlMs({}), CONTROLLER_CREDENTIAL_DEFAULT_TTL_MS);
 assert.equal(
  controllerCredentialTtlMs({ AGENSIS_CONTROLLER_CREDENTIAL_TTL_MS: '1' }),
  CONTROLLER_CREDENTIAL_MIN_TTL_MS,
 );
 assert.equal(
  controllerCredentialTtlMs({ AGENSIS_CONTROLLER_CREDENTIAL_TTL_MS: String(999 * 24 * 60 * 60_000) }),
  CONTROLLER_CREDENTIAL_MAX_TTL_MS,
 );
});

test('public controller projection never returns token material', () => {
 const projected = publicController({
  id: 'controller-1',
  workspace_id: 'workspace-1',
  name: '  Build   farm  ',
  scopes: ['resources:create', 'agents:register'],
  status: 'active',
  token_hash: 'stored-hash',
  token: 'agc_plaintext',
  parent_controller_id: 'parent-1',
  expires_at: '2030-01-01T00:00:00.000Z',
  last_used_at: null,
 });
 assert.equal(projected.name, 'Build farm');
 assert.deepEqual(projected.scopes, ['agents:register', 'resources:create']);
 assert.equal('token' in projected, false);
 assert.equal('token_hash' in projected, false);
});

test('controller names are bounded and whitespace-normalized', () => {
 assert.equal(normalizeControllerName('  Local    build farm  '), 'Local build farm');
 assert.equal(normalizeControllerName('x'.repeat(200)).length, 120);
});
