'use strict';

// ============================================================================
// server/public-workspace-routes.cjs
// ----------------------------------------------------------------------------
// Public workspaces: the unauthenticated read routes, the SSE stream, and the
// manage-gated, audited routes that decide what those reads may show.
// Dependencies are INJECTED (the *-routes.cjs convention), so auth, RBAC, rate
// limiting and audit stay single-sourced in index.cjs / shared/backend-core.cjs.
//
// THE PROJECTION IS NOT HERE. Every value these routes return is built by
// shared/public-workspace.cjs, which the Netlify mirror calls too. This file
// only turns "null" into one fixed 404 and wires the stream.
//
// NO ORACLE. A private workspace, a workspace that does not exist and a
// malformed id all answer the same status, body and headers.
//
// THE STREAM POLLS THE SAME READER. It does not hook notifyDbSubscribers:
// that fanout carries raw rows, and a second path out built on it would be a
// second projection to keep in step. One poll per public workspace with
// viewers, shared by every viewer of it, re-checking visibility each tick and
// closing every stream the moment the workspace stops being public.
// ============================================================================

const {
 WORKSPACE_VISIBILITIES,
 POLICY_EVENT_TYPES,
 PUBLIC_EVENT_TYPES,
 AGENT_ACTIVITY_TYPE,
 isUuid,
 normalizePublicPolicyEntry,
 createPublicWorkspaceReader,
} = require('../shared/public-workspace.cjs');

const NOT_FOUND_BODY = Object.freeze({ data: null, error: { message: 'Not found', code: 'not_found' } });
const STREAM_POLL_MS = 5_000;
const STREAM_PING_MS = 25_000;
const STREAM_MAX_PER_IP = 4;
const STREAM_MAX_TOTAL = 500;

/** Read-only, uncached, readable from any origin by GET. Set on every answer, 404 and 429 included. */
function setPublicHeaders(res) {
 res.setHeader('Cache-Control', 'no-store, max-age=0');
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'content-type');
 res.setHeader('Referrer-Policy', 'no-referrer');
 res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendNotFound(res) {
 setPublicHeaders(res);
 res.status(404).json(NOT_FOUND_BODY);
}

function sendPublicError(res, error) {
 setPublicHeaders(res);
 const status = error?.status === 400 ? 400 : 500;
 // A 500 says nothing about why: an error message from the database is a
 // description of the schema.
 const message = status === 400 ? String(error.message || 'Bad request') : 'Public read failed';
 if (status === 500) console.error('[public-workspace] read failed:', error?.message || error);
 res.status(status).json({ data: null, error: { message, code: status === 400 ? 'bad_request' : 'public_read_failed' } });
}

