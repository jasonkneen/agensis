'use strict';

// ============================================================================
// tests/agent-share-policy.test.cjs
// ----------------------------------------------------------------------------
// The MACHINE's half of sharing: a .agensis-share file in the agent's root
// folder, robots.txt-shaped, declaring what that computer will contribute.
//
// The failures worth catching are all about a file whose author believed they
// had blocked something:
//   - a glob that quietly does not match what it looks like it matches
//   - a directive spelled the way people actually type it, silently ignored
//   - a broken line read as permission rather than as an error
//   - the two halves combined with OR instead of AND
// Each of those ships a file that reads as a restriction and behaves as a grant,
// which is the only really dangerous failure this format has.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SHARE_POLICY_FILENAME,
  MAX_PATH_RULES,
  channelAllowed,
  describeChannelState,
  describeSharePolicy,
  effectiveChannel,
  globToRegExp,
  normalizeSharePolicyMessage,
  parseSharePolicy,
  pathAllowed,
} = require('../shared/agentSharePolicy.cjs');

const parse = (lines) => parseSharePolicy(Array.isArray(lines) ? lines.join('\n') : lines);

// --- the file ----------------------------------------------------------------

test('the filename is the one the daemon and the docs both name', () => {
  assert.equal(SHARE_POLICY_FILENAME, '.agensis-share');
});

test('an absent or empty file restricts nothing', () => {
  // FAIL OPEN ON ABSENCE. Every agent connected before this existed has no such
  // file, and reading that as "share nothing" would silently empty three browse
  // surfaces on deploy.
  for (const input of ['', '   \n\n', undefined, null]) {
    const policy = parseSharePolicy(input);
    assert.equal(policy.declared, false);
    for (const channel of ['memory', 'skills', 'tools', 'documents']) {
      assert.equal(channelAllowed(policy, channel), true, `${channel} should be unrestricted`);
    }
    assert.equal(pathAllowed(policy, 'anything/at/all.md'), true);
  }
});

test('share and withhold set channels, last mention winning', () => {
  const policy = parse([
    'share: documents',
    'withhold: memory',
    'withhold: documents',
  ]);
  assert.equal(policy.declared, true);
  // Last wins, so appending a withhold to the end of a file does what its
  // author obviously means.
  assert.equal(channelAllowed(policy, 'documents'), false);
  assert.equal(channelAllowed(policy, 'memory'), false);
  // Never mentioned = no opinion, deferring to the workspace switch. NOT a grant.
  assert.equal(channelAllowed(policy, 'skills'), true);
  assert.equal(policy.errors.length, 0);
});

test('comments and blank lines are free, and directives are case-insensitive', () => {
  const policy = parse([
    '# what this machine shares',
    '',
    'WITHHOLD: Memory   # not this one',
    '   ',
    'Share: Documents',
  ]);
  assert.equal(channelAllowed(policy, 'memory'), false);
  assert.equal(channelAllowed(policy, 'documents'), true);
  assert.deepEqual(policy.errors, []);
});

test('"deny" is accepted as a synonym for "disallow"', () => {
  // Somebody will type this. Refusing it would produce a file that shares
  // exactly what its author believed they had blocked.
  const policy = parse(['deny: secrets/**']);
  assert.equal(pathAllowed(policy, 'secrets/keys.md'), false);
  assert.deepEqual(policy.errors, []);
});

test('a line nobody can parse becomes an ERROR, never a silent grant', () => {
  // FAIL CLOSED ON GARBAGE: somebody wrote this line meaning to restrict
  // something. Discarding it quietly is the worst reading available.
  const policy = parse([
    'withhold memory',
    'share:',
    'withhold: telepathy',
    'shrare: documents',
  ]);
  assert.equal(policy.errors.length, 4, policy.errors.join(' | '));
  assert.match(policy.errors[0], /expected "directive: value"/);
  assert.match(policy.errors[2], /unknown channel "telepathy"/);
  assert.match(policy.errors[3], /unknown directive "shrare"/);
});

