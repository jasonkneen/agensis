'use strict';

// In-app feedback reports.
//
// Wave 2 of the server/index.cjs reduction: the first ROUTE module. Same shape
// as huddles.cjs and voice.cjs — index.cjs calls mountFeedbackRoutes(app, deps)
// once, and every dependency is INJECTED rather than imported, so the auth and
// rate-limit contract stays single-sourced in index.cjs / shared/backend-core.cjs
// and this file cannot drift from it.
//
// The report itself is built by shared/backend-core.cjs (normalizeFeedbackSubmission
// / insertFeedbackReport), which the Netlify mirror also calls — so both lanes
// write the same row. This module is only the Fly-side route and its realtime
// fanout, which Netlify has no websocket layer for.

function mountFeedbackRoutes(app, deps = {}) {
 const {
  requireAuth,
  jsonError,
  notifyDbSubscribers,
  dbRateLimitBlocked,
  clientIpFromReq,
  // Not in coreDeps: this route's own limiter pair and the raw query helper.
  feedbackRateLimiter,
  feedbackDbRateLimiter,
  dbQuery,
  normalizeFeedbackSubmission,
  insertFeedbackReport,
 } = deps;

 app.post('/backend/feedback', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, feedbackRateLimiter, feedbackDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   // Re-validate, re-clamp and RE-REDACT. The browser already redacted before
   // sending, but a request that did not come from our client would not have,
   // and a feedback endpoint that trusts the caller to have scrubbed its own
   // console is not a control at all.
   const submission = normalizeFeedbackSubmission(req.body);
   const sourceWorkspaceId = String(req.body?.workspaceId || req.body?.workspace_id || '').trim() || null;
   const result = await insertFeedbackReport({
    db: dbQuery,
    // postgres.js: bind the OBJECT. JSON.stringify here would store a jsonb
    // string scalar and every `diagnostics->>'…'` would silently return NULL.
    // Verified against the live database — see insertFeedbackReport's comment.
    jsonParam: (value) => value,
    userId: req.userId,
    sourceWorkspaceId,
    submission,
   });
   // Fan the new task out to anyone with the System workspace open, so a report
   // appears in the review list without a reload. Re-selected rather than
   // returned from the insert because the fanout carries the whole row, and the
   // insert only needs the id. Fly only: Netlify has no WebSocket layer.
   // Never lets a broadcast failure fail an accepted report.
   try {
    const taskRows = await dbQuery('select * from tasks where id = $1', [result.taskId]);
    if (taskRows.length > 0) notifyDbSubscribers('tasks', 'INSERT', taskRows);
   } catch (error) {
    console.warn('[feedback] realtime fanout failed:', error.message || error);
   }
   res.json({ data: { ok: true, taskId: result.taskId }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountFeedbackRoutes };
