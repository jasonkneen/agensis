import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadSharedModelConfig,
  runSharedInference,
  sharedModelAdvertisements,
} from '../agent/agensis-cli/src/sharedInference.mjs';
import { __test as agentTest } from '../agent/agensis-cli/src/agensis.mjs';

test('a daemon loads private local endpoints but advertises only safe model metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agensis-shared-models-'));
  const path = join(root, 'models.json');
  await writeFile(path, JSON.stringify({
    models: [{
      id: 'qwen3-8b',
      name: 'Qwen 3 8B',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      upstreamModel: 'qwen3:8b',
      apiKeyEnv: 'OLLAMA_API_KEY',
      capabilities: ['text', 'streaming', 'tools'],
      contextWindow: 32768,
      maxConcurrency: 2,
      shared: true,
    }],
  }));

  const config = await loadSharedModelConfig(path);
  assert.equal(config[0].baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(config[0].apiKeyEnv, 'OLLAMA_API_KEY');
  assert.deepEqual(sharedModelAdvertisements(config), [{
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
});

test('shared local inference only accepts loopback endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agensis-shared-models-'));
  const path = join(root, 'models.json');
  await writeFile(path, JSON.stringify({ models: [{ id: 'bad', baseUrl: 'https://example.com/v1', shared: true }] }));
  await assert.rejects(() => loadSharedModelConfig(path), /loopback/i);
});

test('shared local inference rejects model ids the server cannot route verbatim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agensis-shared-models-'));
  const path = join(root, 'models.json');
  await writeFile(path, JSON.stringify({ models: [{ id: 'Qwen 3!', baseUrl: 'http://127.0.0.1:11434/v1' }] }));
  await assert.rejects(() => loadSharedModelConfig(path), /model id/i);
});

test('non-streaming inference preserves the OpenAI response and usage', async () => {
  const sent = [];
  const models = [{
    id: 'local',
    name: 'Local',
    provider: 'ollama',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    upstreamModel: 'qwen3:8b',
    apiKeyEnv: 'LOCAL_MODEL_KEY',
    capabilities: ['text'],
    maxConcurrency: 1,
    shared: true,
  }];
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await runSharedInference({
    models,
    request: { type: 'agent_inference_request', action: 'ignored-envelope', requestId: 'req-1', model: 'local', stream: false, messages: [{ role: 'user', content: 'hi' }] },
    fetchImpl,
    env: { LOCAL_MODEL_KEY: 'secret' },
    send: (event) => sent.push(event),
  });

  assert.equal(request.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  assert.equal(request.body.model, 'qwen3:8b');
  assert.equal('type' in request.body, false);
  assert.equal('action' in request.body, false);
  assert.deepEqual(sent.map((event) => event.action), ['agent_inference_started', 'agent_inference_result']);
  assert.equal(sent[1].response.choices[0].message.content, 'hello');
  assert.equal(sent[1].response.usage.total_tokens, 6);
});

test('streaming inference forwards text and tool-call chunks without flattening them', async () => {
  const sent = [];
  const models = [{
    id: 'local', name: 'Local', provider: 'lm-studio', protocol: 'openai-chat',
    baseUrl: 'http://localhost:1234/v1', upstreamModel: 'local-model', apiKeyEnv: '',
    capabilities: ['text', 'streaming', 'tools'], maxConcurrency: 1, shared: true,
  }];
  const chunks = [
    { id: 'c1', choices: [{ index: 0, delta: { content: 'checking ' }, finish_reason: null }] },
    { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: null }] },
    { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 9 } },
  ];
  const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;

  await runSharedInference({
    models,
    request: { requestId: 'req-stream', model: 'local', stream: true, messages: [{ role: 'user', content: 'use a tool' }] },
    fetchImpl: async () => new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (event) => sent.push(event),
  });

  assert.deepEqual(sent.map((event) => event.action), [
    'agent_inference_started',
    'agent_inference_delta',
    'agent_inference_delta',
    'agent_inference_delta',
    'agent_inference_result',
  ]);
  assert.equal(sent[2].chunk.choices[0].delta.tool_calls[0].function.name, 'lookup');
  assert.equal(sent.at(-1).usage.total_tokens, 9);
});

test('managed shared-only agents can explicitly disable the default coding command', () => {
  const config = agentTest.normalizeConfig({
    url: 'https://agensis.test', token: 'aga_test', workspace: 'workspace-1', agent: 'agent-1', noCoding: true,
  });
  assert.equal(config.codingCmd, '');
  assert.equal(config.noCoding, true);
});

test('relative shared-model config paths are pinned to the configured working directory', () => {
  const config = agentTest.normalizeConfig({
    url: 'https://agensis.test', token: 'aga_test', workspace: 'workspace-1', agent: 'agent-1',
    cwd: '/workspace/project', share: true, sharedModelsFile: './shared-models.json',
  });
  assert.equal(config.sharedModelsFile, '/workspace/project/shared-models.json');
});

test('heartbeat metadata reports per-model inference load', () => {
  const activeInference = new Map([
    ['request-1', { model: 'qwen' }],
    ['request-2', { model: 'qwen' }],
    ['request-3', { model: 'llama' }],
  ]);
  const metadata = agentTest.heartbeatMetadata({ cwd: '/tmp', model: '', permissionMode: 'default' }, { active: () => 0, size: () => 0 }, null, null, activeInference);
  assert.deepEqual(metadata.activeInferenceByModel, { qwen: 2, llama: 1 });
});

test('daemon shutdown aborts every active local inference request', () => {
  const aborted = [];
  agentTest.abortInferenceRequests(new Map([
    ['one', { abort: () => aborted.push('one') }],
    ['two', { abort: () => aborted.push('two') }],
  ]));
  assert.deepEqual(aborted, ['one', 'two']);
});
