'use strict';

// Channel bridges: carrying messages between an agensis channel and an OUTSIDE
// network (Telegram, Slack, WhatsApp, Signal, an OpenClaw gateway).
//
// The whole point of this module is that there are exactly TWO functions the
// providers share, and everything provider-specific lives in an adapter that
// knows nothing about agensis:
//
//   ingestBridgeMessage()  remote message  -> a row in `messages`
//   emitBridgeOutbound()   a row in `messages` -> the remote network
//
// Agent dispatch is deliberately untouched. An ingested message is an ordinary
// `messages` row in an ordinary session, so mentions, cadence, jobs and the task
// queue all behave exactly as they do for a human typing in the app. A bridge
// that needed its own dispatch path would be a second conversation engine.
//
// TWO LANES, and the lane is a property of the provider rather than a setting:
//
//   'hub'    Telegram, Slack. The network POSTs to a public URL, so Fly owns the
//            socket and the credential, and outbound is a plain HTTPS call.
//   'daemon' WhatsApp, Signal, OpenClaw. Each of these has to be a linked DEVICE
//            holding account keys (or, for OpenClaw, reach 127.0.0.1:18789).
//            No hosted server can do that, so the transport runs on the user's
//            machine and relays over the daemon WS that already exists.
//
// The daemon lane is why outbound is a dispatch table rather than a switch on
// `provider`: from this module's side, "send it" is either an HTTPS call or a
// frame pushed down a socket, and the rest is the adapter's problem.

const DAEMON_PROVIDERS = new Set(['whatsapp', 'signal', 'openclaw']);
const HUB_PROVIDERS = new Set(['telegram', 'slack', 'nostr']);

function laneForProvider(provider) {
 const key = String(provider || '');
 if (HUB_PROVIDERS.has(key)) return 'hub';
 if (DAEMON_PROVIDERS.has(key)) return 'daemon';
 return null;
}

