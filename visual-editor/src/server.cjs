'use strict';
/**
 * visual-dev-editor — server side.
 *
 * Exposes:
 *   createEditorMiddleware({ root })  — connect-style (req, res, next) middleware
 *   startServer({ root, port })       — standalone static server w/ script injection
 *   applyEdit(source, op)             — pure string patcher (exported for tests)
 *   resolveFilePath(root, rel)        — safe path resolution (exported for tests)
 *
 * Routes:
 *   GET  /__visual-editor/client.js  — the browser editor bundle
 *   POST /__visual-editor/edit       — apply one edit op to an HTML source file
 *   GET  /__visual-editor/palette    — what the host project is made of
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const parse5 = require('parse5');
const { discover } = require('./discover.cjs');
const { applyJsxEdit } = require('./jsxOps.cjs');
const jsxLocator = require('./locators/jsx.cjs');

const CLIENT_JS_PATH = path.join(__dirname, 'client.js');
const ATTR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9\-_:.]*$/;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve a client-supplied relative path inside root; reject traversal. */
function resolveFilePath(root, rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('missing file path');
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new Error('path escapes root: ' + rel);
  }
  // The lexical check above only removes `..`; a symlink inside root can still
  // point outside it. Compare real paths whenever both actually exist.
  let realRoot;
  try {
    realRoot = fs.realpathSync(absRoot);
  } catch (err) {
    if (err && err.code === 'ENOENT') return abs; // root not on disk (unit tests)
    throw err;
  }
  let realAbs;
  try {
    realAbs = fs.realpathSync(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return abs; // file does not exist yet
    throw err;
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    throw new Error('path escapes root via symlink: ' + rel);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Request authentication — this server writes to the developer's disk, so a
// write must not be forgeable by any page that happens to be open in the same
// browser. Two independent gates:
//
//   1. The Host header must name a loopback address, so a public hostname
//      re-pointed at 127.0.0.1 (DNS rebinding) cannot reach these routes.
//   2. A cross-site write is rejected: the Origin header (which browsers
//      always attach to POSTs) must match this server's own origin, and the
//      body must be declared application/json — which forces a CORS preflight
//      that we deliberately never answer.
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostName(hostHeader) {
  if (!hostHeader) return '';
  // Keep a bracketed IPv6 literal intact; otherwise strip the :port suffix.
  const name = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  return name.toLowerCase();
}

function hostIsLoopback(req) {
  return LOOPBACK_HOSTS.has(hostName(req.headers.host));
}

/** True when the request did not come from another site. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // non-CORS same-origin request
  if (origin === 'null') return false;   // opaque origin (sandboxed iframe, data:)
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  return parsed.host === req.headers.host;
}

function isJsonBody(req) {
  const ct = req.headers['content-type'] || '';
  return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

/** Gate for read-only routes: no body, so no content-type to require. */
function rejectReadReason(req) {
  if (!hostIsLoopback(req)) return 'this editor only accepts loopback requests';
  if (!sameOrigin(req)) return 'cross-origin requests are not accepted';
  return null;
}

/** Returns an error string when the request must be refused, else null. */
function rejectReason(req) {
  if (!hostIsLoopback(req)) return 'this editor only accepts loopback requests';
  if (!sameOrigin(req)) return 'cross-origin requests are not accepted';
  if (!isJsonBody(req)) return 'content-type must be application/json';
  return null;
}

// ---------------------------------------------------------------------------
// Tree walking — path = element-only child indices from <html> down
// ---------------------------------------------------------------------------

function elementChildren(node) {
  return (node.childNodes || []).filter(
    (n) => n.nodeName && n.nodeName[0] !== '#' // skip text/comment nodes
  );
}

/** Find the node at an element-only index path, starting at <html>. */
function findNode(doc, indexPath) {
  if (!Array.isArray(indexPath)) throw new Error('missing path');
  let node = null;
  const top = elementChildren(doc);
  for (const n of top) if (n.tagName === 'html') node = n;
  if (!node) throw new Error('no <html> element found');
  for (const idx of indexPath) {
    const kids = elementChildren(node);
    if (typeof idx !== 'number' || idx < 0 || idx >= kids.length) {
      throw new Error('path does not match any element (index ' + idx + ')');
    }
    node = kids[idx];
  }
  return node;
}

function loc(node) {
  const l = node.sourceCodeLocation;
  if (!l || !l.startTag) throw new Error('node has no source location (not an element in source?)');
  return l;
}

// ---------------------------------------------------------------------------
// Splice helper
// ---------------------------------------------------------------------------

function splice(source, start, end, replacement) {
  return source.slice(0, start) + replacement + source.slice(end);
}

// ---------------------------------------------------------------------------
// Attribute patching within a start-tag span
// ---------------------------------------------------------------------------

/**
 * Find `name` in the node's startTag.attrs location info (parse5 v6 gives
 * per-attribute offsets). Falls back to a regex scan of the tag text.
 * Returns { valueStart, valueEnd, attrStart, attrEnd, hasValue } in absolute
 * source offsets, or null when absent.
 */
function findAttrSpan(source, node, name) {
  const l = loc(node);
  const attrs = l.startTag.attrs;
  if (attrs && attrs[name]) {
    const a = attrs[name]; // { startOffset, endOffset } of the whole attribute
    const tagText = source.slice(a.startOffset, a.endOffset);
    return parseAttrText(source, a.startOffset, tagText);
  }
  // Fallback: scan the start tag text for the attribute name.
  const tagStart = l.startTag.startOffset;
  const tagText = source.slice(l.startTag.startOffset, l.startTag.endOffset);
  const re = new RegExp(
    '(^|[\\s])(' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(\\s*=\\s*("[^"]*"|\'[^\']*\'|[^\\s>]+))?(?=\\s|/|>|$)'
  );
  const m = re.exec(tagText);
  if (!m || m[2].toLowerCase() !== name.toLowerCase()) return null;
  const attrStart = tagStart + m.index + m[1].length;
  return parseAttrText(source, attrStart, source.slice(attrStart, tagStart + m.index + m[0].length));
}

/** Given the exact source text of one attribute, compute its value span. */
function parseAttrText(source, attrStart, text) {
  const eq = text.indexOf('=');
  if (eq === -1) {
    return { attrStart, attrEnd: attrStart + text.length, hasValue: false, valueStart: -1, valueEnd: -1 };
  }
  let i = eq + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  let valueStart, valueEnd;
  if (text[i] === '"' || text[i] === "'") {
    const q = text[i];
    const close = text.indexOf(q, i + 1);
    valueStart = attrStart + i + 1;
    valueEnd = close === -1 ? attrStart + text.length : attrStart + close;
  } else {
    let j = i;
    while (j < text.length && !/[\s>]/.test(text[j])) j++;
    valueStart = attrStart + i;
    valueEnd = attrStart + j;
  }
  return { attrStart, attrEnd: attrStart + text.length, hasValue: true, valueStart, valueEnd };
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** setAttr op. value === null removes the attribute. */
function patchAttr(source, node, name, value) {
  if (!ATTR_NAME_RE.test(name)) throw new Error('invalid attribute name: ' + name);
  const l = loc(node);
  const span = findAttrSpan(source, node, name);
  if (value === null) {
    if (!span) return source; // nothing to remove
    // Remove attribute plus preceding whitespace.
    let start = span.attrStart;
    while (start > l.startTag.startOffset && /\s/.test(source[start - 1])) start--;
    // Keep at least one space after the tag name.
    const tagNameEnd = l.startTag.startOffset + 1 + node.tagName.length;
    if (start < tagNameEnd) start = tagNameEnd;
    if (start === tagNameEnd) {
      // First attribute in the tag: the whitespace before it is the separator
      // after the tag name and has to survive, so eat the run that FOLLOWS
      // the attribute instead — otherwise `<div id="a" class="b">` collapses
      // to `<div  class="b">` with a doubled space.
      let end = span.attrEnd;
      while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end++;
      // Nothing follows it inside the tag: drop the leading run instead, so
      // `<div id="a">` becomes `<div>` rather than `<div >`.
      if (source[end] === '>' || (source[end] === '/' && source[end + 1] === '>')) {
        return splice(source, tagNameEnd, span.attrEnd, '');
      }
      return splice(source, span.attrStart, end, '');
    }
    return splice(source, start, span.attrEnd, '');
  }
  if (span && span.hasValue) {
    return splice(source, span.valueStart, span.valueEnd, escapeAttr(value));
  }
  if (span) {
    // Valueless attribute: append ="value" after the name.
    return splice(source, span.attrEnd, span.attrEnd, '="' + escapeAttr(value) + '"');
  }
  // Insert before the closing > or />.
  const tagText = source.slice(l.startTag.startOffset, l.startTag.endOffset);
  const selfClose = /\/\s*>$/.test(tagText);
  const insertAt = selfClose
    ? l.startTag.endOffset - tagText.match(/\/\s*>$/)[0].length
    : l.startTag.endOffset - 1;
  return splice(source, insertAt, insertAt, ' ' + name + '="' + escapeAttr(value) + '"');
}

// ---------------------------------------------------------------------------
// Style attribute read/modify/write
// ---------------------------------------------------------------------------

function parseStyleDecls(styleText) {
  const decls = [];
  for (const part of styleText.split(';')) {
    const t = part.trim();
    if (!t) continue;
    const colon = t.indexOf(':');
    if (colon === -1) continue;
    decls.push([t.slice(0, colon).trim(), t.slice(colon + 1).trim()]);
  }
  return decls;
}

function patchStyle(source, node, property, value) {
  // Assertion, not a value: loc() throws when the node has no source location,
  // which keeps patchStyle from splicing against offsets that don't exist. The
  // return is genuinely unused here — every other caller needs the offsets.
  loc(node);
  const span = findAttrSpan(source, node, 'style');
  const current = span && span.hasValue
    ? source.slice(span.valueStart, span.valueEnd)
    : '';
  const decls = parseStyleDecls(current);
  const key = String(property).toLowerCase();
  const idx = decls.findIndex((d) => d[0].toLowerCase() === key);
  if (value === null) {
    if (idx !== -1) decls.splice(idx, 1);
  } else if (idx !== -1) {
    decls[idx][1] = String(value);
  } else {
    decls.push([String(property), String(value)]);
  }
  if (decls.length === 0) return patchAttr(source, node, 'style', null);
  return patchAttr(source, node, 'style', decls.map((d) => d[0] + ': ' + d[1]).join('; '));
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Elements whose content is raw text, never entity-decoded by the parser.
// Escaping `<`/`>`/`&` inside these corrupts them: `a > b` in a <style> would
// be written as `a &gt; b` and the CSS rule would simply stop working.
const RAW_TEXT_TAGS = new Set([
  'script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext',
]);

function opSetText(source, doc, op) {
  const node = findNode(doc, op.path);
  const l = loc(node);
  if (!l.endTag) throw new Error('element has no end tag; cannot set text');
  if (elementChildren(node).length > 0) {
    throw new Error('setText only allowed on elements with no child elements');
  }
  const tag = String(node.tagName).toLowerCase();
  if (RAW_TEXT_TAGS.has(tag)) {
    throw new Error('cannot set text on <' + tag + '>: raw-text element, escaping would corrupt it');
  }
  return splice(source, l.startTag.endOffset, l.endTag.startOffset, escapeText(op.text));
}

function opSetAttr(source, doc, op) {
  const node = findNode(doc, op.path);
  return patchAttr(source, node, op.name, op.value === undefined ? '' : op.value);
}

function opSetStyle(source, doc, op) {
  const node = findNode(doc, op.path);
  if (!/^[a-zA-Z-][a-zA-Z0-9-]*$/.test(String(op.property))) {
    throw new Error('invalid style property: ' + op.property);
  }
  return patchStyle(source, node, op.property, op.value === undefined ? null : op.value);
}

function elementSiblings(node) {
  // parse5 keeps node.parentNode back-references.
  const parent = node.parentNode;
  if (!parent) throw new Error('element has no parent');
  return elementChildren(parent);
}

function opMove(source, doc, op) {
  const node = findNode(doc, op.path);
  const l = loc(node);
  const sibs = elementSiblings(node);
  const i = sibs.indexOf(node);
  const j = op.direction === 'up' ? i - 1 : op.direction === 'down' ? i + 1 : -1;
  if (j < 0 || j >= sibs.length) {
    throw new Error('no element sibling to swap with (' + op.direction + ')');
  }
  const other = sibs[j];
  const lo = loc(other);
  // a = earlier span, b = later span; gap = text between them (whitespace).
  let aS, aE, bS, bE;
  if (lo.startOffset < l.startOffset) {
    aS = lo.startOffset; aE = lo.endOffset; bS = l.startOffset; bE = l.endOffset;
  } else {
    aS = l.startOffset; aE = l.endOffset; bS = lo.startOffset; bE = lo.endOffset;
  }
  const gap = source.slice(aE, bS);
  const aText = source.slice(aS, aE);
  const bText = source.slice(bS, bE);
  // Swap the two elements, preserving the inter-element gap.
  return source.slice(0, aS) + bText + gap + aText + source.slice(bE);
}

/**
 * Cut the element at op.path out of the source: returns
 * { node, text, source } where text is the element's full outer span
 * (whitespace-trimmed) and source is the remainder after removing the span
 * plus one adjacent whitespace-only gap (prefer the leading indent+newline,
 * fall back to a trailing one).
 */
function cutElement(source, doc, op) {
  const node = findNode(doc, op.path);
  const l = loc(node);
  let start = l.startOffset, end = l.endOffset;
  let s = start;
  while (s > 0 && /[ \t]/.test(source[s - 1])) s--;
  if (s > 0 && source[s - 1] === '\n') {
    start = s - 1;
    if (start > 0 && source[start - 1] === '\r') start--;
  } else if (s < start) {
    start = s;
  } else {
    let e = end;
    while (e < source.length && /[ \t]/.test(source[e])) e++;
    if (source[e] === '\n') end = e + 1;
  }
  return {
    node,
    text: source.slice(l.startOffset, l.endOffset).trim(),
    source: splice(source, start, end, ''),
  };
}

function opRemove(source, doc, op) {
  return cutElement(source, doc, op).source;
}

/** Indent of the line a location starts on: the spaces/tabs right before it,
 * or null when it does not follow a newline (i.e. it's inline/one-liner). */
function lineIndentBefore(source, offset) {
  let pos = offset;
  while (pos > 0 && /[ \t]/.test(source[pos - 1])) pos--;
  if (source[pos - 1] === '\n') return { pos, indent: source.slice(pos, offset) };
  return null;
}

function opMoveTo(source, doc, op) {
  if (!Array.isArray(op.parentPath)) throw new Error('missing parentPath');
  if (typeof op.index !== 'number' || op.index < 0) throw new Error('invalid index');

  // parentPath uses POST-removal coordinates (it is resolved after the cut);
  // post-removal resolution can never land inside the removed subtree, so a
  // failure there means the caller aimed at the moved element/descendant or
  // out of range. The only pre-cut step is cutting the element at op.path.
  const cut = cutElement(source, doc, op);
  const doc2 = parse5.parse(cut.source, { sourceCodeLocationInfo: true });
  let parent;
  try {
    parent = findNode(doc2, op.parentPath);
  } catch (e) {
    // A post-removal path can only fail to resolve if it pointed at (or
    // through) the removed subtree — i.e. the moved element or a descendant —
    // or was simply out of range.
    const movedPath = op.path;
    const intoMoved = movedPath.length <= op.parentPath.length &&
      movedPath.every((v, i) => op.parentPath[i] === v);
    if (intoMoved) {
      throw new Error('cannot move an element into itself or its descendants');
    }
    throw new Error('target parent does not exist after removal: ' + e.message);
  }
  const pl = loc(parent);
  if (!pl.endTag) throw new Error('target parent cannot contain children');
  const kids = elementChildren(parent);
  if (op.index > kids.length) {
    throw new Error('index ' + op.index + ' out of range (parent has ' + kids.length + ' element children)');
  }

  return placeInside(cut.source, parent, op.index, cut.text);
}

/**
 * Splice `text` in as child `index` of `parent`, matching the surrounding
 * indentation. Shared by moveTo and insert so both land identically — the
 * indentation rules here are the fiddly part and only want testing once.
 *
 * `parent` must come from a parse of the SAME string being spliced, since it
 * is used for source offsets.
 */
/**
 * Re-indent a multi-line snippet for its new depth.
 *
 * A template lifted from elsewhere in the page carries that spot's
 * indentation on every line but the first (the first is placed by the caller).
 * Without this, inserting a card three levels deep writes its children at the
 * old depth and the file reads as garbage even though it parses.
 */
function reindent(text, indent) {
  const lines = text.split('\n');
  if (lines.length === 1) return text;
  let common = null;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const lead = /^[ \t]*/.exec(lines[i])[0];
    if (common === null || lead.length < common.length) common = lead;
  }
  if (common === null) return text;
  const rest = lines.slice(1).map((l) => (l.trim() ? indent + l.slice(common.length) : l));
  return [lines[0]].concat(rest).join('\n');
}

function placeInside(source, parent, index, text) {
  const pl = loc(parent);
  if (!pl.endTag) throw new Error('target parent cannot contain children');
  const kids = elementChildren(parent);
  if (index > kids.length) {
    throw new Error('index ' + index + ' out of range (parent has ' + kids.length + ' element children)');
  }
  if (index < kids.length) {
    // Insert before reference child R, on its own line at R's indent,
    // leaving R (including its leading indent) byte-unchanged.
    const rl = loc(kids[index]);
    const line = lineIndentBefore(source, rl.startOffset);
    return line
      ? splice(source, rl.startOffset, rl.startOffset, reindent(text, line.indent) + '\n' + line.indent)
      : splice(source, rl.startOffset, rl.startOffset, text);
  }
  // Append as last child, before the parent's endTag.
  const endTagStart = pl.endTag.startOffset;
  const line = lineIndentBefore(source, endTagStart);
  if (!line) {
    // One-liner parent: keep it a one-liner.
    return splice(source, endTagStart, endTagStart, text);
  }
  let childIndent = line.indent + '  ';
  if (kids.length) {
    const lastLine = lineIndentBefore(source, loc(kids[kids.length - 1]).startOffset);
    if (lastLine) childIndent = lastLine.indent;
  }
  // Insert right after the newline that starts the endTag's line:
  // <childIndent><text>\n then the existing <parentIndent></tag>.
  return splice(source, line.pos, line.pos, childIndent + reindent(text, childIndent) + '\n');
}

/**
 * insert op — add NEW markup as child `index` of `parentPath`.
 *
 * This is what makes the editor able to create, not just rearrange. The markup
 * is validated to be exactly one well-formed element before anything is
 * written; combined with the element-count guard in applyEdit, a malformed
 * snippet can never leave a half-open tag in the file.
 */
function opInsert(source, doc, op) {
  if (!Array.isArray(op.parentPath)) throw new Error('missing parentPath');
  if (typeof op.index !== 'number' || op.index < 0) throw new Error('invalid index');
  if (typeof op.html !== 'string' || !op.html.trim()) throw new Error('insert requires html');

  const text = op.html.trim();
  const frag = parse5.parseFragment(text);
  const roots = elementChildren(frag);
  if (roots.length !== 1) {
    throw new Error('insert requires exactly one root element (got ' + roots.length + ')');
  }
  // parseFragment is lenient: "<li>x</li_WRONG>" or "<li>x</div>" parses fine
  // because an unmatched end tag is simply discarded, and the element count is
  // unchanged either way. Compare which tags the caller CLOSED against which
  // ones parse5 understood to be closed — that is the mismatch that would
  // splice an unbalanced tag into the file.
  if (closingTags(text) !== closingTags(parse5.serialize(frag))) {
    throw new Error('insert markup is not well formed (unbalanced tags)');
  }

  const parent = findNode(doc, op.parentPath);
  return placeInside(source, parent, op.index, text);
}

/** Sorted, lowercased list of the tags a snippet closes. */
function closingTags(html) {
  return (String(html).match(/<\/\s*[a-zA-Z][\w:-]*/g) || [])
    .map((t) => t.replace(/<\/\s*/, '').toLowerCase())
    .sort()
    .join(',');
}

/** Element count of a snippet, used to predict the insert's structural delta. */
function snippetElementCount(html) {
  return countElements(parse5.parseFragment(String(html).trim()));
}

/** Total number of elements in a subtree, excluding the node itself. */
function countElements(node) {
  let n = 0;
  for (const kid of elementChildren(node)) n += 1 + countElements(kid);
  return n;
}

/**
 * Pick the patcher for a file. Each language answers the same question — which
 * byte range does this edit replace — so the splice model is shared; only the
 * way a target is located differs.
 */
function patchSource(file, source, op) {
  if (/\.[jt]sx$/.test(file)) {
    if (!jsxLocator.isAvailable()) {
      throw new Error(
        'editing ' + path.basename(file) + ' needs @babel/parser — ' +
        'install it in this project (npm i -D @babel/parser)'
      );
    }
    return applyJsxEdit(source, op);
  }
  return applyEdit(source, op);
}

/**
 * Apply one edit op to an HTML source string. Returns the patched source.
 * Throws on any validation failure.
 */
function applyEdit(source, op) {
  const doc = parse5.parse(source, { sourceCodeLocationInfo: true });

  // Structural expectation, checked after patching. Every op but `remove`
  // preserves the element count; `remove` drops exactly the target subtree.
  const before = countElements(doc);
  let expectedDelta = 0;
  if (op.op === 'remove') {
    expectedDelta = -(1 + countElements(findNode(doc, op.path)));
  } else if (op.op === 'insert') {
    // countElements() on a fragment already counts the root element.
    expectedDelta = snippetElementCount(op.html);
  }

  let out;
  switch (op.op) {
    case 'setText': out = opSetText(source, doc, op); break;
    case 'setAttr': out = opSetAttr(source, doc, op); break;
    case 'setStyle': out = opSetStyle(source, doc, op); break;
    case 'move': out = opMove(source, doc, op); break;
    case 'moveTo': out = opMoveTo(source, doc, op); break;
    case 'remove': out = opRemove(source, doc, op); break;
    case 'insert': out = opInsert(source, doc, op); break;
    default: throw new Error('unknown op: ' + op.op);
  }

  // parse5 is error-tolerant and never throws, so re-parsing alone proves
  // nothing. Compare the element count instead: a splice that landed at the
  // wrong offset almost always breaks a tag and changes the tree shape.
  // Throwing here means the caller never writes the mangled source to disk.
  const after = countElements(parse5.parse(out));
  if (after !== before + expectedDelta) {
    throw new Error(
      'patch rejected: document structure changed unexpectedly (' + before +
      ' elements → ' + after + ', expected ' + (before + expectedDelta) + ')'
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Undo — in-memory per-file stack of pre-edit sources (dev tool; not persisted)
// ---------------------------------------------------------------------------

function createUndoTracker(cap) {
  const stacks = new Map(); // absPath -> string[] (oldest → newest)
  return {
    push(file, source) {
      let s = stacks.get(file);
      if (!s) { s = []; stacks.set(file, s); }
      s.push(source);
      while (s.length > cap) s.shift();
    },
    /** Returns { source, empty } or null when the stack is empty. */
    pop(file) {
      const s = stacks.get(file);
      if (!s || s.length === 0) return null;
      const source = s.pop();
      return { source, empty: s.length === 0 };
    },
  };
}

/** connect-style middleware: handles /__visual-editor/*, calls next() otherwise. */
function createEditorMiddleware({ root }) {
  if (!root) throw new Error('createEditorMiddleware requires { root }');
  const undo = createUndoTracker(50);
  // Short-lived, not permanent: `npx shadcn add button` mid-session must show
  // up. A scan is ~40ms on a large project, so a few seconds of staleness is
  // the right trade against a palette that silently never updates.
  let paletteCache = null;
  let paletteCachedAt = 0;
  const PALETTE_TTL_MS = 5000;
  return function editorMiddleware(req, res, next) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request: malformed URL');
      return;
    }
    if (url.pathname === '/__visual-editor/client.js' && req.method === 'GET') {
      fs.readFile(CLIENT_JS_PATH, (err, data) => {
        if (err) { res.writeHead(500); res.end('client.js missing'); return; }
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(data);
      });
      return;
    }
    if (url.pathname === '/__visual-editor/palette' && req.method === 'GET') {
      const refusedRead = rejectReadReason(req);
      if (refusedRead) { sendJson(res, 403, { ok: false, error: refusedRead }); return; }
      try {
        // ?fresh=1 forces a rescan regardless of the TTL.
        const stale = Date.now() - paletteCachedAt > PALETTE_TTL_MS;
        if (!paletteCache || stale || url.searchParams.get('fresh')) {
          paletteCache = discover(root);
          paletteCachedAt = Date.now();
        }
        sendJson(res, 200, { ok: true, ...paletteCache });
      } catch (err) {
        // Discovery is a convenience; never let it take the editor down.
        sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
      }
      return;
    }
    if (url.pathname === '/__visual-editor/edit' && req.method === 'POST') {
      const refused = rejectReason(req);
      if (refused) { sendJson(res, 403, { ok: false, error: refused }); return; }
      readBody(req, 1024 * 1024)
        .then((raw) => {
          let op;
          try { op = JSON.parse(raw); } catch { throw new Error('invalid JSON body'); }
          const file = resolveFilePath(root, op.file);
          const source = fs.readFileSync(file, 'utf8');
          const patched = patchSource(file, source, op);
          undo.push(file, source); // only reached when applyEdit succeeded
          fs.writeFileSync(file, patched, 'utf8');
          sendJson(res, 200, { ok: true });
        })
        .catch((err) => sendJson(res, 200, { ok: false, error: String(err.message || err) }));
      return;
    }
    if (url.pathname === '/__visual-editor/undo' && req.method === 'POST') {
      const refusedUndo = rejectReason(req);
      if (refusedUndo) { sendJson(res, 403, { ok: false, error: refusedUndo }); return; }
      readBody(req, 1024 * 1024)
        .then((raw) => {
          let body;
          try { body = JSON.parse(raw); } catch { throw new Error('invalid JSON body'); }
          const file = resolveFilePath(root, body.file);
          const entry = undo.pop(file);
          if (!entry) { sendJson(res, 200, { ok: false, error: 'nothing to undo' }); return; }
          fs.writeFileSync(file, entry.source, 'utf8');
          sendJson(res, 200, { ok: true, empty: entry.empty });
        })
        .catch((err) => sendJson(res, 200, { ok: false, error: String(err.message || err) }));
      return;
    }
    if (typeof next === 'function') return next();
    res.writeHead(404); res.end('not found');
  };
}

// ---------------------------------------------------------------------------
// Standalone static server with script injection
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const INJECT = '<script src="/__visual-editor/client.js"></script>';

function serveStatic(root, req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel;
  try {
    // Throws URIError on a malformed escape such as `/%` — which, uncaught in
    // a request handler, takes the whole dev server down.
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request: malformed URL');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  rel = rel.replace(/^\/+/, '');
  let abs;
  try { abs = resolveFilePath(root, rel); } catch {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html' || ext === '.htm') {
      let html = data.toString('utf8');
      const i = html.toLowerCase().lastIndexOf('</body>');
      html = i === -1 ? html + INJECT : html.slice(0, i) + INJECT + html.slice(i);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  });
}

function startServer({ root, port }) {
  const middleware = createEditorMiddleware({ root });
  const server = http.createServer((req, res) => {
    // Last-resort net: an exception thrown synchronously in a request handler
    // is an uncaught exception, which terminates the whole dev server.
    try {
      middleware(req, res, () => serveStatic(root, req, res));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[visual-dev-editor] request failed:', err && err.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('internal error');
    }
  });
  server.listen(port, () => {
    const addr = server.address();
    // eslint-disable-next-line no-console
    console.log('[visual-dev-editor] serving ' + path.resolve(root) + ' at http://localhost:' + addr.port);
    console.log('[visual-dev-editor] DEV ONLY — do not expose this server');
  });
  return server;
}

module.exports = {
  createEditorMiddleware,
  patchSource,
  startServer,
  applyEdit,
  resolveFilePath,
  createUndoTracker,
  INJECT,
};
