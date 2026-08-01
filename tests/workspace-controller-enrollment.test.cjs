'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountJoinLinksRoutes } = require('../server/join-links-routes.cjs');
const { mountJoinPagesRoutes } = require('../server/join-pages-routes.cjs');
const { mountControllerRoutes } = require('../server/controller-routes.cjs');
const {
 createControllerCredential,
} = require('../server/controller-credentials.cjs');
const {
 agentNextSteps,
 controllerNextSteps,
 invalidDescriptor,
 joinDescriptor,
 machinePayload,
 previewDescriptor,
 renderJoinHtml,
} = require('../server/join-page.cjs');

function captureApp() {
 const routes = new Map();
 const add = method => (path, ...handlers) => {
  const paths = Array.isArray(path) ? path : [path];
  for (const item of paths) routes.set(`${method} ${item}`, handlers.at(-1));
 };
 return {
  routes,
  get: add('GET'),
  post: add('POST'),
  delete: add('DELETE'),
  patch: add('PATCH'),
 };
}

function response() {
 return {
  statusCode: 200,
  headers: {},
  body: null,
  status(code) { this.statusCode = code; return this; },
  setHeader(name, value) { this.headers[name] = value; },
  json(value) { this.body = value; return this; },
  send(value) { this.body = value; return this; },
 };
}

function jsonError(res, status, error) {
 res.status(status).json({ data: null, error: { message: error.message } });
}

const TOKEN = `agj_${'a'.repeat(43)}`;

function addTransactionSupport(db, { snapshot, restore } = {}) {
 const transaction = {
  unsafe: db.unsafe.bind(db),
 };
 transaction.savepoint = async (callback) => {
  const saved = snapshot ? snapshot() : undefined;
  try {
   return await callback(transaction);
  } catch (error) {
   if (restore) restore(saved);
   throw error;
  }
 };
 db.begin = callback => callback(transaction);
 return db;
}

function controllerJoinDeps(db, audits = []) {
 return {
  jsonError,
  getDb: () => db,
  notifyDbSubscribers: () => undefined,
  rateLimitBlocked: () => false,
  dbRateLimitBlocked: async () => false,
  clientIpFromReq: () => '127.0.0.1',
  agentNextSteps,
  controllerNextSteps,
  bearerToken: () => '',
  configBlock: (_base, placeholder) => ({
   mcpServers: { agensis: { headers: { Authorization: `Bearer ${placeholder}` } } },
  }),
  createAgentConnectToken: () => {
   throw new Error('ordinary agent token must not be minted');
  },
  createControllerCredential,
  hashAgentToken: token => `hash:${token}`,
  invalidDescriptor,
  isJoinLinkToken: () => true,
  joinApiBaseUrl: () => 'https://backend.test',
  joinDescriptor,
  joinLinkRateLimiter: {},
  joinLinkRefused: res => res.status(410).json({ data: null, error: { message: 'Link unavailable' } }),
  joinPublicBaseUrl: () => 'https://agensis.test',
  joinRedeemDbRateLimiter: {},
  joinRedeemRateLimiter: {},
  joinWantsJson: () => true,
  loadJoinLinkForDisplay: async () => null,
  logJoinLinkActivity: async () => undefined,
  machinePayload,
  mcpEndpoint: base => `${base}/backend/mcp`,
  parseJsonArray: value => Array.isArray(value) ? value : JSON.parse(value || '[]'),
  previewDescriptor,
  publicFarmEnrolledAgent: row => row,
  recordAudit: async entry => { audits.push(entry); },
  renderJoinHtml,
  setJoinJsonHeaders: () => undefined,
  setJoinPageHeaders: () => undefined,
  uniqueAgentHandle: async () => 'unused',
  verifyToken: async () => null,
 };
}

test('workspace-control link creation is owner-only, scope-fixed, short-lived, and audited without its token', async () => {
 const calls = [];
 const audits = [];
 const db = {
  async unsafe(sql, params = []) {
   const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   calls.push({ sql: normalized, params });
   if (normalized.startsWith('select id, user_id from workspaces')) {
    return [{ id: 'w1', user_id: 'owner-1' }];
   }
   if (normalized.startsWith('insert into workspace_join_links')) {
    return [{
     id: 'link-1',
     workspace_id: params[0],
     label: params[2],
     role: params[3],
     grant_kind: params[4],
     audience: params[5],
     status: 'pending',
     controller_name: params[6],
     controller_scopes: params[7],
     controller_expires_at: params[8],
     expires_at: params[9],
     created_by: params[10],
     created_at: new Date().toISOString(),
    }];
   }
   return [];
  },
 };
 const app = captureApp();
 mountJoinLinksRoutes(app, {
  requireAuth: (_req, _res, next) => next(),
  jsonError,
  enforceWorkspaceRole: async () => undefined,
  getDb: () => db,
  createJoinLinkToken: () => TOKEN,
  hashAgentToken: token => `hash:${token}`,
  joinLinkTtlMs: () => 15 * 60_000,
  joinPublicBaseUrl: () => 'https://agensis.test',
  joinUrlFor: (base, token) => `${base}/join/${token}`,
  logJoinLinkActivity: async () => undefined,
  recordAudit: async entry => { audits.push(entry); },
  clientIpFromReq: () => '127.0.0.1',
 });
 const handler = app.routes.get('POST /backend/workspaces/:id/join-links');
 const res = response();
 await handler({
  params: { id: 'w1' },
  userId: 'owner-1',
  body: {
   grantKind: 'workspace_control',
   controllerName: 'Local build farm',
   scopes: ['agents:register', 'resources:create'],
  },
 }, res);
 assert.equal(res.statusCode, 200);
 assert.equal(res.body.data.grant_kind, 'workspace_control');
 assert.equal(res.body.data.audience, 'controller');
 assert.equal(res.body.data.expiresInMs, 5 * 60_000);
 assert.ok(res.body.data.credentialExpiresInMs > res.body.data.expiresInMs);
 assert.equal(res.body.data.url, `https://agensis.test/join/${TOKEN}`);
 const insert = calls.find(call => call.sql.startsWith('insert into workspace_join_links'));
 assert.equal(insert.params[4], 'workspace_control');
 assert.deepEqual(insert.params[7], ['agents:register', 'resources:create']);
 assert.equal(audits[0].action, 'controller.enrollment_created');
 assert.equal(JSON.stringify(audits).includes(TOKEN), false);
 assert.equal(JSON.stringify(audits).includes(`hash:${TOKEN}`), false);

 const denied = response();
 await handler({
  params: { id: 'w1' },
  userId: 'admin-member',
  body: {
   grantKind: 'workspace_control',
   controllerName: 'Not owner',
   scopes: ['agents:register'],
  },
 }, denied);
 assert.equal(denied.statusCode, 403);
});

test('controller enrollment redeems once into one agc credential and rejects contradictory lanes', async () => {
 let claimed = false;
 let linkedController = null;
 const audits = [];
 const db = {
  async unsafe(sql, params = []) {
   const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   if (normalized.startsWith('update workspace_join_links set status = \'redeemed\'')) {
    if (claimed || params[1] !== 'controller') return [];
    claimed = true;
    return [{
     id: 'link-1',
     workspace_id: 'w1',
     created_by: 'owner-1',
     grant_kind: 'workspace_control',
     audience: 'controller',
     controller_name: 'Build farm',
     controller_scopes: ['agents:register', 'agents:manage_own'],
     controller_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
     role: 'viewer',
    }];
   }
   if (normalized.startsWith('select id, name from workspaces')) {
    return [{ id: 'w1', name: 'Workspace' }];
   }
   if (normalized.startsWith('insert into workspace_controllers')) {
    return [{
     id: 'controller-1',
     workspace_id: 'w1',
     name: params[1],
     scopes: params[3],
     status: 'active',
     parent_controller_id: null,
     expires_at: params[5],
     created_by: params[6],
    }];
   }
   if (normalized.startsWith('update workspace_join_links set redeemed_controller_id')) {
    linkedController = params[1];
    return [];
   }
   return [];
 },
 };
 addTransactionSupport(db);
 const app = captureApp();
 mountJoinPagesRoutes(app, controllerJoinDeps(db, audits));
 const handler = app.routes.get('POST /backend/join/:token/redeem');
 const first = response();
 await handler({
  params: { token: TOKEN },
  headers: {},
  body: { as: 'controller' },
 }, first);
 assert.equal(first.statusCode, 200);
 assert.equal(first.body.data.as, 'controller');
 assert.equal(first.body.data.controller.id, 'controller-1');
 assert.equal(linkedController, 'controller-1');
 assert.match(first.body.data.credential.token, /^agc_/);
 const serialized = JSON.stringify(first.body);
 assert.equal(serialized.split(first.body.data.credential.token).length - 1, 1);
 assert.match(serialized, /agc_YOUR_CONTROLLER_TOKEN/);
 assert.equal(audits[0].action, 'controller.enrolled');
 assert.equal(JSON.stringify(audits).includes(first.body.data.credential.token), false);

 const replay = response();
 await handler({
  params: { token: TOKEN },
  headers: {},
  body: { as: 'controller' },
 }, replay);
 assert.equal(replay.statusCode, 410);
});

