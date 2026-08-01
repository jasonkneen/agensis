'use strict';

// Clock-only agent job deltas must not rewrite messages.content every second.
// Source-level invariant in the Fly-lane handleAgentJobDelta (agent-jobs.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const source = require('./helpers/fly-lane.cjs').flyLaneSource();

function functionBody(text, declaration) {
  const start = text.indexOf(declaration);
  assert.ok(start > 0, `could not find ${declaration}`);
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const indent = text.slice(lineStart, start);
  // Nested close at same indent as declaration (inside createAgentJobs).
  const close = text.indexOf(`\n${indent}}\n`, start);
  assert.ok(close > start, `could not bound ${declaration}`);
  return text.slice(start, close);
}

test('handleAgentJobDelta throttles content-free clock message rewrites', () => {
  // Prefer agent-jobs.cjs body (where the handler lives after Wave 4).
  const jobsSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../server/agent-jobs.cjs'),
    'utf8',
  );
  const body = functionBody(jobsSource, 'async function handleAgentJobDelta');

  assert.match(body, /skipClockMessageUpdate/);
  assert.match(body, /CLOCK_MESSAGE_THROTTLE_MS/);
  assert.match(body, /lastClockAt/);
  // Must still record liveness without treating clock as content progress.
  assert.match(body, /if \(deltaText\) nextMetadata\.lastContentAt/);
  // Message update is gated on the throttle flag.
  assert.match(body, /if \(responseMessageId && !skipClockMessageUpdate\)/);
});
