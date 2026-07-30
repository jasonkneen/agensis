'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { __test } = require('../server/index.cjs');

test('shared-model capability adverts keep routing metadata and strip private endpoints', () => {
  const models = __test.sharedModelsFromMessage([
    {
      id: 'qwen3-8b',
      name: 'Qwen 3 8B',
      provider: 'ollama',
      protocol: 'openai-chat',
      upstreamModel: 'qwen3:8b',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'local-secret',
      capabilities: ['text', 'streaming', 'tools', 'streaming'],
      contextWindow: 32768,
      maxConcurrency: 2,
      shared: true,
    },
  ]);

  assert.deepEqual(models, [{
    id: 'qwen3-8b',
    name: 'Qwen 3 8B',
    provider: 'ollama',
    protocol: 'openai-chat',
    upstreamModel: 'qwen3:8b',
    capabilities: ['text', 'streaming', 'tools'],
    contextWindow: 32768,
    maxConcurrency: 2,
    shared: true,
  }]);
  assert.equal('baseUrl' in models[0], false);
  assert.equal('apiKey' in models[0], false);
});

test('shared-model adverts reject unusable entries and cap the registry', () => {
  const incoming = [
    null,
    { id: '', shared: true },
    { id: 'private', shared: false },
    ...Array.from({ length: 40 }, (_, index) => ({ id: `model-${index}`, shared: true })),
  ];
  const models = __test.sharedModelsFromMessage(incoming);
  assert.equal(models.length, 32);
  assert.equal(models[0].id, 'model-0');
  assert.equal(models.at(-1).id, 'model-31');
  assert.deepEqual(__test.sharedModelsFromMessage([{ id: 'Qwen 3!', shared: true }]), []);
});

test('browser-facing agent connections retain safe shared models and redact endpoints', () => {
  const connection = __test.publicAgentConnection({
    id: 'connection-1',
    workspace_id: 'workspace-1',
    agent_id: 'agent-1',
    name: 'Local inference',
    handle: 'local',
    status: 'online',
    metadata: '{}',
    capabilities: JSON.stringify({
      skills: [],
      clis: [],
      mcpServers: [],
      memoryRoot: null,
      sharedModels: [{ id: 'private-model', shared: true, baseUrl: 'http://localhost:11434/v1' }],
    }),
  });

  assert.deepEqual(connection.capabilities.sharedModels, [{
    id: 'private-model',
    name: 'private-model',
    provider: 'local',
    protocol: 'openai-chat',
    upstreamModel: 'private-model',
    capabilities: ['text'],
    maxConcurrency: 1,
    shared: true,
  }]);
});

test('live agent connections become stable workspace-scoped inference routes', () => {
  const routes = __test.sharedModelRoutesFromConnections('workspace-1', [{
    id: 'connection-1',
    workspace_id: 'workspace-1',
    agent_id: 'agent-1',
    name: 'Workstation',
    handle: 'desk',
    status: 'online',
    metadata: JSON.stringify({ activeInferenceByModel: { 'qwen3:8b': 1 } }),
    capabilities: JSON.stringify({
      sharedModels: [{ id: 'qwen3:8b', name: 'Qwen', provider: 'ollama', protocol: 'openai-chat', upstreamModel: 'qwen3:8b', capabilities: ['text'], maxConcurrency: 2, shared: true }],
    }),
  }]);

  assert.deepEqual(routes, [{
    id: 'agensis/workspace-1/agent-1/qwen3%3A8b',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    connectionId: 'connection-1',
    modelId: 'qwen3:8b',
    name: 'Qwen',
    provider: 'ollama',
    protocol: 'openai-chat',
    capabilities: ['text'],
    maxConcurrency: 2,
    activeInference: 1,
    status: 'online',
    handle: 'desk',
    host: 'Workstation',
  }]);
});

test('offline and non-shared agent models are not routable', () => {
  const routes = __test.sharedModelRoutesFromConnections('workspace-1', [
    { workspace_id: 'workspace-1', agent_id: 'a', status: 'offline', capabilities: JSON.stringify({ sharedModels: [{ id: 'x', shared: true }] }) },
    { workspace_id: 'workspace-1', agent_id: 'b', status: 'online', capabilities: JSON.stringify({ sharedModels: [{ id: 'y', shared: false }] }) },
    { workspace_id: 'other', agent_id: 'c', status: 'online', capabilities: JSON.stringify({ sharedModels: [{ id: 'z', shared: true }] }) },
  ]);
  assert.deepEqual(routes, []);
});

test('OpenAI streaming relay does not duplicate an upstream usage chunk', () => {
  const writes = [];
  const relay = __test.createOpenAIInferenceStreamRelay({ write: (value) => writes.push(value) }, 'public-model');
  relay.onEvent({ action: 'agent_inference_delta', chunk: { choices: [], usage: { total_tokens: 7 } } });
  relay.appendUsage({ usage: { total_tokens: 7 } });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /"total_tokens":7/);
});

test('OpenAI streaming relay appends result-only usage when the upstream emitted none', () => {
  const writes = [];
  const relay = __test.createOpenAIInferenceStreamRelay({ write: (value) => writes.push(value) }, 'public-model');
  relay.onEvent({ action: 'agent_inference_delta', chunk: { choices: [{ delta: { content: 'hi' } }] } });
  relay.appendUsage({ usage: { total_tokens: 7 } });
  assert.equal(writes.length, 2);
  assert.match(writes[1], /"total_tokens":7/);
});

test('inference abort binding cancels work when the response closes early', () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const controller = new AbortController();
  let complete = false;
  __test.bindInferenceAbort(req, res, controller, () => complete);
  res.emit('close');
  assert.equal(controller.signal.aborted, true);

  const second = new AbortController();
  complete = true;
  const secondResponse = new EventEmitter();
  __test.bindInferenceAbort(new EventEmitter(), secondResponse, second, () => complete);
  secondResponse.emit('close');
  assert.equal(second.signal.aborted, false);
});

test('Farm enrollment redacts the stored connection-token hash', () => {
  const agent = __test.publicFarmEnrolledAgent({ id: 'agent-1', name: 'Coder', connect_token_hash: 'private-hash' });
  assert.deepEqual(agent, { id: 'agent-1', name: 'Coder' });
});
