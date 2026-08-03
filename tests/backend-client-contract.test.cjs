const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('hosted Agensis frontend defaults API calls to the Fly backend', async () => {
  const source = await readFile(path.join(root, 'src/lib/backendClient.ts'), 'utf8');

  assert.match(source, /const HOSTED_AGENSIS_BACKEND_BASE = 'https:\/\/agensis-backend\.fly\.dev';/);
  assert.match(source, /const LOCAL_DEMO_BACKEND_BASE = 'http:\/\/127\.0\.0\.1:3142';/);
  assert.match(source, /const demo = localDemoBackendBase\(\);/);
  assert.match(source, /if \(!isLoopbackHost\(window\.location\.hostname\)\) return '';/);
  assert.match(source, /new URLSearchParams\(window\.location\.search\)\.get\('demo'\) === '1'/);
  assert.match(source, /return hostedAgensisBackendBase\(\);/);
  assert.match(source, /function hostedAgensisBackendBase\(\)/);
  assert.match(source, /host === 'agensis\.io'/);
  assert.match(source, /host === 'www\.agensis\.io'/);
  assert.match(source, /host\.endsWith\('\.netlify\.app'\)/);
});