// --- globs -------------------------------------------------------------------

test('** spans directories and also matches zero of them', () => {
  // `docs/**` must cover `docs/a.md` as well as `docs/deep/a.md`. A pattern that
  // only matched the deep case would leave the top level shared.
  const policy = parse(['disallow: docs/**']);
  assert.equal(pathAllowed(policy, 'docs/a.md'), false);
  assert.equal(pathAllowed(policy, 'docs/deep/nested/a.md'), false);
  assert.equal(pathAllowed(policy, 'other/a.md'), true);

  assert.ok(globToRegExp('a/**/b').test('a/b'), 'zero directories');
  assert.ok(globToRegExp('a/**/b').test('a/x/y/b'), 'many directories');
});

test('* stays inside one segment', () => {
  const policy = parse(['disallow: *.private.md']);
  assert.equal(pathAllowed(policy, 'notes.private.md'), false);
  // A single star must not leak across a separator, or `*.md` blocks the tree.
  assert.equal(pathAllowed(policy, 'docs/notes.private.md'), true);
});

test('regex metacharacters in a pattern are literal', () => {
  // MUTATION: interpolate the pattern into a RegExp unescaped. `notes.md` then
  // matches `notesXmd`, and more usefully a pattern like `a+b.md` throws or
  // silently matches nothing.
  const policy = parse(['disallow: notes.md']);
  assert.equal(pathAllowed(policy, 'notes.md'), false);
  assert.equal(pathAllowed(policy, 'notesXmd'), true, 'the dot was treated as a wildcard');
  assert.equal(pathAllowed(parse(['disallow: a+b.md']), 'a+b.md'), false);
});

test('a trailing slash means the directory and everything under it', () => {
  const policy = parse(['disallow: scratch/']);
  assert.equal(pathAllowed(policy, 'scratch/a.md'), false);
  assert.equal(pathAllowed(policy, 'scratch/deep/a.md'), false);
  assert.equal(pathAllowed(policy, 'scratchpad.md'), true, 'prefix, not the directory');
});

test('FIRST match wins, so a carve-out must come before the block', () => {
  const carved = parse(['allow: docs/public/**', 'disallow: docs/**']);
  assert.equal(pathAllowed(carved, 'docs/public/a.md'), true);
  assert.equal(pathAllowed(carved, 'docs/internal/a.md'), false);

  // Reversed, the broad rule matches first and the carve-out is dead. This is
  // the ordering trap robots.txt has too, and it is pinned so the semantics
  // cannot quietly become last-match-wins.
  const shadowed = parse(['disallow: docs/**', 'allow: docs/public/**']);
  assert.equal(pathAllowed(shadowed, 'docs/public/a.md'), false);
});

test('an unmatched path is allowed: rules are exceptions, not an allowlist', () => {
  const policy = parse(['disallow: secrets/**']);
  assert.equal(pathAllowed(policy, 'README.md'), true);
  // An author who wants a true allowlist writes the deny-all first.
  const allowlist = parse(['allow: docs/**', 'disallow: **']);
  assert.equal(pathAllowed(allowlist, 'docs/a.md'), true);
  assert.equal(pathAllowed(allowlist, 'README.md'), false);
});

test('paths are compared in normalized form', () => {
  const policy = parse(['disallow: docs/**']);
  for (const candidate of ['./docs/a.md', '/docs/a.md', 'docs\\a.md']) {
    assert.equal(pathAllowed(policy, candidate), false, candidate);
  }
});

test('the rule count is capped and the overflow is reported, not hidden', () => {
  const many = Array.from({ length: MAX_PATH_RULES + 10 }, (_, index) => `disallow: d${index}/**`);
  const policy = parse(many);
  assert.equal(policy.rules.length, MAX_PATH_RULES);
  assert.ok(policy.errors.some(error => /more than/.test(error)), 'silently truncated');
});

// --- the intersection ---------------------------------------------------------

test('the two halves AND together — neither can widen the other', () => {
  const workspaceOn = { sharing: {} };
  const workspaceOff = { sharing: { documents: false } };
  const machineOn = parse(['share: documents']);
  const machineOff = parse(['withhold: documents']);

  assert.equal(effectiveChannel(workspaceOn, machineOn, 'documents'), true);
  // MUTATION: OR these. A machine that declines then gets overridden by a
  // workspace switch it does not control, which is the whole point of the file.
  assert.equal(effectiveChannel(workspaceOn, machineOff, 'documents'), false, 'machine veto ignored');
  assert.equal(effectiveChannel(workspaceOff, machineOn, 'documents'), false, 'workspace veto ignored');
  assert.equal(effectiveChannel(workspaceOff, machineOff, 'documents'), false);
});

test('a channel that is off says WHICH side turned it off', () => {
  // The distinction is the difference between a fix in the app and a fix on
  // somebody else's computer. One blank list for both sends people to the wrong
  // place entirely.
  const machineOff = parse(['withhold: documents']);
  const empty = parse('');
  assert.deepEqual(describeChannelState({ sharing: {} }, empty, 'documents'), { shared: true, reason: 'shared' });
  assert.deepEqual(describeChannelState({ sharing: {} }, machineOff, 'documents'), { shared: false, reason: 'machine' });
  assert.deepEqual(
    describeChannelState({ sharing: { documents: false } }, empty, 'documents'),
    { shared: false, reason: 'workspace' },
  );
  assert.deepEqual(
    describeChannelState({ sharing: { documents: false } }, machineOff, 'documents'),
    { shared: false, reason: 'both' },
  );
});

// --- the wire -----------------------------------------------------------------

test('a policy from the wire is re-validated, never trusted as sent', () => {
  const policy = normalizeSharePolicyMessage({
    channels: { documents: false, telepathy: true },
    rules: [
      { allow: false, pattern: 'secrets/**' },
      { allow: true, pattern: '' },
      'not an object',
      { allow: false },
    ],
    somethingElse: { deeply: 'nested' },
  });
  assert.equal(policy.channels.documents, false);
  assert.equal(policy.channels.telepathy, undefined, 'unknown channel survived');
  assert.equal(policy.rules.length, 1, 'malformed rules survived');
  assert.equal(policy.rules[0].pattern, 'secrets/**');
  assert.equal(policy.somethingElse, undefined, 'arbitrary keys survived');
});

test('a missing wire policy permits everything', () => {
  for (const input of [undefined, null, 'nope', []]) {
    const policy = normalizeSharePolicyMessage(input);
    assert.equal(policy.declared, false);
    assert.equal(channelAllowed(policy, 'documents'), true);
  }
});

test('the summary distinguishes "no file" from "a file that restricts nothing"', () => {
  assert.match(describeSharePolicy(parse('')), /No policy file/);
  assert.match(describeSharePolicy(parse(['share: documents'])), /no restrictions/);
  assert.match(describeSharePolicy(parse(['withhold: memory'])), /withholds memory/);
  assert.match(describeSharePolicy(parse(['disallow: a/**'])), /1 path rule/);
});

// --- enforcement wiring --------------------------------------------------------

test('the server applies the policy again at ingest', () => {
  // The daemon already filtered. This second pass is what makes the policy a
  // control rather than a convention: a buggy or modified daemon cannot push a
  // path its own declared policy forbids.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server', 'agent-connections.cjs'), 'utf8');
  assert.match(source, /policyFilterPaths\(\s*\n?\s*memoryPolicy/, 'memory sync does not re-filter');
  assert.match(source, /policyFilterPaths\(\s*\n?\s*documentPolicy/, 'document sync does not re-filter');
  assert.match(source, /channelAllowed\(memoryPolicy, 'memory'\)/);
  assert.match(source, /channelAllowed\(skillPolicy, 'skills'\)/);
  assert.match(source, /channelAllowed\(documentPolicy, 'documents'\)/);
  assert.match(source, /sharePolicy: normalizeSharePolicyMessage\(message\.sharePolicy\)/);
});
