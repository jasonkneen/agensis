'use strict';

// ============================================================================
// tests/automation-rules.test.cjs
// ----------------------------------------------------------------------------
// The pure half of automations: condition evaluation, interpolation, definition
// validation, and the YAML renderer.
//
// No db and no mock db, because there is nothing to mock — every function under
// test is a function of its arguments. That is the point of keeping this module
// pure: the whole decision surface of the feature is checkable without a
// database, so these assertions cannot pass against a fake's logic instead of
// the real thing.
//
// The load-bearing group is validation. `validateDefinition` is the ONLY thing
// standing between a caller-supplied blob and a stored standing grant to write
// into a workspace, so every allowlist it enforces gets a test naming the
// mutation that would defeat it.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const {
 AUTOMATION_DEFINITION_VERSION,
 AUTOMATION_FIELDS,
 AUTOMATION_OPS,
 AUTOMATION_ACTIONS,
 MAX_STEPS,
 MAX_CONDITIONS,
 MAX_INTERPOLATED_LENGTH,
 readField,
 evaluateConditions,
 interpolate,
 validateDefinition,
 renderDefinitionYaml,
} = require('../shared/automation-rules.cjs');

const EVENTS = ['message.created', 'message.updated', 'document.created'];

/** A projected event, the shape publicFlowEventRecord produces for a message. */
function messageEvent(overrides = {}) {
 return {
  id: 'message.created:m-1:1',
  type: 'message.created',
  workspaceId: 'ws-1',
  channelId: 'chan-1',
  data: {
   id: 'm-1',
   content: 'The deploy failed on staging',
   role: 'user',
   senderKind: 'user',
   senderName: 'Jason',
   senderId: 'user-1',
   ...overrides,
  },
 };
}

function definition(overrides = {}) {
 return {
  version: 1,
  trigger: { event: 'message.created' },
  when: [],
  steps: [{ action: 'post_message', channelId: 'chan-2', text: 'Heads up' }],
  ...overrides,
 };
}

// --- fields ------------------------------------------------------------------

test('readField reads only allowlisted fields', () => {
 // MUTATION: give AUTOMATION_FIELDS a default/fallback reader that walks the
 // path -> the unknown-field asserts fail. The Map IS the allowlist; a path
 // walker would let a definition read anything the projection happens to hold.
 const event = messageEvent();
 assert.equal(readField(event, 'data.content'), 'The deploy failed on staging');
 assert.equal(readField(event, 'channelId'), 'chan-1');
 assert.equal(readField(event, 'type'), 'message.created');
 assert.equal(readField(event, 'data.senderId'), 'user-1');

 assert.equal(readField(event, 'data.id'), undefined, 'data.id is not allowlisted');
 assert.equal(readField(event, 'data'), undefined);
 assert.equal(readField(event, '__proto__'), undefined);
 assert.equal(readField(event, 'constructor'), undefined);
 assert.equal(readField(event, 'data.content.length'), undefined);
});

test('the field, op and action allowlists are closed sets', () => {
 // Any addition to these is a visible diff to this test, which is the whole
 // mechanism stopping "the condition language" becoming a language.
 assert.equal(AUTOMATION_FIELDS.has('data.content'), true);
 assert.deepEqual([...AUTOMATION_OPS.keys()].sort(), [
  'contains', 'equals', 'is_empty', 'is_not_empty', 'not_contains', 'not_equals', 'starts_with',
 ]);
 // No regex op: a user-supplied regex over user-supplied message content is a
 // ReDoS primitive.
 assert.equal(AUTOMATION_OPS.has('matches'), false);
 assert.equal(AUTOMATION_OPS.has('regex'), false);
 // v1 has exactly one action, and the absence of dispatch_agent is what makes
 // unbounded agent-job fan-out impossible by construction.
 assert.deepEqual([...AUTOMATION_ACTIONS], ['post_message']);
 assert.equal(AUTOMATION_ACTIONS.has('dispatch_agent'), false);
});

// --- conditions --------------------------------------------------------------

test('conditions are AND, never OR', () => {
 // MUTATION: change the `every` in evaluateConditions to `some` -> the mixed
 // case starts matching and this fails.
 const event = messageEvent();
 const hit = { field: 'data.content', op: 'contains', value: 'deploy failed' };
 const miss = { field: 'channelId', op: 'equals', value: 'other-channel' };

 assert.equal(evaluateConditions([hit], event), true);
 assert.equal(evaluateConditions([miss], event), false);
 assert.equal(evaluateConditions([hit, miss], event), false, 'one failing clause must fail the whole set');
 assert.equal(evaluateConditions([hit, { field: 'channelId', op: 'equals', value: 'chan-1' }], event), true);
});