test('a failed controller enrollment rolls back the controller but permanently spends the link', async () => {
 const state = {
  claimed: false,
  controllers: [],
  redeemedControllerId: null,
 };
 const audits = [];
 const db = {
  async unsafe(sql, params = []) {
   const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   if (normalized.startsWith('update workspace_join_links set status = \'redeemed\'')) {
    if (state.claimed || params[1] !== 'controller') return [];
    state.claimed = true;
    return [{
     id: 'link-rollback',
     workspace_id: 'w1',
     created_by: 'owner-1',
     grant_kind: 'workspace_control',
     audience: 'controller',
     controller_name: 'Unreliable build farm',
     controller_scopes: ['agents:register'],
     controller_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
     role: 'viewer',
    }];
   }
   if (normalized.startsWith('select id, name from workspaces')) {
    return [{ id: 'w1', name: 'Workspace' }];
   }
   if (normalized.startsWith('insert into workspace_controllers')) {
    const row = {
     id: 'controller-orphan',
     workspace_id: 'w1',
     name: params[1],
     scopes: params[3],
     status: 'active',
     parent_controller_id: null,
     expires_at: params[5],
     created_by: params[6],
    };
    state.controllers.push(row);
    return [row];
   }
   if (normalized.startsWith('update workspace_join_links set redeemed_controller_id')) {
    state.redeemedControllerId = params[1];
    throw new Error('simulated attribution failure');
   }
   return [];
  },
 };
 addTransactionSupport(db, {
  snapshot: () => ({
   controllers: state.controllers.map(row => ({ ...row })),
   redeemedControllerId: state.redeemedControllerId,
  }),
  restore: saved => {
   state.controllers = saved.controllers;
   state.redeemedControllerId = saved.redeemedControllerId;
  },
 });

 const app = captureApp();
 mountJoinPagesRoutes(app, controllerJoinDeps(db, audits));
 const handler = app.routes.get('POST /backend/join/:token/redeem');

 const failed = response();
 await handler({
  params: { token: TOKEN },
  headers: {},
  body: { as: 'controller' },
 }, failed);
 assert.equal(failed.statusCode, 500);
 assert.equal(state.claimed, true, 'the one-time enrollment link stays spent');
 assert.deepEqual(state.controllers, [], 'savepoint rollback removes the orphan controller');
 assert.equal(state.redeemedControllerId, null);
 assert.deepEqual(audits, [], 'an enrollment that rolled back is not audited as successful');

 const replay = response();
 await handler({
  params: { token: TOKEN },
  headers: {},
  body: { as: 'controller' },
 }, replay);
 assert.equal(replay.statusCode, 410);
});

test('controller list and revoke stay owner-only and return explicit projections', async () => {
 const audits = [];
 const db = {
  async unsafe(sql, params = []) {
   const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   if (normalized.startsWith('select id, user_id from workspaces')) {
    return [{ id: 'w1', user_id: 'owner-1' }];
   }
   if (normalized.startsWith('select id, workspace_id, name, scopes')) {
    return [{
     id: 'controller-1',
     workspace_id: 'w1',
     name: 'Build farm',
     scopes: ['agents:register'],
     status: 'active',
     token_hash: 'must-not-return',
   }];
   }
   if (normalized.startsWith('with recursive controller_tree')) {
    return [{
     id: params[0],
     workspace_id: params[1],
     name: 'Build farm',
     scopes: ['agents:register'],
     status: 'revoked',
     token_hash: 'must-not-return',
   }];
   }
   return [];
  },
 };
 const app = captureApp();
 mountControllerRoutes(app, {
  requireAuth: (_req, _res, next) => next(),
  jsonError,
  getDb: () => db,
  recordAudit: async entry => { audits.push(entry); },
  clientIpFromReq: () => '127.0.0.1',
 });
 const list = response();
 await app.routes.get('GET /backend/workspaces/:id/controllers')({
  params: { id: 'w1' },
  userId: 'owner-1',
 }, list);
 assert.equal(list.statusCode, 200);
 assert.equal(list.body.data[0].name, 'Build farm');
 assert.equal('token_hash' in list.body.data[0], false);

 const revoked = response();
 await app.routes.get('DELETE /backend/workspaces/:id/controllers/:controllerId')({
  params: { id: 'w1', controllerId: 'controller-1' },
  userId: 'owner-1',
 }, revoked);
 assert.equal(revoked.statusCode, 200);
 assert.equal(revoked.body.data.status, 'revoked');
 assert.equal(audits[0].action, 'controller.revoked');
});
