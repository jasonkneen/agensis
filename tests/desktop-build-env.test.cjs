'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('desktop builds default Zig global cache to the ignored writable build tree', async () => {
  const { resolveZigGlobalCacheDir } = await import('../scripts/desktop-build-env.mjs');
  const desktopDir = path.join(path.sep, 'workspace', 'desktop');

  assert.equal(
    resolveZigGlobalCacheDir(desktopDir, {}),
    path.join(desktopDir, '.zig-cache', 'global'),
  );
});

test('desktop builds respect an explicit Zig global cache override', async () => {
  const { resolveZigGlobalCacheDir } = await import('../scripts/desktop-build-env.mjs');

  assert.equal(
    resolveZigGlobalCacheDir('/workspace/desktop', { ZIG_GLOBAL_CACHE_DIR: '/tmp/custom-zig-cache' }),
    '/tmp/custom-zig-cache',
  );
});
