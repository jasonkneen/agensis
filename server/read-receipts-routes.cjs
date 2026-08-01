'use strict';

// Read receipts: advance my marker, and read the session's markers.
//
// The model, the clock decision and the opt-out all live in
// shared/read-receipts.cjs, which owns the SQL so both backends run the same
// statements. This file is the boring half — validate, authorize, execute,
// broadcast.
//
// THE TWO THINGS THIS ROUTE EXISTS TO OWN, and the reason generic writes to
// session_read_state are gated at 'manage' (i.e. unreachable in the product):
//
//   1. `user_id` is req.userId. Never a body field. Otherwise anyone could claim
//      anyone read anything.
//   2. `read_at` is resolved from the named message's own `created_at`. The
//      client sends a message ID, never a timestamp, so markers and messages are
//      stamped by ONE clock and browser skew cannot make a receipt lie.

const { ADVANCE_READ_MARKER_SQL, SESSION_READ_STATE_SQL, toReadMarker } = require('../shared/read-receipts.cjs');
const RECEIPT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalThreadParent(value) {
 const normalized = String(value || '').trim();
 if (!normalized) return null;
 if (!RECEIPT_UUID_RE.test(normalized)) {
  const error = new Error('threadParentId must be a UUID');
  error.status = 400;
  throw error;
 }
 return normalized;
}

function mountReadReceiptsRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, badRequest, getDb, notifyDbSubscribers,
  enforceWorkspaceRole, enforceSessionRead, rateLimitBlocked, readReceiptRateLimiter,
 } = deps;

 // Resolve the session once and run BOTH gates on it: the workspace membership
 // check, then the DM gate under it. Returns the row so neither route re-reads.
 async function authorizeSessionRead(req, sessionId) {
  const rows = await getDb().unsafe(
   'select id, workspace_id, visibility, folder, deleted_at from chat_sessions where id = $1::uuid limit 1',
   [sessionId],
  );
  const session = rows[0];
  if (!session) {
   const error = new Error('Conversation not found');
   error.status = 404;
   throw error;
  }
  await enforceWorkspaceRole(req.userId, session.workspace_id, 'read');
  await enforceSessionRead(req.userId, sessionId, session);
  return session;
 }

 // Advance my marker to the message I have seen. Always reports ok: "already at
 // or ahead of this point" is success, and so is "I have receipts switched off"
 // — a caller must not be able to detect another user's setting by probing, and
 // their own client already knows their own.
 app.post('/backend/sessions/:sessionId/read', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.params.sessionId || '').trim();
   if (!sessionId) return jsonError(res, 400, badRequest('A session id is required'));
   const messageId = String(req.body?.lastSeenMessageId || req.body?.last_seen_message_id || '').trim();
   if (!messageId) return jsonError(res, 400, badRequest('lastSeenMessageId is required'));
   const threadParentId = optionalThreadParent(req.body?.threadParentId || req.body?.thread_parent_id);

   // Per (user, session). The emit policy in src/lib/readReceipts.ts already
   // throttles to one write per RECEIPT_REARM_MS, so this is the floor under a
   // client that ignores it, not the product's normal cadence.
   if (rateLimitBlocked(res, readReceiptRateLimiter, `${req.userId}:${sessionId}:${threadParentId || 'channel'}`)) return;

   await authorizeSessionRead(req, sessionId);

   const rows = await getDb().unsafe(
    ADVANCE_READ_MARKER_SQL,
    [sessionId, String(req.userId), messageId, threadParentId],
   );

   // Rows come back ONLY when the marker actually moved. A no-op must not
   // broadcast: an idle reader re-confirming the same position would otherwise
   // be indistinguishable from new reading, on every socket in the session.
   if (rows.length > 0) notifyDbSubscribers('session_read_state', 'INSERT', rows);

   res.json({ data: { ok: true, marker: rows[0] ? toReadMarker(rows[0]) : null }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Every marker for this session, for the initial render. Realtime keeps it
 // fresh afterwards; this is the one fetch that makes an eye appear on a
 // conversation you have just opened rather than only on activity since.
 app.get('/backend/sessions/:sessionId/read-state', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.params.sessionId || '').trim();
   if (!sessionId) return jsonError(res, 400, badRequest('A session id is required'));
   const threadParentId = optionalThreadParent(req.query?.thread_parent_id || req.query?.threadParentId);
   await authorizeSessionRead(req, sessionId);
   const rows = await getDb().unsafe(SESSION_READ_STATE_SQL, [sessionId, String(req.userId), threadParentId]);
   res.json({ data: { markers: rows.map(toReadMarker) }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountReadReceiptsRoutes };
