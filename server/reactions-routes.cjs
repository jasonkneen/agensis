'use strict';

// The one door for writing a reaction.
//
// Everything about WHY this route exists rather than a whole-map PUT through
// /backend/db/update is in shared/reaction-toggle.cjs — read that first. The
// short version: the mutation used to live on the client, so it raced and its
// attribution was forgeable. Here it is one atomic statement with the reactor
// bound from the session.
//
// Dependencies are INJECTED (the pattern of server/inbox-routes.cjs) so the
// auth, RBAC and rate-limit contract stays single-sourced in index.cjs and
// shared/backend-core.cjs, and this file cannot drift from it.

const { emitReactionFlowEventsForUpdate } = require('../shared/reaction-events.cjs');
const {
 REACTION_RETURNING_COLUMNS,
 explainReactionNoop,
 normalizeReactionOp,
 normalizeReactionValue,
 priorReactionMap,
 reactionToggleSql,
} = require('../shared/reaction-toggle.cjs');

function mountReactionsRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, badRequest, getDb, notifyDbSubscribers,
  enforceWorkspaceRole, enforceSessionRead, rateLimitBlocked, reactionRateLimiter,
 } = deps;

 app.post('/backend/messages/:messageId/reactions', requireAuth, async (req, res) => {
  try {
   const messageId = String(req.params.messageId || '').trim();
   if (!messageId) return jsonError(res, 400, badRequest('A message id is required'));

   const op = normalizeReactionOp(req.body?.op);
   if (!op) return jsonError(res, 400, badRequest("op must be 'add' or 'remove'"));

   // The reaction is user data. It is normalized (never trusted) here, and the
   // stored key is the normalized form — so what a webhook later truncates for
   // its payload and what the map holds cannot disagree.
   const reaction = normalizeReactionValue(req.body?.reaction ?? req.body?.emoji);
   if (!reaction) return jsonError(res, 400, badRequest('A reaction is required'));

   // A reaction is a CLICK HANDLER on a widget designed to be clicked
   // repeatedly, and every accepted write fans the whole message row out to
   // every socket in the session. Per (user, message) rather than per user: a
   // burst on one message is the abusive shape, and limiting the user globally
   // would punish someone reading a busy channel.
   if (rateLimitBlocked(res, reactionRateLimiter, `${req.userId}:${messageId}`)) return;

   // Resolve the message's session and workspace BEFORE the write, and pin the
   // write to that same session id. Authorizing one row and mutating another is
   // the classic shape of this bug, so the session the check ran against is the
   // session the UPDATE names.
   const rows = await getDb().unsafe(
    `select m.id, m.session_id, s.workspace_id, s.visibility, s.folder
       from messages m join chat_sessions s on s.id = m.session_id
      where m.id = $1::uuid limit 1`,
    [messageId],
   );
   const found = rows[0];
   if (!found) return jsonError(res, 404, new Error('Message not found'));

   // Reacting is a WRITE on the workspace — it changes a stored row and it
   // publishes your name against someone else's message. A viewer may read the
   // channel and may not annotate it.
   await enforceWorkspaceRole(req.userId, found.workspace_id, 'write');
   // …and the DM gate under it, so a workspace member who is not in a private
   // conversation cannot react into it. Passing the row we already hold means
   // this costs no second query for the common (channel) case.
   await enforceSessionRead(req.userId, found.session_id, found);

   const updated = await getDb().unsafe(
    reactionToggleSql(op),
    [messageId, String(found.session_id), reaction, String(req.userId)],
   );

   // Zero rows means the world already agrees with the request (a repeat click,
   // a retry) or the message is at the distinct-reaction cap. Both are cheap and
   // rare, and only THEN do we pay a read — to choose the answer, never to
   // decide whether to write.
   if (updated.length === 0) {
    const current = await getDb().unsafe(
     `select ${REACTION_RETURNING_COLUMNS} from messages where id = $1::uuid limit 1`,
     [messageId],
    );
    const problem = explainReactionNoop(current[0], { op, reaction, userId: req.userId });
    if (problem) return jsonError(res, problem.status, new Error(problem.message));
    return res.json({
     data: { messageId, reactions: current[0]?.reactions ?? {}, changed: false },
     error: null,
    });
   }

   const after = updated[0];
   notifyDbSubscribers('messages', 'UPDATE', updated);

   // The flow-webhook contract, preserved exactly: reaction events are the DIFF
   // between the map before the write and the map after it, and this module
   // still hands emitReactionFlowEventsForUpdate two real maps to diff. The
   // before-image is DERIVED rather than re-read (priorReactionMap), because a
   // SELECT for it would reintroduce the very race this route exists to remove —
   // and the statement's WHERE guard makes the derivation exact.
   //
   // Fire-and-forget AFTER the row is written and broadcast: an integration that
   // cannot be told about a reaction must never cost somebody their reaction.
   void emitReactionFlowEventsForUpdate({
    db: (sql, params) => getDb().unsafe(sql, params),
    // porsager: bind the OBJECT. A JSON.stringify here becomes a jsonb string
    // scalar (tests/jsonb-bind-hygiene.test.cjs).
    encodeJsonb: (payload) => payload,
    priorRows: [{ ...after, reactions: priorReactionMap(after.reactions, { op, reaction, userId: req.userId }) }],
    updatedRows: updated,
    nextReactions: after.reactions,
    actorUserId: req.userId,
    onWarn: (message) => console.warn('[flows] reaction events:', message),
   }).catch((error) => {
    console.error('[flows] failed to queue reaction event:', error.message || error);
   });

   res.json({ data: { messageId, reactions: after.reactions ?? {}, changed: true }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountReactionsRoutes };
