'use strict';
/**
 * Patcher unit tests — run with `npm test` (node:test, parse5 only).
 *
 * Fixture paths are element-only child indices from <html>:
 *   html(0)=head, html(1)=body
 *   body(0)=div#main, body(1)=ul.list, body(2)=footer
 *   div#main(0)=h1, div#main(1)=p, div#main(2)=span.leaf
 *   ul(0..2)=li a/b/c
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { applyEdit, resolveFilePath } = require('../src/server.cjs');

const FIXTURE = [
  '<!doctype html>',
  '<html>',
  '<head><title>T</title></head>',
  '<body>',
  '  <div id="main" class="wrap  pad" data-x=1 hidden>',
  '    <h1>Hello &amp; welcome</h1>',
  '    <p class=\'lead\'>Some <b>bold</b> text</p>',
  '    <span class="leaf" style="color: red; margin: 0">Leaf text</span>',
  '  </div>',
  '  <ul class="list">',
  '    <li>a</li>',
  '    <li>b</li>',
  '    <li>c</li>',
  '  </ul>',
  '  <footer>foot</footer>',
  '</body>',
  '</html>',
  '',
].join('\n');

// -- setText ----------------------------------------------------------------

test('setText replaces text of a leaf element, escaping HTML', () => {
  const out = applyEdit(FIXTURE, { op: 'setText', path: [1, 0, 2], text: 'A <b> & C' });
  assert.ok(out.includes('<span class="leaf" style="color: red; margin: 0">A &lt;b&gt; &amp; C</span>'));
  // surrounding bytes untouched
  assert.ok(out.includes('<ul class="list">'));
  assert.ok(out.includes('<h1>Hello &amp; welcome</h1>'));
});

test('setText rejects elements with element children', () => {
  assert.throws(
    () => applyEdit(FIXTURE, { op: 'setText', path: [1, 0, 1], text: 'x' }),
    /no child elements/
  );
});

test('setText rejects a bad path', () => {
  assert.throws(() => applyEdit(FIXTURE, { op: 'setText', path: [9, 9], text: 'x' }), /path/);
});

// -- setAttr ------------------------------------------------------------------

test('setAttr replaces a double-quoted value', () => {
  const out = applyEdit(FIXTURE, { op: 'setAttr', path: [1, 0], name: 'id', value: 'hero' });
  assert.ok(out.includes('<div id="hero" class="wrap  pad" data-x=1 hidden>'));
});

test('setAttr replaces a single-quoted value', () => {
  const out = applyEdit(FIXTURE, { op: 'setAttr', path: [1, 0, 1], name: 'class', value: 'intro' });
  assert.ok(out.includes("<p class='intro'>"));
});

test('setAttr replaces an unquoted value', () => {
  const out = applyEdit(FIXTURE, { op: 'setAttr', path: [1, 0], name: 'data-x', value: '2' });
  assert.ok(out.includes('data-x=2'));
});

test('setAttr adds a value to a valueless attribute', () => {
  const out = applyEdit(FIXTURE, { op: 'setAttr', path: [1, 0], name: 'hidden', value: 'true' });
  assert.ok(out.includes('hidden="true"'));
});

test('setAttr inserts a new attribute before >', () => {
  const out = applyEdit(FIXTURE, { op: 'setAttr', path: [1, 2], name: 'data-new', value: 'v' });
  assert.ok(out.includes('<footer data-new="v">foot</footer>'));
});

test('setAttr removes an attribute plus preceding whitespace (value null)', () => {
  const out = applyEdit(FIXTURE, { op: 'setAttr', path: [1, 0], name: 'class', value: null });
  assert.ok(out.includes('<div id="main" data-x=1 hidden>'));
  assert.ok(!out.includes('class="wrap  pad"'));
});

test('setAttr removing a missing attribute is a no-op', () => {
  const out = applyEdit(FIXTURE, { op: 'setAttr', path: [1, 2], name: 'nope', value: null });
  assert.strictEqual(out, FIXTURE);
});

test('setAttr rejects invalid attribute names', () => {
  assert.throws(
    () => applyEdit(FIXTURE, { op: 'setAttr', path: [1, 0], name: '"><script>', value: 'x' }),
    /invalid attribute name/
  );
});

test('setAttr escapes quotes in values', () => {
  const out = applyEdit(FIXTURE, { op: 'setAttr', path: [1, 2], name: 'data-q', value: 'a"b' });
  assert.ok(out.includes('data-q="a&quot;b"'));
});

// -- setStyle -----------------------------------------------------------------

test('setStyle updates an existing declaration', () => {
  const out = applyEdit(FIXTURE, { op: 'setStyle', path: [1, 0, 2], property: 'color', value: 'blue' });
  assert.ok(out.includes('style="color: blue; margin: 0"'));
});

test('setStyle adds a new declaration', () => {
  const out = applyEdit(FIXTURE, { op: 'setStyle', path: [1, 0, 2], property: 'padding', value: '4px' });
  assert.ok(out.includes('style="color: red; margin: 0; padding: 4px"'));
});

test('setStyle deletes a declaration', () => {
  const out = applyEdit(FIXTURE, { op: 'setStyle', path: [1, 0, 2], property: 'margin', value: null });
  assert.ok(out.includes('style="color: red"'));
});

test('setStyle removes the style attribute when empty', () => {
  let out = applyEdit(FIXTURE, { op: 'setStyle', path: [1, 0, 2], property: 'margin', value: null });
  out = applyEdit(out, { op: 'setStyle', path: [1, 0, 2], property: 'color', value: null });
  assert.ok(out.includes('<span class="leaf">Leaf text</span>'));
});

test('setStyle creates a style attribute when missing', () => {
  const out = applyEdit(FIXTURE, { op: 'setStyle', path: [1, 2], property: 'color', value: 'green' });
  assert.ok(out.includes('<footer style="color: green">foot</footer>'));
});

// -- move ---------------------------------------------------------------------

test('move down swaps with next element sibling, preserving whitespace', () => {
  const out = applyEdit(FIXTURE, { op: 'move', path: [1, 1, 0], direction: 'down' });
  assert.ok(out.indexOf('<li>b</li>') < out.indexOf('<li>a</li>'));
  assert.ok(out.includes('\n    <li>b</li>\n    <li>a</li>\n'));
});

test('move up swaps with previous element sibling', () => {
  const out = applyEdit(FIXTURE, { op: 'move', path: [1, 1, 1], direction: 'up' });
  assert.ok(out.includes('\n    <li>b</li>\n    <li>a</li>\n'));
});

test('move errors at the boundary', () => {
  assert.throws(() => applyEdit(FIXTURE, { op: 'move', path: [1, 1, 0], direction: 'up' }), /sibling/);
});

// -- remove -------------------------------------------------------------------

test('remove deletes the element span and an adjacent gap', () => {
  const out = applyEdit(FIXTURE, { op: 'remove', path: [1, 1, 1] });
  assert.ok(!out.includes('<li>b</li>'));
  // siblings and their whitespace survive cleanly
  assert.ok(out.includes('<li>a</li>\n    <li>c</li>'));
});

// -- path safety ----------------------------------------------------------------

test('resolveFilePath rejects traversal', () => {
  assert.throws(() => resolveFilePath('/root', '../x.html'), /escapes root/);
  assert.throws(() => resolveFilePath('/root', '../../etc/passwd'), /escapes root/);
  assert.strictEqual(resolveFilePath('/root', 'a/b.html'), '/root/a/b.html');
});

// -- sanity -------------------------------------------------------------------

test('unknown op throws', () => {
  assert.throws(() => applyEdit(FIXTURE, { op: 'nope', path: [] }), /unknown op/);
});
