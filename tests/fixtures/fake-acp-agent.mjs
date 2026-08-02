#!/usr/bin/env node
// Minimal ACP server for unit tests — NDJSON JSON-RPC on stdio.
// Speaks initialize / session/new / session/prompt / session/cancel.

import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionId = null;
/** @type {string} */
let currentModeId = 'default';
/** When set, the next prompt issues a session/request_permission and waits. */
const pendingPermission = { resolve: null };

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// Expose last set mode for tests via stderr line (client logs stderr).
function noteMode() {
  process.stderr.write(`[fake-acp] mode=${currentModeId}\n`);
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

  // Client → agent permission response (result for our request_permission)
  if (msg.id !== undefined && !msg.method && (msg.result || msg.error)) {
    if (pendingPermission.resolve) {
      pendingPermission.resolve(msg);
      pendingPermission.resolve = null;
    }
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
    currentModeId = 'default';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId,
        modes: {
          currentModeId,
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'acceptEdits', name: 'Accept Edits' },
            { id: 'bypassPermissions', name: 'Bypass Permissions' },
          ],
        },
      },
    });
    return;
  }

  if (msg.method === 'session/set_mode') {
    const modeId = String(msg.params?.modeId || '');
    const allowed = new Set(['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan']);
    if (!allowed.has(modeId)) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: `Invalid Mode: ${modeId}` },
      });
      return;
    }
    currentModeId = modeId;
    noteMode();
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sid = msg.params?.sessionId;
    const prompt = msg.params?.prompt || [];
    const userText = prompt.map(p => p?.text || '').join('') || 'empty';

    // If the prompt asks for a permission check, exercise request_permission.
    if (userText.startsWith('NEED_PERMISSION:')) {
      const reqId = `perm_${Date.now()}`;
      const toolTitle = userText.slice('NEED_PERMISSION:'.length).trim() || 'Bash';
      send({
        jsonrpc: '2.0',
        id: reqId,
        method: 'session/request_permission',
        params: {
          sessionId: sid,
          toolCall: {
            toolCallId: 'tc_1',
            title: toolTitle,
            kind: /edit|write/i.test(toolTitle) ? 'edit' : 'execute',
            rawInput: { command: 'echo hi' },
          },
          options: [
            { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
            { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
            { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
          ],
        },
      });
      // Wait for client response before finishing the prompt.
      new Promise((resolve) => {
        pendingPermission.resolve = resolve;
        setTimeout(() => resolve({ timedOut: true }), 5000);
      }).then((resp) => {
        const outcome = resp?.result?.outcome;
        const allowed = outcome?.outcome === 'selected'
          && (outcome.optionId === 'allow' || outcome.optionId === 'allow_always');
        const text = allowed
          ? `Permitted (${outcome.optionId}) mode=${currentModeId}`
          : `Denied mode=${currentModeId} outcome=${JSON.stringify(outcome || resp?.error || resp)}`;
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          },
        });
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn' },
        });
      });
      return;
    }

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
          content: { type: 'text', text: `${userText} [mode=${currentModeId}]` },
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
