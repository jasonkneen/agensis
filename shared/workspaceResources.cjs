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
const RESOURCE_OPERATION_PROGRESS_PHASES = Object.freeze([
 'queued',
 'planning',
 'executing',
 'verifying',
 'waiting',
 'completed',
 'rejected',
 'failed',
]);
const RESOURCE_OPERATION_STEP_STATUSES = Object.freeze([
 'pending',
 'running',
 'completed',
 'failed',
 'skipped',
]);

const RESOURCE_NAME_MAX = 120;
const RESOURCE_DESCRIPTION_MAX = 2_000;
const RESOURCE_DESCRIPTOR_MAX_BYTES = 32 * 1024;
const RESOURCE_ARTIFACT_MAX_BYTES = 256 * 1024;
const RESOURCE_IDEMPOTENCY_KEY_MAX = 160;
const RESOURCE_ERROR_MAX = 1_000;
const RESOURCE_OPERATION_STEP_ID_MAX = 64;
const RESOURCE_OPERATION_STEP_INSTRUCTION_MAX = 4_000;
const RESOURCE_OPERATION_MAX_STEPS = 32;
const RESOURCE_OPERATION_PROGRESS_MESSAGE_MAX = 2_000;

const SENSITIVE_KEY_RE = /(?:^|[_-])(?:token|secret|password|passwd|pwd|authorization|cookie|credential|api[_-]?key|private[_-]?key|ciphertext|connect[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?(?:token|secret)|bearer|oauth[_-]?token|ssh[_-]?(?:private[_-]?)?key)(?:$|[_-])/i;
const SENSITIVE_MESSAGE_RE = /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|private[_ -]?key|client[_ -]?secret|bearer)\s*[:=]/i;

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

function normalizeResourceOperationSteps(raw) {
 if (raw === undefined || raw === null) return { ok: true, steps: [], errors: [] };
 if (!Array.isArray(raw)) {
  return { ok: false, steps: [], errors: ['steps must be an array'] };
 }
 const errors = [];
 if (raw.length > RESOURCE_OPERATION_MAX_STEPS) {
  errors.push(`steps must contain at most ${RESOURCE_OPERATION_MAX_STEPS} items`);
 }
 const steps = [];
 const ids = new Set();
 for (let index = 0; index < Math.min(raw.length, RESOURCE_OPERATION_MAX_STEPS); index += 1) {
  const input = plainObject(raw[index]) ? raw[index] : {};
  const rawId = input.id;
  const rawInstruction = input.instruction ?? input.request;
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  const instruction = typeof rawInstruction === 'string' ? rawInstruction.trim() : '';
  const dependsOn = input.dependsOn ?? input.depends_on ?? [];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || id.length > RESOURCE_OPERATION_STEP_ID_MAX) {
   errors.push(`steps[${index}].id must start with a letter or number and contain only letters, numbers, _ or -`);
  } else if (ids.has(id)) {
   errors.push(`steps contains duplicate id: ${id}`);
  } else {
   ids.add(id);
  }
  if (!instruction) errors.push(`steps[${index}].instruction is required`);
  if (instruction.length > RESOURCE_OPERATION_STEP_INSTRUCTION_MAX) {
   errors.push(`steps[${index}].instruction must be at most ${RESOURCE_OPERATION_STEP_INSTRUCTION_MAX} characters`);
  }
  if (!Array.isArray(dependsOn)) {
   errors.push(`steps[${index}].dependsOn must be an array`);
  }
  if (Array.isArray(dependsOn)) {
   for (const dependency of dependsOn) {
    if (typeof dependency !== 'string' || !dependency.trim()) {
     errors.push(`steps[${index}].dependsOn must contain non-empty strings`);
    }
   }
  }
  const normalizedDependencies = Array.isArray(dependsOn)
   ? [...new Set(dependsOn.map(value => (typeof value === 'string' ? value.trim() : '')).filter(Boolean))]
   : [];
  for (const dependency of normalizedDependencies) {
   if (dependency === id) errors.push(`steps[${index}] cannot depend on itself`);
   if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dependency)) {
    errors.push(`steps[${index}].dependsOn contains an invalid step id: ${dependency}`);
   }
  }
  steps.push({ id, instruction, dependsOn: normalizedDependencies });
 }
 // Dependencies must refer to declared steps and form a DAG. This keeps a
 // steward from receiving an execution plan that can never make progress.
 for (const step of steps) {
  for (const dependency of step.dependsOn) {
   if (!ids.has(dependency)) errors.push(`step ${step.id} depends on unknown step: ${dependency}`);
  }
 }
 const byId = new Map(steps.map(step => [step.id, step]));
 const visiting = new Set();
 const visited = new Set();
 const visit = (id) => {
  if (visited.has(id)) return false;
  if (visiting.has(id)) return true;
  visiting.add(id);
  const step = byId.get(id);
  const cycle = step ? step.dependsOn.some(dependency => byId.has(dependency) && visit(dependency)) : false;
  visiting.delete(id);
  visited.add(id);
  return cycle;
 };
 for (const step of steps) {
  if (visit(step.id)) {
   errors.push('steps must not contain dependency cycles');
   break;
  }
 }
 return { ok: errors.length === 0, steps: errors.length === 0 ? steps : [], errors };
}

