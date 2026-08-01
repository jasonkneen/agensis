'use strict';

// Pure validation and projection rules for agent-stewarded workspace resources.
// Resource rows and operation artifacts are intentionally absent from the
// generic database/realtime surfaces. Callers interact through dedicated
// routes/MCP tools; the steward agent remains the gatekeeper.

const RESOURCE_FACETS = Object.freeze(['context', 'knowledge', 'tooling', 'code']);
const RESOURCE_OPERATIONS = Object.freeze(['read', 'propose', 'apply', 'publish']);
const RESOURCE_VISIBILITIES = Object.freeze(['workspace', 'restricted']);
const RESOURCE_STATUSES = Object.freeze(['active', 'archived']);
const RESOURCE_OPERATION_STATUSES = Object.freeze([
 'pending',
 'claimed',
 'completed',
 'rejected',
 'failed',
 'cancelled',
]);

const RESOURCE_NAME_MAX = 120;
const RESOURCE_DESCRIPTION_MAX = 2_000;
const RESOURCE_DESCRIPTOR_MAX_BYTES = 32 * 1024;
const RESOURCE_ARTIFACT_MAX_BYTES = 256 * 1024;
const RESOURCE_IDEMPOTENCY_KEY_MAX = 160;
const RESOURCE_ERROR_MAX = 1_000;

