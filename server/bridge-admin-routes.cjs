'use strict';

// Setting a bridge UP, as opposed to carrying traffic (bridge-routes.cjs) or
// deciding what crosses it (channel-bridges.cjs).
//
// Credentials are the USER'S. agensis never registers a Slack app or a Telegram
// bot on anybody's behalf — the user creates those in the places they already
// exist, pastes what they get, and these routes store it and complete whatever
// handshake the provider needs. That keeps agensis out of the business of
// holding a platform relationship it cannot honour.
//
// What each provider needs from the user:
//   telegram  bot token from @BotFather. We generate the secret and call
//             setWebhook ourselves, so there is nothing else to paste.
//   slack     bot token + signing secret from their own Slack app. They paste
//             our Event URL into that app; we cannot do it for them.
//   whatsapp  nothing — a QR appears and they scan it with their phone.
//   signal    nothing — same, via signal-cli's linking QR.
//   openclaw  gateway URL + auth token from their own OpenClaw install.
//
// Everything provider-specific about *validating* those inputs lives here so the
// UI can show one error message per field instead of a generic failure.

const crypto = require('crypto');

const PROVIDER_FIELDS = {
 telegram: ['botToken'],
 slack: ['botToken', 'signingSecret'],
 whatsapp: [],
 signal: [],
 openclaw: ['gatewayUrl', 'authToken'],
};

// What the user has to be told to do, per provider, once the bridge exists.
// Returned by the create route so the dialog can render the next step without
// the frontend hardcoding a second copy of this knowledge.
function setupHintFor(provider, { eventUrl }) {
 switch (provider) {
  case 'telegram':
   return 'Add the bot to your Telegram group, then send a message there. If the group is not a supergroup, turn OFF the bot\'s privacy mode in @BotFather or it cannot see group messages.';
  case 'slack':
   return `In your Slack app, set the Event Subscriptions request URL to ${eventUrl} and subscribe to message.channels. Then invite the bot to the channel.`;
  case 'whatsapp':
   return 'Scan the QR code with WhatsApp on your phone (Settings, then Linked devices).';
  case 'signal':
   return 'Scan the QR code with Signal on your phone (Settings, then Linked devices).';
  case 'openclaw':
   return 'Make sure your OpenClaw gateway is running and reachable from the machine running the agensis daemon.';
  default:
   return '';
 }
}

function mountBridgeAdminRoutes(app, deps) {
 const {
  getDb, bridges, requireAuth, jsonError, notifyDbSubscribers,
  getWorkspaceRole, roleHasWorkspaceCapability, requestBaseUrl,
  telegramSetWebhook, resolveWorkspaceIdForSession, findConnectedAgent,
 } = deps;

 // Create or replace the bridge on a channel. One bridge per channel (the unique
 // index enforces it), so re-running this is how you re-point or re-key a bridge
 // rather than an error.
 app.post('/backend/bridges', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.body?.sessionId || '').trim();
   const provider = String(req.body?.provider || '').trim();
   const externalId = String(req.body?.externalId || '').trim();
   const config = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {};

   if (!sessionId) return jsonError(res, 400, new Error('sessionId is required'));
   const lane = bridges.laneForProvider(provider);
   if (!lane) return jsonError(res, 400, new Error(`Unknown bridge provider: ${provider}`));

   const workspaceId = await resolveWorkspaceIdForSession(sessionId);
   if (!workspaceId) return jsonError(res, 404, new Error('Channel not found'));

   // Connecting an outside network to a workspace channel is an admin-shaped
   // act: it exposes everything said in that channel to people who are not in
   // the workspace at all. Gate it on the same capability that manages agents.
   const role = await getWorkspaceRole(req.userId, workspaceId);
   if (!roleHasWorkspaceCapability(role, 'manage_workspace')) {
    return jsonError(res, 403, new Error('You do not have permission to bridge this channel'));
   }

   const missing = (PROVIDER_FIELDS[provider] || []).filter(field => !String(config[field] || '').trim());
   if (missing.length) {
    return jsonError(res, 400, new Error(`Missing required ${provider} settings: ${missing.join(', ')}`));
   }
   // Telegram is the one provider where we know the remote id only once a
   // message arrives; everything else needs it up front to address a send.
   if (!externalId && provider !== 'whatsapp' && provider !== 'signal' && provider !== 'telegram') {
    return jsonError(res, 400, new Error('externalId is required for this provider'));
   }

   const stored = { ...config };
   if (provider === 'telegram') {
    // Generated, never user-supplied: it is the only thing standing between the
    // public delivery URL and anybody who finds it.
    stored.secretToken = crypto.randomBytes(24).toString('hex');
   }

   const rows = await getDb().unsafe(
    `insert into channel_bridges (workspace_id, session_id, provider, lane, external_id, config, status)
         values ($1, $2, $3, $4, $5, $6::jsonb, 'pending')
     on conflict (session_id) do update
         set provider = excluded.provider,
             lane = excluded.lane,
             external_id = excluded.external_id,
             config = excluded.config,
             status = 'pending',
             last_error = null,
             enabled = true,
             version = channel_bridges.version + 1,
             updated_at = now()
      returning *`,
    // porsager: bind the OBJECT. JSON.stringify here becomes a jsonb string
    // scalar and `config->>'botToken'` then returns null.
    [workspaceId, sessionId, provider, lane, externalId, stored],
   );
   const bridge = rows[0];
   notifyDbSubscribers('channel_bridges', 'INSERT', rows);

   const eventUrl = `${requestBaseUrl(req)}/backend/bridges/${provider}/${bridge.id}`;

   // Telegram is the only provider we can finish wiring ourselves: it accepts a
   // webhook URL over its own API. Everything else needs a human step.
   if (provider === 'telegram') {
    try {
     await telegramSetWebhook({
      botToken: stored.botToken,
      url: eventUrl,
      secretToken: stored.secretToken,
     });
     await getDb().unsafe(
      "update channel_bridges set status = 'connected', updated_at = now() where id = $1",
      [bridge.id],
     );
     bridge.status = 'connected';
    } catch (error) {
     // Keep the row: the token may simply be wrong, and deleting it would make
     // the user re-enter everything to fix one field.
     await getDb().unsafe(
      "update channel_bridges set status = 'error', last_error = $2, updated_at = now() where id = $1",
      [bridge.id, String(error.message || error).slice(0, 400)],
     );
     return res.json({
      data: { ...publicBridge(bridge), status: 'error', lastError: String(error.message || error) },
      error: null,
     });
    }
   }

   // The daemon lane needs a machine to run on. Pin it to a daemon in this
   // workspace now so the UI can say "connect a daemon first" instead of
   // silently producing a bridge that never carries anything.
   if (lane === 'daemon') {
    const target = findConnectedAgent(workspaceId, null, null);
    if (target?.connectionId) {
     await getDb().unsafe(
      'update channel_bridges set connection_id = $2, updated_at = now() where id = $1',
      [bridge.id, target.connectionId],
     );
     bridge.connection_id = target.connectionId;
     // Bring it up now. Without this the row exists and nothing ever runs — the
     // user would scan a QR that never appears.
     await bridges.startDaemonBridge({ ...bridge, config: stored });
    }
   }

   res.json({
    data: {
     ...publicBridge(bridge),
     eventUrl,
     setupHint: setupHintFor(provider, { eventUrl }),
     needsDaemon: lane === 'daemon' && !bridge.connection_id,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/bridges/:sessionId', requireAuth, async (req, res) => {
  try {
   const bridge = await bridges.bridgeForSession(req.params.sessionId);
   if (!bridge) return res.json({ data: null, error: null });
   const role = await getWorkspaceRole(req.userId, bridge.workspace_id);
   if (!role) return jsonError(res, 403, new Error('Not a member of this workspace'));
   res.json({ data: publicBridge(bridge), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/bridges/:sessionId', requireAuth, async (req, res) => {
  try {
   const bridge = await bridges.bridgeForSession(req.params.sessionId);
   if (!bridge) return res.json({ data: null, error: null });
   const role = await getWorkspaceRole(req.userId, bridge.workspace_id);
   if (!roleHasWorkspaceCapability(role, 'manage_workspace')) {
    return jsonError(res, 403, new Error('You do not have permission to remove this bridge'));
   }
   await getDb().unsafe('delete from channel_bridges where id = $1', [bridge.id]);
   notifyDbSubscribers('channel_bridges', 'DELETE', [bridge]);
   res.json({ data: { removed: true }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

// Credentials NEVER cross back to the browser. The user pasted them; there is no
// reason to hand them out again, and a bot token in a JSON response ends up in
// devtools, in logs, and in a screenshot.
function publicBridge(bridge) {
 if (!bridge) return null;
 return {
  id: bridge.id,
  sessionId: bridge.session_id,
  provider: bridge.provider,
  lane: bridge.lane,
  externalId: bridge.external_id,
  status: bridge.status,
  lastError: bridge.last_error || null,
  lastInboundAt: bridge.last_inbound_at || null,
  lastOutboundAt: bridge.last_outbound_at || null,
  enabled: bridge.enabled !== false,
 };
}

module.exports = { mountBridgeAdminRoutes, publicBridge, setupHintFor, PROVIDER_FIELDS };
