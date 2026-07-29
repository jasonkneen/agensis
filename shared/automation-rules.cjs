'use strict';

// ============================================================================
// shared/automation-rules.cjs
// ----------------------------------------------------------------------------
// The deterministic half of workspace automations: the condition evaluator, the
// interpolator, the definition validator, and the YAML renderer.
//
// PURE. No db, no clock, no network, no require of anything in server/. Every
// function here is a function of its arguments, which is what lets the whole
// decision surface be unit-tested without a database — the same posture as
// shared/replyCadence.cjs.
//
// WHY THIS MODULE IS THE POINT OF THE FEATURE. agensis has three automation
// systems already (agent_schedules, agent_webhooks, flow_connections) and in
// every one of them the only thing that can decide anything is a language model:
// a schedule posts a prompt and pays for a turn, a webhook makes a session and
// pays for a turn, a discarded thread is read by a model. There is no path in
// this product by which "if a message in this channel says 'deploy failed',
// post to #urgent" happens for zero cost with the same answer every time. That
// is what this evaluator buys, and it is a genuinely new capability rather than
// a nicer wrapper on an existing one. An automation that must be RIGHT (an
// escalation, an on-call handoff) cannot be a model call that is right most of
// the time.
//
// SO IT IS DELIBERATELY NOT A LANGUAGE. Fields are a fixed allowlist mapped to
// reader functions, not a path expression. Ops are a closed set of string and
// boolean predicates -- no regex (a user-supplied regex over user-supplied
// message content is a ReDoS primitive), no arithmetic, no OR, no nesting.
// Interpolation substitutes allowlisted field values into message text and
// nothing else -- never into a URL, an identifier, or a SQL fragment. Every one
// of those omissions is what stops "the condition language" from becoming "the
// sandbox escape".
//
// The wire format is JSON, not YAML. A model or a human emitting YAML hits
// significant whitespace and the type coercions (`on:` -> boolean true, `no` ->
// false, an unquoted `1.0` -> float) which do not throw -- they produce a
// DIFFERENT VALID DOCUMENT that runs the wrong step at 3am. JSON's failure mode
// is a parse error at the boundary, which is the failure mode you want at an
// API edge. YAML is rendered here for reading, diffing and pasting, and nothing
// parses it back.

/** Definition format version. Bump only for a breaking shape change. */
const AUTOMATION_DEFINITION_VERSION = 1;

/** Ceilings. Each one is a bound on what a single definition can express. */
const MAX_STEPS = 5;
const MAX_CONDITIONS = 10;
const MAX_TEXT_LENGTH = 4000;
/**
 * Interpolated values are capped well below MAX_TEXT_LENGTH. A message body can
 * be 20k characters; without this, one `{{data.content}}` in a step turns every
 * triggering message into a 20k echo.
 */
const MAX_INTERPOLATED_LENGTH = 500;

/**
 * The fields a condition may read, as a Map from the authored string to a reader.
 *
 * A MAP, not a path walker. `readField` cannot reach a key that is not in here,
 * so a definition can never read (or interpolate) a field nobody vetted -- and
 * "add a field" is a visible diff to this list rather than an emergent property
 * of whatever the projection happens to contain. The projection itself is
 * publicFlowEventRecord in server/index.cjs, which is already the redacted,
 * client-safe view of a row.
 */
const AUTOMATION_FIELDS = new Map([
 ['type', (event) => event?.type],
 ['workspaceId', (event) => event?.workspaceId],
 ['channelId', (event) => event?.channelId],
 ['data.content', (event) => event?.data?.content],
 ['data.title', (event) => event?.data?.title],
 ['data.role', (event) => event?.data?.role],
 ['data.senderKind', (event) => event?.data?.senderKind],
 ['data.senderName', (event) => event?.data?.senderName],
 ['data.senderId', (event) => event?.data?.senderId],
 ['data.name', (event) => event?.data?.name],
 ['data.handle', (event) => event?.data?.handle],
 ['data.folder', (event) => event?.data?.folder],
 ['data.role_name', (event) => event?.data?.role],
]);

