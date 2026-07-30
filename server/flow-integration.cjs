'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

// Reaction events are named where they are produced (shared/reaction-events.cjs)
// because both backends emit them and only this one is a server/ file. Listed
// here so a connection can subscribe to them like any other event.
const { REACTION_FLOW_EVENTS } = require('../shared/reaction-events.cjs');

const FLOW_EVENTS = Object.freeze([
  'message.created',
  'message.updated',
  'channel.created',
  'channel.updated',
  'document.created',
  'document.updated',
  'member.created',
  'member.updated',
  'agent.created',
  'agent.updated',
  ...REACTION_FLOW_EVENTS,
]);

const CHANNEL_SCOPES = Object.freeze([
  'channels:read',
  'messages:read',
  'messages:write',
  'agents:read',
  'agents:dispatch',
  'events:subscribe',
]);

const WORKSPACE_SCOPES = Object.freeze([
  ...CHANNEL_SCOPES,
  'channels:write',
  'members:read',
  'documents:read',
  'documents:write',
  'tasks:read',
  'tasks:write',
  'storage:read',
  'storage:write',
]);

const TOOL_SCOPES = Object.freeze({
  whoami: null,
  list_channels: 'channels:read',
  read_channel: 'messages:read',
  search_messages: 'messages:read',
  list_members: 'members:read',
  list_agents: 'agents:read',
  post_message: 'messages:write',
  dispatch_agent: 'agents:dispatch',
  create_channel: 'channels:write',
  list_docs: 'documents:read',
  read_doc: 'documents:read',
  search_docs: 'documents:read',
  write_doc: 'documents:write',
  list_tasks: 'tasks:read',
  create_task: 'tasks:write',
  update_task: 'tasks:write',
  create_thread_item: 'messages:write',
  update_thread_item: 'messages:write',
  list_thread_items: 'messages:read',
  get_workspace_memory: 'storage:read',
  add_memory: 'storage:write',
});

function codedError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function normalizeEvents(events) {
  const requested = Array.isArray(events) ? events : FLOW_EVENTS;
  return FLOW_EVENTS.filter((event) => requested.includes(event));
}

function normalizeFlowWebhookUrl(value, { production = process.env.NODE_ENV === 'production' } = {}) {
  if (!value) return null;
  let url;
  try { url = new URL(String(value)); } catch { throw codedError('invalid_webhook_url', 'Flows webhook URL is invalid.'); }
  const hostname = url.hostname.toLowerCase();
  const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostname);
  if (loopback) {
    if (production || url.protocol !== 'http:') {
      throw codedError('invalid_webhook_url', 'Loopback Flows webhooks are allowed only over HTTP in local development.');
    }
  } else {
    if (url.protocol !== 'https:') {
      throw codedError('invalid_webhook_url', 'Flows webhook URL must use HTTPS.');
    }
    if (net.isIP(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      throw codedError('invalid_webhook_url', 'Flows webhook URL must use a public hostname.');
    }
  }
  if (url.username || url.password) {
    throw codedError('invalid_webhook_url', 'Flows webhook URL must not contain credentials.');
  }
  return url.toString();
}

function scopesForConnection(channelId) {
  return [...(channelId ? CHANNEL_SCOPES : WORKSPACE_SCOPES)];
}

function connectionCanUseTool(connection, toolName) {
  if (!connection || connection.kind !== 'integration') return true;
  const required = TOOL_SCOPES[toolName];
  if (required === undefined) return false;
  if (required === null) return true;
  return Array.isArray(connection.scopes) && connection.scopes.includes(required);
}

function assertConnectionChannel(connection, requestedChannelId) {
  if (!connection || connection.kind !== 'integration' || !connection.channelId) return;
  if (!requestedChannelId || String(requestedChannelId) !== String(connection.channelId)) {
    throw codedError('channel_scope_violation', 'This connection is limited to a different channel.', 403);
  }
}

