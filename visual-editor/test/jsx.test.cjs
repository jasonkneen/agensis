'use strict';
/**
 * JSX/TSX editing tests.
 *
 * The refusals matter as much as the edits: this subsystem's whole claim is
 * that it will not guess about code it cannot safely rewrite.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { applyJsxEdit } = require('../src/jsxOps.cjs');
const { stampSource, parseStamp } = require('../src/stamp.cjs');
const jsx = require('../src/locators/jsx.cjs');

const available = jsx.isAvailable();
const opts = available ? {} : { skip: '@babel/parser not installed' };

const SRC = [
  'import { Button } from "@/components/ui/button";',
  '',
  'export default function Card({ items, active }) {',
  '  return (',
  '    <article className="card">',
  '      <h3 id="title">Hello</h3>',
  '      <p className="lede">Body text</p>',
  '      <ul className="rows">',
  '        {items.map((i) => (',
  '          <li key={i.id} className={cn("row", active && "on")}>{i.name}</li>',
  '        ))}',
  '      </ul>',
  '      <Button variant="ghost">Go</Button>',
  '    </article>',
  '  );',
  '}',
  '',
].join('\n');

/** Locate an element the way the browser would: via its stamp. */
function locOf(source, tag, nth = 0) {
  const stamped = stampSource(source, 'src/Card.tsx');
  const re = new RegExp('<' + tag + ' data-ve-loc="([^"]+)"', 'g');
  let m, i = 0;
  while ((m = re.exec(stamped))) {
    if (i++ === nth) {
      const s = parseStamp(m[1]);
      return { line: s.line, column: s.column };
    }
  }
  throw new Error('no stamp found for <' + tag + '>');
}

// -- attributes ---------------------------------------------------------------

test('setAttr edits a static string prop', opts, () => {
  const out = applyJsxEdit(SRC, { op: 'setAttr', loc: locOf(SRC, 'h3'), name: 'id', value: 'heading' });
  assert.ok(out.includes('<h3 id="heading">Hello</h3>'), out);
  assert.ok(out.includes('import { Button }'), 'imports untouched');
});

test('setAttr maps class to className', opts, () => {
  const out = applyJsxEdit(SRC, { op: 'setAttr', loc: locOf(SRC, 'p'), name: 'class', value: 'lede big' });
  assert.ok(out.includes('<p className="lede big">Body text</p>'), out);
});

test('setAttr adds a prop that was not there', opts, () => {
  const out = applyJsxEdit(SRC, { op: 'setAttr', loc: locOf(SRC, 'p'), name: 'id', value: 'body' });
  assert.ok(out.includes('<p id="body" className="lede">'), out);
});

test('setAttr removes a prop', opts, () => {
  const out = applyJsxEdit(SRC, { op: 'setAttr', loc: locOf(SRC, 'h3'), name: 'id', value: null });
  assert.ok(out.includes('<h3>Hello</h3>'), out);
});

test('setAttr REFUSES an expression value rather than deleting code', opts, () => {
  assert.throws(
    () => applyJsxEdit(SRC, { op: 'setAttr', loc: locOf(SRC, 'li'), name: 'className', value: 'row' }),
    /expression, not a string/
  );
});

test('setAttr refuses to touch the editor\'s own stamp', opts, () => {
  assert.throws(
    () => applyJsxEdit(SRC, { op: 'setAttr', loc: locOf(SRC, 'h3'), name: 'data-ve-loc', value: 'x' }),
    /editor's own marker/
  );
});

// -- text ---------------------------------------------------------------------

test('setText replaces plain text content', opts, () => {
  const out = applyJsxEdit(SRC, { op: 'setText', loc: locOf(SRC, 'h3'), text: 'Goodbye' });
  assert.ok(out.includes('<h3 id="title">Goodbye</h3>'), out);
});

