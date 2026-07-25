'use strict';

// Two bugs that together hung a live chat on a "Thinking …" spinner for as long
// as the daemon stayed connected. Both are source-level invariants: the node test
// runner mocks the DB, so neither can be caught by asserting on query results —
// the whole point is what the SQL and the bind types actually are.
//
// 1. PROGRESS vs LIVENESS. A waiting daemon sends a content-free tick every
//    second. Each tick ran `updated_at = now()`, so a reaper keyed on updated_at
//    never fired and a wedged turn spun forever (observed: 8 minutes, 0 bytes of
//    response). Keying on started_at instead — the previous behaviour — had the
//    mirror-image bug of killing healthy turns that were streaming fine at the
//    4-minute mark. The reaper must key on the last delta that carried CONTENT.
//
// 2. jsonb DOUBLE-ENCODING. `metadata || patch` merges only when BOTH sides are
//    jsonb objects. Binding JSON.stringify(obj) to a `$n::jsonb` parameter makes a
//    jsonb STRING scalar, and `string || object` APPENDS — turning metadata into
//    an array, after which metadata->>'mode' and metadata->>'lastContentAt' both
//    read NULL in SQL. Verified against real Postgres: an object bind gives
//    jsonb_typeof 'object' and readable keys; a stringified bind gives 'string'
//    and NULL keys.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.cjs'), 'utf8');

test('the stuck-job reaper measures content progress, not liveness ticks', () => {
  const reaper = source.slice(source.indexOf('async function reapStuckAgentJobs'));
  const body = reaper.slice(0, reaper.indexOf('\n}\n'));

  // Non-farm jobs must be judged on lastContentAt, with started_at only as the
  // fallback for a job that has not produced anything yet.
  assert.match(body, /metadata->>'lastContentAt'/);
  assert.match(body, /coalesce\(\(metadata->>'lastContentAt'\)::timestamptz, started_at\)/);

  // An absolute ceiling so no amount of ticking keeps a job alive forever.
  assert.match(body, /started_at < now\(\) - interval '30 minutes'/);

  // The regression: a bare updated_at/started_at comparison for the non-farm
  // branch is what produced both halves of this bug.
  assert.ok(
    !/coalesce\(updated_at, started_at\)/.test(body),
    'non-farm staleness must not be measured from updated_at — liveness ticks bump it every second',
  );
});

test('lastContentAt is only recorded when a delta actually carries text', () => {
  const handler = source.slice(source.indexOf('async function handleAgentJobDelta'));
  const body = handler.slice(0, handler.indexOf('\n}\n'));

  assert.match(body, /const deltaText = textFromValue\(/);
  // Guarded on the text being non-empty — an unconditional assignment would make
  // every "Thinking Ns" tick look like progress again.
  assert.match(body, /if \(deltaText\) nextMetadata\.lastContentAt/);
});

test('agent_jobs metadata is bound as an object, never JSON.stringify, on every write', () => {
  // Each of these is a `$n::jsonb` bind for agent_jobs.metadata. A stringified
  // value silently becomes a jsonb string scalar and corrupts the column on the
  // first `||`, so none of them may be wrapped in JSON.stringify.
  for (const marker of [
    "mode: 'daemon'",
    "mode: 'builtin'",
    "mode: 'mcp'",
  ]) {
    const at = source.indexOf(marker);
    assert.ok(at !== -1, `expected an agent_jobs metadata literal containing ${marker}`);
    const line = source.slice(source.lastIndexOf('\n', at) + 1, source.indexOf('\n', at));
    assert.ok(
      !line.includes('JSON.stringify'),
      `agent_jobs metadata for ${marker} must bind the object, not JSON.stringify: ${line.trim()}`,
    );
  }

  // The delta write replaced SQL-side `||` with a wholesale object write, which
  // also repairs any row already corrupted into an array.
  const handler = source.slice(source.indexOf('async function handleAgentJobDelta'));
  const body = handler.slice(0, handler.indexOf('\n}\n'));
  assert.match(body, /metadata = \$3::jsonb/);
  assert.ok(
    !/metadata \|\| \$/.test(body),
    'delta writes must not use `metadata || $n` — it appends instead of merging when metadata is not an object',
  );
});
