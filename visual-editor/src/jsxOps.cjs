'use strict';
/**
 * Edit ops for JSX/TSX files.
 *
 * Same contract as the HTML patcher: resolve the target to a byte range and
 * splice. Nothing is reprinted, so formatting, comments and every untouched
 * line survive exactly.
 *
 * Two differences from HTML, both consequences of JSX being code:
 *
 *   1. Targets are addressed by SOURCE LOCATION (from the build-time stamp),
 *      not by a positional path. See stamp.cjs for why a path cannot work.
 *
 *   2. Some edits are refused. An element rendered inside a .map() is one
 *      source node behind N DOM nodes; an attribute holding an expression is
 *      code, not a string. Rewriting either would destroy work. Every refusal
 *      names its reason so the UI can grey the control out and say why, rather
 *      than failing silently or guessing.
 */

const jsx = require('./locators/jsx.cjs');
const { splice, lineIndentBefore, reindent, cutRange } = require('./textEdit.cjs');

/** Attributes that are spelled differently in JSX. */
const ALIAS = { class: 'className', for: 'htmlFor' };
const RESERVED = new Set(['data-ve-loc']);

function aliasAttr(name) {
  return Object.hasOwn(ALIAS, name) ? ALIAS[name] : name;
}

function resolve(doc, op) {
  const loc = op.loc;
  if (!loc || typeof loc.line !== 'number' || typeof loc.column !== 'number') {
    throw new Error('JSX edits need a source location (is the stamp plugin installed?)');
  }
  const rec = jsx.findByLoc(doc, loc.line, loc.column);
  if (!rec) {
    throw new Error(
      'no JSX element at ' + loc.line + ':' + loc.column +
      ' — the file changed since the page was rendered; reload and retry'
    );
  }
  return rec;
}

/** Throw when an element is a loop template rather than a single node. */
function assertNotIterated(rec, what) {
  if (jsx.isInsideIteration(rec)) {
    throw new Error(
      'cannot ' + what + ': this element is rendered from a list, so one source node ' +
      'produces every copy on screen. Edit the data or the template deliberately instead.'
    );
  }
}

function escapeJsxText(text) {
  // Braces open an expression in JSX; the rest of HTML's escaping does not
  // apply because JSX text is not entity-decoded the same way.
  return String(text).replace(/([{}])/g, '{"$1"}');
}