test('an empty condition list matches everything', () => {
 assert.equal(evaluateConditions([], messageEvent()), true);
 assert.equal(evaluateConditions(undefined, messageEvent()), true);
});

test('an unknown field or op fails CLOSED', () => {
 // MUTATION: skip unknown clauses instead of returning false -> these pass
 // trivially and a typo'd condition silently widens the automation to match
 // more than the author asked for. Failing closed makes it match nothing and
 // get noticed.
 const event = messageEvent();
 assert.equal(evaluateConditions([{ field: 'data.nope', op: 'equals', value: 'x' }], event), false);
 assert.equal(evaluateConditions([{ field: 'data.content', op: 'regex', value: '.*' }], event), false);
 assert.equal(evaluateConditions([null], event), false);
 assert.equal(evaluateConditions(['not an object'], event), false);
});

test('every op behaves', () => {
 const event = messageEvent();
 const check = (op, value) => evaluateConditions([{ field: 'data.content', op, value }], event);
 assert.equal(check('equals', 'The deploy failed on staging'), true);
 assert.equal(check('equals', 'THE DEPLOY FAILED ON STAGING'), true, 'case-insensitive');
 assert.equal(check('not_equals', 'something else'), true);
 assert.equal(check('contains', 'DEPLOY FAILED'), true);
 assert.equal(check('not_contains', 'succeeded'), true);
 assert.equal(check('starts_with', 'the deploy'), true);
 assert.equal(check('starts_with', 'deploy'), false);
 assert.equal(evaluateConditions([{ field: 'data.content', op: 'is_empty' }], event), false);
 assert.equal(evaluateConditions([{ field: 'data.content', op: 'is_not_empty' }], event), true);

 // An empty needle must not make `contains` match everything — that would turn
 // a half-typed condition into a fire-on-everything automation.
 assert.equal(check('contains', ''), false);
 assert.equal(check('starts_with', ''), false);
 assert.equal(check('not_contains', ''), true);
});

test('a missing field is empty, not a crash', () => {
 const bare = { type: 'message.created', data: {} };
 assert.equal(evaluateConditions([{ field: 'data.content', op: 'is_empty' }], bare), true);
 assert.doesNotThrow(() => evaluateConditions([{ field: 'data.content', op: 'contains', value: 'x' }], null));
});

// --- interpolation -----------------------------------------------------------

test('interpolate substitutes allowlisted fields only', () => {
 const event = messageEvent();
 assert.equal(interpolate('From {{data.senderName}}', event), 'From Jason');
 assert.equal(interpolate('{{ data.senderName }} spaced', event), 'Jason spaced');
});

test('an unknown token is left LITERAL and never throws', () => {
 // MUTATION: return '' or String(undefined) for an unknown path -> this fails.
 // The author must be able to see `{{data.nope}}` in the posted message and fix
 // it, rather than getting a sentence with a silent hole in it.
 const event = messageEvent();
 assert.equal(interpolate('x {{data.nope}} y', event), 'x {{data.nope}} y');
 assert.equal(interpolate('x {{__proto__}} y', event), 'x {{__proto__}} y');
 assert.equal(interpolate('{{data.title}}', event), '{{data.title}}', 'allowlisted but absent stays literal');
 assert.doesNotThrow(() => interpolate('{{data.senderName}}', null));
});

test('interpolated values are length-capped', () => {
 // MUTATION: remove the .slice() -> this fails. A message body can be 20k
 // characters; without the cap one {{data.content}} echoes all of it.
 const event = messageEvent({ content: 'z'.repeat(5000) });
 const out = interpolate('{{data.content}}', event);
 assert.equal(out.length, MAX_INTERPOLATED_LENGTH);
});

test('interpolation cannot inject another token', () => {
 // A substituted value is not re-scanned, so content containing {{...}} cannot
 // reach a second round of substitution.
 const event = messageEvent({ senderName: '{{data.content}}' });
 assert.equal(interpolate('{{data.senderName}}', event), '{{data.content}}');
});

// --- validation --------------------------------------------------------------

test('a good definition validates and is REBUILT', () => {
 const result = validateDefinition(
  { ...definition(), extraKey: 'should not survive', steps: [{ action: 'post_message', channelId: 'chan-2', text: 'hi', bonus: 'nope' }] },
  { allowedEvents: EVENTS },
 );
 assert.equal(result.ok, true, result.errors.join('; '));
 // Rebuilt, not mutated: an unknown key must not ride into the database where
 // something later might trust the stored shape.
 assert.deepEqual(Object.keys(result.definition).sort(), ['steps', 'trigger', 'version', 'when']);
 assert.deepEqual(Object.keys(result.definition.steps[0]).sort(), ['action', 'channelId', 'text']);
 assert.equal(result.definition.version, AUTOMATION_DEFINITION_VERSION);
});

test('an unknown field is rejected at write time', () => {
 // MUTATION: drop the AUTOMATION_FIELDS.has check in the validator -> passes.
 const result = validateDefinition(
  definition({ when: [{ field: 'data.secret', op: 'equals', value: 'x' }] }),
  { allowedEvents: EVENTS },
 );
 assert.equal(result.ok, false);
 assert.match(result.errors.join(' '), /not a readable field/);
});

test('an unknown op is rejected', () => {
 const result = validateDefinition(
  definition({ when: [{ field: 'data.content', op: 'regex', value: '.*' }] }),
  { allowedEvents: EVENTS },
 );
 assert.equal(result.ok, false);
 assert.match(result.errors.join(' '), /not a supported operator/);
});

test('an unknown action is rejected', () => {
 // MUTATION: replace the AUTOMATION_ACTIONS.has check with a truthiness check
 // -> this passes and dispatch_agent becomes storable without an implementation.
 for (const action of ['dispatch_agent', 'http_post', 'delete_channel', '']) {
  const result = validateDefinition(
   definition({ steps: [{ action, channelId: 'c', text: 't' }] }),
   { allowedEvents: EVENTS },
  );
  assert.equal(result.ok, false, `${action} must be rejected`);
 }
});

test('an unknown trigger event is rejected', () => {
 const result = validateDefinition(
  definition({ trigger: { event: 'workspace.deleted' } }),
  { allowedEvents: EVENTS },
 );
 assert.equal(result.ok, false);
 assert.match(result.errors.join(' '), /not a known event/);
});

test('the step and condition caps hold', () => {
 // MUTATION: raise either cap -> these fail. The caps are why a definition
 // cannot express a variable number of actions.
 const tooManySteps = validateDefinition(
  definition({ steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ action: 'post_message', channelId: 'c', text: 't' })) }),
  { allowedEvents: EVENTS },
 );
 assert.equal(tooManySteps.ok, false);
 assert.match(tooManySteps.errors.join(' '), /at most 5/);

 const tooManyWhen = validateDefinition(
  definition({ when: Array.from({ length: MAX_CONDITIONS + 1 }, () => ({ field: 'data.content', op: 'is_not_empty' })) }),
  { allowedEvents: EVENTS },
 );
 assert.equal(tooManyWhen.ok, false);
 assert.match(tooManyWhen.errors.join(' '), /at most 10/);
});

test('a post_message step needs a channel and text', () => {
 for (const step of [
  { action: 'post_message', channelId: '', text: 'hi' },
  { action: 'post_message', channelId: 'c', text: '' },
  { action: 'post_message', channelId: 'c', text: '   ' },
  { action: 'post_message', channelId: 'c' },
 ]) {
  assert.equal(validateDefinition(definition({ steps: [step] }), { allowedEvents: EVENTS }).ok, false);
 }
});

test('steps must be a non-empty array and the whole thing an object', () => {
 assert.equal(validateDefinition(definition({ steps: [] }), { allowedEvents: EVENTS }).ok, false);
 assert.equal(validateDefinition(definition({ steps: 'post' }), { allowedEvents: EVENTS }).ok, false);
 assert.equal(validateDefinition(null, { allowedEvents: EVENTS }).ok, false);
 assert.equal(validateDefinition([], { allowedEvents: EVENTS }).ok, false);
 assert.equal(validateDefinition('{}', { allowedEvents: EVENTS }).ok, false);
});

