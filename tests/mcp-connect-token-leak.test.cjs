// ============================================================================
// tests/mcp-connect-token-leak.test.cjs
// ----------------------------------------------------------------------------
// The `claude mcp add ...` convenience string is rendered in full and has a
// copy button, so anything embedded in it lands on the clipboard as plain text.
// It used to carry the LIVE bearer token, and that is how a real token was
// pasted into a transcript.
//
// The endpoint and the token are separate fields beside it — the token masked
// on screen and copied deliberately — so the combined string never needed the
// secret in it. These pin that it does not get one back.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { claudeMcpAddCommand, configBlock } = require('../server/skills.cjs');

const LIVE = 'aga_live_secret_value_do_not_leak';

test('the command builder defaults to a placeholder, not a real token', () => {
  const cmd = claudeMcpAddCommand('https://example.test');
  assert.match(cmd, /aga_YOUR_AGENT_TOKEN/);
  assert.ok(!cmd.includes(LIVE));
});

test('the connect route builds the command WITHOUT the live token', () => {
  // Read the route rather than booting it: the point is that nobody quietly
  // passes `token` back in as a second argument.
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  const call = source.match(/claudeMcpAdd:\s*claudeMcpAddCommand\(([^)]*)\)/);
  assert.ok(call, 'the connect route must still build a claude mcp add string');
  assert.ok(
    !/token/.test(call[1]),
    `claudeMcpAdd must not be passed a token — got claudeMcpAddCommand(${call[1]})`,
  );
});

test('a token passed explicitly still works, for callers that need it', () => {
  // The builders are not crippled; the ROUTES simply do not use that form.
  assert.match(claudeMcpAddCommand('https://example.test', LIVE), /aga_live_secret/);
  // configBlock returns an OBJECT, not a string — stringify to inspect it.
  assert.match(JSON.stringify(configBlock('https://example.test', LIVE)), /aga_live_secret/);
});

test('the mcp-token route builds the config block WITHOUT the live token either', () => {
  // The SECOND instance of the same mistake, found while checking the first.
  // This block has no copy button, so it was not the reported leak — but it
  // shipped a working credential in an API response, and server/skills.cjs
  // already passed TOKEN_PLACEHOLDER at all three of its own call sites. Two
  // instances of one bug is how you get a third.
  //
  // The rule this pins: a response may have exactly ONE field a secret can be
  // taken from. Here that field is `token`, which the dialog masks.
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  const calls = [...source.matchAll(/config:\s*configBlock\(([^)]*)\)/g)];
  assert.ok(calls.length > 0, 'the mcp-token route must still return a config block');
  for (const call of calls) {
    assert.ok(
      !/token/.test(call[1]),
      `configBlock must not be passed a token — got configBlock(${call[1]})`,
    );
  }
});

test('every configBlock caller outside the builder itself uses the placeholder', () => {
  // Widened deliberately: the point is not that two known sites were fixed, it
  // is that a new caller cannot quietly introduce a third.
  for (const file of ['server/index.cjs', 'server/skills.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const call of source.matchAll(/configBlock\(([^)]*)\)/g)) {
      const args = call[1];
      // The definition itself (`function configBlock(baseUrl, token = ...)`) is
      // matched by the same pattern; skip the declaration, not the calls.
      if (/^\s*baseUrl,\s*token\s*=/.test(args)) continue;
      assert.ok(
        !/\btoken\b/.test(args) || /TOKEN_PLACEHOLDER/.test(args),
        `${file}: configBlock(${args}) passes a token that is not the placeholder`,
      );
    }
  }
});

test('neither connect surface renders the command as a secret-masked field', () => {
  // If someone marks it `secret` instead of removing the token, the value is
  // still copied in full — masking the display would hide the problem, not fix
  // it. This asserts the fix stayed at the source of the string.
  for (const file of [
    'src/components/agents/ConnectMcpDialog.tsx',
    'src/components/settings/SettingsDialog.tsx',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const row = source.split('\n').find((line) => line.includes('label="claude mcp add"'));
    assert.ok(row, `${file} should still show the command`);
    assert.ok(!/\bsecret\b/.test(row), `${file}: masking the command is not the fix`);
  }
});
