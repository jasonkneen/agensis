'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function output(t, redirects) {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-routing-'));
 t.after(() => fs.rm(dir, { recursive: true, force: true }));
 await fs.writeFile(path.join(dir, 'index.html'), '<div id="root"></div>');
 if (redirects !== null) await fs.writeFile(path.join(dir, '_redirects'), redirects);
 return dir;
}

test('the generated fallback cannot shadow app and API rewrites after a build', async t => {
 const { finalizeStaticRouting } = await import('../scripts/finalize-static-routing.mjs');
 const dir = await output(t, '/* /404.html 404\n');
 await finalizeStaticRouting(dir);
 await assert.rejects(fs.readFile(path.join(dir, '_redirects')), { code: 'ENOENT' });
 await finalizeStaticRouting(dir); // repeated finalization is harmless
});
test('unfamiliar generated routes fail the build instead of being silently deleted', async t => {
 const { finalizeStaticRouting } = await import('../scripts/finalize-static-routing.mjs');
 const rules = '/custom /another 301\n/* /404.html 404';
 const dir = await output(t, rules);
 await assert.rejects(finalizeStaticRouting(dir), /Unexpected generated _redirects/);
 assert.equal(await fs.readFile(path.join(dir, '_redirects'), 'utf8'), rules);
});
test('the production build runs the routing finalizer after Nitro finishes', async () => {
 const pkg = require('../package.json');
 assert.match(pkg.scripts.build, /vite build && node scripts\/finalize-static-routing\.mjs$/);
 const config = await fs.readFile(path.join(__dirname, '../netlify.toml'), 'utf8');
 for (const route of ['/app', '/integrations/*', '/join/*']) {
  const routeAt = config.indexOf(`from = "${route}"`);
  assert.ok(routeAt >= 0 && routeAt < config.indexOf('from = "/*"'), `${route} precedes the fallback`);
 }
});
