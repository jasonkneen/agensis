'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
 normalizeResourceOperationRequest,
 normalizeResourceOperationProgress,
 publicResourceOperation,
} = require('../shared/workspaceResources.cjs');

test('resource operation requests accept bounded dependency-ordered steps', () => {
 const result = normalizeResourceOperationRequest({
  operation: 'apply',
  requestText: 'Implement the requested change and verify it.',
  steps: [
   { id: 'patch', instruction: 'Patch the handler.' },
   { id: 'tests', instruction: 'Run the focused tests.', dependsOn: ['patch'] },
   { id: 'verify', instruction: 'Run the final checks.', dependsOn: ['tests'] },
  ],
  stopOnError: true,
  idempotencyKey: 'contract-1',
 });
 assert.equal(result.ok, true);
 assert.deepEqual(result.request.inputArtifact.steps, [
  { id: 'patch', instruction: 'Patch the handler.', dependsOn: [] },
  { id: 'tests', instruction: 'Run the focused tests.', dependsOn: ['patch'] },
  { id: 'verify', instruction: 'Run the final checks.', dependsOn: ['tests'] },
 ]);
 assert.equal(result.request.inputArtifact.stopOnError, true);
});

test('resource operation plans reject duplicates, unknown dependencies, and cycles', () => {
 for (const steps of [
  [{ id: 'same', instruction: 'one' }, { id: 'same', instruction: 'two' }],
  [{ id: 'one', instruction: 'one', dependsOn: ['missing'] }],
  [{ id: 'one', instruction: 'one', dependsOn: ['two'] }, { id: 'two', instruction: 'two', dependsOn: ['one'] }],
 ]) {
  const result = normalizeResourceOperationRequest({
   operation: 'propose',
   requestText: 'Review this plan.',
   steps,
   idempotencyKey: 'contract-invalid',
  });
  assert.equal(result.ok, false);
  assert.equal(result.request, null);
 }
});

test('progress checkpoints are bounded and credential-free', () => {
 const valid = normalizeResourceOperationProgress({
  phase: 'executing',
  message: 'Running the focused tests.',
  stepId: 'tests',
  stepStatus: 'running',
  percent: 60,
 });
 assert.equal(valid.ok, true);
 assert.deepEqual(valid.progress, {
  phase: 'executing',
  message: 'Running the focused tests.',
  stepId: 'tests',
  stepStatus: 'running',
  percent: 60,
 });

 const invalid = normalizeResourceOperationProgress({
  phase: 'executing',
  message: 'x'.repeat(2_001),
  percent: 101,
 });
 assert.equal(invalid.ok, false);

 const credentialLike = normalizeResourceOperationProgress({
  phase: 'executing',
  message: 'The command printed api_key=REDACTED; stopping before sharing it.',
 });
 assert.equal(credentialLike.ok, false);
});

test('public operation projection exposes progress but never lease or idempotency state', () => {
 const operation = publicResourceOperation({
  id: 'operation-1',
  operation: 'apply',
  status: 'claimed',
  resource_version: 4,
  progress: { phase: 'verifying', message: 'Checking the result.' },
  progress_seq: '7',
  progress_updated_at: '2026-08-01T12:00:00.000Z',
  lease_version: '99',
  idempotency_key: 'secret-key',
 });
 assert.deepEqual(operation.progress, { phase: 'verifying', message: 'Checking the result.' });
 assert.equal(operation.progress_seq, 7);
 assert.equal(operation.progress_updated_at, '2026-08-01T12:00:00.000Z');
 assert.equal('lease_version' in operation, false);
 assert.equal('idempotency_key' in operation, false);
});
