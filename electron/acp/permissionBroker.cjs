'use strict';

// Parks ACP tool calls until a human answers in the agensis chat UI
// (PermissionRequestCard), via the same daemon wire as Relay:
//   agent_permission_request → (human decides) → agent_permission_prepare
//   → agent_permission_prepared ack → agent_permission_commit | abort
//
// Grants:
//   - once     → this call only
//   - session  → rest of this job / bridge lifetime (in-memory)
//   - always   → server writes workspace_agents.metadata.permission_rules
//                (manage-gated); we also keep a local copy so the next tool
//                in this process does not re-ask before the next job payload
//
// Without permissionDecisionReceipts on the connection, the decide route
// refuses with permission_receipt_unsupported — so the bridge MUST advertise
// that flag on register (see agentBridge.cjs).

const crypto = require('crypto');

const PERMISSION_SCOPES = ['once', 'session', 'always'];
const DEFAULT_TTL_MS = Number(process.env.AGENSIS_PERMISSION_TIMEOUT_MS || 10 * 60 * 1000);

function denial(message) {
  return { behavior: 'deny', message: String(message || 'Denied') };
}

/**
 * Canonical rule keys from the agent row / job payload.
 * Same idea as agensis-cli permissions.normalizeStoredRules.
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeStoredRules(raw) {
  const source = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.allow) ? raw.allow : []);
  const keys = [];
  for (const entry of source) {
    let key = '';
    if (typeof entry === 'string') key = entry.trim();
    else if (entry && typeof entry === 'object') {
      const toolName = String(entry.toolName || entry.tool_name || '').trim();
      const content = String(entry.ruleContent || entry.rule_content || '').trim();
      key = toolName ? (content ? `${toolName}(${content})` : toolName) : '';
    }
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Job payload → permanent rules list (most specific first). */
function jobPermissionRules(job) {
  return normalizeStoredRules(
    job?.agent?.metadata?.permission_rules
    ?? job?.agent?.permission_rules
    ?? job?.permissionRules
    ?? job?.permission_rules,
  );
}

/**
 * Build rule keys for the Always-allow button. Prefer explicit rules; for Bash
 * fall back to a prefix rule when the command has no shell chaining.
 * @param {{ toolName?: string, rawInput?: unknown, title?: string }} opts
 */
