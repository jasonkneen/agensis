'use strict';
/**
 * JSX/TSX locator — maps a source location to the byte range of a JSX element,
 * so the same splice-the-source model used for HTML works on React files.
 *
 * Addressing is by SOURCE LOCATION, not by a positional path. In HTML the DOM
 * and the file are the same tree, so element indices work. In JSX they are not:
 * one `{items.map(...)}` produces N DOM nodes from one source node, a file
 * holds several components, and conditionals mean the DOM cannot tell you which
 * branch produced it. The build-time stamp (see stamp.cjs) puts the real source
 * location on each rendered element, and that is what we resolve here.
 *
 * @babel/parser is an OPTIONAL dependency: this editor drops into any project,
 * and a project with no JSX should not have to carry a parser. Absent, JSX
 * files are simply not editable and the editor says so.
 */

let parser = null;
let parserError = null;

function getParser() {
  if (parser) return parser;
  if (parserError) throw parserError;
  try {
    parser = require('@babel/parser');
    return parser;
  } catch {
    parserError = new Error(
      'editing JSX needs @babel/parser — install it in this project (npm i -D @babel/parser)'
    );
    throw parserError;
  }
}

function isAvailable() {
  try { getParser(); return true; } catch { return false; }
}

const PLUGINS = ['jsx', 'typescript', 'decorators-legacy', 'classProperties', 'objectRestSpread'];

function parse(source) {
  const babel = getParser();
  let ast;
  try {
    ast = babel.parse(source, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: PLUGINS,
    });
  } catch (err) {
    throw new Error('could not parse as JSX/TSX: ' + (err && err.message));
  }
  const elements = [];
  walk(ast, null, elements);
  return { ast, source, elements };
}

/**
 * Collect every JSXElement with its parent link, in source order.
 *
 * Hand-rolled rather than pulling in @babel/traverse: one more optional
 * dependency for a plain tree walk is a poor trade in a drop-in tool.
 */
function walk(node, parentEl, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, parentEl, out);
    return;
  }
  if (!node.type) return;

  let nextParent = parentEl;
  if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
    const rec = { node, parent: parentEl, children: [] };
    if (parentEl) parentEl.children.push(rec);
    out.push(rec);
    nextParent = rec;
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const v = node[key];
    if (v && typeof v === 'object') walk(v, nextParent, out);
  }
}

function openingName(node) {
  const el = node.openingElement;
  if (!el) return null; // fragment
  return nameOf(el.name);
}

function nameOf(name) {
  if (!name) return null;
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return nameOf(name.object) + '.' + nameOf(name.property);
  if (name.type === 'JSXNamespacedName') return name.namespace.name + ':' + name.name.name;
  return null;
}

/** Locate the element whose opening tag begins at line:col (1-based line). */
function findByLoc(doc, line, col) {
  for (const rec of doc.elements) {
    const open = rec.node.openingElement || rec.node.openingFragment;
    const l = open && open.loc && open.loc.start;
    if (l && l.line === line && l.column === col) return rec;
  }
  return null;
}

/** Element children of a record, skipping text/expression nodes. */
function children(rec) {
  return rec.children;
}

function outerRange(rec) {
  return { start: rec.node.start, end: rec.node.end };
}

function openRange(rec) {
  const open = rec.node.openingElement || rec.node.openingFragment;
  return { start: open.start, end: open.end };
}

function closeRange(rec) {
  const close = rec.node.closingElement || rec.node.closingFragment;
  return close ? { start: close.start, end: close.end } : null;
}

function selfClosing(rec) {
  const open = rec.node.openingElement;
  return !!(open && open.selfClosing);
}

/**
 * Locate one JSX attribute.
 *
 * `dynamic` marks a value the editor must not rewrite: className={cn(...)} is
 * an expression, and splicing a string over it would delete real code. Callers
 * are expected to refuse rather than guess.
 */
function attr(rec, name) {
  const open = rec.node.openingElement;
  if (!open) return null;
  for (const a of open.attributes || []) {
    if (a.type !== 'JSXAttribute') continue;
    if (nameOf(a.name) !== name) continue;
    if (!a.value) {
      return { start: a.start, end: a.end, hasValue: false, dynamic: false };
    }
    if (a.value.type === 'StringLiteral') {
      return {
        start: a.start, end: a.end, hasValue: true, dynamic: false,
        // inside the quotes
        valueStart: a.value.start + 1, valueEnd: a.value.end - 1,
      };
    }
    // JSXExpressionContainer or anything else: present, but not a plain string.
    return {
      start: a.start, end: a.end, hasValue: true, dynamic: true,
      valueStart: a.value.start, valueEnd: a.value.end,
    };
  }
  return null;
}

/** Offset at which a new attribute can be spliced in (just after the tag name). */
function attrInsertPos(rec) {
  const open = rec.node.openingElement;
  if (!open) return null;
  return open.name.end;
}

/** Where children go, for an element that has them. */
function childrenRange(rec) {
  const open = rec.node.openingElement || rec.node.openingFragment;
  const close = rec.node.closingElement || rec.node.closingFragment;
  if (!open || !close) return null;
  return { start: open.end, end: close.start };
}

/**
 * True when this element's children are produced by an expression rather than
 * written out literally — a .map(), a conditional, an interpolation. Structural
 * edits inside these are refused: the source node is not what the DOM shows.
 */
function hasDynamicChildren(rec) {
  for (const c of rec.node.children || []) {
    if (c.type === 'JSXExpressionContainer' &&
        c.expression && c.expression.type !== 'JSXEmptyExpression') return true;
  }
  return false;
}

/** Is this element inside a .map()/callback, i.e. rendered many times? */
function isInsideIteration(rec) {
  let node = rec.node;
  let cur = rec.parent;
  // Walk the record chain; anything above that is an expression container with
  // a call expression means repetition.
  while (cur) {
    if (hasDynamicChildren(cur)) {
      for (const c of cur.node.children || []) {
        if (c.type !== 'JSXExpressionContainer') continue;
        if (containsNode(c.expression, node)) return true;
      }
    }
    node = cur.node;
    cur = cur.parent;
  }
  return false;
}

function containsNode(root, target) {
  if (!root || typeof root !== 'object') return false;
  if (root === target) return true;
  if (Array.isArray(root)) return root.some((n) => containsNode(n, target));
  for (const k of Object.keys(root)) {
    if (k === 'loc') continue;
    const v = root[k];
    if (v && typeof v === 'object' && containsNode(v, target)) return true;
  }
  return false;
}

/** Component (capitalised) vs intrinsic element (lowercase). */
function isComponent(rec) {
  const n = openingName(rec.node);
  return !!n && /^[A-Z]/.test(n[0] === '<' ? n.slice(1) : n);
}

module.exports = {
  isAvailable,
  parse,
  findByLoc,
  children,
  outerRange,
  openRange,
  closeRange,
  childrenRange,
  selfClosing,
  attr,
  attrInsertPos,
  openingName,
  hasDynamicChildren,
  isInsideIteration,
  isComponent,
  // JSX spells these differently from HTML.
  attrAlias: { class: 'className', for: 'htmlFor' },
};
