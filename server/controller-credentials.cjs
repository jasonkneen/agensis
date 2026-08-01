'use strict';

const crypto = require('node:crypto');
const {
 createControllerToken,
 isControllerToken,
 normalizeControllerName,
 normalizeControllerScopes,
 controllerScopesAreSubset,
 publicController,
} = require('../shared/workspaceControl.cjs');

function httpError(status, message) {
 const error = new Error(message);
 error.status = status;
 return error;
}

function hashControllerToken(token) {
 return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function scopesFromRow(value) {
 if (Array.isArray(value)) return value;
 if (typeof value !== 'string') return [];
 try {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
 } catch {
  return [];
 }
}

async function requireWorkspaceOwner({ db, userId, workspaceId }) {
 if (!workspaceId) throw httpError(400, 'workspace id is required');
 const rows = await db.unsafe(
  'select id, user_id from workspaces where id = $1 limit 1',
  [workspaceId],
 );
 if (!rows[0]) throw httpError(404, 'Workspace not found');
 if (!userId || String(rows[0].user_id || '') !== String(userId)) {
  throw httpError(403, 'Only the workspace owner can issue workspace-control credentials');
 }
 return rows[0];
}

async function createControllerCredential({
 db,
 workspaceId,
 name,
 scopes,
 expiresAt,
 createdBy = null,
 parentControllerId = null,
}) {
 const controllerName = normalizeControllerName(name);
 if (!controllerName) throw httpError(400, 'controller name is required');
 const parsed = normalizeControllerScopes(scopes);
 if (!parsed.ok) throw httpError(400, parsed.errors.join('; '));

 const expiry = new Date(expiresAt);
 if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
  throw httpError(400, 'controller expiry must be in the future');
 }

 if (parentControllerId) {
  const parents = await db.unsafe(
   `select id, workspace_id, scopes, expires_at
      from workspace_controllers
     where id = $1 and workspace_id = $2 and status = 'active' and expires_at > now()
     limit 1`,
   [parentControllerId, workspaceId],
  );
  const parent = parents[0];
  if (!parent) throw httpError(403, 'Parent controller is unavailable');
  if (!controllerScopesAreSubset(parsed.scopes, scopesFromRow(parent.scopes))) {
   throw httpError(403, 'A child controller cannot exceed its parent scopes');
  }
  if (new Date(parent.expires_at).getTime() < expiry.getTime()) {
   throw httpError(403, 'A child controller cannot outlive its parent');
  }
 }

 const token = createControllerToken();
 const rows = await db.unsafe(
  `insert into workspace_controllers
      (workspace_id, name, token_hash, scopes, status, parent_controller_id, expires_at, created_by)
      values ($1, $2, $3, $4::jsonb, 'active', $5, $6, $7)
      returning id, workspace_id, name, scopes, status, parent_controller_id,
                expires_at, last_used_at, created_by, created_at, updated_at, revoked_at`,
  [
   workspaceId,
   controllerName,
   hashControllerToken(token),
   parsed.scopes,
   parentControllerId || null,
   expiry,
   createdBy || null,
  ],
 );
 if (!rows[0]) throw httpError(500, 'Controller could not be created');
 return { controller: publicController(rows[0]), token };
}

async function verifyControllerToken({ db, token }) {
 if (!isControllerToken(token)) return null;
 const rows = await db.unsafe(
  `select id, workspace_id, name, scopes, status, parent_controller_id,
          expires_at, last_used_at, created_by, created_at, updated_at, revoked_at
     from workspace_controllers
    where token_hash = $1
      and status = 'active'
      and expires_at > now()
    limit 1`,
  [hashControllerToken(token)],
 );
 const row = rows[0];
 if (!row) return null;
 const parsed = normalizeControllerScopes(scopesFromRow(row.scopes), { defaultScopes: [] });
 if (!parsed.ok) return null;

 // One conditional write per minute at most. Last-used telemetry must never turn
 // an otherwise valid credential into a failed request.
 try {
  await db.unsafe(
   `update workspace_controllers
       set last_used_at = now(), updated_at = now()
     where id = $1
       and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
   [row.id],
  );
 } catch {
  // Deliberately best effort.
 }

 return {
  kind: 'controller',
  controllerId: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  scopes: parsed.scopes,
 };
}

async function revokeController({ db, workspaceId, controllerId }) {
 const rows = await db.unsafe(
  `with recursive controller_tree as (
      select id
        from workspace_controllers
       where id = $1 and workspace_id = $2 and status = 'active'
      union all
      select child.id
        from workspace_controllers child
        join controller_tree parent on child.parent_controller_id = parent.id
       where child.workspace_id = $2
    ),
    revoked as (
      update workspace_controllers
         set status = 'revoked', revoked_at = now(), updated_at = now()
       where id in (select id from controller_tree)
         and workspace_id = $2
         and status = 'active'
       returning id, workspace_id, name, scopes, status, parent_controller_id,
                 expires_at, last_used_at, created_by, created_at, updated_at, revoked_at
    )
    select * from revoked`,
  [controllerId, workspaceId],
 );
 const root = rows.find((row) => String(row.id) === String(controllerId));
 return root ? publicController(root) : null;
}

async function controllerOwnsAgent({ db, identity, agentId }) {
 if (!identity || identity.kind !== 'controller' || !agentId) return false;
 const rows = await db.unsafe(
  `select id
     from workspace_agents
    where id = $1 and workspace_id = $2 and controller_id = $3
    limit 1`,
  [agentId, identity.workspaceId, identity.controllerId],
 );
 return Boolean(rows[0]);
}

module.exports = {
 httpError,
 hashControllerToken,
 scopesFromRow,
 requireWorkspaceOwner,
 createControllerCredential,
 verifyControllerToken,
 revokeController,
 controllerOwnsAgent,
};
