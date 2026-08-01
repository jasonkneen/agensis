'use strict';

// ============================================================================
// tests/agent-read-receipt-daemon.test.cjs
// ----------------------------------------------------------------------------
// A daemon-backed agent must leave a read receipt.
//
// `advanceAgentReadMarker` existed only in server/mcp.cjs, so the eye filled for
// an agent driven through MCP and never for one connected with `agensis connect`
// — which is the normal case, and the one every user actually has. Those agents
// read the message, replied to it, and left no receipt, so the feature looked
// broken while its tests were green: every test drove the MCP path.
//
// This pins the call on the DAEMON path, where the turn actually runs.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

test('the daemon turn advances the exact captured marker only after prompt delivery', () => {
  const src = read('server/builtin-turn.cjs');

  const ctx = src.indexOf('await buildAgentTurnContextSnapshot(');
  assert.ok(ctx > 0, 'the context load moved — re-point this test');

  const send = src.indexOf('const delivered = sendWs(connection.ws', ctx);
  assert.ok(send > ctx, 'the daemon prompt must be sent after its context snapshot');
  const deliveryGuard = src.indexOf('if (!delivered)', send);
  assert.ok(deliveryGuard > send, 'a failed socket delivery must return before marking anything read');
  const call = src.indexOf(
    'await advanceAgentReadMarker(sessionId, agent.id, lastSeenMessageId, threadParentId)',
    deliveryGuard,
  );
  assert.ok(call > deliveryGuard, 'the daemon marker must follow successful delivery of the prompt');

  assert.match(
    src.slice(call - 200, call + 150),
    /lastSeenMessageId/,
    'the write must use the id captured with the delivered context',
  );
});

test('it reuses the single-sourced SQL rather than restating it', () => {
  const src = read('server/builtin-turn.cjs');
  assert.match(
    src,
    /require\('\.\.\/shared\/read-receipts\.cjs'\)/,
    'the SQL must come from shared/read-receipts.cjs',
  );
  assert.match(src, /ADVANCE_AGENT_READ_MARKER_SQL/);

  // A second hand-written INSERT here would drift from the MCP path's, and the
  // two would disagree about monotonicity without anything failing.
  assert.doesNotMatch(
    src,
    /insert\s+into\s+session_read_state/i,
    'do not restate the insert — import it',
  );
});

test('a failed receipt cannot take the turn down', () => {
  const src = read('server/builtin-turn.cjs');
  const i = src.indexOf('async function advanceAgentReadMarker');
  assert.ok(i > 0);
  const body = src.slice(i, i + 700);

  assert.match(body, /try\s*\{/, 'the write must be inside a try');
  assert.match(body, /\}\s*catch/, 'and its failure swallowed');
  assert.match(
    body,
    /if \(!sessionId \|\| !agentId \|\| !lastSeenMessageId\) return/,
    'and guard every part of the exact marker identity',
  );
});

test('job finalization cannot widen a receipt after a long-running turn', () => {
  const jobs = read('server/agent-jobs.cjs');
  const finalizeStart = jobs.indexOf('async function finalizeAgentJobResult(');
  const finalizeEnd = jobs.indexOf('async function relayEndedHuddleWorkToChannel(', finalizeStart);
  assert.ok(finalizeStart > 0 && finalizeEnd > finalizeStart);
  assert.doesNotMatch(
    jobs.slice(finalizeStart, finalizeEnd),
    /advanceAgentReadMarker/,
    'a message arriving after prompt capture must not become read at finalize time',
  );
});

test('the SQL it imports is genuinely monotonic', () => {
  // The whole reason a dropped receipt is safe to swallow: the next turn repairs
  // it, and a marker can never move backwards. If that stops being true, the
  // swallow above becomes a real bug rather than a courtesy.
  const sql = require('../shared/read-receipts.cjs').ADVANCE_AGENT_READ_MARKER_SQL
    .replace(/\s+/g, ' ').toLowerCase();
  assert.match(sql, /on conflict/, 'must upsert');
  assert.match(
    sql,
    /\(session_read_state\.read_at, session_read_state\.last_seen_message_id\) < \(excluded\.read_at, excluded\.last_seen_message_id\)/,
    'must only ever move the marker forward, including equal-time messages',
  );
});
