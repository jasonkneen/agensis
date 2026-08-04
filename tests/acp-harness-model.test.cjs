'use strict';

// A Grok agent was minted a connection string saying `--model claude-opus-5`.
//
// acp_harness and the claude|codex|amp execution runtime are SEPARATE axes. The
// live agents had acp_harness set ("grok", "hermes") and runtime unset, so
// normalizeExecutionRuntime returned '' and resolveExecutionModel fell straight
// through to resolveAnthropicModel — pinning an Anthropic id onto a harness that
// has never run an Anthropic model. The agent then read that id back and
// described itself as Claude, listing Claude models as its own.

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');

const common = {
  baseUrl: 'https://agensis-backend.fly.dev',
  token: 'aga_test',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  handle: 'grok',
  name: 'Grok',
  permissionMode: 'default',
};

test('a grok-harness agent never gets a Claude model, and auto omits --model', () => {
  // Leftover Anthropic pin must not ride the connect string. Empty --model lets
  // the local Grok CLI use ~/.grok/config.toml (or its own default) — forcing
  // grok-4.5 broke accounts without access to that exact id.
  const cmd = __test.agentConnectionCommand({
    ...common,
    acpHarness: 'grok',
    model: 'claude-opus-5',
  }).portableCommand;

  assert.doesNotMatch(cmd, / --model /, 'foreign pins must not invent a Grok model id');
  assert.doesNotMatch(cmd, /claude-opus/, 'a Claude model id must never reach a grok harness');

  for (const model of ['auto', '']) {
    const autoCmd = __test.agentConnectionCommand({ ...common, acpHarness: 'grok', model }).portableCommand;
    assert.doesNotMatch(autoCmd, / --model /, `model=${JSON.stringify(model)} must omit --model`);
  }
});

test('an explicit grok model is kept; a foreign one is dropped', () => {
  const kept = __test.agentConnectionCommand({
    ...common,
    acpHarness: 'grok',
    model: 'grok-4.5-fast',
  }).portableCommand;
  assert.match(kept, / --model grok-4\.5-fast(?: |$)/, 'a real grok id is a deliberate choice');

  const native = __test.agentConnectionCommand({
    ...common,
    acpHarness: 'grok',
    model: 'grok-4.5',
  }).portableCommand;
  assert.match(native, / --model grok-4\.5(?: |$)/, 'native Grok ids must be kept');

  // Codex id is not a Grok choice — drop, do not replace with grok-4.5.
  const cmd = __test.agentConnectionCommand({ ...common, acpHarness: 'grok', model: 'gpt-5.6-sol' }).portableCommand;
  assert.doesNotMatch(cmd, / --model /, 'foreign non-Grok ids must not invent a fallback');
  assert.doesNotMatch(cmd, /gpt-5/);
});

test('a harness with no known catalog takes no --model at all', () => {
  // Hermes/Goose/Cursor bring their own model and we have no id we can stand
  // behind, so send none — the same honest choice Amp already makes. Inventing
  // one would repeat this bug in a new colour.
  const cmd = __test.agentConnectionCommand({
    ...common,
    handle: 'hermes',
    name: 'Hermes',
    acpHarness: 'hermes',
    model: 'claude-opus-5',
  }).portableCommand;

  assert.doesNotMatch(cmd, / --model /, 'an unknown harness must not be handed a model id');
  assert.doesNotMatch(cmd, /claude-opus/, 'and certainly not a Claude one');
});

test('the Claude and Codex runtimes are untouched by any of this', () => {
  const claude = __test.agentConnectionCommand({
    ...common, handle: 'claude', name: 'Claude', runtime: 'claude', model: 'auto',
  }).portableCommand;
  assert.match(claude, / --model claude-opus-5(?: |$)/, 'the Claude path still resolves the Anthropic default');

  const codex = __test.agentConnectionCommand({
    ...common, handle: 'codex', name: 'Codex', runtime: 'codex', model: 'gpt-5.4',
  }).portableCommand;
  assert.match(codex, / --model gpt-5\.4(?: |$)/, 'the Codex path still passes its own ids');

  const amp = __test.agentConnectionCommand({
    ...common, handle: 'amp', name: 'Amp', runtime: 'amp', model: 'auto',
  }).portableCommand;
  assert.doesNotMatch(amp, / --model /, 'Amp still takes no model');
});
