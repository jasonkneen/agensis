'use strict';

// Minimal ACP client over a child process's stdio (NDJSON JSON-RPC 2.0).
// Spec: https://agentclientprotocol.com/protocol/overview
//
// Handles agent→client methods during a turn (permission, optional fs) so
// prompts do not hang.
//
// CLIENT CAPABILITIES (critical — do not "helpfully" enable fs/terminal):
// Desktop agents run ON THE HOST. Claude Code ACP (and similar harnesses) use
// their native Read/Write/Edit/Bash tools against the real filesystem.
//
// If we advertise clientCapabilities.fs.readTextFile / writeTextFile, zed's
// claude-code-acp DISALLOWS native Read/Write/Edit and injects an MCP server
// that renames tools to mcp__acp__* and proxies through fs/* — which is what
// an IDE wants for buffer sync, and the OPPOSITE of a local desktop agent.
// We keep fs/terminal false so the agent keeps real coding tools.
// Permissions still go over ACP: session/request_permission → chat card.
//
// ACCESS (agensis) → ACP session mode (Claude Code ACP):
//   yolo / Full access  → session/set_mode bypassPermissions  (never asks)
//   acceptEdits         → session/set_mode acceptEdits        (edits free; shell asks)
//   default / Ask       → session/set_mode default            (dialog per tool)
// Without set_mode, Claude ACP always starts in "default" and every tool hits
// session/request_permission — even when the Agents UI says Full access.
//
// session/request_permission response shape (ACP schema):
//   { outcome: { outcome: 'selected', optionId } }  |  { outcome: { outcome: 'cancelled' } }
// Flat { outcome, optionId } is invalid: agents treat it as cancelled/deny.

/** Desktop host client capabilities — native agent tools, not MCP shims. */
const DESKTOP_CLIENT_CAPABILITIES = Object.freeze({
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
});

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loginShellPath } = require('../../shared/local-agent-discovery.cjs');

/**
 * Map agensis permission_mode to Claude-Code-ACP session mode ids.
 * Other harnesses may ignore unknown modes; callers must tolerate set_mode errors.
 * @param {string} permissionMode
 * @returns {'default'|'acceptEdits'|'bypassPermissions'|'dontAsk'}
 */
function mapAccessModeToAcpSessionMode(permissionMode) {
  const n = normalizeAccessMode(permissionMode);
  if (n === 'yolo') return 'bypassPermissions';
  if (n === 'acceptedits') return 'acceptEdits';
  // dontAsk is a Claude ACP mode we do not expose in the Agents UI yet.
  const raw = String(permissionMode || '').toLowerCase().replace(/[-_]/g, '');
  if (raw === 'dontask') return 'dontAsk';
  return 'default';
}

/**
 * Normalize agensis ACCESS to a small internal enum.
 * Product/DB/UI spelling is `accept_edits` (underscore). Claude ACP session
 * modes use camelCase (`acceptEdits`). Both must resolve here.
 * @param {string} permissionMode
 * @param {boolean} [autoApprove]
 * @returns {'yolo'|'acceptedits'|'default'}
 */
function normalizeAccessMode(permissionMode, autoApprove) {
  // Strip both - and _ so accept_edits / accept-edits / acceptEdits collapse.
  const raw = String(permissionMode || '').trim().toLowerCase();
  const m = raw.replace(/-/g, '_');
  const compact = m.replace(/_/g, '');
  if (
    compact === 'yolo'
    || compact === 'full'
    || compact === 'fullaccess'
    || compact === 'bypasspermissions'
  ) {
    return 'yolo';
  }
  if (compact === 'acceptedits' || compact === 'autoapproveedits') return 'acceptedits';
  if (compact === 'default' || compact === 'ask' || compact === 'plan') return 'default';
  // Legacy: autoApprove alone meant full access before ACCESS modes existed.
  if (!raw && autoApprove === true) return 'yolo';
  if (!raw && autoApprove === false) return 'default';
  return 'default';
}

/** Modes that elevate beyond per-tool Ask (still differ: yolo vs edits-only). */
function isElevatedAccessMode(permissionMode) {
  const n = normalizeAccessMode(permissionMode);
  return n === 'yolo' || n === 'acceptedits';
}