function deriveRules({ toolName, rawInput, title } = {}) {
  const name = String(toolName || '').trim();
  if (name && name !== 'Bash' && name !== 'execute' && name !== 'other') {
    // Whole-tool rule so Always allow is meaningful for Edit/Write/etc.
    return [name];
  }
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const command = String(input.command || input.cmd || '').trim()
    || (typeof rawInput === 'string' ? rawInput.trim() : '');
  if (!command) {
    const fromTitle = String(title || '').trim();
    // "Bash(ls -la)" style titles from Claude ACP
    const bashish = fromTitle.match(/^Bash\s*\((.+)\)\s*$/i);
    if (bashish) {
      return deriveRules({ toolName: 'Bash', rawInput: { command: bashish[1] }, title: '' });
    }
    if (/^Bash\b/i.test(fromTitle)) return [];
    if (fromTitle) {
      const token = fromTitle.split(/[\s(]/)[0];
      if (token && token !== 'Bash') return [token];
    }
    return [];
  }
  // No chaining — same fail-closed idea as the classic daemon.
  if (/[;&|`]|\$\(/.test(command.replace(/\d*>&\d*|&>/g, ' '))) return [];
  const parts = command.split(/\s+/);
  const bin = parts[0];
  if (!bin || bin.startsWith('-')) return [];
  const sub = parts[1];
  const body = sub && /^[a-z][a-z0-9:_-]*$/i.test(sub) ? `${bin} ${sub}` : bin;
  return [`Bash(${body}:*)`];
}

/**
 * Is this call already covered by stored (or session) rules?
 * Whole-tool keys match any call for that tool; otherwise exact key match.
 */
function isAllowedByStoredRules(storedKeys, { toolName, rawInput, title } = {}) {
  const stored = Array.isArray(storedKeys) ? storedKeys : [];
  if (!stored.length) return false;
  const tool = String(toolName || '').trim();
  if (tool && stored.includes(tool)) return true;
  return deriveRules({ toolName, rawInput, title }).some((key) => stored.includes(key));
}

/**
 * @param {{
 *   send: (frame: object) => boolean,
 *   timeoutMs?: number,
 *   log?: (line: string) => void,
 *   idFactory?: () => string,
 *   initialRules?: string[]|unknown,
 * }} deps
 */
function createPermissionBroker({
  send,
  timeoutMs = DEFAULT_TTL_MS,
  log = () => {},
  idFactory = () => crypto.randomUUID(),
  initialRules = [],
} = {}) {
  if (typeof send !== 'function') throw new Error('createPermissionBroker requires send()');

  /** Permanent grants (seeded from agent.metadata.permission_rules + always answers). */
  const permanentRules = new Set(normalizeStoredRules(initialRules));
  /** Session/job grants (scope=session, and always for the rest of this process). */
  const sessionRules = new Set();

  /** @type {Map<string, { jobId: string, timer: NodeJS.Timeout, resolve: Function, decision: object|null, rules: string[] }>} */
  const pending = new Map();

  const allGranted = () => [...permanentRules, ...sessionRules];

  const rememberGrant = (scope, rules) => {
    const list = Array.isArray(rules) ? rules : [];
    if (scope === 'always') {
      for (const r of list) {
        if (r) permanentRules.add(String(r));
      }
    }
    if (scope === 'session' || scope === 'always') {
      for (const r of list) {
        if (r) sessionRules.add(String(r));
      }
    }
  };

  const settle = (requestId, result) => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (result?.behavior === 'allow') {
      rememberGrant(result.scope || 'once', entry.rules);
    }
    entry.resolve(result);
    return true;
  };

  return {
    /**
     * Raise a request and park until prepare+commit (or abort/timeout).
     * Short-circuits when a permanent or session rule already covers the call.
     * @returns {Promise<{behavior:'allow'|'deny', scope?: string, message?: string, decidedBy?: string}>}
     */
    request({
      jobId,
      toolName,
      title,
      description,
      detail,
      rawInput,
      signal,
    } = {}) {
      const rules = deriveRules({ toolName, rawInput, title });
      if (isAllowedByStoredRules(allGranted(), { toolName, rawInput, title })) {
        log(`permission auto-granted by stored rule for ${toolName || title || 'tool'}`);
        // scope always so the ACP client picks allow_always when offered — Claude
        // session also stops re-prompting for the same class of tool.
        const viaPermanent = isAllowedByStoredRules([...permanentRules], { toolName, rawInput, title });
        return Promise.resolve({
          behavior: 'allow',
          scope: viaPermanent ? 'always' : 'session',
          decidedBy: 'stored-rule',
        });
      }

      const requestId = idFactory();
      const delivered = send({
        action: 'agent_permission_request',
        jobId: jobId || '',
        requestId,
        toolName: String(toolName || '').trim() || 'Tool',
        title: String(title || toolName || 'Tool permission').trim(),
        description: String(description || '').trim(),
        detail: String(detail || '').trim(),
        input: rawInput && typeof rawInput === 'object' ? rawInput : null,
        // Rules an "Always allow" click would persist — server shows them and
        // writes them to metadata.permission_rules when scope=always.
        rules,
        scopes: rules.length > 0 ? PERMISSION_SCOPES : ['once', 'session'],
        expiresInMs: timeoutMs,
      });
      if (!delivered) {
        return Promise.resolve(denial('Agensis was unreachable, so this tool call could not be approved.'));
      }
      log(`permission requested for ${toolName || title || 'tool'} (${requestId}) rules=${JSON.stringify(rules)}`);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          settle(
            requestId,
            denial(`Nobody approved this within ${Math.round(timeoutMs / 60000)} minutes. Ask again in the chat, or grant it on the agent.`),
          );
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(requestId, {
          jobId: jobId || '',
          timer,
          resolve,
          decision: null,
          rules,
        });
        signal?.addEventListener?.('abort', () => {
          settle(requestId, denial('The job was cancelled before this was approved.'));
        }, { once: true });
      });
    },

    /**
     * Inbound frames from the server (type field on the WS message).
     * @returns {boolean} true if handled
     */
    handleServerFrame(message) {
      const type = String(message?.type || '');
      const requestId = String(message?.requestId || '').trim();
      if (!requestId || !pending.has(requestId)) return false;

      if (type === 'agent_permission_prepare') {
        const entry = pending.get(requestId);
        const allowed = message.behavior === 'allow';
        const scope = PERMISSION_SCOPES.includes(message.scope) ? message.scope : 'once';
        entry.decision = allowed
          ? { behavior: 'allow', scope, decidedBy: String(message.decidedBy || '') }
          : denial(String(message.message || '').trim() || 'Denied');
        // Receipt protocol: accept while still parked so the server can commit
        // (and for always, write metadata.permission_rules before commit).
        const ackOk = send({
          action: 'agent_permission_prepared',
          requestId,
          accepted: true,
        });
        if (!ackOk) {
          settle(requestId, denial('Could not acknowledge the permission decision.'));
        }
        log(`permission prepare ${allowed ? `allow(${scope})` : 'deny'} for ${requestId}`);
        return true;
      }

      if (type === 'agent_permission_commit') {
        const entry = pending.get(requestId);
        const result = entry?.decision || denial('Permission decision was lost before commit.');
        log(`permission commit for ${requestId} → ${result.behavior}${result.scope ? `(${result.scope})` : ''}`);
        return settle(requestId, result);
      }

      if (type === 'agent_permission_abort') {
        return settle(
          requestId,
          denial(String(message.message || '').trim() || 'This permission request can no longer be approved.'),
        );
      }

      // Legacy single-frame decision (pre-receipts). Keep for robustness.
      if (type === 'agent_permission_decision') {
        const allowed = message.behavior === 'allow';
        const scope = PERMISSION_SCOPES.includes(message.scope) ? message.scope : 'once';
        const decidedBy = String(message.decidedBy || '').trim();
        return settle(
          requestId,
          allowed
            ? { behavior: 'allow', scope, decidedBy }
            : denial(String(message.message || '').trim() || `${decidedBy || 'The workspace'} denied this tool call.`),
        );
      }

      return false;
    },

    /** Seed or replace permanent rules (e.g. after agent metadata realtime). */
    setPermanentRules(rules) {
      permanentRules.clear();
      for (const r of normalizeStoredRules(rules)) permanentRules.add(r);
    },

    addPermanentRules(rules) {
      for (const r of normalizeStoredRules(rules)) permanentRules.add(r);
    },

    getPermanentRules() {
      return [...permanentRules];
    },

    getSessionRules() {
      return [...sessionRules];
    },

    parkedRequestIds() {
      return [...pending.keys()];
    },

    cancelJob(jobId, reason = 'The job ended before this was approved.') {
      const id = String(jobId || '');
      let n = 0;
      for (const [requestId, entry] of [...pending.entries()]) {
        if (entry.jobId !== id) continue;
        if (settle(requestId, denial(reason))) n += 1;
      }
      // Session grants die with the job; permanent stay for the next job seed.
      sessionRules.clear();
      return n;
    },

    shutdown(reason = 'The desktop ACP bridge disconnected before this was approved.') {
      let n = 0;
      for (const requestId of [...pending.keys()]) {
        if (settle(requestId, denial(reason))) n += 1;
      }
      sessionRules.clear();
      return n;
    },

    pendingCount() {
      return pending.size;
    },
  };
}

module.exports = {
  createPermissionBroker,
  deriveRules,
  normalizeStoredRules,
  jobPermissionRules,
  isAllowedByStoredRules,
  PERMISSION_SCOPES,
  DEFAULT_TTL_MS,
};
