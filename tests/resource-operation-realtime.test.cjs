'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealtime } = require('../server/realtime.cjs');

function forbidden(message) {
 const error = new Error(message);
 error.status = 403;
 return error;
}

function realtimeWithResourceAuthorizer(calls) {
 return createRealtime({
  forbidden,
  authorizeResourceOperationRealtime: async (...args) => calls.push(args),
 });
}

test('resource-operation progress subscriptions use the dedicated operation audience check', async () => {
 const calls = [];
 const realtime = realtimeWithResourceAuthorizer(calls);
 await realtime.authorizeRealtimeBinding(
  'user-1',
  'resource-operation:workspace-1:operation-1',
  {
   type: 'broadcast',
   channel: 'resource-operation:workspace-1:operation-1',
   event: 'progress',
  },
 );
 assert.deepEqual(calls, [['user-1', 'workspace-1', 'operation-1']]);
});

test('clients cannot publish resource-operation progress frames', async () => {
 const realtime = realtimeWithResourceAuthorizer([]);
 await assert.rejects(
  () => realtime.authorizeRealtimeBroadcast('user-1', 'resource-operation:workspace-1:operation-1'),
  { status: 403, message: 'Resource operation progress is server-only' },
 );
});
