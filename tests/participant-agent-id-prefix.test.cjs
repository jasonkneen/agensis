// ============================================================================
// tests/participant-agent-id-prefix.test.cjs
// ----------------------------------------------------------------------------
// "I sent some earlier and they queued when they were assigned to other agents
// so should have run separately. then they were ignored."
//
// They were not queued. They were DELETED. The browser keys agent rows as
// `agent:<uuid>` (a composite id so agents and humans share one option list)
// and that shape reached chat_sessions.participants[].agent_id. Every
// server-side roster check compares the BARE uuid, the load-bearing one being
// insertActiveAgentJob's final reservation:
//
//     where participant->>'agent_id' = a.id::text
//
// 'agent:0870…' <> '0870…', so the reservation found no roster row, the insert
// returned null, the "Thinking …" placeholder was deleted, and the message was
// gone: no job, no parked turn, no error anywhere. Measured live: @codex in
// #testtest carried the prefix and could not answer a single message.
//
// What is under test:
//   1. the normalizer strips the prefix from agent rows and touches nothing
//      else;
//   2. BOTH backends normalize on write, in both input shapes (object and
//      pre-stringified), so the prefix cannot be re-introduced;
//   3. the reservation SQL that rejected it is quoted here, so the two cannot
//      drift apart silently;
//   4. the repair statement is in the migration chain AND the runtime boot.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  bareAgentParticipantId,
  normalizeSessionParticipants,
} = require('../shared/backend-core.cjs');
const { createBindDbParam } = require('../server/lib/db-sql.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const UUID = '0870de2f-c749-4462-9d8f-ee2a0601702c';

// --- 1. the normalizer ------------------------------------------------------

test('the prefix is stripped, and a bare id is left alone', () => {
  assert.equal(bareAgentParticipantId(`agent:${UUID}`), UUID);
  assert.equal(bareAgentParticipantId(UUID), UUID);
  assert.equal(bareAgentParticipantId(`  agent:${UUID}  `), UUID);
  assert.equal(bareAgentParticipantId(null), '');
  // Only a LEADING prefix, and only one. A uuid is not a namespace.
  assert.equal(bareAgentParticipantId('x-agent:abc'), 'x-agent:abc');
});

test('the exact live #testtest roster becomes dispatchable', () => {
  // Copied from production, where @codex was the only prefixed row and the only
  // agent that could not answer.
  const live = [
    { kind: 'agent', handle: 'claude', agent_id: '0d212ca9-63ef-4baf-b636-856833ed37e7', direct: false },
    { kind: 'agent', handle: 'codex', agent_id: `agent:${UUID}`, direct: false },
    { kind: 'agent', handle: 'grok', agent_id: '7746da99-f547-40c9-bd11-074fc30cc478', direct: false },
  ];
  const out = normalizeSessionParticipants(live);
  assert.equal(out[1].agent_id, UUID, '@codex still undispatchable');
  // The rows that already worked are untouched, field for field.
  assert.deepEqual(out[0], live[0]);
  assert.deepEqual(out[2], live[2]);
  // And `handle`/`direct` survive on the repaired row — dropping them would
  // break the DM's direct-participant lookup.
  assert.equal(out[1].handle, 'codex');
  assert.equal(out[1].direct, false);
});

test('non-agent rows and odd shapes pass through untouched', () => {
  const input = [
    { kind: 'user', id: `agent:${UUID}`, agent_id: `agent:${UUID}` },
    null,
    'not-an-object',
    { kind: 'agent' },
    { kind: 'agent', agent_id: UUID, extra: { deep: true } },
  ];
  const out = normalizeSessionParticipants(input);
  // A human row keeps its value verbatim — this normalizer has no opinion on it.
  assert.deepEqual(out[0], input[0]);
  assert.equal(out[1], null);
  assert.equal(out[2], 'not-an-object');
  assert.deepEqual(out[3], { kind: 'agent' });
  assert.deepEqual(out[4].extra, { deep: true }, 'unknown fields dropped');
});

test('`id` is normalized too, not just agent_id', () => {
  // huddle-agents.cjs falls back to `id`, so leaving it prefixed would keep the
  // double-voice/no-voice class of bug alive on that path.
  const [out] = normalizeSessionParticipants([{ kind: 'agent', id: `agent:${UUID}` }]);
  assert.equal(out.id, UUID);
});

test('a non-array is handed back for the JSON validator to reject', () => {
  assert.equal(normalizeSessionParticipants(null), null);
  assert.equal(normalizeSessionParticipants('nope'), 'nope');
});

// --- 2. both backends normalize on write ------------------------------------

function flyBind(value) {
  const params = [];
  // createBindDbParam is the shared builder; the Fly normalizer is the one
  // db-sql exports through it.
  const bind = createBindDbParam(require('../server/lib/db-sql.cjs').normalizeJsonParam);
  bind(params, 'chat_sessions', 'participants', value);
  return params[params.length - 1];
}

test('the Fly write path strips the prefix, from an object AND from a string', () => {
  const rows = [{ kind: 'agent', handle: 'codex', agent_id: `agent:${UUID}` }];
  assert.equal(flyBind(rows)[0].agent_id, UUID);
  // Pre-stringified input must not be a way around the guard.
  assert.equal(flyBind(JSON.stringify(rows))[0].agent_id, UUID);
});

test('the Netlify twin applies the same rule for its own driver', () => {
  const source = read('netlify/functions/backend.mjs');
  const fn = source.slice(source.indexOf('function normalizeJsonParam'), source.indexOf('const bindDbParam = createBindDbParam'));
  assert.match(fn, /normalizeSessionParticipants/);
  // Its driver wants TEXT params where porsager wants objects — the rule is
  // shared, the stringify is not. Getting this backwards is a known repo trap.
  assert.match(fn, /JSON\.stringify\(\s*normalizeSessionParticipants/);
  assert.match(source, /^\s*normalizeSessionParticipants,$/m, 'not imported');
});

test('the Fly path still refuses invalid JSON rather than normalizing it', () => {
  assert.throws(() => flyBind('{not json'), /must be valid JSON/);
});

// --- 3. the comparison this defends -----------------------------------------

test('the reservation really does compare the bare id', () => {
  // If this ever becomes a prefix-tolerant comparison the normalizer is still
  // correct, but this test is the record of WHY it exists.
  const jobs = read('server/agent-jobs.cjs');
  assert.match(jobs, /where participant->>'agent_id' = a\.id::text/);
});

// --- 4. the repair is in the migration chain and the boot -------------------

test('the one-time repair exists in both places and is idempotent', () => {
  const migration = read('supabase/migrations/20260822193000_participant_agent_id_prefix.sql');
  const index = read('server/index.cjs');
  for (const [name, sql] of [['migration', migration], ['runtime boot', index]]) {
    assert.match(sql, /regexp_replace\(participant->>'agent_id', '\^agent:', ''\)/, name);
    // Self-limiting: only rows that still carry the prefix, so a second run is
    // a no-op rather than a full-table rewrite.
    assert.match(sql, /p->>'agent_id' LIKE 'agent:%'/, name);
    // Never rewrite a human participant.
    assert.match(sql, /participant->>'kind' = 'agent'/, name);
    // Order must survive: the roster is rendered in order and
    // directAgentParticipantFromSession falls back to "the sole agent".
    assert.match(sql, /ORDER BY ordinality/, name);
  }
});