function createFlowConnectionCore({ store, now = Date.now, secret = randomSecret } = {}) {
  if (!store) throw new Error('A Flows connection store is required.');

  async function create({ workspaceId, channelId = null, name = 'Flows', webhookUrl = null, events, createdBy = null } = {}) {
    if (!workspaceId) throw codedError('invalid_request', 'workspaceId is required.');
    const token = secret('agx');
    const signingSecret = secret('ags');
    const record = {
      id: crypto.randomUUID(),
      workspaceId: String(workspaceId),
      channelId: channelId ? String(channelId) : null,
      name: String(name || 'Flows').trim().slice(0, 120) || 'Flows',
      tokenHash: hashSecret(token),
      signingSecret,
      webhookUrl: webhookUrl ? String(webhookUrl).trim() : null,
      events: normalizeEvents(events),
      scopes: scopesForConnection(channelId),
      createdBy: createdBy ? String(createdBy) : null,
      createdAt: now(),
      revokedAt: null,
      lastSeenAt: null,
    };
    const stored = await store.insertConnection(record);
    return { connection: stored, token, signingSecret };
  }

  async function authenticate(token) {
    if (!String(token || '').startsWith('agx_')) {
      throw codedError('invalid_token', 'Invalid Flows connection token.', 401);
    }
    const connection = await store.findConnectionByHash(hashSecret(token));
    if (!connection || connection.revokedAt) {
      throw codedError('invalid_token', 'Invalid Flows connection token.', 401);
    }
    await store.touchConnection?.(connection.id, now());
    return {
      kind: 'integration',
      connectionId: connection.id,
      workspaceId: connection.workspaceId,
      channelId: connection.channelId || null,
      name: connection.name || 'Flows',
      scopes: Array.isArray(connection.scopes) ? connection.scopes : [],
    };
  }

  async function revoke(id) {
    return store.revokeConnection(String(id), now());
  }

  return { create, authenticate, revoke };
}

function signFlowWebhook({ secret, timestamp, body }) {
  const digest = crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${body}`).digest('hex');
  return `v1=${digest}`;
}

function verifyFlowWebhook({ secret, timestamp, body, signature }) {
  const expected = signFlowWebhook({ secret, timestamp, body });
  const left = Buffer.from(String(signature || ''));
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function flowWebhookRetryDecision({ httpStatus = null, attempts = 1, maxAttempts = 8 } = {}) {
  const retryable = httpStatus === null
    || httpStatus === 408
    || httpStatus === 409
    || httpStatus === 425
    || httpStatus === 429
    || httpStatus >= 500;
  return {
    retryable,
    dead: !retryable || attempts >= maxAttempts,
    delaySeconds: Math.min(300, Math.max(2, 2 ** attempts)),
  };
}

function createMemoryFlowConnectionStore() {
  const connections = new Map();
  return {
    async insertConnection(record) { connections.set(record.id, { ...record }); return { ...record }; },
    async findConnectionByHash(hash) {
      return [...connections.values()].find((record) => record.tokenHash === hash) || null;
    },
    async touchConnection(id, lastSeenAt) {
      const next = { ...connections.get(id), lastSeenAt };
      connections.set(id, next);
      return next;
    },
    async revokeConnection(id, revokedAt) {
      const current = connections.get(id);
      if (!current) return null;
      const next = { ...current, revokedAt };
      connections.set(id, next);
      return next;
    },
    async listConnections(workspaceId) {
      return [...connections.values()].filter((record) => record.workspaceId === workspaceId);
    },
  };
}

module.exports = {
  CHANNEL_SCOPES,
  FLOW_EVENTS,
  TOOL_SCOPES,
  WORKSPACE_SCOPES,
  assertConnectionChannel,
  connectionCanUseTool,
  createFlowConnectionCore,
  createMemoryFlowConnectionStore,
  hashSecret,
  flowWebhookRetryDecision,
  normalizeEvents,
  normalizeFlowWebhookUrl,
  scopesForConnection,
  signFlowWebhook,
  verifyFlowWebhook,
};
