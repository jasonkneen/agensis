#!/usr/bin/env node
'use strict';

// Pre-flight check for extracting code out of server/index.cjs.
//
// WHY THIS EXISTS
// ---------------
// The refactor plan assumed the `__test` export block was the only coupling
// between server/index.cjs and the suite, and that re-exporting a moved symbol
// from index.cjs would keep every test green. That is true for RUNTIME imports.
//
// It is false for a second, invisible class: 22 test files read
// `server/index.cjs` off disk as a STRING and assert against its text — 195
// assertions in total. Those never touch module.exports, so the re-export
// facade cannot protect them. `tests/sandbox-agent-wiring.test.cjs` even
// asserts `function isBlockedAddress(` appears in that file EXACTLY ONCE, so
// moving the function out turns the count into 0 and fails the test.
//
// Discovering that with a red suite after a 900-line move is the expensive way
// to find out. Run this first instead:
//
//   node scripts/refactor-preflight.cjs isBlockedAddress ipv4ToInt ...
//
// It reports every source-text assertion that mentions any of the given
// symbols, so the move and the test update land in the SAME commit.
//
// PASS ROUTE PATHS TOO, NOT JUST FUNCTION NAMES. Moving a route block was the
// case this was first used wrongly on: tests/feedback.test.cjs asserts
// /app\.post\('\/backend\/feedback', requireAuth,/ against index.cjs's text, and
// checking only the handler's helper names reported CLEAN. Four tests went red.
// For a route module, run it over the URL prefix as well:
//
//   node scripts/refactor-preflight.cjs /backend/feedback feedbackRateLimiter …
//
// Matching here is plain substring, so a path works exactly like a symbol.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');

// A test file participates if it reads server/index.cjs as text at all.
const READS_INDEX = /(?:fs\.)?read[A-Za-z]*\(\s*(?:path\.(?:resolve|join)\([^)]*['"]index\.cjs['"]|['"][^'"]*server\/index\.cjs['"])/;

function collect() {
  return fs.readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.cjs'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(testsDir, name), 'utf8') }))
    .filter((f) => READS_INDEX.test(f.text));
}

function main() {
  const symbols = process.argv.slice(2).filter(Boolean);
  if (!symbols.length) {
    console.error('usage: node scripts/refactor-preflight.cjs <symbol> [symbol...]');
    console.error('       symbols are the function/const names you intend to move out of server/index.cjs');
    process.exit(2);
  }

  const files = collect();
  let hits = 0;

  for (const file of files) {
    const lines = file.text.split('\n');
    const matched = [];
    lines.forEach((line, i) => {
      // Only assertion-ish lines matter; a symbol inside a comment is noise.
      if (!/assert|\.match\(|\.includes\(|\.indexOf\(|RegExp|=~/.test(line)) return;
      for (const symbol of symbols) {
        if (line.includes(symbol)) { matched.push({ line: i + 1, text: line.trim(), symbol }); break; }
      }
    });
    if (!matched.length) continue;
    console.log(`\n${file.name}`);
    for (const m of matched) {
      hits += 1;
      console.log(`  ${String(m.line).padStart(5)}  [${m.symbol}]  ${m.text.slice(0, 120)}`);
    }
  }

  console.log(`\n${'-'.repeat(70)}`);
  if (hits === 0) {
    console.log(`CLEAN — no source-text assertion mentions ${symbols.join(', ')}.`);
    console.log('The __test re-export facade is sufficient; no test file should need editing.');
  } else {
    console.log(`${hits} source-text assertion(s) reference these symbols.`);
    console.log('Each one pins the symbol to server/index.cjs BY NAME, in that file.');
    console.log('Update them in the same commit as the move, or the suite goes red.');
  }
  console.log(`(scanned ${files.length} test files that read server/index.cjs as text)`);
}

main();
