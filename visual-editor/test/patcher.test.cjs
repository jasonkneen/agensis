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
const { applyEdit, resolveFilePath, createUndoTracker } = require('../src/server.cjs');

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
  '  <div class="empty"></div>',
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

// -- moveTo -----------------------------------------------------------------

test('moveTo within same parent, down past one sibling', () => {
  // move <li>a</li> to index 1 (post-removal children: b,c) → b,a,c
  const out = applyEdit(FIXTURE, { op: 'moveTo', path: [1, 1, 0], parentPath: [1, 1], index: 1 });
  assert.ok(out.indexOf('<li>b</li>') < out.indexOf('<li>a</li>'));
  assert.ok(out.indexOf('<li>a</li>') < out.indexOf('<li>c</li>'));
  // indentation preserved: each li on its own line at the same indent
  assert.ok(out.includes('<li>b</li>\n    <li>a</li>\n    <li>c</li>'));
});

test('moveTo within same parent, up to first position', () => {
  // move <li>c</li> to index 0 → c,a,b
  const out = applyEdit(FIXTURE, { op: 'moveTo', path: [1, 1, 2], parentPath: [1, 1], index: 0 });
  assert.ok(out.includes('\n    <li>c</li>\n    <li>a</li>\n    <li>b</li>\n'));
});

test('moveTo a different parent, insert before first child', () => {
  // move <footer> into div#main at index 0 → before h1, at h1's indent
  const out = applyEdit(FIXTURE, { op: 'moveTo', path: [1, 2], parentPath: [1, 0], index: 0 });
  assert.ok(out.includes('hidden>\n    <footer>foot</footer>\n    <h1>Hello'));
  // and the old spot is gone
  assert.ok(!out.includes('\n  <footer>foot</footer>'));
});

test('moveTo append as last child uses sibling indent, endTag stays put', () => {
  // move span.leaf into ul at index 3 (== childCount) → after li c
  const out = applyEdit(FIXTURE, { op: 'moveTo', path: [1, 0, 2], parentPath: [1, 1], index: 3 });
  assert.ok(out.includes(
    '<li>c</li>\n    <span class="leaf" style="color: red; margin: 0">Leaf text</span>\n  </ul>'
  ));
});

test('moveTo into a previously-empty one-liner parent', () => {
  const out = applyEdit(FIXTURE, { op: 'moveTo', path: [1, 1, 0], parentPath: [1, 3], index: 0 });
  assert.ok(out.includes('<div class="empty"><li>a</li></div>'));
});

test('moveTo rejects moving into own descendant', () => {
  // Under post-removal parentPath semantics, aiming at the moved subtree can
  // only fail resolution — the error must name the real cause.
  assert.throws(
    () => applyEdit(FIXTURE, { op: 'moveTo', path: [1, 0], parentPath: [1, 0, 1, 0], index: 0 }),
    /itself or its descendants|does not exist after removal/
  );
});

test('moveTo regression: parentPath is resolved POST-removal', () => {
  // Mirror of the real-world bug: moving body child 2 (".ticker") into
  // section > .wrap > .cols. After the cut, the section shifts from body
  // child 3 to body child 2, so the (correct) parentPath [1,2,0,0] passes
  // THROUGH the removed element's old slot. The server must not mistake that
  // for "moving into itself".
  const src = [
    '<!doctype html>',
    '<html>',
    '<body>',
    '  <div id="a">a</div>',
    '  <div id="b">b</div>',
    '  <div class="ticker"><span>t</span></div>',
    '  <section id="how">',
    '    <div class="wrap">',
    '      <div class="cols">',
    '        <div class="col">1</div>',
    '        <div class="col">2</div>',
    '      </div>',
    '    </div>',
    '  </section>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  const out = applyEdit(src, { op: 'moveTo', path: [1, 2], parentPath: [1, 2, 0, 0], index: 2 });
  // ticker is gone from body level…
  assert.ok(!out.includes('\n  <div class="ticker">'));
  // …and lands as the last child of .cols, at the cols-child indent
  assert.ok(out.includes(
    '<div class="col">2</div>\n        <div class="ticker"><span>t</span></div>\n      </div>'
  ));
  // surrounding structure untouched
  assert.ok(out.includes('<div id="b">b</div>\n  <section id="how">'));
});

test('moveTo rejects an out-of-range index', () => {
  assert.throws(
    () => applyEdit(FIXTURE, { op: 'moveTo', path: [1, 2], parentPath: [1, 1], index: 99 }),
    /out of range/
  );
});

test('moveTo rejects a missing target parent', () => {
  assert.throws(
    () => applyEdit(FIXTURE, { op: 'moveTo', path: [1, 2], parentPath: [1, 9], index: 0 }),
    /path|parent/
  );
});

// -- undo tracker -------------------------------------------------------------

test('undo tracker: push/pop restores newest-first and reports empty', () => {
  const undo = createUndoTracker(50);
  assert.strictEqual(undo.pop('/f.html'), null); // empty → nothing to undo
  undo.push('/f.html', 'v1');
  undo.push('/f.html', 'v2');
  const first = undo.pop('/f.html');
  assert.strictEqual(first.source, 'v2');
  assert.strictEqual(first.empty, false);
  const second = undo.pop('/f.html');
  assert.strictEqual(second.source, 'v1');
  assert.strictEqual(second.empty, true);
  assert.strictEqual(undo.pop('/f.html'), null);
});

test('undo tracker: stacks are per-file and capped', () => {
  const undo = createUndoTracker(3);
  undo.push('/a.html', 'a1');
  undo.push('/b.html', 'b1');
  assert.strictEqual(undo.pop('/b.html').source, 'b1');
  for (let i = 0; i < 10; i++) undo.push('/a.html', 'a' + (i + 2));
  // cap 3: only the last three survive
  assert.strictEqual(undo.pop('/a.html').source, 'a11');
  assert.strictEqual(undo.pop('/a.html').source, 'a10');
  const last = undo.pop('/a.html');
  assert.strictEqual(last.source, 'a9');
  assert.strictEqual(last.empty, true);
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
