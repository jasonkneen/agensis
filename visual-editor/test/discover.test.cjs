'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover } = require('../src/discover.cjs');

test('discover lists separate editable HTML pages with human titles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-editor-pages-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><title>Home</title><main>Home</main></html>');
    fs.writeFileSync(path.join(root, 'work.html'), '<!doctype html><html><title>Selected Work</title><main>Work</main></html>');
    fs.writeFileSync(path.join(root, 'nested', 'about.htm'), '<html><title>About &amp; Team</title></html>');
    fs.writeFileSync(path.join(root, 'nested', 'card.html'), '<article>Reusable partial</article>');
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored.html'), '<html><title>Ignored</title></html>');

    const result = discover(root);

    assert.deepEqual(result.pages, [
      { path: 'index.html', title: 'Home' },
      { path: 'nested/about.htm', title: 'About & Team' },
      { path: 'work.html', title: 'Selected Work' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