function normalizeResourceOperationProgress(raw) {
 const input = plainObject(raw) ? raw : {};
 const errors = [];
 const phase = String(input.phase || '').trim();
 if (!RESOURCE_OPERATION_PROGRESS_PHASES.includes(phase)) {
  errors.push(`phase must be one of ${RESOURCE_OPERATION_PROGRESS_PHASES.join(', ')}`);
 }
 const message = String(input.message || '').trim();
 if (!message) errors.push('message is required');
 if (message.length > RESOURCE_OPERATION_PROGRESS_MESSAGE_MAX) {
  errors.push(`message must be at most ${RESOURCE_OPERATION_PROGRESS_MESSAGE_MAX} characters`);
 }
 if (message && (SENSITIVE_KEY_RE.test(message) || SENSITIVE_MESSAGE_RE.test(message))) {
  errors.push('message must not include credential-like field names');
 }
 const stepId = input.stepId ?? input.step_id;
 if (stepId !== undefined && stepId !== null && stepId !== '') {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(stepId).trim())) {
   errors.push('stepId must be a valid operation step id');
  }
 }
 const stepStatus = input.stepStatus ?? input.step_status;
 if (stepStatus !== undefined && stepStatus !== null && stepStatus !== ''
  && !RESOURCE_OPERATION_STEP_STATUSES.includes(String(stepStatus).trim())) {
  errors.push(`stepStatus must be one of ${RESOURCE_OPERATION_STEP_STATUSES.join(', ')}`);
 }
 let percent = null;
 if (input.percent !== undefined && input.percent !== null && input.percent !== '') {
  percent = Number(input.percent);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
   errors.push('percent must be an integer between 0 and 100');
  }
 }
 return {
  ok: errors.length === 0,
  errors,
  progress: errors.length === 0 ? {
   phase,
   message,
   stepId: stepId === undefined || stepId === null || stepId === '' ? null : String(stepId).trim(),
   stepStatus: stepStatus === undefined || stepStatus === null || stepStatus === '' ? null : String(stepStatus).trim(),
   percent,
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
 const hasRequestText = input.requestText !== undefined || input.request_text !== undefined;
 const hasInputArtifact = input.inputArtifact !== undefined || input.input_artifact !== undefined;
 const hasSteps = input.steps !== undefined;
 const hasStopOnError = input.stopOnError !== undefined || input.stop_on_error !== undefined;
 const requestText = input.requestText ?? input.request_text;
 if (hasRequestText && typeof requestText !== 'string') errors.push('requestText must be a string');
 if (typeof requestText === 'string' && !requestText.trim()) errors.push('requestText must not be empty');
 if (hasRequestText && hasInputArtifact) errors.push('requestText cannot be combined with inputArtifact');
 if (hasSteps && hasInputArtifact) errors.push('steps cannot be combined with inputArtifact; put steps inside inputArtifact instead');
 if (hasStopOnError && hasInputArtifact) errors.push('stopOnError cannot be combined with inputArtifact; put stopOnError inside inputArtifact instead');
 const rawInputArtifact = !hasRequestText
  ? (input.inputArtifact ?? input.input_artifact)
  : {
   request: typeof requestText === 'string' ? requestText.trim() : '',
   ...(hasSteps ? { steps: input.steps } : {}),
   ...(hasStopOnError ? { stopOnError: input.stopOnError ?? input.stop_on_error } : {}),
  };
 const inputArtifact = normalizeBoundedObject(rawInputArtifact, {
  label: 'inputArtifact',
  maxBytes: RESOURCE_ARTIFACT_MAX_BYTES,
 });
 errors.push(...inputArtifact.errors);
 let normalizedArtifact = inputArtifact.value;
 if (inputArtifact.ok) {
  const stepResult = normalizeResourceOperationSteps(normalizedArtifact.steps);
  errors.push(...stepResult.errors);
  if (stepResult.steps.length > 0) normalizedArtifact = { ...normalizedArtifact, steps: stepResult.steps };
  else if (Object.prototype.hasOwnProperty.call(normalizedArtifact, 'steps')) {
   normalizedArtifact = { ...normalizedArtifact, steps: [] };
  }
  if (Object.prototype.hasOwnProperty.call(normalizedArtifact, 'stopOnError')) {
   if (typeof normalizedArtifact.stopOnError !== 'boolean') errors.push('stopOnError must be true or false');
  }
 }
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
   inputArtifact: normalizedArtifact,
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
  deleted_at: row.deleted_at || null,
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
  progress: parseJsonObject(row.progress),
  progress_seq: Number(row.progress_seq) || 0,
  progress_updated_at: row.progress_updated_at || null,
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
 RESOURCE_OPERATION_PROGRESS_PHASES,
 RESOURCE_OPERATION_STEP_STATUSES,
 RESOURCE_NAME_MAX,
 RESOURCE_DESCRIPTION_MAX,
 RESOURCE_DESCRIPTOR_MAX_BYTES,
 RESOURCE_ARTIFACT_MAX_BYTES,
 RESOURCE_IDEMPOTENCY_KEY_MAX,
 RESOURCE_ERROR_MAX,
 RESOURCE_OPERATION_STEP_ID_MAX,
 RESOURCE_OPERATION_STEP_INSTRUCTION_MAX,
 RESOURCE_OPERATION_MAX_STEPS,
 RESOURCE_OPERATION_PROGRESS_MESSAGE_MAX,
 SENSITIVE_KEY_RE,
 plainObject,
 jsonBytes,
 normalizedKeyName,
 sensitivePaths,
 normalizeBoundedObject,
 normalizeResourceDefinition,
 normalizeResourceOperationSteps,
 normalizeResourceOperationProgress,
 normalizeResourceOperationRequest,
 normalizeResourceOperationResult,
 publicResource,
 publicResourceOperation,
};
