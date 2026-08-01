#!/usr/bin/env node
// Minimal ACP server for unit tests — NDJSON JSON-RPC on stdio.
// Speaks initialize / session/new / session/prompt / session/cancel.

import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionId = null;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  // Notifications — ignore
  if (msg.method && msg.id === undefined) return;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: { name: 'fake-acp', version: '0.0.1' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionId = `sess_${Date.now()}`;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId },
    });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sid = msg.params?.sessionId;
    const prompt = msg.params?.prompt || [];
    const userText = prompt.map(p => p?.text || '').join('') || 'empty';
    // Stream two agent_message_chunk updates, then finish.
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Echo: ' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: userText },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { stopReason: 'end_turn' },
    });
    return;
  }

  if (msg.method === 'session/cancel') {
    // notification or request — reply if id present
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `unknown method ${msg.method}` },
    });
  }
});
