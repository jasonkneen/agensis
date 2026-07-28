'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// The inbox and the threads list — what is addressed to YOU.
//
// Both are SQL-shaped in shared helpers (buildInboxSql / buildThreadInboxSql) so
// the "unread" comparison and the follow rules have one definition. An inbox row
// is not "everything in a channel"; it is a mention, a reply to something you
// wrote, or a DM. Getting that filter wrong turns the inbox into a second
// activity feed, which is the failure mode it exists to avoid.

function mountInboxRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, INBOX_DEFAULT_LIMIT,
  INBOX_FILTERS, INBOX_MAX_LIMIT, THREAD_INBOX_DEFAULT_LIMIT, buildInboxSql,
  buildThreadInboxSql, inboxMentionHandle, inboxMentionPattern, toInboxItem,
  toThreadInboxItem,
 } = deps;

 app.get('/backend/workspaces/:workspaceId/threads', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const limit = Math.trunc(Number(req.query.limit)) || THREAD_INBOX_DEFAULT_LIMIT;
   const rows = await getDb().unsafe(buildThreadInboxSql(limit), [workspaceId, String(req.userId)]);
   const items = rows.map(toThreadInboxItem);
   // Counted over the returned window, like the inbox badge: more unread than
   // the cap is a "lots" signal, not a number anyone acts on precisely.
   const unreadCount = items.reduce((n, item) => n + (item.unread ? 1 : 0), 0);
   res.json({ data: { items, unreadCount }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:workspaceId/inbox', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const filter = String(req.query.filter || 'all').trim().toLowerCase();
   if (!INBOX_FILTERS.has(filter)) return jsonError(res, 400, new Error('Unknown inbox filter'));
   const limit = Math.min(INBOX_MAX_LIMIT, Math.max(1, Math.trunc(Number(req.query.limit)) || INBOX_DEFAULT_LIMIT));

   const userRows = await getDb().unsafe('select display_name, email from app_users where id = $1 limit 1', [req.userId]);
   const pattern = inboxMentionPattern(inboxMentionHandle(userRows[0]));

   const rows = await getDb().unsafe(buildInboxSql(limit), [workspaceId, String(req.userId), pattern]);
   const all = rows.map(toInboxItem);
   // unreadCount is deliberately computed over EVERY category, not the filtered
   // view, so the badge does not change when the user switches tabs. It counts
   // the bounded window this query returns — an inbox with more unread than that
   // is a "lots" signal, not a precise number.
   const unreadCount = all.reduce((n, item) => n + (item.unread ? 1 : 0), 0);
   const items = (filter === 'all' ? all : all.filter((item) => item.category === filter)).slice(0, limit);
   res.json({ data: { items, unreadCount }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Advance the caller's read marker for one context. MONOTONIC: the upsert's
 // WHERE guard drops a readAt that is not newer than the stored one, so a slow
 // or out-of-order write (a second device that was behind) can never un-read an
 // item. Always reports ok — "already at or ahead of this point" is success.
 app.post('/backend/inbox/read', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.body?.workspaceId || req.body?.workspace_id || '').trim();
   const contextKey = String(req.body?.contextKey || req.body?.context_key || '').trim().slice(0, 200);
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   if (!contextKey) return jsonError(res, 400, new Error('contextKey is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rawReadAt = req.body?.readAt ?? req.body?.read_at;
   const readAt = rawReadAt === undefined || rawReadAt === null || rawReadAt === ''
    ? new Date()
    : new Date(rawReadAt);
   if (Number.isNaN(readAt.getTime())) return jsonError(res, 400, new Error('readAt must be an ISO timestamp'));
   // Stored at MILLISECOND resolution to match what the read predicate compares
   // against (see buildInboxSql). Normalising on the way in means the column's
   // contract holds whoever writes it, not just callers that happen to be
   // JavaScript — and it keeps the monotonic guard below comparing like with
   // like, so a marker cannot creep forward by sub-millisecond noise.
   await getDb().unsafe(
    `insert into inbox_read_state (user_id, workspace_id, context_key, read_at)
         values ($1::uuid, $2::uuid, $3, date_trunc('milliseconds', $4::timestamptz))
         on conflict (user_id, workspace_id, context_key)
         do update set read_at = excluded.read_at, updated_at = now()
         where inbox_read_state.read_at < excluded.read_at`,
    [String(req.userId), workspaceId, contextKey, readAt.toISOString()],
   );
   res.json({ data: { ok: true }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- Link preview cards ----------------------------------------------------
 //
 // The browser CANNOT do this itself: it cannot read a cross-origin document
 // (CORS), and if it could, every reader's IP would be handed to every host
 // anybody links to. One fetch here, cached, is both the only workable option
 // and the private one.
 //
 // Every security decision lives in server/link-preview.cjs (SSRF gate, budget,
 // untrusted-text clamp) and is tested there. This route is the boring half:
 // validate, read cache, fetch the misses, write the cache, answer. Note there
 // is no jsonb column anywhere in this feature — the whole row is text and
 // timestamps, so the porsager-stringify trap (tests/jsonb-bind-hygiene) has
 // nothing to catch here.
 //
 // `urls` comes from the client's own extractor (src/lib/linkPreview.ts). It is
 // re-validated here regardless: a drift between the two extractors can only
 // change which cards appear, never what this server is willing to fetch.
}

module.exports = { mountInboxRoutes };
