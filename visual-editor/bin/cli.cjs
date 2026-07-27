#!/usr/bin/env node
'use strict';
/**
 * visual-dev-editor <root-dir> [--port N]
 *
 * Serves the static site at <root-dir> on http://localhost:N (default 4399)
 * with the visual editor injected into every HTML page.
 * DEV ONLY — never expose this server to a network.
 */
const fs = require('fs');
const path = require('path');
const { startServer } = require('../src/server.cjs');

const args = process.argv.slice(2);
let root = null;
let port = 4399;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') {
    port = parseInt(args[++i], 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      console.error('invalid --port value');
      process.exit(1);
    }
  } else if (args[i] === '-h' || args[i] === '--help') {
    console.log('usage: visual-dev-editor <root-dir> [--port N]');
    process.exit(0);
  } else if (!root) {
    root = args[i];
  } else {
    console.error('unexpected argument: ' + args[i]);
    process.exit(1);
  }
}

if (!root) {
  console.error('usage: visual-dev-editor <root-dir> [--port N]');
  process.exit(1);
}

// Fail loudly on a typo'd root rather than serving 404s from an empty tree.
const absRoot = path.resolve(root);
let rootStat;
try {
  rootStat = fs.statSync(absRoot);
} catch {
  console.error('no such directory: ' + absRoot);
  process.exit(1);
}
if (!rootStat.isDirectory()) {
  console.error('not a directory: ' + absRoot);
  process.exit(1);
}

startServer({ root: absRoot, port });