test('a unary op needs no value and a binary op does', () => {
 const unary = validateDefinition(
  definition({ when: [{ field: 'data.content', op: 'is_empty' }] }),
  { allowedEvents: EVENTS },
 );
 assert.equal(unary.ok, true, unary.errors.join('; '));
 assert.equal('value' in unary.definition.when[0], false, 'no phantom value on a unary clause');

 const binary = validateDefinition(
  definition({ when: [{ field: 'data.content', op: 'contains' }] }),
  { allowedEvents: EVENTS },
 );
 assert.equal(binary.ok, false);
 assert.match(binary.errors.join(' '), /requires a value/);
});

test('a wrong version is rejected', () => {
 assert.equal(validateDefinition(definition({ version: 2 }), { allowedEvents: EVENTS }).ok, false);
 // Omitted defaults to the current version rather than failing.
 const omitted = { ...definition() };
 delete omitted.version;
 assert.equal(validateDefinition(omitted, { allowedEvents: EVENTS }).ok, true);
});

// --- YAML rendering ----------------------------------------------------------

test('the YAML renderer is stable and quotes ambiguous scalars', () => {
 // MUTATION: remove the quoting of a value like `on` or `1.0` -> this fails.
 // The whole reason the wire format is JSON is that YAML coerces silently; a
 // renderer that reintroduced the ambiguity would show someone a document that
 // does not mean what runs.
 const rendered = renderDefinitionYaml({
  version: 1,
  trigger: { event: 'message.created' },
  when: [
   { field: 'data.content', op: 'equals', value: 'on' },
   { field: 'data.senderName', op: 'equals', value: '1.0' },
   { field: 'data.role', op: 'is_not_empty' },
  ],
  steps: [{ action: 'post_message', channelId: 'chan-2', text: 'Deploy: check it' }],
 });

 assert.match(rendered, /value: "on"/);
 assert.match(rendered, /value: "1\.0"/);
 // A colon in a value must be quoted or the line reparses as a mapping.
 assert.match(rendered, /text: "Deploy: check it"/);
 assert.match(rendered, /event: message\.created/);
 // A unary clause renders no value key at all.
 const roleBlock = rendered.slice(rendered.indexOf('data.role'));
 assert.equal(roleBlock.includes('value:'), false);

 // Stable: same input, same string.
 assert.equal(rendered, renderDefinitionYaml({
  version: 1,
  trigger: { event: 'message.created' },
  when: [
   { field: 'data.content', op: 'equals', value: 'on' },
   { field: 'data.senderName', op: 'equals', value: '1.0' },
   { field: 'data.role', op: 'is_not_empty' },
  ],
  steps: [{ action: 'post_message', channelId: 'chan-2', text: 'Deploy: check it' }],
 }));
});

test('the YAML renderer quotes every YAML-truthy spelling', () => {
 for (const value of ['on', 'On', 'ON', 'off', 'yes', 'no', 'No', 'true', 'false', 'null', '~', 'y', 'n', '', '007', '1e3', '.inf']) {
  const rendered = renderDefinitionYaml({
   version: 1,
   trigger: { event: 'message.created' },
   when: [{ field: 'data.content', op: 'equals', value }],
   steps: [],
  });
  assert.match(rendered, /value: ".*"/, `${JSON.stringify(value)} must be quoted`);
 }
});

test('the YAML renderer never emits a raw newline inside a scalar', () => {
 // A raw newline would break the document structure and could forge a key.
 const rendered = renderDefinitionYaml({
  version: 1,
  trigger: { event: 'message.created' },
  when: [],
  steps: [{ action: 'post_message', channelId: 'c', text: 'line one\nsteps:\n  - action: evil' }],
 });
 // The injected text must not become STRUCTURE. Count lines that actually open
 // a step (a list item at the step indent) rather than lines merely containing
 // the word, since the escaped payload legitimately contains "action:" as text.
 // MUTATION: drop the \n escaping in yamlScalar -> a second `  - action: evil`
 // line appears and this fails.
 const stepOpeners = rendered.split('\n').filter((line) => /^ {2}- action:/.test(line));
 assert.deepEqual(stepOpeners, ['  - action: post_message']);
 assert.equal(rendered.split('\n').some((line) => /^\s*- action: evil/.test(line)), false);
 assert.match(rendered, /\\n/, 'the newline is escaped, not dropped');
});

test('the YAML renderer handles an empty definition without throwing', () => {
 assert.doesNotThrow(() => renderDefinitionYaml({}));
 assert.doesNotThrow(() => renderDefinitionYaml(null));
 assert.match(renderDefinitionYaml({}), /when: \[\]/);
 assert.match(renderDefinitionYaml({}), /steps: \[\]/);
});
