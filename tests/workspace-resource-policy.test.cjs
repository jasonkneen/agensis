'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
 RESOURCE_DESCRIPTOR_MAX_BYTES,
 RESOURCE_ARTIFACT_MAX_BYTES,
 RESOURCE_IDEMPOTENCY_KEY_MAX,
 RESOURCE_NAME_MAX,
 RESOURCE_DESCRIPTION_MAX,
 RESOURCE_ERROR_MAX,
 normalizeBoundedObject,
 normalizeResourceDefinition,
 normalizeResourceOperationRequest,
 normalizeResourceOperationResult,
 publicResource,
 publicResourceOperation,
 sensitivePaths,
} = require('../shared/workspaceResources.cjs');

test('resource definitions are closed to known facets and bounded JSON descriptors', () => {
 const valid = normalizeResourceDefinition({
  name: 'Repository handler',
  description: 'Applies reviewed patches on the build host.',
  facet: 'code',
  visibility: 'workspace',
  descriptor: { repository: 'agensis', capabilities: ['apply_patch', 'test'] },
 });
 assert.equal(valid.ok, true);
 assert.deepEqual(valid.resource, {
  name: 'Repository handler',
  description: 'Applies reviewed patches on the build host.',
  facet: 'code',
  visibility: 'workspace',
  descriptor: { repository: 'agensis', capabilities: ['apply_patch', 'test'] },
 });

 assert.equal(normalizeResourceDefinition({ name: 'X', facet: 'billing' }).ok, false);
 assert.equal(
  normalizeResourceDefinition({ name: 'X', facet: 'code', descriptor: 'not-an-object' }).ok,
  false,
 );
 assert.equal(
  normalizeResourceDefinition({
   name: 'X',
   facet: 'code',
   descriptor: { body: 'x'.repeat(RESOURCE_DESCRIPTOR_MAX_BYTES + 1) },
  }).ok,
  false,
 );
});

test('descriptor and artifact structures refuse credential-bearing key names recursively', () => {
 const raw = {
  safe: true,
  nested: {
   api_key: 'must-not-land',
   children: [
    { connectToken: 'must-not-land-either' },
    { accessToken: 'camel-case must not bypass the filter' },
    { clientSecretValue: 'compound camel-case must not bypass the filter' },
   ],
  },
 };
 assert.deepEqual(sensitivePaths(raw), [
  'nested.api_key',
  'nested.children[0].connectToken',
  'nested.children[1].accessToken',
  'nested.children[2].clientSecretValue',
 ]);

 const descriptor = normalizeResourceDefinition({ name: 'X', facet: 'tooling', descriptor: raw });
 assert.equal(descriptor.ok, false);
 assert.match(descriptor.errors.join(' '), /api_key/);

 const artifact = normalizeBoundedObject({ credential: 'nope' }, {
  label: 'artifact',
  maxBytes: RESOURCE_ARTIFACT_MAX_BYTES,
 });
 assert.equal(artifact.ok, false);
});

test('resource operation requests require a stable idempotency key', () => {
 const valid = normalizeResourceOperationRequest({
  operation: 'propose',
  idempotencyKey: 'proposal:commit-123',
  inputArtifact: { patch: 'diff --git a/a b/a' },
 });
 assert.equal(valid.ok, true);
 assert.equal(valid.request.operation, 'propose');
 assert.equal(valid.request.idempotencyKey, 'proposal:commit-123');

 const chatRequest = normalizeResourceOperationRequest({
  operation: 'read',
  requestText: 'List the files that define the current API boundaries.',
  idempotencyKey: 'read:api-boundaries',
 });
 assert.equal(chatRequest.ok, true);
 assert.deepEqual(chatRequest.request.inputArtifact, {
  request: 'List the files that define the current API boundaries.',
 });
 assert.equal(normalizeResourceOperationRequest({
  operation: 'read',
  requestText: 'Describe the entrypoint.',
  inputArtifact: { request: 'ignored' },
  idempotencyKey: 'read:ambiguous',
 }).ok, false);

 assert.equal(normalizeResourceOperationRequest({ operation: 'propose' }).ok, false);
 assert.equal(
  normalizeResourceOperationRequest({
   operation: 'execute-shell',
   idempotencyKey: 'x',
  }).ok,
  false,
 );
 assert.equal(
  normalizeResourceOperationRequest({
   operation: 'propose',
   idempotencyKey: `same-prefix-${'x'.repeat(RESOURCE_IDEMPOTENCY_KEY_MAX)}`,
  }).ok,
  false,
  'oversized idempotency keys must be rejected, not truncated into collisions',
 );
});

test('resource operation settlement is closed and failures need a bounded reason', () => {
 assert.deepEqual(
  normalizeResourceOperationResult({
   status: 'completed',
   outputArtifact: { commit: 'abc123' },
  }).result,
  { status: 'completed', outputArtifact: { commit: 'abc123' }, error: '' },
 );
 assert.equal(normalizeResourceOperationResult({ status: 'failed' }).ok, false);
 assert.equal(normalizeResourceOperationResult({ status: 'running' }).ok, false);
 assert.equal(
  normalizeResourceOperationResult({
   status: 'completed',
   outputArtifact: { token: 'must-not-return' },
  }).ok,
  false,
 );
 assert.equal(
  normalizeResourceOperationResult({
   status: 'failed',
   error: 'x'.repeat(RESOURCE_ERROR_MAX + 1),
  }).ok,
  false,
 );
});

test('resource labels reject oversized values instead of silently truncating them', () => {
 assert.equal(
  normalizeResourceDefinition({
   name: 'x'.repeat(RESOURCE_NAME_MAX + 1),
   facet: 'code',
  }).ok,
  false,
 );
 assert.equal(
  normalizeResourceDefinition({
   name: 'Code handler',
   description: 'x'.repeat(RESOURCE_DESCRIPTION_MAX + 1),
   facet: 'code',
  }).ok,
  false,
 );
});

test('public resource projections contain no controller or vault credential material', () => {
 const resource = publicResource({
  id: 'r1',
  workspace_id: 'w1',
  steward_agent_id: 'a1',
  controller_id: 'c1',
  name: 'Code handler',
  description: 'Repository operations',
  facet: 'code',
  descriptor: '{"repository":"agensis"}',
  version: 3,
  visibility: 'workspace',
  status: 'active',
  deleted_at: '2026-08-01T10:00:00.000Z',
  created_by: null,
  token_hash: 'never',
  vault_cipher: 'never',
 });
 assert.equal(resource.controller_id, 'c1');
 assert.equal(resource.deleted_at, '2026-08-01T10:00:00.000Z');
 assert.deepEqual(resource.descriptor, { repository: 'agensis' });
 assert.equal('token_hash' in resource, false);
 assert.equal('vault_cipher' in resource, false);

 const operation = publicResourceOperation({
  id: 'op1',
  workspace_id: 'w1',
  resource_id: 'r1',
  steward_agent_id: 'a1',
  operation: 'propose',
  status: 'pending',
  input_artifact: '{"patch":"..."}',
  output_artifact: '{}',
  idempotency_key: 'not-returned',
 });
 assert.deepEqual(operation.input_artifact, { patch: '...' });
 assert.equal('idempotency_key' in operation, false);
});