function escapeAttrValue(v) {
  return String(v).replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

function opSetAttr(source, doc, op) {
  const rec = resolve(doc, op);
  const rawName = String(op.name);
  if (RESERVED.has(rawName)) throw new Error('cannot edit ' + rawName + ': it is the editor\'s own marker');
  const name = aliasAttr(rawName);
  if (!/^[a-zA-Z][a-zA-Z0-9\-_:.]*$/.test(name)) throw new Error('invalid attribute name: ' + name);

  const found = jsx.attr(rec, name);
  const removing = op.value === null || op.value === undefined;

  if (found && found.dynamic) {
    throw new Error(
      'cannot edit ' + name + ': its value is an expression, not a string. ' +
      'Editing it here would delete code.'
    );
  }

  if (removing) {
    if (!found) return source;
    const cut = cutAttr(source, found);
    return splice(source, cut.start, cut.end, '');
  }
  const value = escapeAttrValue(op.value);
  if (found && found.hasValue) {
    return splice(source, found.valueStart, found.valueEnd, value);
  }
  if (found) {
    // Valueless (`disabled`) → give it one.
    return splice(source, found.end, found.end, '="' + value + '"');
  }
  const at = jsx.attrInsertPos(rec);
  return splice(source, at, at, ' ' + name + '="' + value + '"');
}

/** Attribute span plus the single space in front of it. */
function cutAttr(source, found) {
  let start = found.start;
  while (start > 0 && /[ \t]/.test(source[start - 1])) start--;
  return { start, end: found.end };
}

function opSetText(source, doc, op) {
  const rec = resolve(doc, op);
  assertNotIterated(rec, 'set text');
  if (jsx.selfClosing(rec)) throw new Error('self-closing element has no text');
  const kids = rec.node.children || [];
  const meaningful = kids.filter(
    (c) => !(c.type === 'JSXText' && !c.value.trim())
  );
  // A {"{"} container is how this editor escapes a literal brace, so it is
  // text as far as the author is concerned. Without this, writing a brace once
  // would make the element permanently uneditable by its own escaping.
  const isTextLike = (c) =>
    c.type === 'JSXText' ||
    (c.type === 'JSXExpressionContainer' && c.expression &&
      c.expression.type === 'StringLiteral');
  if (meaningful.some((c) => !isTextLike(c))) {
    throw new Error('setText only applies to elements whose content is plain text');
  }
  const range = jsx.childrenRange(rec);
  if (!range) throw new Error('element has no children range');
  return splice(source, range.start, range.end, escapeJsxText(op.text));
}

function opRemove(source, doc, op) {
  const rec = resolve(doc, op);
  assertNotIterated(rec, 'remove this element');
  const r = jsx.outerRange(rec);
  const cut = cutRange(source, r.start, r.end);
  return splice(source, cut.start, cut.end, '');
}

function opInsert(source, doc, op) {
  const code = String(op.code || op.html || '').trim();
  if (!code) throw new Error('insert requires code');
  const parentRec = resolve(doc, { loc: op.parentLoc || op.loc });
  assertNotIterated(parentRec, 'insert here');
  if (jsx.selfClosing(parentRec)) throw new Error('cannot insert into a self-closing element');
  if (jsx.hasDynamicChildren(parentRec)) {
    throw new Error(
      'cannot insert here: this element\'s children are produced by an expression, ' +
      'so a literal child would not survive the next render'
    );
  }
  const kids = jsx.children(parentRec);
  const index = typeof op.index === 'number' ? op.index : kids.length;
  if (index > kids.length) throw new Error('index ' + index + ' out of range');

  if (index < kids.length) {
    const at = jsx.outerRange(kids[index]).start;
    const line = lineIndentBefore(source, at);
    return line
      ? splice(source, at, at, reindent(code, line.indent) + '\n' + line.indent)
      : splice(source, at, at, code);
  }
  const range = jsx.childrenRange(parentRec);
  if (!range) throw new Error('element cannot contain children');
  const close = jsx.closeRange(parentRec);
  const line = lineIndentBefore(source, close.start);
  if (!line) return splice(source, range.end, range.end, code);
  let childIndent = line.indent + '  ';
  if (kids.length) {
    const lastLine = lineIndentBefore(source, jsx.outerRange(kids[kids.length - 1]).start);
    if (lastLine) childIndent = lastLine.indent;
  }
  return splice(source, line.pos, line.pos, childIndent + reindent(code, childIndent) + '\n');
}

function opMove(source, doc, op) {
  const rec = resolve(doc, op);
  assertNotIterated(rec, 'move this element');
  const parent = rec.parent;
  if (!parent) throw new Error('element has no parent to move within');
  const sibs = jsx.children(parent);
  const i = sibs.indexOf(rec);
  const j = op.direction === 'up' ? i - 1 : op.direction === 'down' ? i + 1 : -1;
  if (j < 0 || j >= sibs.length) throw new Error('no sibling to swap with (' + op.direction + ')');

  const a = jsx.outerRange(sibs[Math.min(i, j)]);
  const b = jsx.outerRange(sibs[Math.max(i, j)]);
  const gap = source.slice(a.end, b.start);
  const aText = source.slice(a.start, a.end);
  const bText = source.slice(b.start, b.end);
  return source.slice(0, a.start) + bText + gap + aText + source.slice(b.end);
}

function opMoveTo(source, doc, op) {
  const rec = resolve(doc, op);
  assertNotIterated(rec, 'move this element');
  const r = jsx.outerRange(rec);
  const text = source.slice(r.start, r.end);
  const cut = cutRange(source, r.start, r.end);
  const without = splice(source, cut.start, cut.end, '');

  // Re-parse after the cut: the target's offsets have moved.
  const doc2 = jsx.parse(without);
  const parentLoc = op.parentLoc;
  if (!parentLoc) throw new Error('moveTo needs parentLoc');
  // The cut only removes text; a target BELOW it shifts up by the cut length,
  // so resolve by identity of line/column recorded post-cut.
  const rec2 = jsx.findByLoc(doc2, parentLoc.line, parentLoc.column);
  if (!rec2) {
    throw new Error('target parent no longer resolves after the cut — reload and retry');
  }
  return opInsert(without, doc2, { code: text, index: op.index, parentLoc: parentLoc });
}

/**
 * Make sure `{ name } from source` is imported, adding the least code that
 * achieves it: nothing if already present, a specifier on an existing import
 * from the same module, otherwise a new line after the last import.
 *
 * This is the "automatically prepped to use" half of placing a component — a
 * palette that inserts <Button> and leaves the file failing to compile has not
 * actually done the job.
 */
function ensureImports(source, imports) {
  if (!Array.isArray(imports) || !imports.length) return source;
  let out = source;
  for (const spec of imports) {
    const name = spec && spec.name;
    const from = spec && spec.from;
    if (!name || !from) continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    out = ensureOneImport(out, name, from);
  }
  return out;
}

function ensureOneImport(source, name, from) {
  const doc = jsx.parse(source);
  const body = (doc.ast.program && doc.ast.program.body) || [];
  const imports = body.filter((n) => n.type === 'ImportDeclaration');

  for (const imp of imports) {
    const already = (imp.specifiers || []).some(
      (s) => (s.local && s.local.name === name) ||
             (s.imported && s.imported.name === name)
    );
    if (already) return source; // any module already provides this name
  }

  const sameModule = imports.find((imp) => imp.source && imp.source.value === from);
  if (sameModule) {
    const named = (sameModule.specifiers || []).filter((s) => s.type === 'ImportSpecifier');
    if (named.length) {
      const last = named[named.length - 1];
      return splice(source, last.end, last.end, ', ' + name);
    }
    // Default-only import: `import X from "m"` → `import X, { Name } from "m"`
    const def = (sameModule.specifiers || [])[0];
    if (def) return splice(source, def.end, def.end, ', { ' + name + ' }');
  }

  const line = 'import { ' + name + ' } from "' + from + '";';
  if (imports.length) {
    const last = imports[imports.length - 1];
    return splice(source, last.end, last.end, '\n' + line);
  }
  return line + '\n' + source;
}

const OPS = {
  setAttr: opSetAttr,
  setText: opSetText,
  remove: opRemove,
  insert: opInsert,
  move: opMove,
  moveTo: opMoveTo,
};

/**
 * Apply one op to a JSX/TSX source string.
 *
 * setStyle is deliberately absent: JSX carries styles as `style={{...}}`, an
 * object expression, and in practice these projects style with className. A
 * refusal that says so beats silently writing an inline style the codebase
 * does not use.
 */
function applyJsxEdit(source, op) {
  const fn = OPS[op.op];
  if (!fn) {
    if (op.op === 'setStyle') {
      throw new Error(
        'inline styles are not edited in JSX — set a class instead ' +
        '(style={{...}} is an object expression, not a string)'
      );
    }
    throw new Error('unknown op: ' + op.op);
  }
  const doc = jsx.parse(source);
  let out = fn(source, doc, op);

  // Imports come last: the insert has already moved every offset above it, and
  // re-parsing is how ensureImports stays honest about where they now are.
  if (op.imports && (op.op === 'insert' || op.op === 'setAttr')) {
    out = ensureImports(out, op.imports);
  }

  // Structural guard: the result must still parse. Unlike parse5, a JS parser
  // genuinely fails on broken syntax, so this catches a bad splice before the
  // caller writes it.
  try {
    jsx.parse(out);
  } catch (err) {
    throw new Error('patch rejected: result does not parse (' + (err && err.message) + ')');
  }
  return out;
}

module.exports = { applyJsxEdit, ensureImports, aliasAttr, escapeJsxText };
