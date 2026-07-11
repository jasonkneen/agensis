'use strict';

const crypto = require('node:crypto');

function createInferenceBroker({ sendToAgent, timeoutMs = 180_000, idFactory = () => crypto.randomUUID() }) {
  if (typeof sendToAgent !== 'function') throw new Error('sendToAgent is required');
  const pending = new Map();

  function finish(requestId, callback) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    callback(entry);
    return true;
  }

  function request(route, body = {}, options = {}) {
    if (!route?.agentId || !route?.modelId) return Promise.reject(new Error('A routable agent model is required.'));
    const requestId = String(idFactory());
    return new Promise((resolve, reject) => {
      const abort = () => {
        sendToAgent(route.agentId, { type: 'agent_inference_cancel', requestId }, route.connectionId || null);
        finish(requestId, (entry) => entry.reject(Object.assign(new Error('Inference cancelled.'), { code: 'cancelled' })));
      };
      const timer = setTimeout(() => {
        sendToAgent(route.agentId, { type: 'agent_inference_cancel', requestId }, route.connectionId || null);
        finish(requestId, (entry) => entry.reject(Object.assign(new Error('Inference timed out.'), { code: 'timeout' })));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(requestId, {
        agentId: route.agentId,
        connectionId: route.connectionId || null,
        onEvent: typeof options.onEvent === 'function' ? options.onEvent : null,
        resolve,
        reject,
        timer,
        signal: options.signal,
        abort,
      });
      if (options.signal) {
        if (options.signal.aborted) return abort();
        options.signal.addEventListener('abort', abort, { once: true });
      }
      const { model: _publicModel, requestId: _ignoredRequestId, type: _ignoredType, action: _ignoredAction, ...requestBody } = body || {};
      const sent = sendToAgent(route.agentId, {
        type: 'agent_inference_request',
        requestId,
        model: route.modelId,
        ...requestBody,
      }, route.connectionId || null);
      if (!sent) finish(requestId, (entry) => entry.reject(Object.assign(new Error('Agent is not connected.'), { code: 'agent_offline' })));
    });
  }

  function handleAgentEvent(agentId, message = {}, connectionId = null) {
    const requestId = String(message.requestId || '');
    const entry = pending.get(requestId);
    if (!entry || String(entry.agentId) !== String(agentId)) return false;
    if (entry.connectionId && String(entry.connectionId) !== String(connectionId || '')) return false;
    if (message.action === 'agent_inference_started' || message.action === 'agent_inference_delta') {
      entry.onEvent?.(message);
      return true;
    }
    if (message.action === 'agent_inference_result') {
      return finish(requestId, (current) => current.resolve(message));
    }
    if (message.action === 'agent_inference_error') {
      return finish(requestId, (current) => current.reject(Object.assign(new Error(message.error || 'Inference failed.'), { code: message.code || 'inference_failed' })));
    }
    return false;
  }

  function failAgent(agentId, reason = 'Agent disconnected.') {
    for (const [requestId, entry] of pending) {
      if (String(entry.agentId) !== String(agentId)) continue;
      finish(requestId, (current) => current.reject(Object.assign(new Error(reason), { code: 'agent_offline' })));
    }
  }

  function failConnection(connectionId, reason = 'Agent connection disconnected.') {
    for (const [requestId, entry] of pending) {
      if (String(entry.connectionId || '') !== String(connectionId || '')) continue;
      finish(requestId, (current) => current.reject(Object.assign(new Error(reason), { code: 'agent_offline' })));
    }
  }

  return { request, handleAgentEvent, failAgent, failConnection, size: () => pending.size };
}

module.exports = { createInferenceBroker };
