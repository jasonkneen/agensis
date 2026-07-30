'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFarmIntegrationCore,
  createMemoryFarmIntegrationStore,
} = require('../server/farm-integration.cjs');

test('device pairing approves one workspace and exchanges the device secret once', async () => {
  const store = createMemoryFarmIntegrationStore();
  let now = 1_000_000;
  let sequence = 0;
  const core = createFarmIntegrationCore({
    store,
    now: () => now,
    secret: (prefix) => `${prefix}_${++sequence}`,
    userCode: () => 'FARM-ABCD',
  });

  const started = await core.start({ name: 'Jason laptop' });
  assert.equal(started.userCode, 'FARM-ABCD');
  assert.equal(started.status, 'pending');
  assert.equal(started.interval, 5);

  await assert.rejects(() => core.exchange(started.deviceCode), (error) => error.code === 'authorization_pending');
  await core.approve({
    userCode: started.userCode,
    workspaceId: 'workspace-1',
    approvedBy: 'user-1',
    scopes: ['agents:read', 'agents:enroll', 'models:read', 'models:invoke', 'not:allowed'],
  });

  const exchanged = await core.exchange(started.deviceCode);
  assert.match(exchanged.token, /^agf_/);
  assert.equal(exchanged.workspaceId, 'workspace-1');
  assert.deepEqual(exchanged.scopes, ['agents:read', 'agents:enroll', 'models:read', 'models:invoke']);
  await assert.rejects(() => core.exchange(started.deviceCode), (error) => error.code === 'expired_token');

  const auth = await core.authenticate(exchanged.token, 'models:invoke');
  assert.equal(auth.workspaceId, 'workspace-1');
  await assert.rejects(() => core.authenticate(exchanged.token, 'agents:dispatch'), (error) => error.code === 'insufficient_scope');

  now += 60_000;
  assert.equal((await store.listIntegrations()).length, 1);
});

test('expired and denied device requests never mint an integration token', async () => {
  const store = createMemoryFarmIntegrationStore();
  let now = 10_000;
  let sequence = 0;
  const core = createFarmIntegrationCore({ store, now: () => now, secret: (prefix) => `${prefix}_${++sequence}`, userCode: () => now < 15_000 ? 'FARM-ZZZZ' : 'FARM-YYYY', ttlMs: 1000 });
  const expired = await core.start({ name: 'Expired' });
  now += 1001;
  await assert.rejects(() => core.exchange(expired.deviceCode), (error) => error.code === 'expired_token');

  now = 20_000;
  const denied = await core.start({ name: 'Denied' });
  await core.deny({ userCode: denied.userCode, deniedBy: 'user-1' });
  await assert.rejects(() => core.exchange(denied.deviceCode), (error) => error.code === 'access_denied');
});

test('revoking an integration invalidates its token', async () => {
  const store = createMemoryFarmIntegrationStore();
  let sequence = 0;
  const core = createFarmIntegrationCore({ store, secret: (prefix) => `${prefix}_${++sequence}`, userCode: () => 'FARM-RRRR' });
  const started = await core.start({ name: 'Farm' });
  await core.approve({ userCode: started.userCode, workspaceId: 'workspace-1', approvedBy: 'user-1' });
  const exchanged = await core.exchange(started.deviceCode);
  await core.revoke(exchanged.integrationId);
  await assert.rejects(() => core.authenticate(exchanged.token), (error) => error.code === 'invalid_token');
});

test('concurrent exchanges consume an approved device code exactly once', async () => {
  const store = createMemoryFarmIntegrationStore();
  let sequence = 0;
  const core = createFarmIntegrationCore({ store, secret: (prefix) => `${prefix}_${++sequence}`, userCode: () => 'FARM-ONCE' });
  const started = await core.start({ name: 'Farm' });
  await core.approve({ userCode: started.userCode, workspaceId: 'workspace-1', approvedBy: 'user-1' });

  const results = await Promise.allSettled([core.exchange(started.deviceCode), core.exchange(started.deviceCode)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await store.listIntegrations()).length, 1);
});

test('starting a new device flow prunes requests beyond the retention window', async () => {
  const store = createMemoryFarmIntegrationStore();
  let now = 1_000;
  let sequence = 0;
  const core = createFarmIntegrationCore({
    store,
    now: () => now,
    secret: (prefix) => `${prefix}_${++sequence}`,
    userCode: () => `FARM-${sequence}`,
    ttlMs: 100,
    deviceRetentionMs: 1_000,
  });
  await core.start({ name: 'Old' });
  assert.equal(store.deviceCount(), 1);
  now = 2_101;
  await core.start({ name: 'New' });
  assert.equal(store.deviceCount(), 1);
});

test('an explicit empty scope request stays least-privilege', async () => {
  const store = createMemoryFarmIntegrationStore();
  let sequence = 0;
  const core = createFarmIntegrationCore({ store, secret: (prefix) => `${prefix}_${++sequence}`, userCode: () => 'FARM-NONE' });
  const started = await core.start();
  await core.approve({ userCode: started.userCode, workspaceId: 'workspace-1', approvedBy: 'user-1', scopes: [] });
  const integration = await core.exchange(started.deviceCode);
  assert.deepEqual(integration.scopes, []);
  await assert.rejects(() => core.authenticate(integration.token, 'workspace:read'), (error) => error.code === 'insufficient_scope');
});
