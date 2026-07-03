'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function collectTourSelectors(manifest) {
  const selectors = [];
  if (Array.isArray(manifest.tour)) {
    selectors.push(...manifest.tour.map(step => step.selector).filter(Boolean));
  }
  if (manifest.pages && typeof manifest.pages === 'object') {
    for (const page of Object.values(manifest.pages)) {
      if (Array.isArray(page?.tour)) {
        selectors.push(...page.tour.map(step => step.selector).filter(Boolean));
      }
    }
  }
  return selectors;
}

function assertManifestShape(manifest) {
  assert.equal(typeof manifest.name, 'string');
  assert.equal(typeof manifest.summary, 'string');
  assert.equal(manifest.appearance?.activation, 'hover');
  assert.ok(Array.isArray(manifest.actions));
  assert.ok(manifest.actions.some(action => action.tour === true));
  assert.ok(Array.isArray(manifest.tour));
  assert.ok(manifest.pages && typeof manifest.pages === 'object');
  assert.ok(manifest.pages['/']);
}

function assertRelativeActionHrefs(manifest) {
  const actions = [
    ...(Array.isArray(manifest.actions) ? manifest.actions : []),
    ...Object.values(manifest.pages || {}).flatMap(page => Array.isArray(page?.actions) ? page.actions : []),
  ];
  for (const action of actions) {
    if (action.href) {
      assert.match(action.href, /^\/(?!\/)/, `${action.href} should be same-origin relative`);
    }
  }
}

test('root app CursorBuddy manifest is available at Vite public well-known path', () => {
  const manifest = readJson('public/.well-known/cursorbuddy.json');
  assertManifestShape(manifest);
  assertRelativeActionHrefs(manifest);

  assert.equal(manifest.name, 'agensis');
  assert.match(manifest.summary, /realtime collaborative workspace/i);
  assert.ok(manifest.important.some(line => /AI Agents/i.test(line)));
  assert.ok(manifest.avoid.some(line => /builder or live-agent/i.test(line)));
});

test('root app CursorBuddy tour selectors are backed by source selectors', () => {
  const manifest = readJson('public/.well-known/cursorbuddy.json');
  const source = [
    readText('src/App.tsx'),
    readText('src/components/home/HomeCanvas.tsx'),
    readText('src/components/layout/Sidebar.tsx'),
    readText('src/components/windows/AgentsWindowContent.tsx'),
  ].join('\n');

  const selectorNeedles = new Map([
    ['main', '<main'],
    ['[data-sidebar-panel]', 'data-sidebar-panel'],
    ['.home-workspace-composer', 'home-workspace-composer'],
    ['[data-workspace-viewport]', 'data-workspace-viewport'],
    ['.workspace-window-dock', 'workspace-window-dock'],
    ['.workspace-bottom-controls', 'workspace-bottom-controls'],
    ['.agents-window-body', 'agents-window-body'],
  ]);

  for (const selector of collectTourSelectors(manifest)) {
    const needle = selectorNeedles.get(selector);
    assert.ok(needle, `missing selector contract for ${selector}`);
    assert.ok(source.includes(needle), `${selector} should exist in root app source`);
  }
});

test('landing CursorBuddy manifest describes visible marketing sections', () => {
  const manifest = readJson('landing/public/.well-known/cursorbuddy.json');
  assertManifestShape(manifest);
  assertRelativeActionHrefs(manifest);

  assert.equal(manifest.name, 'agensis landing');
  assert.ok(manifest.important.some(line => /Pricing/i.test(line)));
  assert.ok(manifest.important.some(line => /waitlist/i.test(line)));
  assert.ok(manifest.avoid.some(line => /contact form/i.test(line)));
});

test('landing CursorBuddy tour selectors are backed by landing source selectors', () => {
  const manifest = readJson('landing/public/.well-known/cursorbuddy.json');
  const source = readText('landing/src/App.tsx');
  const selectorNeedles = new Map([
    ['header', '<header'],
    ['section.relative.overflow-hidden', 'relative overflow-hidden'],
    ['#features', 'id="features"'],
    ['#teams', 'id="teams"'],
    ['#pricing', 'id="pricing"'],
    ['footer', '<footer'],
  ]);

  for (const selector of collectTourSelectors(manifest)) {
    const needle = selectorNeedles.get(selector);
    assert.ok(needle, `missing selector contract for ${selector}`);
    assert.ok(source.includes(needle), `${selector} should exist in landing source`);
  }
});