const SENSITIVE_KEY_RE = /(?:^|[_-])(?:token|secret|password|passwd|pwd|authorization|cookie|credential|api[_-]?key|private[_-]?key|ciphertext|connect[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?(?:token|secret)|bearer|oauth[_-]?token|ssh[_-]?(?:private[_-]?)?key)(?:$|[_-])/i;

function plainObject(value) {
 return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function jsonBytes(value) {
 try {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
 } catch {
  return Number.POSITIVE_INFINITY;
 }
}

function normalizedKeyName(value) {
 return String(value || '')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[^A-Za-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .toLowerCase();
}

function sensitivePaths(value, path = '', out = [], seen = new Set()) {
 if (!value || typeof value !== 'object' || seen.has(value)) return out;
 seen.add(value);
 if (Array.isArray(value)) {
  for (let index = 0; index < value.length; index += 1) {
   sensitivePaths(value[index], `${path}[${index}]`, out, seen);
  }
  return out;
 }
 for (const [key, child] of Object.entries(value)) {
  const next = path ? `${path}.${key}` : key;
  if (SENSITIVE_KEY_RE.test(normalizedKeyName(key))) out.push(next);
  sensitivePaths(child, next, out, seen);
 }
 return out;
}

function normalizeBoundedObject(value, {
 label,
 maxBytes,
 allowSensitiveKeys = false,
} = {}) {
 const resolvedLabel = label || 'value';
 if (value === undefined || value === null) return { ok: true, value: {}, errors: [] };
 if (!plainObject(value)) return { ok: false, value: null, errors: [`${resolvedLabel} must be an object`] };
 const bytes = jsonBytes(value);
 if (!Number.isFinite(bytes) || bytes > maxBytes) {
  return { ok: false, value: null, errors: [`${resolvedLabel} must be at most ${maxBytes} bytes`] };
 }
 if (!allowSensitiveKeys) {
  const paths = sensitivePaths(value);
  if (paths.length > 0) {
   return {
    ok: false,
    value: null,
    errors: [`${resolvedLabel} cannot carry credential-bearing keys: ${paths.slice(0, 5).join(', ')}`],
   };
  }
 }
 // Round-trip to detach prototypes and make the returned shape JSON-only.
 return { ok: true, value: JSON.parse(JSON.stringify(value)), errors: [] };
}

function normalizeResourceDefinition(raw) {
 const input = plainObject(raw) ? raw : {};
 const errors = [];
 const name = String(input.name || '').trim().replace(/\s+/g, ' ');
 if (!name) errors.push('name is required');
 if (name.length > RESOURCE_NAME_MAX) errors.push(`name must be at most ${RESOURCE_NAME_MAX} characters`);

 const facet = String(input.facet || '').trim();
 if (!RESOURCE_FACETS.includes(facet)) errors.push(`facet must be one of ${RESOURCE_FACETS.join(', ')}`);

 const visibility = String(input.visibility || 'workspace').trim();
 if (!RESOURCE_VISIBILITIES.includes(visibility)) {
  errors.push(`visibility must be one of ${RESOURCE_VISIBILITIES.join(', ')}`);
 }

 const description = String(input.description || '').trim();
 if (description.length > RESOURCE_DESCRIPTION_MAX) {
  errors.push(`description must be at most ${RESOURCE_DESCRIPTION_MAX} characters`);
 }
 const descriptor = normalizeBoundedObject(input.descriptor, {
  label: 'descriptor',
  maxBytes: RESOURCE_DESCRIPTOR_MAX_BYTES,
 });
 errors.push(...descriptor.errors);

 return {
  ok: errors.length === 0,
  errors,
  resource: errors.length === 0 ? {
   name,
   description,
   facet,
   visibility,
   descriptor: descriptor.value,
  } : null,
 };
}

function normalizeResourceOperationRequest(raw) {
 const input = plainObject(raw) ? raw : {};
 const errors = [];
 const operation = String(input.operation || '').trim();
 if (!RESOURCE_OPERATIONS.includes(operation)) {
  errors.push(`operation must be one of ${RESOURCE_OPERATIONS.join(', ')}`);
 }
 const inputArtifact = normalizeBoundedObject(input.inputArtifact ?? input.input_artifact, {
  label: 'inputArtifact',
  maxBytes: RESOURCE_ARTIFACT_MAX_BYTES,
 });
 errors.push(...inputArtifact.errors);
 const idempotencyKey = String(input.idempotencyKey ?? input.idempotency_key ?? '').trim();
 if (!idempotencyKey) errors.push('idempotencyKey is required');
 if (idempotencyKey.length > RESOURCE_IDEMPOTENCY_KEY_MAX) {
  errors.push(`idempotencyKey must be at most ${RESOURCE_IDEMPOTENCY_KEY_MAX} characters`);
 }
 return {
  ok: errors.length === 0,
  errors,
  request: errors.length === 0 ? {
   operation,
   inputArtifact: inputArtifact.value,
   idempotencyKey,
  } : null,
 };
}

function normalizeResourceOperationResult(raw) {
 const input = plainObject(raw) ? raw : {};
 const errors = [];
 const status = String(input.status || 'completed').trim();
 if (!['completed', 'rejected', 'failed'].includes(status)) {
  errors.push('status must be completed, rejected, or failed');
 }
 const outputArtifact = normalizeBoundedObject(input.outputArtifact ?? input.output_artifact, {
  label: 'outputArtifact',
  maxBytes: RESOURCE_ARTIFACT_MAX_BYTES,
 });
 errors.push(...outputArtifact.errors);
 const error = String(input.error || '').trim();
 if (error.length > RESOURCE_ERROR_MAX) {
  errors.push(`error must be at most ${RESOURCE_ERROR_MAX} characters`);
 }
 if ((status === 'rejected' || status === 'failed') && !error) {
  errors.push('error is required when status is rejected or failed');
 }
 return {
  ok: errors.length === 0,
  errors,
  result: errors.length === 0 ? { status, outputArtifact: outputArtifact.value, error } : null,
 };
}

function parseJsonObject(value) {
 if (plainObject(value)) return value;
 if (typeof value !== 'string') return {};
 try {
  const parsed = JSON.parse(value);
  return plainObject(parsed) ? parsed : {};
 } catch {
  return {};
 }
}

function publicResource(row) {
 if (!row || typeof row !== 'object') return null;
 return {
  id: row.id,
  workspace_id: row.workspace_id,
  steward_agent_id: row.steward_agent_id,
  controller_id: row.controller_id || null,
  name: String(row.name || ''),
  description: String(row.description || ''),
  facet: RESOURCE_FACETS.includes(row.facet) ? row.facet : '',
  descriptor: parseJsonObject(row.descriptor),
  version: Number(row.version) || 1,
  visibility: RESOURCE_VISIBILITIES.includes(row.visibility) ? row.visibility : 'restricted',
  status: RESOURCE_STATUSES.includes(row.status) ? row.status : 'archived',
  created_by: row.created_by || null,
  created_at: row.created_at || null,
  updated_at: row.updated_at || null,
 };
}

function publicResourceOperation(row, { includeArtifacts = true } = {}) {
 if (!row || typeof row !== 'object') return null;
 const out = {
  id: row.id,
  workspace_id: row.workspace_id,
  resource_id: row.resource_id,
  steward_agent_id: row.steward_agent_id,
  requested_by_user_id: row.requested_by_user_id || null,
  requested_by_agent_id: row.requested_by_agent_id || null,
  requested_by_controller_id: row.requested_by_controller_id || null,
  requested_by_workspace_id: row.requested_by_workspace_id || null,
  claimed_by_agent_id: row.claimed_by_agent_id || null,
  operation: RESOURCE_OPERATIONS.includes(row.operation) ? row.operation : '',
  status: RESOURCE_OPERATION_STATUSES.includes(row.status) ? row.status : 'failed',
  resource_version: Number(row.resource_version) || 1,
  error: String(row.error || ''),
  audit_reference: row.audit_reference || null,
  created_at: row.created_at || null,
  updated_at: row.updated_at || null,
  claimed_at: row.claimed_at || null,
  completed_at: row.completed_at || null,
 };
 if (includeArtifacts) {
  out.input_artifact = parseJsonObject(row.input_artifact);
  out.output_artifact = parseJsonObject(row.output_artifact);
 }
 return out;
}

module.exports = {
 RESOURCE_FACETS,
 RESOURCE_OPERATIONS,
 RESOURCE_VISIBILITIES,
 RESOURCE_STATUSES,
 RESOURCE_OPERATION_STATUSES,
 RESOURCE_NAME_MAX,
 RESOURCE_DESCRIPTION_MAX,
 RESOURCE_DESCRIPTOR_MAX_BYTES,
 RESOURCE_ARTIFACT_MAX_BYTES,
 RESOURCE_IDEMPOTENCY_KEY_MAX,
 RESOURCE_ERROR_MAX,
 SENSITIVE_KEY_RE,
 plainObject,
 jsonBytes,
 normalizedKeyName,
 sensitivePaths,
 normalizeBoundedObject,
 normalizeResourceDefinition,
 normalizeResourceOperationRequest,
 normalizeResourceOperationResult,
 publicResource,
 publicResourceOperation,
};
