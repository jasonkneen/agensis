'use strict';

const {
 assertWorkspaceRoleLocked,
 badRequest,
 enforceSessionReadAccess,
 isPrivateSessionRow,
 safeSelectColumns,
} = require('./backend-core.cjs');

const SERVER_CONTROLLED_SESSION_CREATE_COLUMNS = new Set([
 'created_at',
 'updated_at',
 'version',
 'deleted_at',
 'split_at',
]);

const SPLIT_INHERITED_COLUMNS = [
 'model',
 'folder',
 'description',
 'icon',
 'intent',
 'participants',
 'conversation_mode',
 'max_agent_turns',
 'auto_rounds',
];

function sessionLineageKind(row) {
 const hasParentMessage = Boolean(row?.parent_message_id);
 const hasSplitParent = Boolean(row?.split_parent_id);
 if (hasParentMessage && hasSplitParent) {
  throw badRequest('A conversation can have only one parent');
 }
 if (hasParentMessage) return 'subthread';
 if (hasSplitParent) return 'split';
 return 'root';
}

function normalizeSessionCreateRow(row) {
 if (!row || typeof row !== 'object' || Array.isArray(row)) {
  throw badRequest('Conversation values must be an object');
 }
 const next = { ...row };
 for (const column of SERVER_CONTROLLED_SESSION_CREATE_COLUMNS) delete next[column];
 const visibility = String(next.visibility || '').trim();
 if (visibility && visibility !== 'workspace' && visibility !== 'private') {
  throw badRequest('Conversation visibility must be workspace or private');
 }
 if (visibility) next.visibility = visibility;
 else delete next.visibility;
 if (String(next.folder || '').trim() === 'Direct messages') {
  next.folder = 'Direct messages';
  next.visibility = 'private';
 }
 return next;
}

async function loadLineageParent({ db, kind, row, workspaceId }) {
 if (kind === 'split') {
  const parents = await db(
   `select s.id, s.workspace_id, s.title, s.model, s.folder, s.description,
           s.icon, s.intent, s.participants, s.conversation_mode,
           s.max_agent_turns, s.auto_rounds, s.canvas_id, s.visibility,
           s.deleted_at
     from chat_sessions s
     where s.id = $1::uuid
       and s.workspace_id = $2::uuid
       and s.deleted_at is null
       for share of s`,
   [String(row.split_parent_id), String(workspaceId)],
  );
  return parents?.[0] || null;
 }
 if (kind === 'subthread') {
  // Resolve the edge first, then lock in the same order as session closure:
  // session -> message. A single joined FOR SHARE leaves lock order to the
  // query planner and can deadlock with closure, which locks the session before
  // tombstoning its messages. The final message query rechecks the edge after
  // both waits, so a concurrent delete or in-workspace move fails closed.
  const references = await db(
   `select m.session_id
      from messages m
      join chat_sessions s on s.id = m.session_id
     where m.id = $1::uuid
       and s.workspace_id = $2::uuid
       and m.deleted_at is null
       and s.deleted_at is null
     limit 1`,
   [String(row.parent_message_id), String(workspaceId)],
  );
  const parentSessionId = references?.[0]?.session_id;
  if (!parentSessionId) return null;
  const parents = await db(
   `select s.id, s.workspace_id, s.title, s.model, s.folder, s.description,
           s.icon, s.intent, s.participants, s.conversation_mode,
           s.max_agent_turns, s.auto_rounds, s.canvas_id, s.visibility,
           s.deleted_at
     from chat_sessions s
     where s.id = $1::uuid
       and s.workspace_id = $2::uuid
       and s.deleted_at is null
       for share of s`,
   [String(parentSessionId), String(workspaceId)],
  );
  const parent = parents?.[0] || null;
  if (!parent) return null;
  const lockedMessages = await db(
   `select m.id
      from messages m
     where m.id = $1::uuid
       and m.session_id = $2::uuid
       and m.deleted_at is null
       for share of m`,
   [String(row.parent_message_id), String(parent.id)],
  );
  return lockedMessages?.[0] ? parent : null;
 }
 return null;
}

async function lockPrivateSessionRoster({ db, userId, parent }) {
 if (!isPrivateSessionRow(parent)) return [];
 const memberships = await db(
  `select user_id, source, granted_by, expires_at
     from chat_session_members
    where session_id = $1::uuid
      and (expires_at is null or expires_at > now())
    order by user_id
    for share`,
  [String(parent.id)],
 );
 const creatorIsMember = !userId || memberships.some(
  (membership) => String(membership.user_id) === String(userId),
 );
 if (!creatorIsMember) {
  const error = new Error('You do not have access to this conversation');
  error.status = 403;
  throw error;
 }
 return memberships;
}

function inheritLineageFields({ row, kind, parent, now }) {
 const next = {
  ...row,
  workspace_id: parent.workspace_id,
  canvas_id: parent.canvas_id ?? null,
  visibility: isPrivateSessionRow(parent) ? 'private' : 'workspace',
 };
 if (kind === 'split') {
  for (const column of SPLIT_INHERITED_COLUMNS) {
   next[column] = parent[column] ?? null;
  }
  next.split_at = now().toISOString();
  delete next.parent_message_id;
 } else {
  next.folder = 'sub-thread';
  delete next.split_parent_id;
  delete next.split_at;
 }
 return next;
}

/**
 * Resolve and authorize every chat_sessions INSERT row inside the transaction
 * that will perform the INSERT.
 *
 * The generic database route remains the browser transport, but session lineage
 * is not a generic-table concern. A derived conversation inherits its security
 * boundary from an authoritative, locked parent row. Both HTTP runtimes call
 * this function so Netlify cannot accidentally create a public offshoot of a
 * private Fly conversation.
 */
async function prepareSessionCreateRows({
 db,
 userId,
 rows,
 now = () => new Date(),
 assertRole = assertWorkspaceRoleLocked,
 enforceRead = enforceSessionReadAccess,
} = {}) {
 if (typeof db !== 'function') throw new TypeError('prepareSessionCreateRows requires db');
 if (!userId) throw badRequest('A conversation creator is required');
 if (!Array.isArray(rows) || rows.length === 0) {
  throw badRequest('Conversation values are required');
 }
 if (rows.length !== 1) {
  // Membership lineage is indexed to the created row. PostgreSQL does not
  // contractually promise multi-row RETURNING order, so pairing two children
  // to two private rosters by array position is not an authorization design.
  throw badRequest('Create one conversation at a time');
 }

 const prepared = [];
 const lineage = [];
 for (const original of rows) {
  let row = normalizeSessionCreateRow(original);
  const kind = sessionLineageKind(row);
  const requestedWorkspaceId = String(row.workspace_id || '');
  if (!requestedWorkspaceId) throw badRequest('A workspace reference is required');

  // Lock role evidence before touching any session row. Workspace deletion and
  // hierarchy changes take the same outer boundary first; keeping that global
  // order avoids workspace->session versus session->workspace deadlocks.
  await assertRole({
   userId,
   workspaceId: requestedWorkspaceId,
   capability: 'write',
   db,
  });

  if (kind === 'root') {
   prepared.push(row);
   lineage.push({ kind, parentSessionId: null });
   continue;
  }

  const parent = await loadLineageParent({
   db,
   kind,
   row,
   workspaceId: requestedWorkspaceId,
  });
  // One refusal surface for a missing, deleted, or wrong-kind parent. The
  // caller must not learn whether a UUID in another tenant exists.
  if (!parent || String(parent.workspace_id) !== requestedWorkspaceId) {
   throw badRequest('Parent conversation is unavailable');
  }

  await enforceRead({
   userId,
   sessionId: parent.id,
   sessionRow: parent,
   db,
  });
  // Lock the complete live private roster after the canonical read check. This
  // prevents any concurrent participant/grant revoke from committing between
  // authorization and the authoritative child-roster copy.
  await lockPrivateSessionRoster({ db, userId, parent });

  row = inheritLineageFields({ row, kind, parent, now });
  prepared.push(row);
  lineage.push({ kind, parentSessionId: String(parent.id) });
 }

 return { rows: prepared, lineage };
}

/**
 * Install the private-session member graph after INSERT and before COMMIT.
 * Any failure aborts the session INSERT; membership inheritance is never a
 * best-effort fixup because a private conversation without its members is an
 * authorization state, not presentation damage.
 */
async function installCreatedSessionMemberships({
 db,
 userId,
 createdRows,
 lineage,
} = {}) {
 if (typeof db !== 'function') throw new TypeError('installCreatedSessionMemberships requires db');
 if (!Array.isArray(createdRows) || !Array.isArray(lineage) || createdRows.length !== lineage.length) {
  throw new Error('Created conversation rows do not match their lineage');
 }

 for (let index = 0; index < createdRows.length; index += 1) {
  const created = createdRows[index];
  if (!created?.id || !isPrivateSessionRow(created)) continue;
  const parentSessionId = lineage[index]?.parentSessionId || null;
  if (parentSessionId) {
   // The complete live roster was SHARE-locked during preparation. Copy its
   // provenance and expiry unchanged: a creator who holds only a temporary
   // grant must not turn derivation into a permanent participant self-grant.
   await db(
    `insert into chat_session_members
           (session_id, user_id, source, granted_by, expires_at)
       select $1::uuid, members.user_id, members.source,
              members.granted_by, members.expires_at
         from chat_session_members members
        where members.session_id = $2::uuid
          and (members.expires_at is null or members.expires_at > now())
     on conflict (session_id, user_id) do nothing`,
    [String(created.id), parentSessionId],
   );
  } else {
   // Only a root private session synthesizes intrinsic membership. There is no
   // parent provenance to preserve, and without this row its creator could not
   // read the DM they just opened.
   await db(
    `insert into chat_session_members
           (session_id, user_id, source, granted_by, expires_at)
     values ($1::uuid, $2::uuid, 'participant', null, null)
     on conflict (session_id, user_id) do nothing`,
    [String(created.id), String(userId)],
   );
  }
 }
}

function projectSessionCreateRows(rows, columns = '*') {
 const safeColumns = safeSelectColumns('chat_sessions', columns);
 if (!safeColumns || safeColumns === '*') return rows;
 const names = String(safeColumns).split(',').map((column) => column.trim()).filter(Boolean);
 for (const name of names) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
   throw badRequest(`Invalid conversation column: ${name}`);
  }
 }
 return rows.map((row) => Object.fromEntries(
  names.map((column) => [column, row?.[column] ?? null]),
 ));
}

module.exports = {
 SERVER_CONTROLLED_SESSION_CREATE_COLUMNS,
 SPLIT_INHERITED_COLUMNS,
 inheritLineageFields,
 installCreatedSessionMemberships,
 lockPrivateSessionRoster,
 normalizeSessionCreateRow,
 prepareSessionCreateRows,
 projectSessionCreateRows,
 sessionLineageKind,
};
