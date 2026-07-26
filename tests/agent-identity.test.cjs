'use strict';

// Agent self-declared identity: avatar, name, profile, voice — and WHO WINS.
//
// An agent declares its identity on EVERY connect: every daemon restart, every
// MCP reconnect. If that blindly overwrote the stored row, a name or avatar
// someone chose in the app would be destroyed the next time the daemon bounced,
// and the app would look like it forgot. So:
//
//   A HUMAN'S EXPLICIT CHOICE BEATS THE AGENT'S SELF-DECLARATION.
//   The agent's values are a DEFAULT for fields no human has ever set.
//
// Which makes "unset" and "set to the same value as the default" genuinely
// different states, tracked in identity.human_set rather than guessed at.
//
// The other half of the rule lives on the human's write path: whatever a person
// edits through POST /backend/db/update is marked, so the next declaration
// leaves it alone. Both halves are here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const {
  applyIdentityDeclaration,
  markHumanIdentityWrite,
  identityWriteSql,
  synthesizeHumanIdentityInsert,
  repairStoredIdentity,
  normalizeIdentityDeclaration,
  normalizeVoicePreference,
  resolveAgentVoice,
} = require('../shared/agentIdentity.cjs');

const root = path.resolve(__dirname, '..');

// Real Cartesia-shaped ids. Stock voices are UUIDs.
const VOICE_A = 'f9fc912e-e650-4766-a20c-5a93a43aa6e3';
const VOICE_B = '0834f3df-e650-4766-a20c-5a93a43aa6e3';
const VOICE_C = 'a1b2c3d4-1111-2222-3333-444455556666';

// A stored agent row, as the DB hands it back.
const row = (overrides = {}) => ({
  id: 'agent-1',
  name: 'Coder',
  avatar: 'CO',
  accent_color: '#00a95c',
  description: '',
  soul: '',
  identity: {},
  ...overrides,
});

// --- the precedence rule ----------------------------------------------------

test('an agent declaration fills in fields nobody has set', () => {
  const result = applyIdentityDeclaration({
    current: row({ description: '' }),
    declared: { description: 'Ships backend changes', avatar: 'CD' },
  });
  assert.deepEqual(result.columns, { description: 'Ships backend changes', avatar: 'CD' });
  assert.equal(result.changed, true);
});

test('a human-set value SURVIVES an agent re-declaration', () => {
  // The data-loss bug this rule exists to prevent: the daemon restarts and the
  // avatar someone picked in the UI is gone.
  const result = applyIdentityDeclaration({
    current: row({ avatar: 'JK', identity: { human_set: { avatar: true } } }),
    declared: { avatar: 'CD', description: 'Ships backend changes' },
  });
  assert.equal('avatar' in result.columns, false, 'the human-set avatar must not be overwritten');
  assert.equal(result.columns.description, 'Ships backend changes', 'unset fields still take the default');
});

test('a human-set value survives an IDENTICAL re-declaration too', () => {
  // Re-declaring the same value is still a write nobody asked for, and it is the
  // case a "did the value change?" check would wave through.
  const result = applyIdentityDeclaration({
    current: row({ avatar: 'JK', identity: { human_set: { avatar: true } } }),
    declared: { avatar: 'JK' },
  });
  assert.equal(result.changed, false);
});

