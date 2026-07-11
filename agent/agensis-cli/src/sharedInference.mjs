import { readFile } from 'node:fs/promises';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(number)));
}

function normalizeModel(raw, index) {
  if (!raw || typeof raw !== 'object' || raw.shared === false) return null;
  const id = String(raw.id || raw.upstreamModel || `model-${index + 1}`).trim();
  if (!id) return null;
  if (!/^[a-zA-Z0-9._:@/-]+$/.test(id)) {
    throw new Error(`Shared model id '${id}' may only contain letters, numbers, dot, underscore, colon, at, slash, or dash.`);
  }
  const baseUrl = new URL(String(raw.baseUrl || 'http://127.0.0.1:11434/v1'));
  if (!LOOPBACK_HOSTS.has(baseUrl.hostname)) {
    throw new Error(`Shared model '${id}' must use a loopback endpoint.`);
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error(`Shared model '${id}' must use an HTTP endpoint.`);
  }
  return {
    id: id.slice(0, 160),
    name: String(raw.name || id).trim().slice(0, 160) || id,
    provider: String(raw.provider || 'local').trim().slice(0, 80) || 'local',
    protocol: 'openai-chat',
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    upstreamModel: String(raw.upstreamModel || id).trim().slice(0, 200) || id,
    apiKeyEnv: String(raw.apiKeyEnv || '').trim().slice(0, 120),
    capabilities: [...new Set((Array.isArray(raw.capabilities) ? raw.capabilities : ['text', 'streaming'])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean))].slice(0, 16),
    ...(raw.contextWindow ? { contextWindow: boundedInteger(raw.contextWindow, undefined, 10_000_000) } : {}),
    maxConcurrency: boundedInteger(raw.maxConcurrency, 1, 64),
    shared: true,
  };
}

export async function loadSharedModelConfig(path) {
  if (!path) return [];
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const source = Array.isArray(parsed) ? parsed : parsed?.models;
  if (!Array.isArray(source)) throw new Error('Shared model config must contain a models array.');
  return source.slice(0, 32).map(normalizeModel).filter(Boolean);
}

export function sharedModelAdvertisements(models) {
  return (Array.isArray(models) ? models : []).filter((model) => model?.shared).map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    protocol: model.protocol,
    upstreamModel: model.upstreamModel,
    capabilities: [...model.capabilities],
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    maxConcurrency: model.maxConcurrency,
    shared: true,
  }));
}

export async function runSharedInference({
  models,
  request,
  send,
  signal,
  fetchImpl = fetch,
  env = process.env,
}) {
  const requestId = String(request?.requestId || '').trim();
  if (!requestId) throw new Error('Inference requestId is required.');
  const model = (Array.isArray(models) ? models : []).find((candidate) => candidate.id === request?.model);
  if (!model) throw new Error(`Shared model '${request?.model || ''}' is not available.`);
  const headers = { 'content-type': 'application/json' };
  const apiKey = model.apiKeyEnv ? env[model.apiKeyEnv] : '';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  send({ action: 'agent_inference_started', requestId, model: model.id });
  const { requestId: _requestId, model: _requestedModel, type: _type, action: _action, ...body } = request;
  const response = await fetchImpl(`${model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, model: model.upstreamModel, stream: request.stream === true }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Local model returned HTTP ${response.status}.`);
  }
  if (request.stream === true) {
    if (!response.body) throw new Error('Local model returned an empty stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage;
    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return false;
      const data = trimmed.slice(5).trim();
      if (!data) return false;
      if (data === '[DONE]') return true;
      try {
        const chunk = JSON.parse(data);
        if (chunk?.usage) usage = chunk.usage;
        send({ action: 'agent_inference_delta', requestId, model: model.id, chunk });
      } catch {
        // A malformed upstream event is ignored; later valid chunks still flow.
      }
      return false;
    };
    let doneEvent = false;
    while (!doneEvent) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : lines.pop() || '';
      for (const line of lines) {
        if (processLine(line)) { doneEvent = true; break; }
      }
      if (done) break;
    }
    if (buffer) processLine(buffer);
    const result = { action: 'agent_inference_result', requestId, model: model.id, ...(usage ? { usage } : {}) };
    send(result);
    return result;
  }
  const value = await response.json();
  send({ action: 'agent_inference_result', requestId, model: model.id, response: value });
  return value;
}
