'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const entryScript = fs.readFileSync(path.join(repoRoot, 'public/root-entry.js'), 'utf8');

function routeFor(url, entryKind) {
  const parsed = new URL(url);
  let replacement = null;
  const location = {
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    replace(value) {
      replacement = value;
    },
  };

  vm.runInNewContext(entryScript, {
    document: {
      currentScript: { dataset: { entryKind } },
    },
    URLSearchParams,
    window: { location },
  });

  return replacement;
}

test('the public origin routes an ordinary root visit to the main site', () => {
  assert.equal(routeFor('https://agensis.io/', 'landing'), null);
  assert.equal(routeFor('https://agensis.io/', 'app'), '/landing/index.html');
  assert.equal(
    routeFor('https://www.agensis.io/index.html?campaign=summer#about', 'app'),
    '/landing/index.html?campaign=summer#about',
  );
  assert.equal(routeFor('https://agensis.io/landing/index.html', 'landing'), null);
});

test('the desktop and local development entry points are never redirected', () => {
  assert.equal(routeFor('zero://app/index.html', 'app'), null);
  assert.equal(routeFor('http://127.0.0.1:5173/', 'app'), null);
});

test('known auth callbacks and app launch links enter /app with state intact', () => {
  assert.equal(
    routeFor('https://agensis.io/#access_token=abc&refresh_token=def', 'landing'),
    '/app#access_token=abc&refresh_token=def',
  );
  assert.equal(
    routeFor('https://agensis.io/landing/index.html?source=agensis-cli&intent=setup&state=xyz', 'landing'),
    '/app?source=agensis-cli&intent=setup&state=xyz',
  );
  assert.equal(
    routeFor('https://agensis.io/?invite=invite-token', 'landing'),
    '/app?invite=invite-token',
  );
});

test('both HTML entry points load the shared routing guard', () => {
  const appShell = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const landingPage = fs.readFileSync(path.join(repoRoot, 'public/landing/index.html'), 'utf8');

  assert.match(appShell, /<script src="\/root-entry\.js" data-entry-kind="app"><\/script>/);
  assert.match(landingPage, /<script src="\/root-entry\.js" data-entry-kind="landing"><\/script>/);
});

test('the service worker never substitutes the SPA shell for landing routes', () => {
  const viteConfig = fs.readFileSync(path.join(repoRoot, 'vite.config.ts'), 'utf8');

  // An allowlist, not a denylist: Workbox matches these against
  // `pathname + search`, so a denylist entry for `/` missed `/?utm_source=x`
  // and unknown paths still fell back to the SPA shell (soft-404).
  assert.ok(
    viteConfig.includes(
      'navigateFallbackAllowlist: [/^\\/app(?:\\/|$)/, /^\\/integrations(?:\\/|$)/]',
    ),
  );
  assert.ok(!viteConfig.includes('navigateFallbackDenylist'));
});

test('the public landing page keeps /app as an explicit user choice', () => {
  const landingPage = fs.readFileSync(path.join(repoRoot, 'public/landing/index.html'), 'utf8');

  assert.match(landingPage, /<a\s+href="\/app"[^>]*>Open the app<\/a>/);
});