test('a declaration matching what is stored writes nothing', () => {
  // A daemon that reconnects on a loop must not produce an UPDATE and a
  // realtime fanout on every loop.
  const result = applyIdentityDeclaration({
    current: row({ description: 'Ships backend changes' }),
    declared: { description: 'Ships backend changes' },
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.columns, {});
  assert.equal(result.identity, null);
});

test('an agent may name itself only when it is brand new', () => {
  const created = applyIdentityDeclaration({ current: null, declared: { name: 'Cursor' }, isNew: true });
  assert.equal(created.columns.name, 'Cursor');

  const reconnect = applyIdentityDeclaration({ current: row(), declared: { name: 'Something Else' } });
  assert.equal('name' in reconnect.columns, false, 'an existing agent must not rename itself on reconnect');
});

test('a human-set voice is not replaced by a declared one', () => {
  const result = applyIdentityDeclaration({
    current: row({ identity: { voice: { cartesia_voice_id: VOICE_A }, human_set: { voice: true } } }),
    declared: { voice: { cartesia_voice_id: VOICE_B, emotion: 'excited' } },
  });
  assert.equal(result.identity, null);
  assert.equal(result.changed, false);
});

test('a declared voice lands when nobody has chosen one', () => {
  const result = applyIdentityDeclaration({
    current: row(),
    declared: { voice: { voice_id: VOICE_B, speed: 1.2, attitude: 'contemplative' } },
  });
  assert.deepEqual(result.identity.voice, {
    cartesia_voice_id: VOICE_B, speed: 1.2, emotion: 'contemplative',
  });
});

test('re-declaring the same voice does not rewrite the row', () => {
  const stored = { voice: { cartesia_voice_id: VOICE_B, speed: 1.2, emotion: 'contemplative' } };
  const result = applyIdentityDeclaration({
    current: row({ identity: stored }),
    declared: { voice: { id: VOICE_B, speed: 1.2, emotion: 'contemplative' } },
  });
  assert.equal(result.changed, false);
});

test('declaring a voice keeps the rest of the identity column', () => {
  const result = applyIdentityDeclaration({
    current: row({ identity: { human_set: { name: true } } }),
    declared: { voice: { cartesia_voice_id: VOICE_A } },
  });
  assert.deepEqual(result.identity.human_set, { name: true }, 'the lock map must not be dropped');
});

test('an identity column stored as a JSON string is still read', () => {
  // jsonb comes back as an object from postgres.js and as a string from some
  // paths; reading it wrongly would silently un-protect every locked field.
  const result = applyIdentityDeclaration({
    current: row({ avatar: 'JK', identity: JSON.stringify({ human_set: { avatar: true } }) }),
    declared: { avatar: 'CD' },
  });
  assert.equal(result.changed, false);
});

// --- what a declaration is allowed to contain -------------------------------

test('a declaration drops unknown keys and blank values', () => {
  const declared = normalizeIdentityDeclaration({
    name: '  Cursor  ',
    description: '   ',
    permission_mode: 'bypassPermissions',
    mcp_approved: true,
    enabled: false,
  });
  assert.deepEqual(declared, { name: 'Cursor' });
});

test('clearing a field is a human action, not something omission does', () => {
  // A daemon sending description: '' on reconnect must not wipe a profile.
  const result = applyIdentityDeclaration({
    current: row({ description: 'Ships backend changes' }),
    declared: { description: '' },
  });
  assert.equal(result.changed, false);
});

test('a declared accent colour must be a hex colour', () => {
  assert.deepEqual(normalizeIdentityDeclaration({ accent_color: 'red' }), {});
  assert.deepEqual(normalizeIdentityDeclaration({ accent_color: '#0af' }), { accent_color: '#0af' });
});

test('declared text is truncated rather than trusted', () => {
  const declared = normalizeIdentityDeclaration({ name: 'x'.repeat(500), soul: 'y'.repeat(9000) });
  assert.equal(declared.name.length, 80);
  assert.equal(declared.soul.length, 4000);
});

test('a browser voice name cannot be stored as a Cartesia voice id', () => {
  // A device voice name is meaningless to a hosted API, and would 400 mid-huddle.
  assert.deepEqual(normalizeVoicePreference({ cartesia_voice_id: 'Microsoft Aria Online (Natural)' }), {});
  assert.deepEqual(normalizeVoicePreference({ voice_id: 'a warm british voice' }), {});
});

test('speed is clamped to the range Cartesia accepts', () => {
  assert.equal(normalizeVoicePreference({ speed: 50 }).speed, 1.5);
  assert.equal(normalizeVoicePreference({ speed: 0 }).speed, 0.6);
});

test('an unknown emotion is dropped rather than forwarded to the API', () => {
  assert.deepEqual(normalizeVoicePreference({ emotion: 'brisk' }), {});
  assert.deepEqual(normalizeVoicePreference({ attitude: 'Sarcastic' }), { emotion: 'sarcastic' });
});

test('resolveAgentVoice is the clean handoff to the TTS pipeline', () => {
  const catalogue = [VOICE_A, VOICE_B, VOICE_C].sort((a, b) => a.localeCompare(b));

  const chosen = resolveAgentVoice({ id: 'a', identity: { voice: { cartesia_voice_id: VOICE_C, speed: 0.8 } } }, catalogue);
  assert.equal(chosen.voiceId, VOICE_C);
  assert.equal(chosen.speed, 0.8);
  assert.equal(chosen.isDefault, false);
  assert.equal(chosen.modelId, 'sonic-3.5');

  // Nobody configured this one: it still gets a real voice, deterministically.
  const derived = resolveAgentVoice({ id: 'agent-zzz' }, catalogue);
  assert.ok(catalogue.includes(derived.voiceId));
  assert.equal(derived.isDefault, true);
  assert.equal(resolveAgentVoice({ id: 'agent-zzz' }, catalogue).voiceId, derived.voiceId);
});

test('resolveAgentVoice reports NO voice when the catalogue is unavailable', () => {
  // '' must never be passed to Cartesia as a voice id — the caller skips instead.
  assert.equal(resolveAgentVoice({ id: 'a' }, []).voiceId, '');
});

// --- the human half of the rule ---------------------------------------------

test('a human edit to an identity column is marked', () => {
  const { lockPatch } = markHumanIdentityWrite('workspace_agents', { name: 'Jason\'s Coder', model: 'auto' });
  assert.deepEqual(lockPatch, { name: true });
});

test('a human edit to the voice is marked, extracted and validated', () => {
  const { values, voice, lockPatch } = markHumanIdentityWrite('workspace_agents', {
    identity: { voice: { cartesia_voice_id: VOICE_A, speed: 1.2, emotion: 'calm' }, human_set: { avatar: true } },
  });
  assert.deepEqual(lockPatch, { voice: true });
  assert.deepEqual(voice, { cartesia_voice_id: VOICE_A, speed: 1.2, emotion: 'calm' });
  // `identity` never reaches the SET list as the caller's object — the voice is
  // grafted onto the STORED column in SQL, and the human_set echo is discarded.
  assert.equal('identity' in values, false);
});

test('an edit that touches no identity field is not marked', () => {
  assert.equal(markHumanIdentityWrite('workspace_agents', { model: 'auto', enabled: false }).lockPatch, null);
  assert.equal(markHumanIdentityWrite('workspace_agents', { metadata: { host_folders: [] } }).lockPatch, null);
});

test('only workspace_agents is marked', () => {
  assert.equal(markHumanIdentityWrite('tasks', { name: 'x' }).lockPatch, null);
});

test('BLOCKER regression: a forged human_set is discarded, not written', () => {
  // {"identity":{"human_set":{...}}} used to skip the voice-marking branch and
  // be written VERBATIM — any workspace editor could lock (or pre-lock) every
  // field. Now the identity key is dropped and nothing identity-shaped remains.
  const { values, voice, lockPatch } = markHumanIdentityWrite('workspace_agents', {
    identity: { human_set: { name: true, avatar: true, voice: true } },
  });
  assert.equal(lockPatch, null);
  assert.equal(voice, undefined);
  assert.equal('identity' in values, false);
});

test('BLOCKER regression: {"identity":{}} cannot erase the locks', () => {
  // The same hole in the other direction: an empty identity object was written
  // verbatim, wiping human_set (and the stored voice) in one request.
  const { values, voice, lockPatch } = markHumanIdentityWrite('workspace_agents', { identity: {} });
  assert.equal(lockPatch, null);
  assert.equal(voice, undefined);
  assert.equal('identity' in values, false);
});

test('clearing an identity field UNLOCKS it instead of pinning emptiness', () => {
  // Locking a field at '' is worse than not locking it: the agent could never
  // fill it again. An explicit clear reads as "go back to the default".
  const { lockPatch } = markHumanIdentityWrite('workspace_agents', { avatar: '', description: 'Ships things' });
  assert.deepEqual(lockPatch, { avatar: false, description: true });
});

test('clearing the voice unlocks it too', () => {
  const { voice, lockPatch } = markHumanIdentityWrite('workspace_agents', { identity: { voice: {} } });
  assert.deepEqual(voice, {});
  assert.deepEqual(lockPatch, { voice: false });
});

test('the identity SET fragment builds on the STORED column, never the caller', () => {
  // Without a voice: base is the stored column; human_set = stored ∪ patch.
  const bare = identityWriteSql(null, '$1::jsonb');
  assert.match(bare, /jsonb_set\(coalesce\("identity", '\{\}'::jsonb\), '\{human_set\}'/);
  assert.match(bare, /coalesce\("identity"->'human_set', '\{\}'::jsonb\) \|\| \$1::jsonb/);

  // With a voice: only the voice key is grafted in; human_set still comes from
  // the stored row. There is no spelling in which the caller's human_set lands.
  const withVoice = identityWriteSql('$1::jsonb', '$2::jsonb');
  assert.match(withVoice, /'\{voice\}', \$1::jsonb/);
  assert.match(withVoice, /coalesce\("identity"->'human_set', '\{\}'::jsonb\) \|\| \$2::jsonb/);
  assert.equal(withVoice.includes('$1::jsonb->'), false);
});

// --- human INSERTS (agent creation) ------------------------------------------

test('a human insert locks the fields actually chosen — and only those', () => {
  const created = synthesizeHumanIdentityInsert('workspace_agents', {
    workspace_id: 'w', name: 'Coder', avatar: 'CO', accent_color: '#00a95c',
    description: '', soul: '', model: 'auto',
  });
  // Non-empty choices are protected from the agent's FIRST connect; empty
  // fields stay open for the declaration to fill.
  assert.deepEqual(created.identity, { human_set: { name: true, avatar: true, accent_color: true } });
  assert.equal(created.model, 'auto', 'non-identity values pass through untouched');
});

test('a human insert discards a forged human_set and junk identity keys', () => {
  const created = synthesizeHumanIdentityInsert('workspace_agents', {
    name: 'Coder',
    identity: { human_set: { soul: true }, voice: { cartesia_voice_id: VOICE_A }, junk: 1 },
  });
  assert.deepEqual(created.identity, {
    voice: { cartesia_voice_id: VOICE_A },
    human_set: { name: true, voice: true },
  });
});

test('inserts into other tables are left alone', () => {
  const row = { title: 'x', identity: { human_set: { name: true } } };
  assert.equal(synthesizeHumanIdentityInsert('tasks', row), row);
});

// --- repairing rows the double-encoded jsonb bind corrupted ------------------

test('a canonical identity is left alone — repair returns null', () => {
  assert.equal(repairStoredIdentity({}), null);
  assert.equal(repairStoredIdentity({ voice: { cartesia_voice_id: VOICE_A }, human_set: { name: true } }), null);
});

test('a whole-value string scalar parses back to the object it was meant to be', () => {
  const repaired = repairStoredIdentity(JSON.stringify({ voice: { cartesia_voice_id: VOICE_A }, human_set: { voice: true } }));
  assert.deepEqual(repaired, { voice: { cartesia_voice_id: VOICE_A }, human_set: { voice: true } });
});

test('an array-degraded human_set folds back into locks, later entries winning', () => {
  // The live shape: `human_set || $patch` with a stringified patch appends one
  // corrupted element per human edit instead of merging.
  const repaired = repairStoredIdentity({
    human_set: [{}, '{"name":true,"avatar":false}', '{"avatar":true}', 'not json', 42],
  });
  assert.deepEqual(repaired, { human_set: { name: true, avatar: true } });
});

test('repair keeps only genuine locks on known fields', () => {
  const repaired = repairStoredIdentity({ human_set: ['{"name":"yes","mcp_approved":true,"soul":true}'] });
  assert.deepEqual(repaired, { human_set: { soul: true } }, 'non-boolean and unknown keys must not become locks');
});

// --- the guarantee, in one scenario ------------------------------------------

test('declare → human edit → re-declare: the human edit survives the reconnect', () => {
  // 1. The agent connects for the first time and declares who it is.
  const first = applyIdentityDeclaration({
    current: row({ avatar: '', identity: {} }),
    declared: { avatar: 'CD', description: 'Ships backend changes', voice: { cartesia_voice_id: VOICE_A } },
  });
  let stored = row({
    avatar: first.columns.avatar,
    description: first.columns.description,
    identity: first.identity,
  });
  assert.equal(stored.avatar, 'CD');

  // 2. A human edits the avatar in the app. The generic update path marks the
  //    write; the SQL merge unions the patch into the STORED human_set.
  const { lockPatch } = markHumanIdentityWrite('workspace_agents', { avatar: 'JK' });
  assert.deepEqual(lockPatch, { avatar: true });
  stored = {
    ...stored,
    avatar: 'JK',
    identity: { ...stored.identity, human_set: { ...(stored.identity.human_set || {}), ...lockPatch } },
  };

  // 3. The agent reconnects and re-declares everything, avatar included.
  const second = applyIdentityDeclaration({
    current: stored,
    declared: { avatar: 'CD', description: 'Ships backend changes', voice: { cartesia_voice_id: VOICE_B } },
  });
  assert.equal('avatar' in second.columns, false, 'the human\'s avatar must survive the reconnect');
  assert.deepEqual(second.identity.voice, { cartesia_voice_id: VOICE_B }, 'unlocked fields still follow the agent');
  assert.deepEqual(second.identity.human_set, { avatar: true }, 'the lock rides along with the identity write');
});

// --- wiring -----------------------------------------------------------------

test('the identity columns exist in all three schema places', async () => {
  const runtime = await readFile(path.join(root, 'server/index.cjs'), 'utf8');
  assert.match(runtime, /ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS identity jsonb/);
  assert.match(runtime, /ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_identity jsonb/);

  const canonical = await readFile(path.join(root, 'database/neon-schema.sql'), 'utf8');
  assert.match(canonical, /identity jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(canonical, /requested_identity jsonb NOT NULL DEFAULT '\{\}'::jsonb/);

  const migration = await readFile(
    path.join(root, 'supabase/migrations/20260726150000_agent_identity.sql'),
    'utf8',
  );
  assert.match(migration, /ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS identity jsonb/);
  assert.match(migration, /ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_identity jsonb/);
});

test('every explicit workspace_agents select lists identity', async () => {
  // The blank-column trap: several selects name agent columns one by one, and a
  // column missing from one of them reads blank in exactly one screen. This has
  // shipped broken twice (host_folders, canvas_id).
  for (const file of ['server/index.cjs', 'netlify/functions/backend.mjs']) {
    const src = await readFile(path.join(root, file), 'utf8');
    const selects = src.match(/select [^`;]*?from\s+workspace_agents/gs) || [];
    const explicit = selects.filter(sql => !/select\s+\*/i.test(sql) && /\bavatar\b/.test(sql));
    assert.ok(explicit.length > 0, `${file}: expected at least one explicit workspace_agents select`);
    for (const sql of explicit) {
      assert.match(sql, /\bidentity\b/, `${file}: an explicit agent select is missing "identity"`);
    }
  }
});

test('agentRuntimePayload passes identity through to the client', () => {
  const { __test } = require('../server/index.cjs');
  const payload = __test.agentRuntimePayload({
    id: 'a', workspace_id: 'w', name: 'S', handle: 's',
    identity: JSON.stringify({ voice: { locale: 'en-GB' }, human_set: { name: true } }),
  });
  assert.deepEqual(payload.identity, { voice: { locale: 'en-GB' }, human_set: { name: true } });
});

test('register_agent accepts an identity declaration', async () => {
  const src = await readFile(path.join(root, 'server/mcp.cjs'), 'utf8');
  assert.match(src, /identity: \(args\?\.identity && typeof args\.identity === 'object'\)/);
});

test('both backends mark a human identity write and synthesize insert locks', async () => {
  for (const file of ['server/index.cjs', 'netlify/functions/backend.mjs']) {
    const src = await readFile(path.join(root, file), 'utf8');
    assert.match(src, /markHumanIdentityWrite\(table, safeValues\)/, `${file}: db/update must mark human identity writes`);
    assert.match(src, /identityWriteSql\(/, `${file}: identity writes must go through the stored-column SET fragment`);
    assert.match(src, /synthesizeHumanIdentityInsert\(table, next\)/, `${file}: db/insert must synthesize creation-time locks`);
  }
});