/**
 * Ops. String and boolean only.
 *
 * Comparison is case-insensitive for the text ops because the alternative is
 * every user's first automation silently failing on "Deploy Failed" -- and a
 * case-sensitive variant is an addition anyone can make later, whereas a
 * case-sensitive default is a support burden now.
 */
const AUTOMATION_OPS = new Map([
 ['equals', (actual, expected) => norm(actual) === norm(expected)],
 ['not_equals', (actual, expected) => norm(actual) !== norm(expected)],
 ['contains', (actual, expected) => norm(expected) !== '' && norm(actual).includes(norm(expected))],
 ['not_contains', (actual, expected) => norm(expected) === '' || !norm(actual).includes(norm(expected))],
 ['starts_with', (actual, expected) => norm(expected) !== '' && norm(actual).startsWith(norm(expected))],
 ['is_empty', (actual) => norm(actual) === ''],
 ['is_not_empty', (actual) => norm(actual) !== ''],
]);

/** Ops that ignore `value`, so the validator must not demand one. */
const UNARY_OPS = new Set(['is_empty', 'is_not_empty']);

/**
 * Actions. v1 has exactly one, and the omissions are the safety property.
 *
 * `post_message` inserts a message and notifies subscribers. It does NOT call
 * continueConversation, so it does not advance the conversation and does not
 * wake any agent -- exactly the semantics the MCP `post_message` tool already
 * documents ("Pure speak -- it does NOT trigger other agents to respond").
 * That is what makes an automation run cost zero model calls.
 *
 * There is deliberately NO `dispatch_agent` here. With no action that can start
 * an agent turn, unbounded agent-job fan-out is impossible BY CONSTRUCTION
 * rather than bounded by a limiter someone could later raise. When it is added,
 * it must go through continueConversation (never a direct agent_jobs insert) so
 * it inherits the one-active-job index, the turn budget and the conversation
 * lock -- and the run-time re-check of the author's role becomes mandatory.
 */
const AUTOMATION_ACTIONS = new Set(['post_message']);

function norm(value) {
 if (value === null || value === undefined) return '';
 if (typeof value === 'boolean') return value ? 'true' : 'false';
 return String(value).trim().toLowerCase();
}

/** The raw value of an allowlisted field, or undefined. Never walks a path. */
function readField(event, field) {
 const reader = AUTOMATION_FIELDS.get(String(field));
 if (!reader) return undefined;
 return reader(event);
}

/**
 * Do ALL conditions hold?
 *
 * AND, never OR -- `every`. An empty list matches everything, which is the
 * honest reading of "no conditions" and is why a definition with no `when` is a
 * fire-on-every-event automation (and why new automations start disabled).
 *
 * A condition naming an unknown field or op returns FALSE rather than throwing
 * or being skipped. Skipping would make a typo'd condition silently widen the
 * automation to match more than the author asked for, which is the direction
 * that costs money; failing closed makes it match nothing and get noticed.
 */
function evaluateConditions(conditions, event) {
 if (!Array.isArray(conditions) || conditions.length === 0) return true;
 return conditions.every((condition) => {
  if (!condition || typeof condition !== 'object') return false;
  const op = AUTOMATION_OPS.get(String(condition.op));
  if (!op) return false;
  if (!AUTOMATION_FIELDS.has(String(condition.field))) return false;
  return Boolean(op(readField(event, condition.field), condition.value));
 });
}

/**
 * Substitute `{{field}}` from the same allowlist into a string.
 *
 * An unknown or unreadable token is left LITERAL rather than replaced with
 * 'undefined' or an empty string: the author sees `{{data.nope}}` in the posted
 * message and can fix it, instead of quietly getting a sentence with a hole in
 * it. Never throws -- an automation must not die on a bad token.
 */
