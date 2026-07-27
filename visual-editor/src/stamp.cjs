'use strict';
/**
 * Build-time source stamping for JSX/TSX.
 *
 * Adds `data-ve-loc="file:line:col"` to every intrinsic JSX element, so the
 * running DOM can say exactly which source node produced it.
 *
 * Why this exists: element paths work for HTML because the DOM and the file are
 * the same tree. In JSX they are not. One `{items.map(...)}` yields N DOM nodes
 * from one source node; a file holds several components; a conditional means
 * the DOM cannot tell you which branch ran. Deriving a path positionally from
 * the DOM would therefore be a guess, and a wrong guess corrupts a real file.
 * A stamp turns the guess into a fact.
 *
 * It also gives dynamic content away for free: if two DOM elements carry the
 * SAME stamp, they were rendered from one source node in a loop, and the editor
 * can refuse structural edits on them instead of mangling the template.
 *
 * Deliberately a string transform rather than a Babel plugin: it only needs to
 * insert an attribute after a tag name, the parser is already an optional
 * dependency, and staying off @babel/traverse / @babel/generator keeps a
 * drop-in tool from dragging in a toolchain. Nothing is reprinted — the source
 * is spliced, so line and column numbers stay true to the file on disk.
 */

const path = require('path');
const jsx = require('./locators/jsx.cjs');

const ATTR = 'data-ve-loc';

/** Elements whose props are not DOM attributes, so a stamp would be a prop. */
function isIntrinsic(name) {
  return !!name && /^[a-z]/.test(name) && !name.includes('.');
}

/**
 * Insert the stamp attribute into every intrinsic element of `source`.
 * Splices from the end backwards so earlier offsets stay valid.
 */
function stampSource(source, fileId) {
  if (!jsx.isAvailable()) return source;
  if (source.indexOf('<') === -1) return source;

  let doc;
  try {
    doc = jsx.parse(source);
  } catch {
    return source; // not parseable as JSX — leave it exactly as it was
  }

  const edits = [];
  for (const rec of doc.elements) {
    const name = jsx.openingName(rec.node);
    if (!isIntrinsic(name)) continue;
    // Never stamp twice.
    if (jsx.attr(rec, ATTR)) continue;
    const at = jsx.attrInsertPos(rec);
    if (at == null) continue;
    const open = rec.node.openingElement;
    const loc = open && open.loc && open.loc.start;
    if (!loc) continue;
    edits.push({ at, text: ' ' + ATTR + '="' + fileId + ':' + loc.line + ':' + loc.column + '"' });
  }
  if (!edits.length) return source;

  edits.sort((a, b) => b.at - a.at);
  let out = source;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

/** Parse a stamp back into its parts. */
function parseStamp(value) {
  if (typeof value !== 'string') return null;
  const m = /^(.*):(\d+):(\d+)$/.exec(value);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
}

/**
 * Vite plugin. Registered as a `transform`, and only in serve mode, so a
 * production build never carries the stamps.
 *
 *   import { visualEditorStamp } from 'visual-dev-editor/stamp'
 *   plugins: [react(), visualEditorStamp()]
 */
function visualEditorStamp(options = {}) {
  const root = options.root ? path.resolve(options.root) : process.cwd();
  const include = options.include || /\.(jsx|tsx)$/;
  let isServe = true;
  return {
    name: 'visual-editor-stamp',
    enforce: 'pre', // run before the React transform rewrites JSX away
    configResolved(config) {
      isServe = !config || config.command === 'serve';
    },
    transform(code, id) {
      if (!isServe) return null;
      const clean = id.split('?')[0];
      if (!include.test(clean)) return null;
      if (clean.includes('node_modules')) return null;
      const rel = path.relative(root, clean) || path.basename(clean);
      const out = stampSource(code, rel.split(path.sep).join('/'));
      return out === code ? null : { code: out, map: null };
    },
  };
}

module.exports = { ATTR, stampSource, parseStamp, visualEditorStamp, isIntrinsic };