test('setText escapes braces so text cannot become an expression', opts, () => {
  const out = applyJsxEdit(SRC, { op: 'setText', loc: locOf(SRC, 'h3'), text: 'a {b} c' });
  assert.ok(out.includes('{"{"}'), out);
  assert.doesNotThrow(() => applyJsxEdit(out, { op: 'setText', loc: locOf(SRC, 'h3'), text: 'ok' }));
});

test('setText refuses an element containing markup', opts, () => {
  assert.throws(
    () => applyJsxEdit(SRC, { op: 'setText', loc: locOf(SRC, 'article'), text: 'x' }),
    /plain text/
  );
});

// -- iteration guard ----------------------------------------------------------

test('structural edits inside a .map() are refused, with the reason', opts, () => {
  const at = locOf(SRC, 'li');
  assert.throws(() => applyJsxEdit(SRC, { op: 'remove', loc: at }), /rendered from a list/);
  assert.throws(() => applyJsxEdit(SRC, { op: 'setText', loc: at, text: 'x' }), /rendered from a list/);
  assert.throws(() => applyJsxEdit(SRC, { op: 'move', loc: at, direction: 'up' }), /rendered from a list/);
});

test('inserting into a container whose children are an expression is refused', opts, () => {
  assert.throws(
    () => applyJsxEdit(SRC, { op: 'insert', parentLoc: locOf(SRC, 'ul'), index: 0, code: '<li>x</li>' }),
    /produced by an expression/
  );
});

// -- structure ----------------------------------------------------------------

test('insert places a component and re-indents it', opts, () => {
  const out = applyJsxEdit(SRC, {
    op: 'insert', parentLoc: locOf(SRC, 'article'), index: 1,
    code: '<Badge variant="new">\n  New\n</Badge>',
  });
  assert.ok(out.includes('      <Badge variant="new">\n        New\n      </Badge>'), out);
  assert.ok(out.includes('<p className="lede">Body text</p>'), 'siblings intact');
});

test('insert appends as the last child', opts, () => {
  const out = applyJsxEdit(SRC, {
    op: 'insert', parentLoc: locOf(SRC, 'article'), code: '<hr />',
  });
  assert.ok(/<Button variant="ghost">Go<\/Button>\n      <hr \/>\n    <\/article>/.test(out), out);
});

test('remove cuts the element and its blank line', opts, () => {
  const out = applyJsxEdit(SRC, { op: 'remove', loc: locOf(SRC, 'h3') });
  assert.ok(!out.includes('<h3'), out);
  assert.ok(out.includes('    <article className="card">\n      <p className="lede">'), out);
});

test('move swaps two siblings', opts, () => {
  const out = applyJsxEdit(SRC, { op: 'move', loc: locOf(SRC, 'p'), direction: 'up' });
  assert.ok(out.indexOf('<p className="lede">') < out.indexOf('<h3 id="title">'), out);
});

// -- guards -------------------------------------------------------------------

test('a stale location fails loudly instead of editing the wrong node', opts, () => {
  assert.throws(
    () => applyJsxEdit(SRC, { op: 'setAttr', loc: { line: 999, column: 0 }, name: 'id', value: 'x' }),
    /no JSX element at 999:0/
  );
});

test('setStyle is refused with a pointer to className', opts, () => {
  assert.throws(
    () => applyJsxEdit(SRC, { op: 'setStyle', loc: locOf(SRC, 'h3'), property: 'color', value: 'red' }),
    /set a class instead/
  );
});

test('a patch that would not parse is rejected before it is returned', opts, () => {
  assert.throws(
    () => applyJsxEdit(SRC, { op: 'insert', parentLoc: locOf(SRC, 'article'), code: '<div>' }),
    /does not parse|rejected/
  );
});

// -- fidelity -----------------------------------------------------------------

test('an edit changes only its own span', opts, () => {
  const out = applyJsxEdit(SRC, { op: 'setAttr', loc: locOf(SRC, 'h3'), name: 'id', value: 'x' });
  const a = SRC.split('\n');
  const b = out.split('\n');
  assert.strictEqual(a.length, b.length, 'line count unchanged');
  const differing = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  assert.deepStrictEqual(differing, [5], 'exactly one line differs');
});