function createChannelBridges(deps = {}) {
 const {
  getDb,
  notifyDbSubscribers,
  continueConversation,
  sendToConnection,
  isConnectionSocketOpen,
 } = deps;

 // Adapters register here at construction. Keeping the registry local (rather
 // than a module-level singleton) is what lets a test build a world with one
 // fake adapter and no network at all.
 const hubAdapters = new Map();
 const conversationWakes = new Map();

 function queueConversationWake(target) {
  const key = `${target.sessionId}::${target.threadParentId || ''}`;
  const run = async () => {
   let result = await continueConversation(target);
   for (let attempt = 0; result?.reason === 'locked' && attempt < 200; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    result = await continueConversation(target);
   }
   return result;
  };
  const previous = conversationWakes.get(key);
  const queued = previous ? previous.then(run, run) : Promise.resolve(run());
  conversationWakes.set(key, queued);
  void queued.finally(() => {
   if (conversationWakes.get(key) === queued) conversationWakes.delete(key);
  }).catch(error => console.error('[bridge] continueConversation failed', error));
 }

 /** @param {{provider: string, send: (bridge, text, meta) => Promise<string|null>}} adapter */
 function registerHubAdapter(adapter) {
  hubAdapters.set(adapter.provider, adapter);
 }

 async function bridgeForSession(sessionId) {
  const rows = await getDb().unsafe(
   'select * from channel_bridges where session_id = $1 and enabled = true limit 1',
   [String(sessionId)],
  ).catch(() => []);
  return rows[0] || null;
 }

 async function bridgeById(bridgeId) {
  const rows = await getDb().unsafe(
   'select * from channel_bridges where id = $1 limit 1',
   [String(bridgeId)],
  ).catch(() => []);
  return rows[0] || null;
 }

 // Claim (bridge, externalMessageId) BEFORE doing any work. The unique index is
 // the arbiter, so two concurrent deliveries of the same remote message — a
 // Telegram webhook retry racing the original, a Baileys replay on reconnect —
 // cannot both proceed. Returns false when somebody else already claimed it.
 //
 // Deliberately not a SELECT-then-INSERT: that races. The insert IS the check.
 async function claimExternalMessage(bridgeId, externalMessageId, direction) {
  if (!externalMessageId) return true; // nothing to dedupe on; caller accepted that
  try {
   const rows = await getDb().unsafe(
    `insert into bridge_messages (bridge_id, external_message_id, direction)
         values ($1, $2, $3)
         on conflict (bridge_id, external_message_id) do nothing
         returning id`,
    [String(bridgeId), String(externalMessageId), String(direction)],
   );
   return rows.length > 0;
  } catch (error) {
   console.error('[bridge] claim failed', error);
   return false; // fail CLOSED: a duplicate message is worse than a dropped one
  }
 }

 async function localMessageForExternal(bridgeId, externalMessageId) {
  if (!externalMessageId) return null;
  const rows = await getDb().unsafe(
   `select message_id from bridge_messages
     where bridge_id = $1 and external_message_id = $2 limit 1`,
   [String(bridgeId), String(externalMessageId)],
  ).catch(() => []);
  return rows[0]?.message_id || null;
 }

 // Remote message -> agensis channel.
 //
 // `sender_kind: 'bridge'` is load-bearing in two places: emitBridgeOutbound
 // skips it (so an ingested message is never echoed straight back out), and the
 // UI can attribute it to the remote human rather than to an agensis account
 // that does not exist.
  async function ingestBridgeMessage({
   bridgeId, externalMessageId = '', authorName = '', text = '', authorHandle = '',
  threadParentExternalId = null, sourceCreatedAt = null, dispatch = true,
 }) {
  const body = String(text || '').trim();
  if (!body) return { ingested: false, reason: 'empty' };

  const bridge = await bridgeById(bridgeId);
  if (!bridge) return { ingested: false, reason: 'no_bridge' };
  if (bridge.enabled === false) return { ingested: false, reason: 'disabled' };

  const fresh = await claimExternalMessage(bridge.id, externalMessageId, 'in');
  if (!fresh) return { ingested: false, reason: 'duplicate' };

  const who = String(authorName || authorHandle || 'Someone').trim();
  const threadParentId = await localMessageForExternal(bridge.id, threadParentExternalId);
  const sourceSeconds = Number.isFinite(Number(sourceCreatedAt)) && Number(sourceCreatedAt) > 0
   ? Math.floor(Number(sourceCreatedAt))
   : null;
  const rows = await getDb().unsafe(
   `insert into messages (session_id, role, content, sender_kind, sender_name, thread_parent_id, created_at)
        values ($1, 'user', $2, 'bridge', $3, $4, coalesce(to_timestamp($5), now()))
        returning *`,
   [String(bridge.session_id), body, who, threadParentId, sourceSeconds],
  );
  const message = rows[0];
  if (!message) return { ingested: false, reason: 'insert_failed' };
  notifyDbSubscribers('messages', 'INSERT', rows);

  if (externalMessageId) {
   await getDb().unsafe(
    'update bridge_messages set message_id = $1 where bridge_id = $2 and external_message_id = $3',
    [message.id, bridge.id, String(externalMessageId)],
   ).catch(() => { });
  }
  await getDb().unsafe(
   'update channel_bridges set last_inbound_at = now(), status = $2, last_error = null, updated_at = now() where id = $1',
   [bridge.id, 'connected'],
  ).catch(() => { });

  // Exactly the call an in-app message makes. Fire-and-forget: a bridge delivery
  // must be ACKed to the remote network promptly, and Telegram in particular
  // retries anything slow — which would then be deduped as a duplicate and the
  // sender would see nothing.
  if (dispatch) {
   const target = { workspaceId: bridge.workspace_id, sessionId: bridge.session_id };
   if (threadParentId) target.threadParentId = threadParentId;
   queueConversationWake(target);
  }

  return { ingested: true, messageId: message.id, sessionId: bridge.session_id };
 }

 // agensis channel -> remote network.
 //
 // Called for every message inserted into a bridged session. Three things never
 // go out, and each one is a loop or a leak if it does:
 //   - 'bridge'  we just ingested it; sending it back is the echo loop
 //   - system/placeholder rows, which are UI furniture and not anybody's words
 //   - a message in a session with no bridge, which is every normal channel
 async function emitBridgeOutbound(message) {
  try {
   if (!message || !message.session_id) return { sent: false, reason: 'no_message' };
   const kind = String(message.sender_kind || '');
   if (kind === 'bridge') return { sent: false, reason: 'inbound_echo' };
   if (kind === 'system') return { sent: false, reason: 'system' };

   const text = String(message.content || '').trim();
   if (!text) return { sent: false, reason: 'empty' };

   const bridge = await bridgeForSession(message.session_id);
   if (!bridge) return { sent: false, reason: 'not_bridged' };

   const meta = {
    authorName: String(message.sender_name || '').trim(),
    senderKind: kind,
    messageId: message.id,
    threadParentId: message.thread_parent_id || null,
   };

   if (bridge.lane === 'daemon') return await sendViaDaemon(bridge, text, meta);

   const adapter = hubAdapters.get(String(bridge.provider));
   if (!adapter) return { sent: false, reason: 'no_adapter' };
   const externalId = await adapter.send(bridge, text, meta);
   await noteOutbound(bridge, externalId, meta.messageId);
   return { sent: true, reason: 'sent' };
  } catch (error) {
   console.error('[bridge] outbound failed', error);
   await markBridgeError(message?.session_id, error).catch(() => { });
   return { sent: false, reason: 'error' };
  }
 }

 // The daemon lane's "send" is a frame, not a call. There is no response to wait
 // for: the daemon owns the provider socket and will report failures back as a
 // bridge_status frame, exactly like agent jobs report their own results.
 async function sendViaDaemon(bridge, text, meta) {
  if (!bridge.connection_id) return { sent: false, reason: 'no_daemon' };
  if (isConnectionSocketOpen && !isConnectionSocketOpen(bridge.connection_id)) {
   await markBridgeError(bridge.session_id, new Error('the daemon carrying this bridge is offline'));
   return { sent: false, reason: 'daemon_offline' };
  }
  // hub -> daemon frames are keyed on `type` (agent_job, agent_config…);
  // daemon -> hub frames are keyed on `action`. Mixing them up means the frame
  // arrives and is silently ignored.
  const ok = sendToConnection(bridge.connection_id, {
   type: 'bridge_send',
   bridgeId: bridge.id,
   provider: bridge.provider,
   externalId: bridge.external_id,
   text,
   author: meta.authorName,
   // The daemon echoes this back on its bridge_send_result so a failure can be
   // attributed to the message that caused it.
   messageId: meta.messageId,
  });
  if (!ok) return { sent: false, reason: 'daemon_unreachable' };
  await noteOutbound(bridge, null);
  return { sent: true, reason: 'relayed' };
 }

 async function noteOutbound(bridge, externalMessageId, messageId = null) {
  await getDb().unsafe(
   'update channel_bridges set last_outbound_at = now(), status = $2, last_error = null, updated_at = now() where id = $1',
   [bridge.id, 'connected'],
  ).catch(() => { });
  // Recording our OWN sends matters for the providers that echo a sent message
  // back down the receive socket (WhatsApp and Signal both do, since the linked
  // device sees its own traffic). Without this the echo reads as a new inbound
  // message and the agent answers itself.
  if (externalMessageId) {
   const claimed = await claimExternalMessage(bridge.id, externalMessageId, 'out').catch(() => false);
   if (claimed && messageId) {
    await getDb().unsafe(
     'update bridge_messages set message_id = $1 where bridge_id = $2 and external_message_id = $3',
     [String(messageId), bridge.id, String(externalMessageId)],
    ).catch(() => { });
   }
  }
 }

 async function markBridgeError(sessionId, error) {
  if (!sessionId) return;
  await getDb().unsafe(
   'update channel_bridges set status = $2, last_error = $3, updated_at = now() where session_id = $1',
   [String(sessionId), 'error', String(error?.message || error || 'unknown').slice(0, 400)],
  ).catch(() => { });
 }

 // Tell a daemon to bring a bridge up. This is the ONLY place a daemon-lane
 // credential leaves the database, and it goes to exactly one machine: the one
 // the bridge is pinned to. It is sent on two occasions — when the bridge is
 // created, and when a daemon (re)connects, because a daemon restart loses every
 // live provider socket and nothing else would ever bring them back.
 async function startDaemonBridge(bridge) {
  if (!bridge || bridge.lane !== 'daemon' || !bridge.connection_id) return false;
  if (bridge.enabled === false) return false;
  return sendToConnection(bridge.connection_id, {
   type: 'bridge_start',
   bridgeId: bridge.id,
   provider: bridge.provider,
   externalId: bridge.external_id || '',
   config: bridge.config || {},
  });
 }

 // Called when a daemon registers. Re-homes this workspace's daemon-lane bridges
 // onto the connection that just arrived and starts them, so "restart the
 // daemon" is a repair rather than a way to lose every bridge silently.
 async function resumeDaemonBridges(workspaceId, connectionId) {
  if (!workspaceId || !connectionId) return 0;
  const rows = await getDb().unsafe(
   `update channel_bridges
       set connection_id = $2, updated_at = now()
     where workspace_id = $1 and lane = 'daemon' and enabled = true
   returning *`,
   [String(workspaceId), String(connectionId)],
  ).catch(() => []);
  let started = 0;
  for (const bridge of rows) {
   if (await startDaemonBridge(bridge)) started += 1;
  }
  if (rows.length) notifyDbSubscribers('channel_bridges', 'UPDATE', rows);
  return started;
 }

 // The daemon lane's inbound and status frames.
 //
 // The socket says which CONNECTION this is, and the bridge row says which
 // connection owns it. Requiring those to match is the whole authorization
 // story here: a daemon can only feed bridges that were pinned to it, so a
 // compromised or confused daemon cannot post into another workspace's channel
 // by guessing a bridge id.
 async function handleBridgeMessage(ws, message) {
  try {
   const connectionId = ws?.agentConnectionId;
   if (!connectionId) return;
   const bridgeId = String(message?.bridgeId || '');
   if (!bridgeId) return;

   const bridge = await bridgeById(bridgeId);
   if (!bridge) return;
   if (String(bridge.connection_id || '') !== String(connectionId)) {
    console.warn(`[bridge] ${message.action} for bridge=${bridgeId} from the wrong connection; ignored`);
    return;
   }

   if (message.action === 'bridge_status') {
    // The daemon reporting the id of a message IT just sent. Claiming it here is
    // what stops the provider's own echo — WhatsApp and Signal both show a
    // linked device its own traffic — being ingested as somebody talking.
    if (message.sentMessageId) {
     await claimExternalMessage(bridge.id, String(message.sentMessageId), 'out').catch(() => { });
    }
    // Carries the QR for WhatsApp/Signal linking, and the connected/error
    // transitions. The QR is deliberately NOT stored — it is valid for seconds
    // and is a live credential — it is broadcast straight to the open dialog.
    const status = String(message.status || '').slice(0, 40);
    const lastError = message.error ? String(message.error).slice(0, 400) : null;
    const rows = await getDb().unsafe(
     `update channel_bridges
         set status = coalesce(nullif($2, ''), status),
             external_id = coalesce(nullif($3, ''), external_id),
             last_error = $4,
             updated_at = now()
       where id = $1 returning *`,
     [bridge.id, status, String(message.externalId || ''), lastError],
    );
    if (rows[0]) notifyDbSubscribers('channel_bridges', 'UPDATE', rows);
    if (message.qr) {
     notifyDbSubscribers('bridge_qr', 'UPDATE', [{
      id: bridge.id, session_id: bridge.session_id, workspace_id: bridge.workspace_id,
      provider: bridge.provider, qr: String(message.qr),
     }]);
    }
    return;
   }

   await ingestBridgeMessage({
    bridgeId: bridge.id,
    externalMessageId: String(message.externalMessageId || ''),
    authorName: String(message.author || ''),
    authorHandle: String(message.authorHandle || ''),
    text: String(message.text || ''),
   });
  } catch (error) {
   console.error('[bridge] daemon frame failed', error);
  }
 }

 return {
  laneForProvider,
  registerHubAdapter,
  handleBridgeMessage,
  startDaemonBridge,
  resumeDaemonBridges,
  bridgeForSession,
  bridgeById,
  claimExternalMessage,
  localMessageForExternal,
  ingestBridgeMessage,
  emitBridgeOutbound,
  markBridgeError,
  queueConversationWake,
  DAEMON_PROVIDERS,
  HUB_PROVIDERS,
 };
}

module.exports = { createChannelBridges, laneForProvider, DAEMON_PROVIDERS, HUB_PROVIDERS };
