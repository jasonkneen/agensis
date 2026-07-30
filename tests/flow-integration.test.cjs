'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertConnectionChannel,
  connectionCanUseTool,
  createFlowConnectionCore,
  createMemoryFlowConnectionStore,
  flowWebhookRetryDecision,
  normalizeFlowWebhookUrl,
  signFlowWebhook,
  verifyFlowWebhook,
} = require('../server/flow-integration.cjs');

test('channel connections are revocable, scoped identities', async () => {
  const store = createMemoryFlowConnectionStore();
  const core = createFlowConnectionCore({ store, now: () => 1234, secret: prefix => `${prefix}_test` });
  const created = await core.create({ workspaceId: 'workspace-1', channelId: 'channel-1', name: 'Flows' });
  const identity = await core.authenticate(created.token);

  assert.equal(identity.kind, 'integration');
  assert.equal(identity.workspaceId, 'workspace-1');
  assert.equal(identity.channelId, 'channel-1');
  assert.equal(connectionCanUseTool(identity, 'read_channel'), true);
  assert.equal(connectionCanUseTool(identity, 'read_doc'), false);
  assert.doesNotThrow(() => assertConnectionChannel(identity, 'channel-1'));
  assert.throws(() => assertConnectionChannel(identity, 'channel-2'), /limited to a different channel/);

  await core.revoke(identity.connectionId);
  await assert.rejects(() => core.authenticate(created.token), /Invalid Flows connection token/);
});

test('workspace connections expose workspace capabilities without a channel restriction', async () => {
  const core = createFlowConnectionCore({
    store: createMemoryFlowConnectionStore(),
    secret: prefix => `${prefix}_workspace`,
  });
  const created = await core.create({ workspaceId: 'workspace-1' });
  const identity = await core.authenticate(created.token);

  assert.equal(identity.channelId, null);
  assert.equal(connectionCanUseTool(identity, 'read_doc'), true);
  assert.equal(connectionCanUseTool(identity, 'write_doc'), true);
  assert.doesNotThrow(() => assertConnectionChannel(identity, 'any-channel'));
});

test('Flows webhook signatures bind the timestamp and exact request bytes', () => {
  const input = { secret: 'ags_secret', timestamp: '1720890000', body: '{"event":"message.created"}' };
  const signature = signFlowWebhook(input);

  assert.equal(verifyFlowWebhook({ ...input, signature }), true);
  assert.equal(verifyFlowWebhook({ ...input, body: `${input.body} `, signature }), false);
  assert.equal(verifyFlowWebhook({ ...input, timestamp: '1720890001', signature }), false);
});

test('Flows webhook URLs require a public HTTPS host outside local development', () => {
  assert.equal(
    normalizeFlowWebhookUrl('https://flows.example.test/events', { production: true }),
    'https://flows.example.test/events',
  );
  assert.equal(
    normalizeFlowWebhookUrl('http://127.0.0.1:3000/events', { production: false }),
    'http://127.0.0.1:3000/events',
  );
  assert.throws(
    () => normalizeFlowWebhookUrl('http://127.0.0.1:3000/events', { production: true }),
    /Loopback/,
  );
  assert.throws(
    () => normalizeFlowWebhookUrl('https://10.0.0.2/events', { production: true }),
    /public hostname/,
  );
});

test('webhook retry decisions retry transient failures and dead-letter permanent failures', () => {
  assert.deepEqual(flowWebhookRetryDecision({ httpStatus: 503, attempts: 2 }), {
    retryable: true,
    dead: false,
    delaySeconds: 4,
  });
  assert.equal(flowWebhookRetryDecision({ httpStatus: 400, attempts: 1 }).dead, true);
  assert.equal(flowWebhookRetryDecision({ httpStatus: null, attempts: 8 }).dead, true);
});
