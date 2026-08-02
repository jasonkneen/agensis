'use strict';

// Minimal ACP client over a child process's stdio (NDJSON JSON-RPC 2.0).
// Spec: https://agentclientprotocol.com/protocol/overview
//
// Handles agent→client methods during a turn (permission, fs/read) so prompts
// do not hang. Desktop v1 auto-approves tool permission when autoApprove=true.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loginShellPath } = require('../../shared/local-agent-discovery.cjs');

const PROTOCOL_VERSION = 1;

function buildPathEnv() {
  const parts = [];
  const shell = loginShellPath();
  if (shell) parts.push(...shell.split(path.delimiter).filter(Boolean));
  if (process.env.PATH) parts.push(...process.env.PATH.split(path.delimiter).filter(Boolean));
  const home = os.homedir();
  parts.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.grok', 'bin'),
    path.join(home, '.volta', 'bin'),
  );
  const seen = new Set();
  return parts.filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  }).join(path.delimiter);
}

// child_process.spawn's shell:true does NOT escape args on Windows (Node
// warns about this — DEP0190): it hands cmd.exe a plain space-joined command
// line, so any arg with a space or shell metacharacter needs its own
// quoting. Our harness args are static literals, not user input, but this
// is the correct way to invoke them under a shell regardless.
//
// cmd.exe expands %VAR% while it parses the command line, even inside a
// double-quoted argument. The usual %% escape for a literal percent does
// NOT survive here — Node's shell:true wraps the whole command line in an
// extra layer of quoting for `cmd /d /s /c "..."`, and that extra layer
// changes how the %-scan interacts with quote boundaries (verified
// empirically: %%USERPROFILE%% still expands to the real path through it).
// Rather than ship an escape that only looks safe, refuse a literal "%".
function quoteWindowsShellArg(value) {
  const str = String(value);
  if (str === '') return '""';
  if (str.includes('%')) {
    throw new Error(`Refusing to pass "%" through the Windows shell (cmd.exe would expand it as %VAR%): ${str}`);
  }
  if (!/[\s"^&|<>()]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function extractTextFromUpdate(update) {
  if (!update || typeof update !== 'object') return '';
  const sessionUpdate = String(update.sessionUpdate || update.session_update || update.type || '');
  // Only agent-visible message chunks count as reply text. Reject thoughts,
  // tool calls, plans, and user_message_chunk echoes (Grok re-emits the prompt).
  const isAgentMessage = sessionUpdate === 'agent_message_chunk'
    || sessionUpdate === 'agent_message'
    || sessionUpdate === 'message';
  if (!isAgentMessage) return '';

  const content = update.content || update.message?.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (Array.isArray(content)) {
      return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
    }
  }
  if (typeof update.text === 'string') return update.text;
  return '';
}

function extractTextFromResult(result) {
  if (!result || typeof result !== 'object') return '';
  if (typeof result.text === 'string') return result.text;
  if (Array.isArray(result.content)) {
    return result.content.map((c) => c?.text || '').join('');
  }
  return '';
}

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   autoApprove?: boolean,
 *   onUpdate?: (params: object) => void,
 *   onLog?: (line: string) => void,
 * }} options
 */