/**
 * Pick the option the ACCESS mode wants from the agent's option list.
 * Prefer kind (allow_always / allow_once / reject_*) then exact optionId.
 * Claude Code ACP options:
 *   { kind: allow_always, optionId: 'allow_always' }
 *   { kind: allow_once,   optionId: 'allow' }
 *   { kind: reject_once,  optionId: 'reject' }
 * @param {Array<object>} optionsList
 * @param {'allow_always'|'allow_once'|'reject'} preference
 */
function pickPermissionOption(optionsList, preference) {
  const list = Array.isArray(optionsList) ? optionsList : [];
  if (!list.length) return null;

  const kindOf = (o) => String(o?.kind || o?.optionKind || '').toLowerCase().replace(/-/g, '_');
  const idOf = (o) => String(o?.optionId || o?.option_id || o?.id || o?.name || '').toLowerCase();

  if (preference === 'allow_always') {
    const always = list.find((o) => (
      kindOf(o) === 'allow_always'
      || idOf(o) === 'allow_always'
      || idOf(o) === 'allow_all'
      || idOf(o) === 'acceptedits' // ExitPlanMode "auto-accept edits"
    ));
    if (always) return always;
  }
  if (preference === 'allow_always' || preference === 'allow_once') {
    // Do NOT match id "allow_always" here — /allow/ used to false-match it.
    const once = list.find((o) => (
      kindOf(o) === 'allow_once'
      || idOf(o) === 'allow_once'
      || idOf(o) === 'allow'
      || idOf(o) === 'default' // ExitPlanMode "manually approve edits"
      || idOf(o) === 'accept'
      || idOf(o) === 'approve'
      || idOf(o) === 'yes'
    ));
    if (once) return once;
  }
  if (preference === 'reject') {
    const rej = list.find((o) => (
      kindOf(o).startsWith('reject')
      || idOf(o) === 'reject'
      || idOf(o) === 'reject_once'
      || idOf(o) === 'reject_always'
      || idOf(o) === 'deny'
      || idOf(o) === 'plan' // ExitPlanMode "keep planning"
    ));
    if (rej) return rej;
  }
  // Never fall back to options[0] blindly — it is often "reject".
  return list.find((o) => kindOf(o).startsWith('allow')) || null;
}

function permissionResultSelected(option) {
  const optionId = option?.optionId || option?.option_id || option?.id || 'allow';
  return { outcome: { outcome: 'selected', optionId: String(optionId) } };
}

function permissionResultCancelled() {
  return { outcome: { outcome: 'cancelled' } };
}

/** Edit-class tool calls (for acceptEdits auto-allow without shell). */
function isEditToolCall(params) {
  const tc = params?.toolCall || params?.tool_call || {};
  const kind = String(tc.kind || '').toLowerCase();
  if (kind === 'edit' || kind === 'write' || kind === 'delete' || kind === 'move') return true;
  const title = String(tc.title || tc.toolName || tc.name || '');
  if (/^(Edit|Write|MultiEdit|NotebookEdit|Delete|Move)\b/i.test(title)) return true;
  if (/\b(edit|write|create file|update file)\b/i.test(title) && !/\b(bash|shell|command|run)\b/i.test(title)) {
    return true;
  }
  return false;
}

/**
 * Ask the human via a native dialog when ACCESS is Ask / not auto-approve.
 * Returns the selected PermissionOption or null if cancelled/denied.
 */