function interpolate(text, event) {
 if (typeof text !== 'string' || text === '') return '';
 return text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (whole, field) => {
  if (!AUTOMATION_FIELDS.has(field)) return whole;
  const value = readField(event, field);
  if (value === null || value === undefined) return whole;
  return String(value).slice(0, MAX_INTERPOLATED_LENGTH);
 });
}

function fail(errors, message) {
 errors.push(message);
 return errors;
}

function cleanText(value, max = MAX_TEXT_LENGTH) {
 return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Validate and NORMALISE a definition.
 *
 * Returns `{ ok, errors, definition }`. On success `definition` is a rebuilt
 * object containing only known keys with clamped values -- the caller stores
 * THAT, never the caller-supplied object. Rebuilding rather than mutating means
 * an unknown key cannot ride into the database and cannot later be read by
 * something that trusts the stored shape.
 *
 * `allowedEvents` is injected rather than imported so this module stays pure and
 * the event vocabulary has exactly one home (server/flow-integration.cjs
 * FLOW_EVENTS). A definition naming an event outside it is rejected at write
 * time, which is the only place it can be rejected cheaply.
 */
function validateDefinition(input, { allowedEvents = [] } = {}) {
 const errors = [];
 const allowed = new Set(allowedEvents);
 if (!input || typeof input !== 'object' || Array.isArray(input)) {
  return { ok: false, errors: ['definition must be an object'], definition: null };
 }

 const version = input.version === undefined ? AUTOMATION_DEFINITION_VERSION : input.version;
 if (version !== AUTOMATION_DEFINITION_VERSION) {
  fail(errors, `version must be ${AUTOMATION_DEFINITION_VERSION}`);
 }

 const trigger = input.trigger;
 const event = trigger && typeof trigger === 'object' ? String(trigger.event || '') : '';
 if (!event) fail(errors, 'trigger.event is required');
 else if (allowed.size > 0 && !allowed.has(event)) fail(errors, `trigger.event ${JSON.stringify(event)} is not a known event`);

 const rawWhen = input.when === undefined ? [] : input.when;
 const when = [];
 if (!Array.isArray(rawWhen)) {
  fail(errors, 'when must be an array');
 } else if (rawWhen.length > MAX_CONDITIONS) {
  fail(errors, `when may have at most ${MAX_CONDITIONS} conditions`);
 } else {
  rawWhen.forEach((condition, index) => {
   if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    fail(errors, `when[${index}] must be an object`);
    return;
   }
   const field = String(condition.field || '');
   const op = String(condition.op || '');
   if (!AUTOMATION_FIELDS.has(field)) {
    fail(errors, `when[${index}].field ${JSON.stringify(field)} is not a readable field`);
    return;
   }
   if (!AUTOMATION_OPS.has(op)) {
    fail(errors, `when[${index}].op ${JSON.stringify(op)} is not a supported operator`);
    return;
   }
   const unary = UNARY_OPS.has(op);
   if (!unary && (condition.value === undefined || condition.value === null)) {
    fail(errors, `when[${index}] requires a value for op ${op}`);
    return;
   }
   when.push(unary
    ? { field, op }
    : { field, op, value: cleanText(String(condition.value), MAX_INTERPOLATED_LENGTH) });
  });
 }

 const rawSteps = input.steps;
 const steps = [];
 if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
  fail(errors, 'steps must be a non-empty array');
 } else if (rawSteps.length > MAX_STEPS) {
  fail(errors, `steps may have at most ${MAX_STEPS} entries`);
 } else {
  rawSteps.forEach((step, index) => {
   if (!step || typeof step !== 'object' || Array.isArray(step)) {
    fail(errors, `steps[${index}] must be an object`);
    return;
   }
   const action = String(step.action || '');
   if (!AUTOMATION_ACTIONS.has(action)) {
    fail(errors, `steps[${index}].action ${JSON.stringify(action)} is not a supported action`);
    return;
   }
   if (action === 'post_message') {
    const channelId = String(step.channelId || '').trim();
    const text = cleanText(step.text);
    if (!channelId) { fail(errors, `steps[${index}].channelId is required`); return; }
    if (!text.trim()) { fail(errors, `steps[${index}].text is required`); return; }
    steps.push({ action, channelId, text });
   }
  });
 }

 if (errors.length) return { ok: false, errors, definition: null };
 return {
  ok: true,
  errors: [],
  definition: { version: AUTOMATION_DEFINITION_VERSION, trigger: { event }, when, steps },
 };
}

