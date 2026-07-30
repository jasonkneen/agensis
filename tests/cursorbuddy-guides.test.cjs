'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const guides = require('../shared/cursorbuddy-guides.cjs');
const { ALLOWED_TABLES } = require('../shared/backend-core.cjs');
const { mountCursorbuddyRoutes } = require('../server/cursorbuddy-routes.cjs');
const { mountTenantsRoutes } = require('../server/tenants-routes.cjs');

const repoRoot = path.resolve(__dirname, '..');

function sample(overrides = {}) {
  return {
    site_url: 'https://docs.example.com/getting-started',
    path_pattern: '/getting-started*',
    manifest: {
      name: 'Example docs',
      summary: 'Help people get from the docs to their first working project.',
      appearance: { activation: 'immediate', greeting: 'Need a hand?' },
      skills: ['Explain this page'],
      important: ['Start with the install command'],
      avoid: ['Do not invent credentials'],
      actions: [{ label: 'Open setup', href: '/getting-started' }],
      tour: [{ selector: 'main h1', text: 'Start here', pad: 8 }],
      pages: {
        '/getting-started': {
          skills: ['Explain setup'],
          tour: [{ selector: '#install', text: 'Copy this command' }],
        },
      },
      apiKey: 'must-not-survive',
      provider: { token: 'must-not-survive' },
    },
    ...overrides,
  };
}

test('normalizes a portable v1 guide and drops credentials and unsupported fields', () => {
  const input = guides.normalizeGuideInput(sample({
    site_url: 'https://docs.example.com/getting-started?invite=must-not-survive#install',
  }));
  assert.equal(input.host, 'docs.example.com');
  assert.equal(input.siteUrl, 'https://docs.example.com/getting-started');
  assert.equal(input.pathPattern, '/getting-started*');
  assert.equal(input.manifest.$schema, 'https://cursorbuddy.app/cursorbuddy-guide.schema.json');
  assert.equal(input.manifest.version, '1.0');
  assert.deepEqual(input.manifest.match, {
    hosts: ['docs.example.com'],
    paths: ['/getting-started*'],
  });
  const serialized = JSON.stringify(input.manifest);
  assert.ok(!serialized.includes('must-not-survive'));
  assert.ok(!serialized.includes('apiKey'));
  assert.ok(!serialized.includes('provider'));
  assert.equal(input.manifest.actions[0].href, '/getting-started');
});

test('rejects cross-origin actions and malformed match patterns', () => {
  const input = guides.normalizeGuideInput(sample({
    manifest: {
      name: 'Safe guide',
      actions: [
        { label: 'External', href: 'https://evil.example' },
        { label: 'Protocol relative', href: '//evil.example' },
        { label: 'Internal', href: '/safe' },
      ],
    },
  }));
  assert.deepEqual(input.manifest.actions, [{ label: 'Internal', href: '/safe' }]);
  assert.throws(
    () => guides.normalizeGuideInput(sample({ path_pattern: '/docs/*/secret' })),
    /trailing \* only/,
  );
});

test('published guide resolution uses exact hosts and the most specific matching path', async () => {
  const rows = [
    { id: 'root', host: 'docs.example.com', path_pattern: '/*', review_status: 'approved', manifest: { name: 'Root' } },
    { id: 'docs', host: 'docs.example.com', path_pattern: '/getting-started*', review_status: 'approved', manifest: { name: 'Docs' } },
  ];
  const db = async (sql, params) => {
    assert.match(sql, /review_status = 'approved' and host = \$1/);
    assert.deepEqual(params, ['docs.example.com']);
    return rows;
  };
  const resolved = await guides.resolveCommunityGuide(
    db,
    'https://docs.example.com/getting-started/install?token=not-used-for-matching',
  );
  assert.equal(resolved.id, 'docs');
  assert.equal(resolved.manifest.name, 'Docs');
});

