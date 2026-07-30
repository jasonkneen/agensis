'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInferenceBroker } = require('../server/inference-broker.cjs');

test('the broker relays a request to one agent and preserves streaming chunks', async () => {
  const outbound = [];
  const observed = [];
  const broker = createInferenceBroker({
    timeoutMs: 1000,
    sendToAgent: (agentId, message) => {
      outbound.push({ agentId, message });
      return true;
    },
  });

  const pending = broker.request({ agentId: 'agent-1', modelId: 'local-model' }, {
    model: 'public-route',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  }, { onEvent: (event) => observed.push(event) });

  const requestId = outbound[0].message.requestId;
  assert.equal(outbound[0].agentId, 'agent-1');
  assert.equal(outbound[0].message.type, 'agent_inference_request');
  assert.equal(outbound[0].message.model, 'local-model');

  assert.equal(broker.handleAgentEvent('agent-1', {
    action: 'agent_inference_delta', requestId,
    chunk: { choices: [{ delta: { tool_calls: [{ function: { name: 'lookup' } }] } }] },
  }), true);
  broker.handleAgentEvent('agent-1', {
    action: 'agent_inference_result', requestId,
    usage: { total_tokens: 7 },
  });

  const result = await pending;
  assert.equal(observed[0].chunk.choices[0].delta.tool_calls[0].function.name, 'lookup');
  assert.equal(result.usage.total_tokens, 7);
  assert.equal(broker.size(), 0);
});

test('events from a different agent cannot complete a request', async () => {
  const outbound = [];
  const broker = createInferenceBroker({ timeoutMs: 1000, sendToAgent: (_agentId, message) => { outbound.push(message); return true; } });
  const pending = broker.request({ agentId: 'agent-1', modelId: 'm' }, { messages: [] });
  const requestId = outbound[0].requestId;
  assert.equal(broker.handleAgentEvent('agent-2', { action: 'agent_inference_result', requestId }), false);
  broker.handleAgentEvent('agent-1', { action: 'agent_inference_result', requestId, response: { choices: [] } });
  await pending;
});

test('the broker pins inference to the advertised connection, not just the agent id', async () => {
  const outbound = [];
  const broker = createInferenceBroker({
    timeoutMs: 1000,
    sendToAgent: (agentId, message, connectionId) => { outbound.push({ agentId, message, connectionId }); return true; },
  });
  const pending = broker.request({ agentId: 'agent-1', connectionId: 'connection-b', modelId: 'local' }, { messages: [] });
  const requestId = outbound[0].message.requestId;
  assert.equal(outbound[0].connectionId, 'connection-b');
  assert.equal(broker.handleAgentEvent('agent-1', { action: 'agent_inference_result', requestId }, 'connection-a'), false);
  assert.equal(broker.handleAgentEvent('agent-1', { action: 'agent_inference_result', requestId, response: { choices: [] } }, 'connection-b'), true);
  await pending;
});

test('disconnecting one connection only fails requests pinned to that connection', async () => {
  const outbound = [];
  const broker = createInferenceBroker({ timeoutMs: 1000, sendToAgent: (_agentId, message, connectionId) => { outbound.push({ message, connectionId }); return true; } });
  const first = broker.request({ agentId: 'agent-1', connectionId: 'connection-a', modelId: 'a' }, { messages: [] });
  const second = broker.request({ agentId: 'agent-1', connectionId: 'connection-b', modelId: 'b' }, { messages: [] });
  broker.failConnection('connection-a');
  await assert.rejects(first, /disconnected/i);
  const secondRequest = outbound.find((entry) => entry.connectionId === 'connection-b');
  broker.handleAgentEvent('agent-1', { action: 'agent_inference_result', requestId: secondRequest.message.requestId, response: { choices: [] } }, 'connection-b');
  await second;
});
