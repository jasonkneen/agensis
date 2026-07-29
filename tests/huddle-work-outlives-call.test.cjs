// ============================================================================
// tests/huddle-work-outlives-call.test.cjs
// ----------------------------------------------------------------------------
// You ask an agent for something in a huddle, then hang up. The turn keeps
// running — nothing cancels it — but it was dispatched into the huddle's OWN
// transcript session (huddles.transcript_session_id), which is only on screen
// while the call is up. So the answer landed in a closed room, and the only
// trace was the channel marker's "Open transcript" link. In practice the work
// was done and never read.
//
// Pinned here:
//   1. A turn finishing in the transcript session of an ENDED huddle also lands
//      in the host channel, verbatim, attributed to the agent.
//   2. A LIVE huddle does not (the panel is showing it — copying would double
//      every answer).
//   3. A session that is not a huddle transcript at all is untouched.
//   4. The lookup really is restricted to ended huddles, and the answer is
//      written to the HOST session, never back into the transcript.
//   5. Hanging up while an agent is mid-turn says so, rather than looking like
//      the work was thrown away.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const huddles = require('../server/huddles.cjs');

const TRANSCRIPT = 'session-transcript';
const CHANNEL = 'session-channel';
const HUDDLE_ID = 'huddle-1';

function makeJob(overrides = {}) {
  return {
    id: 'job-1',
    agent_id: 'agent-1',
    workspace_id: 'ws-1',
    session_id: TRANSCRIPT,
    status: 'running',
    agent_name: 'Coder',
    agent_handle: 'coder',
    metadata: { mode: 'daemon', responseMessageId: null },
    ...overrides,
  };
}

// `huddleRow` is what the huddles lookup finds: null models "not a transcript
// session, or its huddle is still live". The mock does NOT re-implement the
// ended_at filter — the SQL is asserted separately — it only decides whether a
// row comes back, so what is under test is the relay's branching, not the mock.
function installDb({ job = makeJob(), huddleRow = null } = {}) {
  const calls = [];
  const inserted = [];
  let autoId = 0;
  const db = {
    calls,
    inserted,
    job,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('update agent_jobs set status = $2')) {
        job.status = params[1];
        return [{ ...job }];
      }
      if (n.startsWith('select id, session_id from huddles')) {
        return huddleRow ? [huddleRow] : [];
      }
      if (n.startsWith('insert into messages (session_id,')) {
        // Zip COLUMNS against VALUES and resolve each $n itself, rather than
        // assuming a position. finalizeAgentJobResult has several inserts with
        // different column orders, and some columns ('role', 'sender_kind') are
        // string literals that consume no bind at all — so counting parameters
        // positionally reads the wrong field off whichever insert doesn't match
        // the shape you guessed.
        const columns = (/insert into messages \(([^)]*)\)/.exec(n)?.[1] || '')
          .split(',').map((c) => c.trim());
        const values = (/values \(([^)]*)\)/.exec(n)?.[1] || '')
          .split(',').map((v) => v.trim());
        const byColumn = {};
        columns.forEach((column, i) => {
          const placeholder = /^\$(\d+)$/.exec(values[i] || '');
          byColumn[column] = placeholder
            ? params[Number(placeholder[1]) - 1]
            : String(values[i] || '').replace(/^'|'$/g, '');
        });
        const row = { id: `auto-${++autoId}`, ...byColumn, params, sql: n };
        inserted.push(row);
        return [{ ...row }];
      }
      return [];
    },
  };
  __test.setTestDb(db);
  return db;
}

// Writes made by the RELAY specifically. finalizeAgentJobResult also writes the
// turn's ordinary reply into the job's own session, which is a different insert
// (it carries thread_parent_id, not huddle_id) — conflating the two would make
// these tests pass on the normal reply and prove nothing about the relay.
function relayWrites(db) {
  return db.inserted.filter((row) => row.sql.includes('huddle_id'));
}

test.afterEach(() => __test.resetTestState());

test('a turn that finishes after the huddle ended lands in the host channel', async () => {
  const db = installDb({ huddleRow: { id: HUDDLE_ID, session_id: CHANNEL } });

  await __test.finalizeAgentJobResult(makeJob(), { responseText: 'Deployed v42 and it is green.' });

  const writes = relayWrites(db);
  assert.equal(writes.length, 1, 'exactly one copy reaches the channel');
  assert.equal(writes[0].session_id, CHANNEL, 'it goes to the host channel');
  // Verbatim: this is the work product. A pointer the reader has to click is how
  // it got lost in the first place.
  assert.equal(writes[0].content, 'Deployed v42 and it is green.');
  assert.equal(writes[0].sender_name, 'Coder', 'attributed to the agent, not to "Huddle"');
  assert.ok(writes[0].sql.includes('huddle_id'), 'provenance is recorded on the row');
  assert.ok(writes[0].params.includes(HUDDLE_ID));
});

test('the lookup only matches ENDED huddles, and writes to the host, not the transcript', async () => {
  const db = installDb({ huddleRow: { id: HUDDLE_ID, session_id: CHANNEL } });

  await __test.finalizeAgentJobResult(makeJob(), { responseText: 'done' });

  const lookup = db.calls.find((c) => c.n.startsWith('select id, session_id from huddles'));
  assert.ok(lookup, 'the huddle is looked up before anything is copied');
  // Without this predicate every answer in a LIVE huddle would be duplicated
  // into the channel while the panel is already showing it.
  assert.match(lookup.n, /ended_at is not null/);
  assert.match(lookup.n, /transcript_session_id = \$1/);
  assert.deepEqual(lookup.params, [TRANSCRIPT]);
  const writes = relayWrites(db);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].session_id, CHANNEL, 'never copied back into the transcript');
});

test('a live huddle is left alone — the transcript panel is already showing it', async () => {
  // huddleRow null is what the real query returns while ended_at is null.
  const db = installDb({ huddleRow: null });

  await __test.finalizeAgentJobResult(makeJob(), { responseText: 'still talking' });

  assert.equal(relayWrites(db).length, 0);
});

test('an older huddle whose transcript IS its channel is not given the answer twice', async () => {
  const db = installDb({ huddleRow: { id: HUDDLE_ID, session_id: TRANSCRIPT } });

  await __test.finalizeAgentJobResult(makeJob(), { responseText: 'done' });

  assert.equal(
    relayWrites(db).length,
    0,
    'the host and the transcript are the same session — copying would duplicate it',
  );
});

test('a failure is carried across too — silence is the thing being fixed', async () => {
  const db = installDb({ huddleRow: { id: HUDDLE_ID, session_id: CHANNEL } });

  await __test.finalizeAgentJobResult(makeJob(), { errorText: 'the deploy timed out' });

  const writes = relayWrites(db);
  assert.equal(writes.length, 1);
  assert.match(writes[0].content, /failed: the deploy timed out/);
});

// --- the marker sentence ----------------------------------------------------

test('hanging up mid-turn says the work is continuing, and otherwise does not', () => {
  const ended = {
    startedAt: '2026-07-29T10:00:00.000Z',
    endedAt: '2026-07-29T10:01:23.000Z',
    everJoinedCount: 2,
  };

  assert.equal(
    huddles.huddleMarkerContent(ended, ['Ada', 'Sam'], { workContinuing: true }),
    'You were in a huddle · 1:23 · Ada, Sam · work continuing',
  );
  // Default and explicit-false both compose the sentence they always did, so an
  // older caller is unaffected.
  assert.equal(
    huddles.huddleMarkerContent(ended, ['Ada', 'Sam'], { workContinuing: false }),
    'You were in a huddle · 1:23 · Ada, Sam',
  );
  assert.equal(
    huddles.huddleMarkerContent(ended, ['Ada', 'Sam']),
    'You were in a huddle · 1:23 · Ada, Sam',
  );
});