/**
 * YAML scalar quoting.
 *
 * The whole reason the wire format is JSON is that YAML coerces silently, so a
 * renderer that emits `enabled: on` or `value: 1.0` unquoted would reintroduce
 * exactly the ambiguity this design avoided -- and this output is what a human
 * reads to decide whether the automation does what they meant. Anything that
 * could parse as a non-string gets quoted.
 */
const YAML_AMBIGUOUS = /^(?:|~|null|Null|NULL|true|True|TRUE|false|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|[-+]?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

function yamlScalar(value) {
 if (value === null || value === undefined) return 'null';
 if (typeof value === 'boolean') return value ? 'true' : 'false';
 if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
 const text = String(value);
 const needsQuote = text === ''
  || YAML_AMBIGUOUS.test(text)
  || /^[\s]|[\s]$/.test(text)
  || /[:#\-?,[\]{}&*!|>'"%@`\n\r\t]/.test(text);
 if (!needsQuote) return text;
 return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/**
 * Render a VALIDATED definition as YAML, for reading, diffing and pasting.
 *
 * Display only. Nothing parses this back in v1, and there is no YAML parser in
 * this repo -- adding one would mean a third-party parser processing text a
 * manage-role user supplies, on the Fly machine, for no capability gain.
 * Import-from-YAML is the moment that dependency becomes justified.
 */
function renderDefinitionYaml(definition) {
 const source = definition && typeof definition === 'object' ? definition : {};
 const lines = [];
 lines.push(`version: ${yamlScalar(source.version ?? AUTOMATION_DEFINITION_VERSION)}`);
 lines.push('trigger:');
 lines.push(`  event: ${yamlScalar(source.trigger?.event ?? '')}`);

 const when = Array.isArray(source.when) ? source.when : [];
 if (when.length === 0) {
  lines.push('when: []');
 } else {
  lines.push('when:');
  for (const condition of when) {
   lines.push(`  - field: ${yamlScalar(condition.field)}`);
   lines.push(`    op: ${yamlScalar(condition.op)}`);
   if (Object.prototype.hasOwnProperty.call(condition, 'value')) {
    lines.push(`    value: ${yamlScalar(condition.value)}`);
   }
  }
 }

 const steps = Array.isArray(source.steps) ? source.steps : [];
 if (steps.length === 0) {
  lines.push('steps: []');
 } else {
  lines.push('steps:');
  for (const step of steps) {
   lines.push(`  - action: ${yamlScalar(step.action)}`);
   if (step.channelId !== undefined) lines.push(`    channelId: ${yamlScalar(step.channelId)}`);
   if (step.text !== undefined) lines.push(`    text: ${yamlScalar(step.text)}`);
  }
 }
 return `${lines.join('\n')}\n`;
}

module.exports = {
 AUTOMATION_DEFINITION_VERSION,
 AUTOMATION_FIELDS,
 AUTOMATION_OPS,
 AUTOMATION_ACTIONS,
 UNARY_OPS,
 MAX_STEPS,
 MAX_CONDITIONS,
 MAX_TEXT_LENGTH,
 MAX_INTERPOLATED_LENGTH,
 readField,
 evaluateConditions,
 interpolate,
 validateDefinition,
 renderDefinitionYaml,
 yamlScalar,
};
