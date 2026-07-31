'use strict';

// Authenticated management and read surfaces for Nostr community connections.
// Invite codes and Nostr private keys never appear in a response.

function mountNostrCommunityRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, enforceSessionRead,
  getDb, nostrCommunities,
 } = deps;

 app.post('/backend/nostr-communities/preview', requireAuth, async (req, res) => {
  try {
   const preview = await nostrCommunities.previewInvite(req.body?.inviteUrl);
   res.json({ data: preview, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:workspaceId/nostr-communities', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.workspaceId || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const result = await nostrCommunities.connectCommunity({
    workspaceId,
    inviteUrl: req.body?.inviteUrl,
    policyVersion: String(req.body?.policyVersion || ''),
    ageConfirmed: req.body?.ageConfirmed === true,
    termsAccepted: req.body?.termsAccepted === true,
    privacyAccepted: req.body?.privacyAccepted === true,
    createdBy: req.userId,
   });
   res.status(result.alreadyConnected ? 200 : 201).json({ data: result, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:workspaceId/nostr-communities', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.workspaceId || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   res.json({ data: await nostrCommunities.listConnections(workspaceId), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/nostr-communities/:connectionId/channels', requireAuth, async (req, res) => {
  try {
   const connection = await nostrCommunities.connectionById(req.params.connectionId);
   if (!connection) return jsonError(res, 404, new Error('Nostr community connection not found'));
   await enforceWorkspaceRole(req.userId, connection.workspace_id, 'read');
   res.json({ data: await nostrCommunities.discoverChannels(connection.id), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/nostr-communities/:connectionId/channels', requireAuth, async (req, res) => {
  try {
   const connection = await nostrCommunities.connectionById(req.params.connectionId);
   if (!connection) return jsonError(res, 404, new Error('Nostr community connection not found'));
   await enforceWorkspaceRole(req.userId, connection.workspace_id, 'manage');
   const rows = await nostrCommunities.mapChannels(connection.id, req.body?.mappings);
   res.status(201).json({ data: { mapped: rows.length }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/sessions/:sessionId/nostr-members', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.params.sessionId || '').trim();
   const sessions = await getDb().unsafe(
    'select * from chat_sessions where id = $1 and deleted_at is null limit 1',
    [sessionId],
   );
   const session = sessions[0];
   if (!session) return jsonError(res, 404, new Error('Channel not found'));
   await enforceWorkspaceRole(req.userId, session.workspace_id, 'read');
   await enforceSessionRead(req.userId, sessionId, session);
   res.json({ data: await nostrCommunities.membersForSession(sessionId), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/nostr-communities/:connectionId', requireAuth, async (req, res) => {
  try {
   const connection = await nostrCommunities.connectionById(req.params.connectionId);
   if (!connection) return jsonError(res, 404, new Error('Nostr community connection not found'));
   await enforceWorkspaceRole(req.userId, connection.workspace_id, 'manage');
   const disconnected = await nostrCommunities.disconnectCommunity(connection.id, req.userId);
   res.json({ data: disconnected, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountNostrCommunityRoutes };
