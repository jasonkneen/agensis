const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('hosted Agensis frontend defaults API calls to the Fly backend', async () => {
  const source = await readFile(path.join(root, 'src/lib/backendClient.ts'), 'utf8');

  assert.match(source, /const HOSTED_AGENSIS_BACKEND_BASE = 'https:\/\/agensis-backend\.fly\.dev';/);
  assert.match(source, /return hostedAgensisBackendBase\(\);/);
  assert.match(source, /function hostedAgensisBackendBase\(\)/);
  assert.match(source, /host === 'agensis\.io'/);
  assert.match(source, /host === 'www\.agensis\.io'/);
  assert.match(source, /host\.endsWith\('\.netlify\.app'\)/);
});
