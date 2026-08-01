'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
 mountWorkspaceResourceRoutes,
 operationRequest,
 queryBoolean,
 resourceDefinition,
 userActor,
} = require('../server/workspace-resource-routes.cjs');

function mountedRoutes(workspaceResources = {}) {
 const routes = new Map();
 const app = {
  get(path, ...handlers) { routes.set(`GET ${path}`, handlers.at(-1)); },
  post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)); },
  patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers.at(-1)); },
  delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers.at(-1)); },
 };
 mountWorkspaceResourceRoutes(app, {
  requireAuth: (_req, _res, next) => next(),
  jsonError(res, status, error) {
   res.status(status).json({ data: null, error: { message: error.message } });
  },
  workspaceResources,
 });
 return routes;
}

function response() {
 return {
  statusCode: 200,
  payload: null,
  status(code) {
   this.statusCode = code;
   return this;
  },
  json(payload) {
   this.payload = payload;
   return this;
  },
 };
}

test('route helpers build identities from authentication, never request bodies', () => {
 assert.deepEqual(userActor({ userId: 'signed-in' }, 'w1'), {
  kind: 'user',
  userId: 'signed-in',
  workspaceId: 'w1',
 });
 assert.deepEqual(resourceDefinition({
  body: { stewardAgentId: 'a1', name: 'Runbook', facet: 'knowledge' },
 }), { name: 'Runbook', facet: 'knowledge' });
 assert.deepEqual(resourceDefinition({
  body: { steward_agent_id: 'a1', definition: { name: 'Runbook' } },
 }), { name: 'Runbook' });
});

test('operation idempotency accepts the standard header only when the body has no key', () => {
 assert.deepEqual(operationRequest({
  headers: { 'idempotency-key': 'request-1' },
  body: { operation: 'read', inputArtifact: {} },
 }), { operation: 'read', inputArtifact: {}, idempotencyKey: 'request-1' });
 assert.equal(operationRequest({
  headers: { 'idempotency-key': 'header-key' },
  body: { operation: 'read', idempotencyKey: 'body-key' },
 }).idempotencyKey, 'body-key');
});

test('includeArtifacts query values are parsed strictly', () => {
 assert.equal(queryBoolean(undefined, true), true);
 assert.equal(queryBoolean('true'), true);
 assert.equal(queryBoolean('false', true), false);
 assert.throws(() => queryBoolean('yes'), /must be true or false/);
});

test('human create and request routes pass only authenticated identity to the service', async () => {
 const calls = [];
 const routes = mountedRoutes({
  async createResource(input) {
   calls.push(['create', input]);
   return { id: 'r1' };
  },
  async requestOperation(input) {
   calls.push(['request', input]);
   return { id: 'o1', status: 'pending' };
  },
 });

 const createRes = response();
 await routes.get('POST /backend/workspaces/:id/resources')({
  userId: 'signed-in',
  params: { id: 'w1' },
  body: {
   userId: 'forged',
   actor: { kind: 'controller', controllerId: 'forged' },
   stewardAgentId: 'a1',
   definition: { name: 'Runbook', facet: 'knowledge' },
  },
  headers: {},
 }, createRes);
 assert.equal(createRes.statusCode, 201);
 assert.deepEqual(calls[0][1], {
  workspaceId: 'w1',
  stewardAgentId: 'a1',
  definition: { name: 'Runbook', facet: 'knowledge' },
  actor: { kind: 'user', userId: 'signed-in', workspaceId: 'w1' },
 });

 const requestRes = response();
 await routes.get('POST /backend/workspaces/:id/resources/:resourceId/operations')({
  userId: 'signed-in',
  params: { id: 'w1', resourceId: 'r1' },
  body: { operation: 'propose', inputArtifact: { change: 'x' } },
  headers: { 'idempotency-key': 'proposal-1' },
 }, requestRes);
 assert.equal(requestRes.statusCode, 202);
 assert.deepEqual(calls[1][1], {
  workspaceId: 'w1',
  resourceId: 'r1',
  requester: { kind: 'user', userId: 'signed-in', workspaceId: 'w1' },
  request: {
   operation: 'propose',
   inputArtifact: { change: 'x' },
   idempotencyKey: 'proposal-1',
  },
 });
});

test('delete and restore routes use the authenticated workspace manager identity', async () => {
 const calls = [];
 const routes = mountedRoutes({
  async deleteResource(input) { calls.push(['delete', input]); return { id: 'r1', deleted_at: 'now' }; },
  async restoreResource(input) { calls.push(['restore', input]); return { id: 'r1', deleted_at: null }; },
 });
 const req = { userId: 'signed-in', params: { id: 'w1', resourceId: 'r1' }, body: {}, headers: {} };
 const deleted = response();
 await routes.get('DELETE /backend/workspaces/:id/resources/:resourceId')(req, deleted);
 const restored = response();
 await routes.get('POST /backend/workspaces/:id/resources/:resourceId/restore')(req, restored);
 assert.equal(deleted.statusCode, 200);
 assert.equal(restored.statusCode, 200);
 assert.deepEqual(calls.map(([, input]) => input.actor), [
  { kind: 'user', userId: 'signed-in', workspaceId: 'w1' },
  { kind: 'user', userId: 'signed-in', workspaceId: 'w1' },
 ]);
});

test('operation read routes keep artifacts opt-in for lists and on for detail', async () => {
 const calls = [];
 const routes = mountedRoutes({
  async listOperations(input) {
   calls.push(input);
   return [];
  },
  async getOperation(input) {
   calls.push(input);
   return { id: input.operationId };
  },
 });

 await routes.get('GET /backend/workspaces/:id/resource-operations')({
  userId: 'u1',
  params: { id: 'w1' },
  query: {},
 }, response());
 await routes.get('GET /backend/workspaces/:id/resource-operations/:operationId')({
  userId: 'u1',
  params: { id: 'w1', operationId: 'o1' },
  query: {},
 }, response());

 assert.equal(calls[0].includeArtifacts, false);
 assert.equal(calls[1].includeArtifacts, true);
});

test('the Netlify HTTP mirror delegates every resource route to the shared service', () => {
 const source = fs.readFileSync(
  path.resolve(__dirname, '../netlify/functions/backend.mjs'),
  'utf8',
 );
 assert.match(source, /import \{ createWorkspaceResourceService \} from '\.\.\/\.\.\/server\/workspace-resources\.cjs'/);
 assert.match(source, /begin: callback => withDbTransaction/);
 for (const method of [
  'listResources', 'getResource', 'createResource', 'updateResource',
  'requestOperation', 'listOperations', 'getOperation',
  'deleteResource', 'restoreResource',
 ]) {
  assert.match(source, new RegExp(`workspaceResources\\.${method}\\(`), `Netlify missing ${method}`);
 }
 assert.match(source, /idempotency-key/);
 assert.match(source, /'Access-Control-Allow-Headers': '[^']*idempotency-key/);
});