test('local and private guides can be saved but cannot be submitted publicly', async () => {
  const db = async (sql) => {
    if (sql.startsWith('select host')) return [{ host: 'localhost' }];
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  await assert.rejects(
    guides.submitOwnedGuide(db, 'user-1', 'guide-1'),
    /cannot be submitted publicly/,
  );
});

test('admin review only publishes pending guides and public lists omit manifests', async () => {
  let reviewParams;
  const reviewed = await guides.reviewGuideSubmission(async (sql, params) => {
    assert.match(sql, /where id = \$1 and review_status = 'pending'/);
    reviewParams = params;
    return [{
      id: 'guide-1',
      host: 'docs.example.com',
      path_pattern: '/*',
      name: 'Docs',
      review_status: 'approved',
      manifest: { name: 'Docs' },
    }];
  }, 'guide-1', 'owner-1', { decision: 'approved', notes: 'Checked' });
  assert.deepEqual(reviewParams, ['guide-1', 'owner-1', 'approved', 'Checked']);
  assert.equal(reviewed.review_status, 'approved');

  const community = await guides.listCommunityGuides(async () => [{
    id: 'guide-1',
    host: 'docs.example.com',
    path_pattern: '/*',
    name: 'Docs',
    review_status: 'approved',
    manifest: { private: 'not in catalogue' },
    review_notes: 'not in public catalogue',
  }]);
  assert.equal(community[0].manifest, undefined);
  assert.equal(community[0].review_notes, undefined);
});

test('guide schema and dedicated routes are mirrored across both backend lanes', () => {
  assert.equal(
    ALLOWED_TABLES.has('cursorbuddy_guides'),
    false,
    'guide ownership and moderation must not be exposed through generic DB routes',
  );

  const runtime = fs.readFileSync(path.join(repoRoot, 'server/index.cjs'), 'utf8');
  const canonical = fs.readFileSync(path.join(repoRoot, 'database/neon-schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(repoRoot, 'supabase/migrations/20260730200000_cursorbuddy_guides.sql'),
    'utf8',
  );
  for (const source of [runtime, canonical, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS cursorbuddy_guides/i);
    assert.match(source, /review_status IN \('draft', 'pending', 'approved', 'rejected'\)/i);
  }

  const expressRoutes = fs.readFileSync(path.join(repoRoot, 'server/cursorbuddy-routes.cjs'), 'utf8');
  const tenantRoutes = fs.readFileSync(path.join(repoRoot, 'server/tenants-routes.cjs'), 'utf8');
  const netlify = fs.readFileSync(path.join(repoRoot, 'netlify/functions/backend.mjs'), 'utf8');
  for (const source of [expressRoutes, netlify]) {
    assert.match(source, /\/backend\/cursorbuddy\/guides\/resolve/);
    assert.match(source, /\/backend\/cursorbuddy\/guides\/community/);
    assert.match(source, /submitOwnedGuide/);
  }
  for (const source of [tenantRoutes, netlify]) {
    assert.match(source, /\/backend\/tenants\/guide-submissions/);
    assert.match(source, /assertSystemOwner/);
    assert.match(source, /reviewGuideSubmission/);
  }
});

function routeRegistry() {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (pathname, ...handlers) => routes.set(`${method.toUpperCase()} ${pathname}`, handlers);
  }
  return { app, routes };
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('Express personal guide routes all require authentication and resolver stays public', async () => {
  const { app, routes } = routeRegistry();
  const requireAuth = () => {};
  mountCursorbuddyRoutes(app, {
    requireAuth,
    dbRateLimitBlocked: async () => false,
    clientIpFromReq: () => '127.0.0.1',
    cursorBuddyGuidesRateLimiter: {},
    cursorBuddyGuidesDbRateLimiter: {},
    dbQuery: async () => [],
    listCommunityGuides: async () => [],
    resolveCommunityGuide: async (_db, url) => ({ id: 'resolved', site_url: url }),
    listOwnedGuides: async () => [],
    createOwnedGuide: async () => ({}),
    updateOwnedGuide: async () => ({}),
    deleteOwnedGuide: async () => ({}),
    submitOwnedGuide: async () => ({}),
    jsonError: (res, status, error) => res.status(status).json({ error: error.message }),
  });

  for (const key of [
    'GET /backend/cursorbuddy/guides',
    'POST /backend/cursorbuddy/guides',
    'PATCH /backend/cursorbuddy/guides/:id',
    'DELETE /backend/cursorbuddy/guides/:id',
    'POST /backend/cursorbuddy/guides/:id/submit',
  ]) {
    assert.equal(routes.get(key)[0], requireAuth, `${key} must start with requireAuth`);
  }
  const publicHandlers = routes.get('GET /backend/cursorbuddy/guides/resolve');
  assert.notEqual(publicHandlers[0], requireAuth);
  const res = responseRecorder();
  await publicHandlers.at(-1)({ query: { url: 'https://docs.example.com/start' } }, res);
  assert.equal(res.body.data.id, 'resolved');
  assert.match(res.headers['Cache-Control'], /public/);
});

test('Express guide review routes enforce the system-owner gate before data access', async () => {
  const { app, routes } = routeRegistry();
  const requireAuth = () => {};
  const calls = [];
  mountTenantsRoutes(app, {
    requireAuth,
    dbRateLimitBlocked: async () => false,
    clientIpFromReq: () => '127.0.0.1',
    tenantsRateLimiter: {},
    tenantsDbRateLimiter: {},
    dbQuery: async () => [],
    assertSystemOwner: async ({ userId }) => { calls.push(`owner:${userId}`); return userId; },
    listGuideSubmissions: async () => { calls.push('list'); return []; },
    reviewGuideSubmission: async (_db, id, reviewerId) => {
      calls.push(`review:${id}:${reviewerId}`);
      return { id, review_status: 'approved' };
    },
    jsonError: (res, status, error) => res.status(status).json({ error: error.message }),
  });

  const listHandlers = routes.get('GET /backend/tenants/guide-submissions');
  assert.equal(listHandlers[0], requireAuth);
  await listHandlers.at(-1)({ userId: 'owner-1' }, responseRecorder());
  assert.deepEqual(calls, ['owner:owner-1', 'list']);

  calls.length = 0;
  const reviewHandlers = routes.get('POST /backend/tenants/guide-submissions/:id/review');
  assert.equal(reviewHandlers[0], requireAuth);
  const res = responseRecorder();
  await reviewHandlers.at(-1)({
    userId: 'owner-1',
    params: { id: 'guide-1' },
    body: { decision: 'approved' },
  }, res);
  assert.deepEqual(calls, ['owner:owner-1', 'review:guide-1:owner-1']);
  assert.equal(res.body.data.review_status, 'approved');
});