async function askPermissionViaDialog(params, optionsList) {
  let dialog;
  try {
    // electron is only available in the main process (this file runs there).
    dialog = require('electron').dialog;
  } catch {
    return null;
  }
  const toolCall = params.toolCall || params.tool_call || {};
  const title = String(toolCall.title || toolCall.kind || toolCall.toolName || 'Tool permission');
  const detail = typeof toolCall.rawInput === 'string'
    ? toolCall.rawInput
    : (toolCall.rawInput && typeof toolCall.rawInput === 'object'
      ? JSON.stringify(toolCall.rawInput).slice(0, 600)
      : (toolCall.content
        ? JSON.stringify(toolCall.content).slice(0, 400)
        : JSON.stringify(toolCall).slice(0, 400)));

  const buttons = optionsList.map((o, i) => {
    const name = String(o?.name || o?.optionId || o?.kind || `Option ${i + 1}`);
    return name.slice(0, 40);
  });
  // Always offer Cancel as last escape.
  buttons.push('Cancel');

  // Prefer Allow / Yes as default button when present.
  let defaultId = 0;
  for (let i = 0; i < optionsList.length; i += 1) {
    const k = String(optionsList[i]?.kind || '').toLowerCase();
    if (k === 'allow_once' || k === 'allow_always') {
      defaultId = i;
      break;
    }
  }

  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Agent permission',
    message: title,
    detail: detail || 'This agent wants to run a tool.',
    buttons,
    defaultId,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (result.response < 0 || result.response >= optionsList.length) return null;
  return optionsList[result.response];
}

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
 *   permissionMode?: 'default'|'acceptEdits'|'yolo',
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
    autoApprove,
    permissionMode = 'default',
    /** ACP session/new mcpServers (authenticated workspace MCP when token present). */
    mcpServers = [],
    onUpdate = null,
    onLog = null,
    /** Optional: every outbound JSON-RPC frame (tests pin set_mode + permission shape). */
    onOutbound = null,
    /**
     * Optional: product approval path (in-chat PermissionRequestCard via bridge).
     * (params, optionsList) => Promise<{behavior:'allow'|'deny', scope?: string}|null>
     * When set, preferred over the native Electron dialog for Ask / residual shell.
     */
    onPermissionRequest = null,
  } = options;
  // yolo / Full access → set_mode bypassPermissions + auto-allow any residual asks.
  // acceptEdits → set_mode acceptEdits; residual shell asks still show a dialog.
  // default (Ask) → product permission card (or native dialog fallback).
  const mode = normalizeAccessMode(permissionMode, autoApprove);
  const acpSessionMode = mapAccessModeToAcpSessionMode(mode);

  /** @type {null|((params: object, optionsList: object[]) => Promise<object|null>)} */
  let permissionRequestHandler = typeof onPermissionRequest === 'function' ? onPermissionRequest : null;

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

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      PATH: buildPathEnv(),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

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
    if (typeof onOutbound === 'function') {
      try {
        onOutbound(msg);
      } catch {
        // test hooks must never break the wire
      }
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
      let selected = null;

      // Auto-allow residual prompts when Full access, or edit tools under acceptEdits.
      // (Primary control is session/set_mode; this is the safety net if the agent
      // still asks, or for harnesses that ignore set_mode.)
      const autoAllow = mode === 'yolo'
        || (mode === 'acceptedits' && isEditToolCall(params));
      if (autoAllow) {
        const prefer = mode === 'yolo' ? 'allow_always' : 'allow_once';
        selected = pickPermissionOption(optionsList, prefer)
          || pickPermissionOption(optionsList, 'allow_once');
        if (selected) {
          log(`[permission] auto-approve mode=${mode} option=${selected.optionId || selected.kind}`);
          write({ jsonrpc: '2.0', id: msg.id, result: permissionResultSelected(selected) });
          return;
        }
        // No allow option at all — fall through to dialog rather than inventing an id.
      }

      // Ask mode, acceptEdits+shell, or auto with no match: ask a human.
      // Prefer the product path (in-chat PermissionRequestCard via onPermissionRequest /
      // agent bridge). Fall back to a native Electron dialog when no handler is set
      // (tests, or ACP run without a bridge). Never silent-cancel.
      const toolCall = params.toolCall || params.tool_call || {};
      log(`[permission] prompting user mode=${mode} tool=${toolCall.title || toolCall.kind || '?'}`);
      try {
        if (typeof permissionRequestHandler === 'function') {
          const decision = await permissionRequestHandler(params, optionsList);
          if (decision && decision.behavior === 'allow') {
            const prefer = decision.scope === 'always' ? 'allow_always' : 'allow_once';
            selected = pickPermissionOption(optionsList, prefer)
              || pickPermissionOption(optionsList, 'allow_once');
          } else {
            selected = null;
          }
        } else {
          selected = await askPermissionViaDialog(params, optionsList);
        }
      } catch (err) {
        log(`[permission] prompt failed: ${err?.message || err}`);
        selected = null;
      }
      if (selected) {
        log(`[permission] user selected ${selected.optionId || selected.kind}`);
        write({ jsonrpc: '2.0', id: msg.id, result: permissionResultSelected(selected) });
      } else {
        // Prefer an explicit reject option over cancelled when the user dismisses.
        log('[permission] denied/cancelled — no selection');
        const reject = pickPermissionOption(optionsList, 'reject');
        if (reject) {
          write({ jsonrpc: '2.0', id: msg.id, result: permissionResultSelected(reject) });
        } else {
          write({ jsonrpc: '2.0', id: msg.id, result: permissionResultCancelled() });
        }
      }
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
      // Must stay false/false/false — see DESKTOP_CLIENT_CAPABILITIES comment.
      clientCapabilities: {
        fs: {
          readTextFile: DESKTOP_CLIENT_CAPABILITIES.fs.readTextFile,
          writeTextFile: DESKTOP_CLIENT_CAPABILITIES.fs.writeTextFile,
        },
        terminal: DESKTOP_CLIENT_CAPABILITIES.terminal,
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

  async function setSessionMode(modeId) {
    if (!sessionId) throw new Error('No ACP session — call newSession first');
    const id = String(modeId || 'default');
    return request('session/set_mode', { sessionId, modeId: id });
  }

  async function newSession(sessionCwd = cwd) {
    const servers = Array.isArray(mcpServers) ? mcpServers : [];
    const result = await request('session/new', {
      cwd: path.resolve(sessionCwd),
      // Authenticated workspace MCP when the host has a token; empty otherwise.
      // Unauthenticated hits to agensis MCP get OAuth 401 (AuthRequired) from
      // Grok's MCP worker — that is expected noise when no Bearer is supplied.
      mcpServers: servers,
    });
    sessionId = result?.sessionId || result?.session_id || result?.id || null;
    if (!sessionId) throw new Error('session/new did not return a sessionId');
    if (servers.length) {
      log(`[mcp] session wired ${servers.length} MCP server(s): ${servers.map((s) => s.name || s.url).join(', ')}`);
    }

    // Apply ACCESS immediately. Claude Code ACP always starts in "default";
    // without this, Full access still prompts (or used to silent-deny).
    if (acpSessionMode && acpSessionMode !== 'default') {
      try {
        await setSessionMode(acpSessionMode);
        log(`[permission] session mode set to ${acpSessionMode} (agensis access=${mode})`);
      } catch (err) {
        // Harness may not implement modes (Grok, Goose, …). Fall back to
        // request_permission auto-approve for yolo; acceptEdits degrades to ask.
        log(`[permission] session/set_mode ${acpSessionMode} failed: ${err?.message || err}`);
      }
    } else {
      log(`[permission] session mode default (agensis access=${mode})`);
    }
    return result;
  }

  /**
   * @param {string} text
   * @param {{
   *   onChunk?: (text: string) => void,
   *   onPermissionRequest?: (params: object, optionsList: object[]) => Promise<object|null>,
   * }} [opts]
   */
  async function prompt(text, opts = {}) {
    if (!sessionId) throw new Error('No ACP session — call newSession first');
    const prevHandler = permissionRequestHandler;
    if (typeof opts.onPermissionRequest === 'function') {
      permissionRequestHandler = opts.onPermissionRequest;
    }
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
      permissionRequestHandler = prevHandler;
    }
  }

  function setPermissionRequestHandler(fn) {
    permissionRequestHandler = typeof fn === 'function' ? fn : null;
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
    get accessMode() { return mode; },
    get acpSessionMode() { return acpSessionMode; },
    initialize,
    newSession,
    setSessionMode,
    setPermissionRequestHandler,
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
  DESKTOP_CLIENT_CAPABILITIES,
  extractTextFromUpdate,
  extractTextFromResult,
  buildPathEnv,
  mapAccessModeToAcpSessionMode,
  normalizeAccessMode,
  isElevatedAccessMode,
  pickPermissionOption,
  permissionResultSelected,
  permissionResultCancelled,
  isEditToolCall,
};
