#!/usr/bin/env node
'use strict';

// Mechanical half of a Wave 2 route extraction.
//
// Given a start marker and an end marker, it lifts that span out of
// server/index.cjs into a new server/<name>-routes.cjs exporting
// mount<Name>Routes(app, deps), replaces the span with the mount call, and adds
// the require. It does NOT decide the dependency list — that is
// `--analyze`, which prints the index.cjs symbols the span actually references
// so a human picks the deps and the header comment.
//
// The block keeps its existing indentation: inside createApp() it sits at one
// space, and inside mountXRoutes it sits at one space too, so a verbatim lift is
// also correctly indented. That is what makes these commits reviewable as pure
// motion — `git show` is a move, not a reformat.
//
//   node scripts/extract-routes.cjs --analyze "<startMarker>" "<endMarker>"
//   node scripts/extract-routes.cjs --apply <name> "<startMarker>" "<endMarker>" dep1,dep2,...
//
// Markers are matched as the first line CONTAINING the text (start) and the
// first line at-or-after it that EQUALS ' });' following the last route in the
// span (end, given as a line number offset or a literal to search for).

const fs = require('fs');
const path = require('path');

const INDEX = path.resolve(__dirname, '..', 'server', 'index.cjs');

function loadLines() {
  return fs.readFileSync(INDEX, 'utf8').split('\n');
}

function findSpan(lines, startMarker, endMarker) {
  const start = lines.findIndex((line) => line.includes(startMarker));
  if (start < 0) throw new Error(`start marker not found: ${startMarker}`);
  const afterStart = lines.slice(start + 1);
  const relEnd = afterStart.findIndex((line) => line.includes(endMarker));
  if (relEnd < 0) throw new Error(`end marker not found after start: ${endMarker}`);
  // The span ends on the line BEFORE the end marker, then walks back over blank
  // lines and any trailing comment block that belongs to what comes next.
  let end = start + relEnd; // inclusive index of last span line
  while (end > start && lines[end].trim() === '') end -= 1;
  return { start, end };
}

function indexSymbols(lines) {
  const whole = lines.join('\n');
  const defs = new Set();
  for (const re of [
    /^(?:async )?function ([A-Za-z_]\w*)/gm,
    /^const ([A-Za-z_]\w*)\s*=/gm,
    /^let ([A-Za-z_]\w*)/gm,
    // Nested declarations INSIDE createApp(). resolveGatewayRoute is one, and
    // missing it shipped an ai-chat extraction with an undefined reference.
    // A route block can close over anything createApp declares, not only
    // top-level names.
    /^ (?:async )?function ([A-Za-z_]\w*)/gm,
    /^ const ([A-Za-z_]\w*)\s*=/gm,
  ]) {
    let m;
    while ((m = re.exec(whole))) defs.add(m[1]);
  }
  // Destructured requires at the top of the file — BOTH shapes. The multi-line
  // form (one name per line) and the single-line form
  // `const { a, b } = require('…')`. Missing the second shape is not academic:
  // it hid assertSafeOutboundUrl from the ai-chat analysis, the extraction
  // shipped without that dep, and the gate caught it as a ReferenceError.
  // The require prologue runs past line 200 — recordAnthropicUsage sits at 203
  // and a 200-line window missed it. Scan generously; a false positive here only
  // costs a dep that turns out to be unused, which lint reports immediately.
  const head = lines.slice(0, 400).join('\n');
  let m;
  const multiLineRe = /^\s([A-Za-z_]\w*),\s*$/gm;
  while ((m = multiLineRe.exec(head))) defs.add(m[1]);
  const singleLineRe = /^const \{([^}]*)\} = require\(/gm;
  while ((m = singleLineRe.exec(head))) {
    m[1].split(',').forEach((raw) => {
      const name = raw.split(':').pop().trim();
      if (/^[A-Za-z_]\w*$/.test(name)) defs.add(name);
    });
  }
  return defs;
}

function analyze(startMarker, endMarker) {
  const lines = loadLines();
  const { start, end } = findSpan(lines, startMarker, endMarker);
  const block = lines.slice(start, end + 1).join('\n');
  const defs = indexSymbols(lines);
  const used = new Set(block.match(/\b[A-Za-z_]\w*\b/g) || []);
  const hits = [...defs].filter((name) => used.has(name)).sort();
  console.log(`span: lines ${start + 1}-${end + 1} (${end - start + 1} lines)`);
  console.log(`first: ${lines[start].trim().slice(0, 90)}`);
  console.log(`last:  ${lines[end].trim().slice(0, 90)}`);
  console.log(`\nindex.cjs symbols referenced (${hits.length}):`);
  console.log(hits.join(', '));
}

const CORE = new Set([
  'getDb', 'jsonError', 'forbidden', 'badRequest', 'requireAuth', 'requireUserOrFarm',
  'enforceWorkspaceRole', 'enforceDbOperationAccess', 'notifyDbSubscribers', 'sendWs',
  'rateLimitBlocked', 'dbRateLimitBlocked', 'clientIpFromReq', 'parseJsonObject',
  'parseJsonArray', 'slugHandle', 'textFromValue', 'isAgentEnabled',
]);

function pascal(name) {
  return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function apply(name, startMarker, endMarker, depList) {
  const lines = loadLines();
  const { start, end } = findSpan(lines, startMarker, endMarker);
  const block = lines.slice(start, end + 1);
  const deps = depList.split(',').map((d) => d.trim()).filter(Boolean);
  const extras = deps.filter((d) => !CORE.has(d));
  const fnName = `mount${pascal(name)}Routes`;

  const modulePath = path.resolve(__dirname, '..', 'server', `${name}-routes.cjs`);
  const header = [
    "'use strict';",
    '',
    `// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs`,
    `// reduction). Mounted once by index.cjs; every dependency is INJECTED rather`,
    `// than imported, so the auth, RBAC and rate-limit contract stays single-sourced`,
    `// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.`,
    '//',
    `// TODO(header): replace this paragraph with what this surface actually is.`,
    '',
    `function ${fnName}(app, deps = {}) {`,
    ' const {',
    ...chunk(deps).map((line) => `  ${line}`),
    ' } = deps;',
    '',
  ];
  const footer = ['}', '', `module.exports = { ${fnName} };`, ''];
  fs.writeFileSync(modulePath, header.concat(block, footer).join('\n'));

  const mountCall = extras.length
    ? [` ${fnName}(app, { ...coreDeps(), ${extras.join(', ')} });`]
    : [` ${fnName}(app, coreDeps());`];
  const next = lines.slice(0, start).concat(mountCall, lines.slice(end + 1));

  // Insert the require after the last existing ./*-routes.cjs require, or after
  // the net-guard require if this is the first one.
  const anchor = next.reduce(
    (acc, line, i) => (/^const \{ mount\w+Routes \} = require\('\.\/[\w-]+\.cjs'\);$/.test(line) ? i : acc),
    next.findIndex((line) => line.includes("require('./lib/net-guard.cjs')")),
  );
  next.splice(anchor + 1, 0, `const { ${fnName} } = require('./${name}-routes.cjs');`);

  fs.writeFileSync(INDEX, next.join('\n'));
  console.log(`extracted ${end - start + 1} lines -> server/${name}-routes.cjs`);
  console.log(`mount: ${mountCall[0].trim()}`);
}

function chunk(deps, width = 74) {
  const out = [];
  let line = '';
  for (const dep of deps) {
    const piece = `${dep},`;
    if (line && (line.length + piece.length + 1) > width) { out.push(line); line = ''; }
    line = line ? `${line} ${piece}` : piece;
  }
  if (line) out.push(line);
  return out;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === '--analyze') analyze(rest[0], rest[1]);
else if (mode === '--apply') apply(rest[0], rest[1], rest[2], rest[3] || '');
else {
  console.error('usage: --analyze "<start>" "<end>"   |   --apply <name> "<start>" "<end>" dep1,dep2');
  process.exit(2);
}
