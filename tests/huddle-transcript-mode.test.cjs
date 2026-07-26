// ============================================================================
// tests/huddle-transcript-mode.test.cjs
// ----------------------------------------------------------------------------
// A huddle's transcript session must be created on 'mention', NEVER inheriting
// the host channel's conversation_mode.
//
// It used to `select host.conversation_mode`. A channel on 'auto' has agents
// continue the conversation among themselves for auto_rounds turns, so in a
// live voice call a SECOND agent started talking over the first while the human
// was still listening. Reported as "I get a response from one to start with,
// then suddenly two start responding."
//
// Source-contract test: createTranscriptSession is not exported and the insert
// is a single SQL literal, so the cheapest honest check is that the literal
// says 'mention' and no longer reads the host's mode.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'huddles.cjs'), 'utf8');

test('the transcript session is created on mention, not the host mode', () => {
  assert.match(
    source,
    /select \$1, \$2, \$3, host\.model, 'mention', 'huddle'/,
    "the insert must hardcode 'mention'",
  );
});

test('it no longer inherits host.conversation_mode', () => {
  assert.doesNotMatch(
    source,
    /host\.conversation_mode/,
    'inheriting the host mode is what made two agents answer at once',
  );
});

test('it still inherits the things it SHOULD share with the host', () => {
  // The model, canvas and participants are deliberately the host's — only the
  // turn-taking mode is overridden.
  for (const inherited of ['host.model', 'host.canvas_id', 'host.participants']) {
    assert.ok(source.includes(inherited), `expected to inherit ${inherited}`);
  }
});
