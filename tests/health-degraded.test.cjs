'use strict';

// A failed non-fatal boot migration (the one-active-job unique index) must be
// visible on /backend/health as `degraded` detail without taking the instance
// out of rotation: still HTTP 200, still ok:true.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mountHealthRoutes } = require('../server/health-routes.cjs');

async function probe(deps) {
  const app = express();
  mountHealthRoutes(app, {
    jsonError: (res, status, error) => res.status(status).json({ error: error.message }),
    getDb: () => ({ unsafe: async () => [{}] }),
    getRuntimeSchemaError: () => null,
    ...deps,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/backend/health`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('health stays 200 and ok but reports degraded detail', async () => {
  const { status, body } = await probe({ getDegradedDetails: () => ({ agentJobsActiveIndex: 'deadlock detected' }) });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.degraded, { agentJobsActiveIndex: 'deadlock detected' });
});

test('a clean boot reports exactly { ok: true }, and an absent getter is tolerated', async () => {
  assert.deepEqual((await probe({ getDegradedDetails: () => ({}) })).body, { ok: true });
  assert.deepEqual((await probe({})).body, { ok: true });
});
