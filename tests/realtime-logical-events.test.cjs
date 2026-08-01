'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRealtime } = require('../server/realtime.cjs');

function messageRow(content) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    role: 'assistant',
    sender_kind: 'agent',
    sender_id: '33333333-3333-4333-8333-333333333333',
    sender_name: 'Coder',
    content,
  };
}

test('provisional realtime state is transport-only and finalized state is one logical create', async () => {
  const flows = [];
  const automations = [];
  const activities = [];
  const realtime = createRealtime({
    enqueueFlowWebhookEvents: async (table, eventType, rows) => {
      flows.push({ table, eventType, content: rows[0]?.content });
    },
    enqueueAutomationRuns: async (table, eventType, rows) => {
      automations.push({ table, eventType, content: rows[0]?.content });
      return [];
    },
    logMessageActivity: async (rows) => {
      activities.push(rows[0]?.content);
    },
    resolveSessionActivityContext: async () => null,
  });

  realtime.notifyDbSubscribers(
    'messages',
    'INSERT',
    [messageRow('Thinking …')],
    { suppressMessageActivity: true, suppressLogicalEvents: true },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(flows, []);
  assert.deepEqual(automations, []);
  assert.deepEqual(activities, []);

  realtime.notifyDbSubscribers(
    'messages',
    'UPDATE',
    [messageRow('Finished result')],
    { workflowEventType: 'INSERT' },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(flows, [
    { table: 'messages', eventType: 'INSERT', content: 'Finished result' },
  ]);
  assert.deepEqual(automations, [
    { table: 'messages', eventType: 'INSERT', content: 'Finished result' },
  ]);
  // The AI route records the finalized activity explicitly. The realtime
  // chokepoint must not infer another activity row from an UPDATE.
  assert.deepEqual(activities, []);
});