test('the stamp is invisible to the file on disk', opts, () => {
  // Stamping is a build-time transform; edits are computed against the ORIGINAL
  // source, so no stamp may ever reach the file.
  const out = applyJsxEdit(SRC, { op: 'setAttr', loc: locOf(SRC, 'h3'), name: 'id', value: 'x' });
  assert.ok(!out.includes('data-ve-loc'), 'no stamp written to source');
});

// -- import auto-prep ----------------------------------------------------------

const WITH_IMPORT = [
  'import { Button } from "@/components/ui/button";',
  '',
  'export default function P() {',
  '  return (',
  '    <div>',
  '      <span>x</span>',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

function divLoc(src) { return locOf(src, 'div'); }

test('insert adds the import a placed component needs', opts, () => {
  const out = applyJsxEdit(WITH_IMPORT, {
    op: 'insert', parentLoc: divLoc(WITH_IMPORT), code: '<Card />',
    imports: [{ name: 'Card', from: '@/components/ui/card' }],
  });
  assert.ok(out.includes('import { Card } from "@/components/ui/card";'), out);
  assert.ok(out.includes('<Card />'), out);
});

test('an import that already exists is not duplicated', opts, () => {
  const out = applyJsxEdit(WITH_IMPORT, {
    op: 'insert', parentLoc: divLoc(WITH_IMPORT), code: '<Button />',
    imports: [{ name: 'Button', from: '@/components/ui/button' }],
  });
  assert.strictEqual(out.split('import { Button }').length - 1, 1, 'exactly one Button import');
});

test('a second name from the same module joins the existing import', opts, () => {
  const out = applyJsxEdit(WITH_IMPORT, {
    op: 'insert', parentLoc: divLoc(WITH_IMPORT), code: '<Badge />',
    imports: [{ name: 'Badge', from: '@/components/ui/button' }],
  });
  assert.ok(out.includes('import { Button, Badge } from "@/components/ui/button";'), out);
});

test('a file with no imports gets one at the top', opts, () => {
  const bare = 'export default function P() {\n  return <div><span>x</span></div>;\n}\n';
  const out = applyJsxEdit(bare, {
    op: 'insert', parentLoc: divLoc(bare), code: '<Card />',
    imports: [{ name: 'Card', from: '@/components/ui/card' }],
  });
  assert.ok(out.startsWith('import { Card } from "@/components/ui/card";\n'), out);
});

// -- stamping ------------------------------------------------------------------

test('stamping preserves line numbers and skips components', opts, () => {
  const stamped = stampSource(SRC, 'src/Card.tsx');
  assert.strictEqual(stamped.split('\n').length, SRC.split('\n').length, 'no reflowing');
  assert.ok(/<h3 data-ve-loc="src\/Card\.tsx:6:6"/.test(stamped), stamped);
  // <Button> is a component: a stamp there would be a prop, not an attribute.
  assert.ok(!/<Button[^>]*data-ve-loc/.test(stamped), 'components left alone');
});

test('stamping is idempotent', opts, () => {
  const once = stampSource(SRC, 'src/Card.tsx');
  assert.strictEqual(stampSource(once, 'src/Card.tsx'), once);
});

test('a .map() template gets ONE stamp — the dynamic-content signal', opts, () => {
  const stamped = stampSource(SRC, 'src/Card.tsx');
  const liStamps = stamped.match(/<li data-ve-loc="[^"]+"/g) || [];
  assert.strictEqual(liStamps.length, 1,
    'one source node, however many rows it renders — duplicates in the DOM are how the client detects iteration');
});

test('unparseable input is returned untouched rather than mangled', opts, () => {
  const broken = 'export default function ( { <<< }';
  assert.strictEqual(stampSource(broken, 'x.tsx'), broken);
});