function createAcpClient(options) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = {},
    autoApprove = true,
    onUpdate = null,
    onLog = null,
  } = options;

  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  const pending = new Map();
  /** @type {Set<(params: object) => void>} */
  const updateHandlers = new Set();
  if (typeof onUpdate === 'function') updateHandlers.add(onUpdate);

  let closed = false;
  let buffer = '';
  let sessionId = null;
  let initializeResult = null;

  const log = (line) => {
    if (typeof onLog === 'function') onLog(line);
  };

  // npm-installed CLI harnesses resolve to .cmd/.bat shims on Windows, and
  // child_process.spawn cannot exec those directly without shell:true (they
  // are batch files, not PE executables). Only shim extensions get shell:true
  // — a resolved .exe still spawns directly, with no argument re-quoting risk.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);

  const child = spawn(
    needsShell ? quoteWindowsShellArg(command) : command,
    needsShell ? args.map(quoteWindowsShellArg) : args,
    {
      cwd,
      env: {
        ...process.env,
        PATH: buildPathEnv(),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
      windowsHide: true,
    },
  );

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk || '').split('\n')) {
      if (line.trim()) log(`[stderr] ${line}`);
    }
  });

  child.on('error', (err) => {
    closed = true;
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  child.on('exit', (code, signal) => {
    closed = true;
    const err = new Error(`ACP process exited (code=${code}, signal=${signal || 'none'})`);
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`[bad-json] ${line.slice(0, 200)}`);
        continue;
      }
      handleMessage(msg);
    }
  });

  function write(msg) {
    if (closed || !child.stdin.writable) {
      throw new Error('ACP process is not writable');
    }
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error('ACP process is closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  function notify(method, params = {}) {
    write({ jsonrpc: '2.0', method, params });
  }

  function emitUpdate(params) {
    for (const handler of updateHandlers) {
      try {
        handler(params);
      } catch {
        // never break the pipe for a bad listener
      }
    }
  }

  function handleMessage(msg) {
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id')
      && (msg.result !== undefined || msg.error)) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        err.data = msg.error.data;
        waiter.reject(err);
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    if (msg && msg.method && Object.prototype.hasOwnProperty.call(msg, 'id')) {
      void handleAgentRequest(msg).catch((err) => {
        try {
          write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: err?.message || String(err) },
          });
        } catch {
          // process gone
        }
      });
      return;
    }

    if (msg && msg.method === 'session/update') {
      emitUpdate(msg.params || {});
      return;
    }
    if (msg && msg.method) log(`[notify] ${msg.method}`);
  }

  async function handleAgentRequest(msg) {
    const method = msg.method;
    const params = msg.params || {};

    if (method === 'session/request_permission') {
      const optionsList = Array.isArray(params.options) ? params.options : [];
      const allow = optionsList.find((o) => /allow|accept|yes|approve/i.test(
        String(o?.optionId || o?.name || o?.kind || ''),
      )) || optionsList[0];
      const result = autoApprove
        ? { outcome: 'selected', optionId: allow?.optionId || allow?.id || 'allow_once' }
        : { outcome: 'cancelled' };
      write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }

    if (method === 'fs/read_text_file') {
      const filePath = String(params.path || '');
      if (!path.isAbsolute(filePath)) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: 'path must be absolute' },
        });
        return;
      }
      try {
        let content = fs.readFileSync(filePath, 'utf8');
        const max = 512 * 1024;
        if (content.length > max) content = content.slice(0, max);
        write({ jsonrpc: '2.0', id: msg.id, result: { content } });
      } catch (err) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: err?.message || String(err) },
        });
      }
      return;
    }

    if (method === 'fs/write_text_file') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'fs/write_text_file not enabled in agensis desktop v1' },
      });
      return;
    }

    write({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  async function initialize() {
    initializeResult = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'agensis-desktop', title: 'agensis', version: '0.1.0' },
    });
    try {
      notify('notifications/initialized', {});
    } catch {
      // optional
    }
    return initializeResult;
  }

  async function newSession(sessionCwd = cwd) {
    const result = await request('session/new', {
      cwd: path.resolve(sessionCwd),
      mcpServers: [],
    });
    sessionId = result?.sessionId || result?.session_id || result?.id || null;
    if (!sessionId) throw new Error('session/new did not return a sessionId');
    return result;
  }

  /**
   * @param {string} text
   * @param {{ onChunk?: (text: string) => void }} [opts]
   */
  async function prompt(text, opts = {}) {
    if (!sessionId) throw new Error('No ACP session — call newSession first');
    const chunks = [];
    const handler = (params) => {
      const update = params?.update || params;
      const bit = extractTextFromUpdate(update);
      if (bit) {
        chunks.push(bit);
        if (typeof opts.onChunk === 'function') opts.onChunk(bit);
      }
    };
    updateHandlers.add(handler);
    try {
      const result = await request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: String(text || '') }],
      });
      const reply = chunks.join('') || extractTextFromResult(result) || '';
      return {
        stopReason: result?.stopReason || result?.stop_reason || 'end_turn',
        text: reply,
        result,
      };
    } finally {
      updateHandlers.delete(handler);
    }
  }

  function cancel() {
    if (!sessionId || closed) return;
    try {
      notify('session/cancel', { sessionId });
    } catch {
      // ignore
    }
  }

  function dispose() {
    closed = true;
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    const t = setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch { /* ignore */ }
    }, 2000);
    if (typeof t.unref === 'function') t.unref();
  }

  return {
    get sessionId() { return sessionId; },
    get initializeResult() { return initializeResult; },
    get pid() { return child.pid; },
    get closed() { return closed; },
    initialize,
    newSession,
    prompt,
    cancel,
    dispose,
    request,
    _child: child,
  };
}

module.exports = {
  createAcpClient,
  PROTOCOL_VERSION,
  extractTextFromUpdate,
  extractTextFromResult,
  buildPathEnv,
  quoteWindowsShellArg,
};