function sseWrite(res, event, data) {
 res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * One poller per public workspace with viewers. Exported for the route test,
 * which drives `tick()` directly instead of waiting on timers.
 */
function createPublicStreamHub({ reader, pollMs = STREAM_POLL_MS, pingMs = STREAM_PING_MS, setTimer = setInterval, clearTimer = clearInterval } = {}) {
 const rooms = new Map(); // workspaceId -> room
 const opening = new Map(); // workspaceId -> Promise<room>, so two first joins share one room
 const perIp = new Map();
 let total = 0;

 function canJoin(ip) {
  return total < STREAM_MAX_TOTAL && (perIp.get(ip) || 0) < STREAM_MAX_PER_IP;
 }

 function closeRoom(room) {
  if (room.closed) return;
  room.closed = true;
  // Only ever remove THIS room: a later viewer may already have opened a new one.
  if (rooms.get(room.workspaceId) === room) rooms.delete(room.workspaceId);
  if (room.pollTimer) clearTimer(room.pollTimer);
  if (room.pingTimer) clearTimer(room.pingTimer);
  for (const client of [...room.clients]) {
   try { client.res.end(); } catch { /* already closed */ }
   release(room, client);
  }
 }

 function release(room, client) {
  if (!room.clients.delete(client)) return;
  total = Math.max(0, total - 1);
  const left = (perIp.get(client.ip) || 1) - 1;
  if (left <= 0) perIp.delete(client.ip);
  else perIp.set(client.ip, left);
 }

 function broadcast(room, event, data) {
  for (const client of room.clients) {
   try { sseWrite(client.res, event, data); } catch { /* the close handler releases it */ }
  }
 }

 async function tick(room) {
  if (room.ticking) return;
  room.ticking = true;
  try {
   const workspace = await reader.loadPublicWorkspace(room.workspaceId);
   if (!workspace) {
    closeRoom(room);
    return;
   }
   const policy = await reader.loadPolicy(workspace.id);
   const page = await reader.eventsFor(workspace, policy, { since: room.cursor, limit: 200 });
   room.cursor = page.next;
   for (const event of page.events) broadcast(room, 'event', event);
   const summary = await reader.summaryFor(workspace, policy);
   for (const agent of summary.agents) {
    const json = JSON.stringify(agent);
    if (room.agents.get(agent.id) !== json) {
     room.agents.set(agent.id, json);
     broadcast(room, 'agent', agent);
    }
   }
  } catch (error) {
   console.error('[public-workspace] stream tick failed:', error?.message || error);
  } finally {
   room.ticking = false;
  }
 }

 async function openRoom(workspace, policy, summary) {
  // The cursor starts at the newest published event, read from the database
  // so the server clock never decides what counts as "after connect".
  const latest = await reader.eventsFor(workspace, policy, { limit: 1 });
  const room = { workspaceId: workspace.id, clients: new Set(), agents: new Map(), cursor: latest.next, ticking: false };
  for (const agent of summary.agents) room.agents.set(agent.id, JSON.stringify(agent));
  room.pollTimer = setTimer(() => { void tick(room); }, pollMs);
  room.pingTimer = setTimer(() => broadcast(room, 'ping', { at: new Date().toISOString() }), pingMs);
  room.pollTimer?.unref?.();
  room.pingTimer?.unref?.();
  rooms.set(workspace.id, room);
  return room;
 }

 async function join({ workspace, policy, summary, res, ip }) {
  let room = rooms.get(workspace.id);
  if (!room) {
   let pending = opening.get(workspace.id);
   if (!pending) {
    pending = openRoom(workspace, policy, summary).finally(() => opening.delete(workspace.id));
    opening.set(workspace.id, pending);
   }
   room = await pending;
  }
  if (room.closed) {
   // The workspace stopped being public while this room was opening.
   try { res.end(); } catch { /* already closed */ }
   return () => {};
  }
  const client = { res, ip };
  room.clients.add(client);
  total += 1;
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  return () => {
   release(room, client);
   if (room.clients.size === 0) closeRoom(room);
  };
 }

 function reset() {
  for (const room of [...rooms.values()]) closeRoom(room);
  perIp.clear();
  total = 0;
 }

 return { canJoin, join, tick: (workspaceId) => (rooms.get(workspaceId) ? tick(rooms.get(workspaceId)) : undefined), rooms, reset };
}

function mountPublicWorkspaceRoutes(app, deps = {}) {
 const {
  getDb, requireAuth, enforceWorkspaceRole, recordAudit, jsonError,
  rateLimitBlocked, dbRateLimitBlocked, clientIpFromReq,
  publicWorkspaceRateLimiter, publicWorkspaceDbRateLimiter, publicStreamHub,
 } = deps;

 const db = (sql, params) => getDb().unsafe(sql, params);
 const reader = createPublicWorkspaceReader({ db });
 const hub = publicStreamHub || createPublicStreamHub({ reader });

 async function limited(req, res) {
  setPublicHeaders(res);
  const key = `public:${clientIpFromReq(req)}`;
  if (publicWorkspaceDbRateLimiter) return dbRateLimitBlocked(res, publicWorkspaceRateLimiter, publicWorkspaceDbRateLimiter, key);
  return rateLimitBlocked(res, publicWorkspaceRateLimiter, key);
 }

 // --- Public reads (no sign-in) ---------------------------------------------

 app.get('/backend/public/workspaces/:id', async (req, res) => {
  if (await limited(req, res)) return;
  try {
   const summary = await reader.getSummary(String(req.params.id || ''));
   if (!summary) return sendNotFound(res);
   setPublicHeaders(res);
   res.json(summary);
  } catch (error) {
   sendPublicError(res, error);
  }
 });

 app.get('/backend/public/workspaces/:id/events', async (req, res) => {
  if (await limited(req, res)) return;
  try {
   const page = await reader.getEvents(String(req.params.id || ''), {
    since: typeof req.query.since === 'string' ? req.query.since : '',
    limit: typeof req.query.limit === 'string' ? req.query.limit : '',
   });
   if (!page) return sendNotFound(res);
   setPublicHeaders(res);
   res.json(page);
  } catch (error) {
   sendPublicError(res, error);
  }
 });

 app.get('/backend/public/workspaces/:id/stream', async (req, res) => {
  if (await limited(req, res)) return;
  try {
   const workspace = await reader.loadPublicWorkspace(String(req.params.id || ''));
   if (!workspace) return sendNotFound(res);
   const ip = String(clientIpFromReq(req));
   if (!hub.canJoin(ip)) {
    setPublicHeaders(res);
    res.setHeader('Retry-After', '30');
    return res.status(429).json({ data: null, error: { message: 'Too many open streams. Please retry shortly.', code: 'rate_limited' } });
   }
   const policy = await reader.loadPolicy(workspace.id);
   const summary = await reader.summaryFor(workspace, policy);
   setPublicHeaders(res);
   res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
   res.setHeader('Connection', 'keep-alive');
   res.setHeader('X-Accel-Buffering', 'no');
   res.status(200);
   res.flushHeaders?.();
   sseWrite(res, 'snapshot', summary);
   // Listen for the close BEFORE joining: a viewer who leaves while the room
   // is opening must still be released.
   let closed = false;
   let leave = null;
   req.on('close', () => {
    closed = true;
    if (leave) leave();
   });
   leave = await hub.join({ workspace, policy, summary, res, ip });
   if (closed) leave();
  } catch (error) {
   if (!res.headersSent) sendPublicError(res, error);
   else res.end();
  }
 });

 app.get('/backend/public/marketplace/listings', async (req, res) => {
  if (await limited(req, res)) return;
  try {
   const result = await reader.getListings({
    category: typeof req.query.category === 'string' ? req.query.category : '',
    q: typeof req.query.q === 'string' ? req.query.q : '',
   });
   setPublicHeaders(res);
   res.json(result);
  } catch (error) {
   sendPublicError(res, error);
  }
 });

 // --- The owner's controls (manage, audited) ---------------------------------

 function requireWorkspaceId(req) {
  const id = String(req.params.id || '').trim();
  if (!isUuid(id)) throw Object.assign(new Error('Workspace not found'), { status: 404 });
  return id;
 }

 async function readPolicyState(workspaceId) {
  const workspaces = await getDb().unsafe('select visibility from workspaces where id = $1 limit 1', [workspaceId]);
  if (!workspaces[0]) throw Object.assign(new Error('Workspace not found'), { status: 404 });
  const rows = await getDb().unsafe(
   'select event_type, level, detail, updated_at from workspace_public_policy where workspace_id = $1 order by event_type asc',
   [workspaceId],
  );
  return {
   visibility: WORKSPACE_VISIBILITIES.includes(workspaces[0].visibility) ? workspaces[0].visibility : 'private',
   policies: rows.map((row) => ({
    eventType: String(row.event_type),
    level: String(row.level),
    detail: String(row.detail),
    updatedAt: row.updated_at,
   })),
   eventTypes: POLICY_EVENT_TYPES.map((eventType) => ({
    eventType,
    category: eventType === AGENT_ACTIVITY_TYPE ? 'agents' : PUBLIC_EVENT_TYPES[eventType].category,
    ceiling: eventType === AGENT_ACTIVITY_TYPE ? 'category' : PUBLIC_EVENT_TYPES[eventType].ceiling,
   })),
  };
 }

 app.get('/backend/workspaces/:id/public-policy', requireAuth, async (req, res) => {
  try {
   const workspaceId = requireWorkspaceId(req);
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   res.json({ data: await readPolicyState(workspaceId), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.patch('/backend/workspaces/:id/visibility', requireAuth, async (req, res) => {
  try {
   const workspaceId = requireWorkspaceId(req);
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const visibility = String(req.body?.visibility || '');
   if (!WORKSPACE_VISIBILITIES.includes(visibility)) {
    return jsonError(res, 400, new Error(`visibility must be one of ${WORKSPACE_VISIBILITIES.join(', ')}`));
   }
   const before = await getDb().unsafe('select visibility from workspaces where id = $1 limit 1', [workspaceId]);
   if (!before[0]) return jsonError(res, 404, new Error('Workspace not found'));
   const previous = String(before[0].visibility || 'private');
   if (previous !== visibility) {
    await getDb().unsafe('update workspaces set visibility = $2, updated_at = now() where id = $1', [workspaceId, visibility]);
    await recordAudit({
     workspaceId,
     actor: { userId: req.userId ? String(req.userId) : '' },
     action: 'workspace.visibility_changed',
     target: { type: 'workspace', id: workspaceId },
     before: previous,
     after: visibility,
     requestIp: clientIpFromReq(req),
    });
   }
   res.json({ data: await readPolicyState(workspaceId), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.put('/backend/workspaces/:id/public-policy', requireAuth, async (req, res) => {
  try {
   const workspaceId = requireWorkspaceId(req);
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const result = normalizePublicPolicyEntry(req.body);
   if (!result.ok) return jsonError(res, 400, new Error(result.errors.join('; ')));
   const { eventType, level, detail } = result.entry;
   const existing = await getDb().unsafe(
    'select level, detail from workspace_public_policy where workspace_id = $1 and event_type = $2 limit 1',
    [workspaceId, eventType],
   );
   const before = existing[0] ? `${existing[0].level}/${existing[0].detail}` : 'none';
   const after = `${level}/${detail}`;
   if (before !== after) {
    await getDb().unsafe(
     `insert into workspace_public_policy (workspace_id, event_type, level, detail, updated_by, updated_at)
           values ($1, $2, $3, $4, $5, now())
      on conflict (workspace_id, event_type)
      do update set level = excluded.level, detail = excluded.detail,
                    updated_by = excluded.updated_by, updated_at = now()`,
     [workspaceId, eventType, level, detail, req.userId ? String(req.userId) : null],
    );
    await recordAudit({
     workspaceId,
     actor: { userId: req.userId ? String(req.userId) : '' },
     action: 'workspace.public_policy_changed',
     target: { type: 'workspace_public_policy', id: workspaceId, label: eventType },
     before,
     after,
     detail: { eventType },
     requestIp: clientIpFromReq(req),
    });
   }
   res.json({ data: await readPolicyState(workspaceId), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/public-policy/:eventType', requireAuth, async (req, res) => {
  try {
   const workspaceId = requireWorkspaceId(req);
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const eventType = String(req.params.eventType || '');
   if (!POLICY_EVENT_TYPES.includes(eventType)) return jsonError(res, 400, new Error('Unknown event type'));
   const removed = await getDb().unsafe(
    'delete from workspace_public_policy where workspace_id = $1 and event_type = $2 returning level, detail',
    [workspaceId, eventType],
   );
   if (removed[0]) {
    await recordAudit({
     workspaceId,
     actor: { userId: req.userId ? String(req.userId) : '' },
     action: 'workspace.public_policy_changed',
     target: { type: 'workspace_public_policy', id: workspaceId, label: eventType },
     before: `${removed[0].level}/${removed[0].detail}`,
     after: 'none',
     detail: { eventType },
     requestIp: clientIpFromReq(req),
    });
   }
   res.json({ data: await readPolicyState(workspaceId), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 return { hub, reader };
}

module.exports = {
 mountPublicWorkspaceRoutes,
 createPublicStreamHub,
 setPublicHeaders,
 NOT_FOUND_BODY,
};
