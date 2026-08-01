'use strict';

// Authenticated management and read surfaces for Nostr community connections.
// Invite codes and Nostr private keys never appear in a response.

function mountNostrCommunityRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, enforceSessionRead,
  getDb, nostrCommunities,
 } = deps;

 async function readableSessionIds(userId, sessionIds) {
  const readable = new Set();
  for (const sessionId of new Set(sessionIds.filter(Boolean).map(String))) {
   const sessions = await getDb().unsafe(
    'select * from chat_sessions where id = $1 and deleted_at is null limit 1',
    [sessionId],
   );
   const session = sessions[0];
   if (!session) continue;
   try {
    await enforceSessionRead(userId, sessionId, session);
    readable.add(sessionId);
   } catch (error) {
    if (error?.status !== 403) throw error;
   }
  }
  return readable;
 }

 async function filterConnectionSubscriptions(userId, connections) {
  const sessionIds = connections.flatMap(connection =>
   Array.isArray(connection.subscriptions) ? connection.subscriptions.map(value => value.sessionId) : []);
  const readable = await readableSessionIds(userId, sessionIds);
  return connections.map(connection => ({
   ...connection,
   subscriptions: (connection.subscriptions || []).filter(value => readable.has(String(value.sessionId))),
  }));
 }

 async function filterChannelSubscriptions(userId, channels) {
  const sessionIds = channels.map(channel => channel.subscription?.sessionId).filter(Boolean);
  const readable = await readableSessionIds(userId, sessionIds);
  return channels.map(channel => ({
   ...channel,
   subscription: channel.subscription && readable.has(String(channel.subscription.sessionId))
    ? channel.subscription
    : null,
  }));
 }

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
   const connections = await nostrCommunities.listConnections(workspaceId);
   res.json({ data: await filterConnectionSubscriptions(req.userId, connections), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/nostr-communities/:connectionId/channels', requireAuth, async (req, res) => {
  try {
   const connection = await nostrCommunities.connectionById(req.params.connectionId);
   if (!connection) return jsonError(res, 404, new Error('Nostr community connection not found'));
   await enforceWorkspaceRole(req.userId, connection.workspace_id, 'read');
   const channels = await nostrCommunities.discoverChannels(connection.id, { allowLocalFallback: true });
   res.json({ data: await filterChannelSubscriptions(req.userId, channels), error: null });
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

 app.patch('/backend/nostr-communities/:connectionId/channels/:channelId', requireAuth, async (req, res) => {
  try {
   const connection = await nostrCommunities.connectionById(req.params.connectionId);
   if (!connection) return jsonError(res, 404, new Error('Nostr community connection not found'));
   await enforceWorkspaceRole(req.userId, connection.workspace_id, 'manage');
   if (typeof req.body?.enabled !== 'boolean') {
    return jsonError(res, 400, new Error('enabled must be true or false'));
   }
   const subscription = await nostrCommunities.setChannelSubscription(
    connection.id,
    req.params.channelId,
    req.body.enabled,
   );
   res.json({ data: subscription, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/nostr-communities/:connectionId/channels/:channelId', requireAuth, async (req, res) => {
  try {
   const connection = await nostrCommunities.connectionById(req.params.connectionId);
   if (!connection) return jsonError(res, 404, new Error('Nostr community connection not found'));
   await enforceWorkspaceRole(req.userId, connection.workspace_id, 'manage');
   const removed = await nostrCommunities.removeChannelSubscription(connection.id, req.params.channelId);
   res.json({ data: removed, error: null });
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
   const deleted = await nostrCommunities.deleteCommunity(connection.id, req.userId);
   res.json({ data: deleted, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountNostrCommunityRoutes };
