'use strict';

// shared/taskTitle.cjs rewrites user-authored text on every task create. A false
// positive silently corrupts data nobody asked it to touch, so the "must survive
// untouched" block below is the more important half of this file — if a change
// makes the matcher greedier, that is where it should fail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeTaskTitle, resolveTaskParentByTitle } = require('../shared/taskTitle.cjs');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('strips the outline prefixes agents actually produce', () => {
  const cases = [
    // The literal rows in production today.
    ['Ship UI work / 1. Push main to origin (Netlify build)', 'Push main to origin (Netlify build)', 'Ship UI work'],
    ['Ship UI work / 2. fly deploy for the server changes', 'fly deploy for the server changes', 'Ship UI work'],
    ['Ship UI work / 6. Thread escalation (design + build)', 'Thread escalation (design + build)', 'Ship UI work'],
    // Bare numbering, with a trailing dot.
    ['3. Visual QA on the five shipped changes', 'Visual QA on the five shipped changes', null],
    ['10. Ship it', 'Ship it', null],
    ['1.2. Wire the panel', 'Wire the panel', null],
    // Three or more components need no trailing dot to be unambiguous.
    ['1.2.1 Wire the panel', 'Wire the panel', null],
    ['1.2.1. Wire the panel', 'Wire the panel', null],
    // Spacing around the separator varies between agents.
    ['Ship UI work/3. Fix three known defects', 'Fix three known defects', 'Ship UI work'],
    ['Ship UI work  /  3.  Fix three known defects', 'Fix three known defects', 'Ship UI work'],
  ];
  for (const [input, title, parentTitle] of cases) {
    const result = normalizeTaskTitle(input);
    assert.equal(result.title, title, `title for ${JSON.stringify(input)}`);
    assert.equal(result.parentTitle, parentTitle, `parentTitle for ${JSON.stringify(input)}`);
    assert.equal(result.changed, true, `changed for ${JSON.stringify(input)}`);
  }
});

test('leaves a title that merely STARTS with a number completely alone', () => {
  const survivors = [
    // Digits with no dot at all.
    '2026 roadmap',
    '1984 retrospective',
    '3 blockers before launch',
    // No separator between the digit and the word.
    '3D view removal',
    '2FA for the admin console',
    // Two components and no trailing dot: a version or a decimal, not an
    // outline number. This is the single riskiest false positive.
    '3.5 Sonnet evaluation',
    '1.5x faster rendering',
    '0.5 day spike',
    'v1.2 release notes',
    // A slash with no numbering after it is just a slash.
    'and/or handling in the parser',
    'UI / UX review',
    'Design / build the settings panel',
    'https://example.com/1. thing',
    // Nothing meaningful would be left behind.
    '1.',
    '1. ',
    '2. a',
    // Numbering that is not at the very start.
    'Fix bug 1. in the parser',
    'Step / 1',
  ];
  for (const input of survivors) {
    const result = normalizeTaskTitle(input);
    assert.equal(result.changed, false, `should not have changed: ${JSON.stringify(input)}`);
    assert.equal(result.title, input, `must be byte-identical: ${JSON.stringify(input)}`);
    assert.equal(result.parentTitle, null);
  }
});

test('refuses to treat a whole sentence as a parent path', () => {
  // The path segment is capped, so a long line containing a slash cannot be
  // swallowed as a "parent" no matter what follows it.
  const long = `${'x'.repeat(80)} / 1. Real title`;
  const result = normalizeTaskTitle(long);
  // The path branch declines, and the bare-numbering branch cannot match either
  // (the numbering is not at the start), so nothing is touched.
  assert.equal(result.changed, false);
  assert.equal(result.title, long);
});

test('only ever strips one prefix', () => {
  // Not recursive: "1. 2. Foo" loses the first level and keeps the rest as text,
  // rather than peeling until something unrecognisable is left.
  assert.equal(normalizeTaskTitle('1. 2. Foo').title, '2. Foo');
});

test('handles non-string and empty input without throwing', () => {
  for (const input of [undefined, null, 42, {}, [], '', '   ']) {
    const result = normalizeTaskTitle(input);
    assert.equal(result.changed, false);
    assert.equal(result.parentTitle, null);
  }
  assert.equal(normalizeTaskTitle(undefined).title, '');
  assert.equal(normalizeTaskTitle('   ').title, '   ');
});

test('resolveTaskParentByTitle returns the id only on an unambiguous match', async () => {
  const one = async () => [{ id: 'task-1' }];
  assert.equal(await resolveTaskParentByTitle(one, 'ws-1', 'Ship UI work'), 'task-1');

  // Two tasks share the title — we cannot know which was meant, so nest nothing.
  const two = async () => [{ id: 'task-1' }, { id: 'task-2' }];
  assert.equal(await resolveTaskParentByTitle(two, 'ws-1', 'Ship UI work'), null);

  const none = async () => [];
  assert.equal(await resolveTaskParentByTitle(none, 'ws-1', 'Ship UI work'), null);
});

test('resolveTaskParentByTitle scopes the lookup to the workspace', async () => {
  let seen = null;
  const query = async (sql, params) => { seen = { sql, params }; return []; };
  await resolveTaskParentByTitle(query, 'ws-1', 'Ship UI work');
  assert.match(seen.sql, /workspace_id = \$1/);
  assert.deepEqual(seen.params, ['ws-1', 'Ship UI work']);
});

test('resolveTaskParentByTitle never queries for an empty parent', async () => {
  let called = false;
  const query = async () => { called = true; return []; };
  assert.equal(await resolveTaskParentByTitle(query, 'ws-1', '   '), null);
  assert.equal(await resolveTaskParentByTitle(query, '', 'Ship UI work'), null);
  assert.equal(called, false);
});

// Both backends serve /backend/db/insert over the same DB (see AGENTS.md), so a
// normalisation that lands in only one of them is live or inert depending on
// which host answered the request — the worst possible failure mode for a rule
// that rewrites stored text.
test('every task-create path normalises the title', () => {
  for (const file of ['server/index.cjs', 'netlify/functions/backend.mjs', 'server/mcp.cjs']) {
    const source = read(file);
    assert.match(source, /taskTitle\.cjs/, `${file} must import shared/taskTitle.cjs`);
    assert.match(source, /normalizeTaskTitle\(/, `${file} must call normalizeTaskTitle`);
  }
});

// Only the MCP tool infers parent_id from the stripped path: that is where
// agents create tasks and where faking hierarchy in the title is the documented
// mistake. On the generic route a human typed the title, and silently re-nesting
// their task from a string they wrote would be worse than leaving the words in.
test('only the MCP tool infers a parent from the stripped path', () => {
  assert.match(read('server/mcp.cjs'), /resolveTaskParentByTitle\(/);
  for (const file of ['server/index.cjs', 'netlify/functions/backend.mjs']) {
    assert.doesNotMatch(read(file), /resolveTaskParentByTitle/, `${file} should not infer a parent`);
  }
});
