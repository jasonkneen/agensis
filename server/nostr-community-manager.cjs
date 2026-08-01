'use strict';

// Connection-level ownership for Nostr communities.
//
// One connection owns one Nostr identity and one relay socket. Individual Nostr
// channels remain ordinary channel_bridges rows, so the existing bridge module
// stays the only path into and out of agensis conversations.

const crypto = require('node:crypto');
const WebSocket = require('ws');
const nostr = require('nostr-tools');
const {
 NOSTR_MESSAGE_KINDS,
 buildNip42AuthEvent,
 buildOutboundMessageEvent,
 createNostrProtocol,
 extractNostrChannels,
 extractNostrMembers,
 inputError,
 mapInboundNostrEvent,
 verifiedNostrEvents,
} = require('./nostr-community.cjs');

const AUTH_TIMEOUT_MS = 20_000;
const RECONNECT_MAX_MS = 30_000;
const INITIAL_HISTORY_LIMIT = 100;
const MAX_FILTERS_PER_SUBSCRIPTION = 10;
const MEMBER_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

function nostrSecretKey(connectionId) {
 return `bridge:nostr:${String(connectionId)}:nsec`;
}

function publicConnection(row) {
 if (!row) return null;
 return {
  id: row.id,
  workspaceId: row.workspace_id,
  relayHttpUrl: row.relay_http_url,
  relayWsUrl: row.relay_ws_url,
  communityId: row.community_id || '',
  host: row.host || '',
  name: row.name || row.host || 'Nostr community',
  description: row.description || '',
  relayPubkey: row.relay_pubkey || '',
  memberPubkey: row.member_pubkey || '',
  policyVersion: row.policy_version || '',
  status: row.status || 'pending',
  lastError: row.last_error || '',
  lastInboundAt: row.last_inbound_at || null,
  lastOutboundAt: row.last_outbound_at || null,
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
  subscriptions: [],
 };
}

function publicSubscription(row) {
 return {
  bridgeId: String(row.id || ''),
  channelId: String(row.external_id || ''),
  sessionId: String(row.session_id || ''),
  enabled: row.enabled === true,
  status: String(row.status || (row.enabled === true ? 'connected' : 'disconnected')),
  lastError: String(row.last_error || ''),
 };
}

function publicMember(row) {
 return {
  pubkey: String(row.pubkey || ''),
  channelId: String(row.channelId || row.channel_id || ''),
  name: String(row.name || ''),
  handle: String(row.handle || ''),
  picture: String(row.picture || ''),
  isAgent: row.isAgent === true || row.is_agent === true,
  aliases: Array.isArray(row.aliases) ? row.aliases : [],
 };
}

function createNostrCommunityManager(deps = {}) {
 const {
  getDb,
  getWorkspaceSecretValue,
  setWorkspaceSecretValue,
  assertSafeOutboundUrl,
  bridges,
  notifyDbSubscribers = () => {},
  fetchImpl = globalThis.fetch,
  WebSocketClass = WebSocket,
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
 } = deps;
 if (typeof getDb !== 'function') throw new TypeError('getDb is required');
 if (!bridges) throw new TypeError('bridges is required');
 const protocol = deps.protocol || createNostrProtocol({ fetchImpl, assertSafeOutboundUrl });
 const runtimes = new Map();

 async function connectionById(connectionId) {
  const rows = await getDb().unsafe(
   'select * from nostr_community_connections where id = $1 limit 1',
   [String(connectionId)],
  );
  return rows[0] || null;
 }

 async function listConnections(workspaceId) {
  const rows = await getDb().unsafe(
   'select * from nostr_community_connections where workspace_id = $1 order by created_at desc',
   [String(workspaceId)],
  );
  const subscriptions = await getDb().unsafe(
   `select b.* from channel_bridges b
      join nostr_community_connections c on c.id = b.nostr_connection_id
     where c.workspace_id = $1 and b.provider = 'nostr'
     order by b.created_at`,
   [String(workspaceId)],
  );
  const byConnection = new Map();
  for (const subscription of subscriptions) {
   const key = String(subscription.nostr_connection_id || '');
   const values = byConnection.get(key) || [];
   values.push(publicSubscription(subscription));
   byConnection.set(key, values);
  }
  return rows.map(row => ({
   ...publicConnection(row),
   subscriptions: byConnection.get(String(row.id)) || [],
  }));
 }

 async function previewInvite(inviteUrl) {
  const preview = await protocol.previewInvite(inviteUrl);
  // The opaque code is needed only for the eventual claim. Never send it back
  // as a second field and never persist it; the browser already owns the URL.
  const { code: _code, inviteUrl: _inviteUrl, ...safe } = preview;
  return safe;
 }

 async function setConnectionError(connectionId, error) {
  if (!connectionId) return;
  const message = String(error?.message || error || 'Nostr connection failed').slice(0, 500);
  await getDb().unsafe(
   "update nostr_community_connections set status = 'error', last_error = $2, updated_at = now() where id = $1",
   [String(connectionId), message],
  ).catch(() => {});
 }

 async function connectCommunity({
  workspaceId, inviteUrl, policyVersion = '', ageConfirmed = false,
  termsAccepted = false, privacyAccepted = false, createdBy = null,
 }) {
  const preview = await protocol.previewInvite(inviteUrl);
  const existingRows = await getDb().unsafe(
   'select * from nostr_community_connections where workspace_id = $1 and relay_ws_url = $2 limit 1',
   [String(workspaceId), preview.wsUrl],
  );
  let row = existingRows[0] || null;
  if (row?.status === 'connected') {
   return { connection: publicConnection(row), channels: await discoverChannels(row.id), alreadyConnected: true };
  }

  let connectionId = row?.id || randomUUID();
  let secretKeyHex = await getWorkspaceSecretValue(workspaceId, nostrSecretKey(connectionId)).catch(() => '');
  if (!/^[0-9a-f]{64}$/i.test(secretKeyHex)) {
   secretKeyHex = Buffer.from(nostr.generateSecretKey()).toString('hex');
   await setWorkspaceSecretValue(
    workspaceId,
    nostrSecretKey(connectionId),
    secretKeyHex,
    createdBy,
    `Nostr community identity for ${preview.host}`,
   );
  }
  let memberPubkey = nostr.getPublicKey(Uint8Array.from(Buffer.from(secretKeyHex, 'hex')));

  const upserted = await getDb().unsafe(
   `insert into nostr_community_connections
      (id, workspace_id, relay_http_url, relay_ws_url, host, name, description,
       relay_pubkey, member_pubkey, policy_version, status, created_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
    on conflict (workspace_id, relay_ws_url) do update
      set relay_http_url = excluded.relay_http_url,
          host = excluded.host,
          name = excluded.name,
          description = excluded.description,
          relay_pubkey = excluded.relay_pubkey,
          member_pubkey = excluded.member_pubkey,
          policy_version = excluded.policy_version,
          status = 'pending', last_error = null, updated_at = now()
    returning *`,
   [
    connectionId, String(workspaceId), preview.httpUrl, preview.wsUrl, preview.host,
    preview.name, preview.description, preview.relayPubkey, memberPubkey,
    preview.policy?.version || '', createdBy || null,
   ],
  );
  row = upserted[0] || row;
  if (row?.id && String(row.id) !== String(connectionId)) {
   const losingSecretKey = nostrSecretKey(connectionId);
   connectionId = row.id;
   const canonicalSecret = await getWorkspaceSecretValue(workspaceId, nostrSecretKey(connectionId)).catch(() => '');
   if (/^[0-9a-f]{64}$/i.test(canonicalSecret)) secretKeyHex = canonicalSecret.toLowerCase();
   else await setWorkspaceSecretValue(
    workspaceId,
    nostrSecretKey(connectionId),
    secretKeyHex,
    createdBy,
    `Nostr community identity for ${preview.host}`,
   );
   await getDb().unsafe(
    'delete from workspace_secrets where workspace_id = $1 and key = $2',
    [String(workspaceId), losingSecretKey],
   ).catch(() => {});
   memberPubkey = nostr.getPublicKey(Uint8Array.from(Buffer.from(secretKeyHex, 'hex')));
   const canonicalRows = await getDb().unsafe(
    'update nostr_community_connections set member_pubkey = $2, updated_at = now() where id = $1 returning *',
    [connectionId, memberPubkey],
   );
   row = canonicalRows[0] || row;
  }

  try {
   const claimed = await protocol.claimInvite({
    inviteUrl,
    secretKeyHex,
    policyVersion,
    ageConfirmed,
    termsAccepted,
    privacyAccepted,
   });
   const rows = await getDb().unsafe(
    `update nostr_community_connections
        set community_id = $2, host = $3, policy_version = $4,
            status = 'connected', last_error = null, updated_at = now()
      where id = $1 returning *`,
    [connectionId, claimed.communityId, claimed.host, claimed.preview.policy?.version || ''],
   );
   row = rows[0] || row;

   // A real profile makes the integration identity legible in Nostr. Profile
   // publication is best-effort after membership succeeds; a profile failure
   // must not turn a successful invite claim into a false failure.
   const profileEvent = nostr.finalizeEvent({
    kind: 0,
    created_at: Math.floor(now() / 1000),
    tags: [],
    content: JSON.stringify({
     name: 'agensis', display_name: 'Agensis bridge',
     about: 'Bridges this Nostr community to an Agensis workspace.', is_agent: true,
    }),
   }, Uint8Array.from(Buffer.from(secretKeyHex, 'hex')));
   await protocol.publish({ httpUrl: preview.httpUrl, secretKeyHex, event: profileEvent }).catch(() => {});

   const channels = await discoverChannels(connectionId);
   return { connection: publicConnection(row), channels, alreadyConnected: false };
  } catch (error) {
   await setConnectionError(connectionId, error);
   throw error;
  }
 }

 async function connectionSecret(row) {
  const secret = await getWorkspaceSecretValue(row.workspace_id, nostrSecretKey(row.id));
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw inputError('Nostr connection identity is unavailable', 500);
  return secret.toLowerCase();
 }

 async function discoverChannels(connectionId, { allowLocalFallback = false } = {}) {
  const row = await connectionById(connectionId);
  if (!row) throw inputError('Nostr community connection not found', 404);
  const subscriptions = await getDb().unsafe(
   `select b.*, s.title as session_title, s.description as session_description
      from channel_bridges b
      join chat_sessions s on s.id = b.session_id and s.deleted_at is null
     where b.nostr_connection_id = $1 and b.provider = 'nostr'`,
   [row.id],
  );
  const byChannel = new Map(subscriptions.map(value => [String(value.external_id), publicSubscription(value)]));
  const localFallbacks = subscriptions.map(value => ({
   id: String(value.external_id || ''),
   name: String(value.session_title || value.external_id || 'Imported channel'),
   description: String(value.session_description || ''),
   type: String(value.config?.channelType || 'stream'),
   visibility: 'public',
   archived: false,
   joined: true,
   subscription: publicSubscription(value),
  }));
  try {
   const secretKeyHex = await connectionSecret(row);
   const rawEvents = await protocol.query({
    httpUrl: row.relay_http_url,
    secretKeyHex,
    filters: [
     { kinds: [39002], '#p': [row.member_pubkey], limit: 500 },
     { kinds: [39000], limit: 500 },
    ],
   });
   const events = verifiedNostrEvents(rawEvents, {
    authors: [row.relay_pubkey],
    kinds: [39000, 39002],
   });
   const remoteChannels = extractNostrChannels(events).map(channel => ({
    ...channel,
    subscription: byChannel.get(channel.id) || null,
   }));
   const remoteIds = new Set(remoteChannels.map(channel => channel.id));
   return [...remoteChannels, ...localFallbacks.filter(channel => !remoteIds.has(channel.id))];
  } catch (error) {
   if (allowLocalFallback) return localFallbacks;
   throw error;
  }
 }

 async function refreshMembers(connectionId, channelId) {
  const row = await connectionById(connectionId);
  if (!row) throw inputError('Nostr community connection not found', 404);
  const secretKeyHex = await connectionSecret(row);
  const memberships = await protocol.query({
   httpUrl: row.relay_http_url,
   secretKeyHex,
   filters: [{ kinds: [39002], '#d': [String(channelId)], limit: 1 }],
  });
  const membership = verifiedNostrEvents(memberships, {
   authors: [row.relay_pubkey],
   kinds: [39002],
  })[0] || null;
  if (!membership) return [];
  const pubkeys = (Array.isArray(membership.tags) ? membership.tags : [])
   .filter(value => Array.isArray(value) && value[0] === 'p' && /^[0-9a-f]{64}$/i.test(String(value[1] || '')))
   .map(value => String(value[1]).toLowerCase());
  const rawProfiles = pubkeys.length
   ? await protocol.query({
    httpUrl: row.relay_http_url,
    secretKeyHex,
    filters: [{ kinds: [0], authors: pubkeys, limit: Math.min(pubkeys.length, 500) }],
   })
   : [];
  const profiles = verifiedNostrEvents(rawProfiles, { authors: pubkeys, kinds: [0] });
  const members = extractNostrMembers(membership, profiles);

  await getDb().unsafe(
   'delete from nostr_community_members where connection_id = $1 and channel_id = $2',
   [row.id, String(channelId)],
  );
  for (const member of members) {
   await getDb().unsafe(
    `insert into nostr_community_members
       (connection_id, channel_id, pubkey, name, handle, picture, is_agent, aliases, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
     on conflict (connection_id, channel_id, pubkey) do update
       set name = excluded.name, handle = excluded.handle, picture = excluded.picture,
           is_agent = excluded.is_agent, aliases = excluded.aliases, updated_at = now()`,
    [row.id, String(channelId), member.pubkey, member.name, member.handle, member.picture, member.isAgent, member.aliases],
   );
  }
  return members;
 }

 async function mapChannels(connectionId, mappings) {
  const row = await connectionById(connectionId);
  if (!row) throw inputError('Nostr community connection not found', 404);
  const available = await discoverChannels(connectionId);
  const byId = new Map(available.map(channel => [channel.id, channel]));
  const values = Array.isArray(mappings) ? mappings : [];
  if (!values.length) throw inputError('Select at least one Nostr channel');
  const saved = [];
  for (const mapping of values) {
   const channelId = String(mapping?.channelId || '').trim();
   const sessionId = String(mapping?.sessionId || '').trim();
   const channel = byId.get(channelId);
   if (!channel) throw inputError(`Nostr channel is not accessible: ${channelId}`);
   if (channel.archived) throw inputError(`Nostr channel is archived: ${channel.name}`);
   if (channel.visibility === 'private') {
    throw inputError(`Private Nostr channel ${channel.name} cannot be connected until equivalent Agensis access is configured`);
   }
   const sessions = await getDb().unsafe(
    'select id from chat_sessions where id = $1 and workspace_id = $2 and deleted_at is null limit 1',
    [sessionId, row.workspace_id],
   );
   if (!sessions[0]) throw inputError('Agensis channel not found in this workspace', 404);
   const existingMappings = await getDb().unsafe(
    `select session_id from channel_bridges
      where nostr_connection_id = $1 and external_id = $2 and session_id <> $3 limit 1`,
    [row.id, channelId, sessionId],
   );
   if (existingMappings[0]) throw inputError(`Nostr channel ${channel.name} is already connected to another Agensis channel`, 409);
   const rows = await getDb().unsafe(
    `insert into channel_bridges
       (workspace_id, session_id, provider, lane, external_id, config, nostr_connection_id, status)
     values ($1, $2, 'nostr', 'hub', $3, jsonb_build_object('channelType', $4::text), $5, 'connected')
     on conflict (session_id) do update
       set provider = 'nostr', lane = 'hub', external_id = excluded.external_id,
           config = excluded.config, nostr_connection_id = excluded.nostr_connection_id,
           connection_id = null,
           nostr_last_event_at = case
             when channel_bridges.external_id = excluded.external_id
              and channel_bridges.nostr_connection_id = excluded.nostr_connection_id
             then channel_bridges.nostr_last_event_at else 0 end,
           nostr_initial_sync_completed = case
             when channel_bridges.external_id = excluded.external_id
              and channel_bridges.nostr_connection_id = excluded.nostr_connection_id
             then channel_bridges.nostr_initial_sync_completed else false end,
           status = 'connected', last_error = null, enabled = true,
           version = channel_bridges.version + 1, updated_at = now()
     returning *`,
    [row.workspace_id, sessionId, channelId, channel.type || 'stream', row.id],
   );
   if (rows[0]) {
    saved.push(rows[0]);
    notifyDbSubscribers('channel_bridges', 'INSERT', rows);
   }
   await refreshMembers(row.id, channelId);
  }
  await startConnection(row.id);
  return saved;
 }

 async function setChannelSubscription(connectionId, channelId, enabled) {
  const row = await connectionById(connectionId);
  if (!row) throw inputError('Nostr community connection not found', 404);
  if (enabled === true && row.status === 'disconnected') {
   throw inputError('Reconnect this Nostr community with an invite before enabling channels', 409);
  }
  if (enabled === true) {
   const available = await discoverChannels(row.id);
   const channel = available.find(value => value.id === String(channelId));
   if (!channel) throw inputError('Nostr channel is no longer accessible', 404);
   if (channel.archived) throw inputError(`Nostr channel is archived: ${channel.name}`);
   if (channel.visibility === 'private') {
    throw inputError(`Private Nostr channel ${channel.name} cannot be enabled until equivalent Agensis access is configured`);
   }
  }
  const rows = await getDb().unsafe(
   `update channel_bridges
       set enabled = $3,
           status = case when $3 then 'connected' else 'disconnected' end,
           nostr_initial_sync_completed = case when $3 then nostr_initial_sync_completed else false end,
           last_error = null, version = version + 1, updated_at = now()
     where nostr_connection_id = $1 and external_id = $2 and provider = 'nostr'
     returning *`,
   [String(row.id), String(channelId), enabled === true],
  );
  if (!rows[0]) throw inputError('Imported Nostr channel not found', 404);
  let finalRows = rows;
  try {
   await startConnection(row.id);
  } catch (error) {
   await setConnectionError(row.id, error);
   if (enabled === true) {
    finalRows = await getDb().unsafe(
     `update channel_bridges
         set enabled = false, status = 'error', last_error = $3,
             nostr_initial_sync_completed = false, version = version + 1, updated_at = now()
       where nostr_connection_id = $1 and external_id = $2 and provider = 'nostr'
       returning *`,
     [String(row.id), String(channelId), String(error?.message || error || 'Nostr subscription restart failed').slice(0, 500)],
    );
   }
   notifyDbSubscribers('channel_bridges', 'UPDATE', finalRows);
   throw error;
  }
  notifyDbSubscribers('channel_bridges', 'UPDATE', finalRows);
  return publicSubscription(finalRows[0]);
 }

 async function removeChannelSubscription(connectionId, channelId) {
  const row = await connectionById(connectionId);
  if (!row) throw inputError('Nostr community connection not found', 404);
  const normalizedChannelId = String(channelId || '').trim();
  if (!normalizedChannelId) throw inputError('Nostr channel id is required');

  // Removing an import is deliberately narrower than deleting the local
  // Agensis channel. The bridge, relay cursor, and cached member roster go
  // away; the local channel and its message history remain available as an
  // ordinary Agensis channel.
  const rows = await getDb().unsafe(
   `delete from channel_bridges
      where nostr_connection_id = $1 and external_id = $2 and provider = 'nostr'
      returning *`,
   [String(row.id), normalizedChannelId],
  );
  if (!rows[0]) throw inputError('Imported Nostr channel not found', 404);
  await getDb().unsafe(
   'delete from nostr_community_members where connection_id = $1 and channel_id = $2',
   [String(row.id), normalizedChannelId],
  );
  notifyDbSubscribers('channel_bridges', 'DELETE', rows);

  // Rebuild the relay subscription without the removed channel. A failed
  // replacement must not turn a successful removal into a false 500: the
  // durable row is already gone, and the connection is marked for recovery.
  stopConnection(row.id);
  if (row.status !== 'disconnected') {
   try {
    await startConnection(row.id);
   } catch (error) {
    await setConnectionError(row.id, error);
   }
  }
  return {
   removed: true,
   channelId: normalizedChannelId,
   sessionId: String(rows[0].session_id || ''),
  };
 }

 async function membersForSession(sessionId) {
  const mappings = await getDb().unsafe(
   `select nostr_connection_id, external_id
      from channel_bridges
     where session_id = $1 and provider = 'nostr' and enabled = true limit 1`,
   [String(sessionId)],
  );
  const mapping = mappings[0];
  if (!mapping?.nostr_connection_id) return [];
  let rows = await getDb().unsafe(
   `select m.*
      from channel_bridges b
      join nostr_community_members m
        on m.connection_id = b.nostr_connection_id and m.channel_id = b.external_id
     where b.session_id = $1 and b.provider = 'nostr' and b.enabled = true
     order by m.is_agent desc, lower(m.name), m.pubkey`,
   [String(sessionId)],
  );
  const newest = rows.reduce((value, member) => Math.max(value, Date.parse(member.updated_at) || 0), 0);
  if (!rows.length || newest < now() - MEMBER_CACHE_MAX_AGE_MS) {
   const refreshed = await refreshMembers(mapping.nostr_connection_id, mapping.external_id).catch(() => null);
   if (refreshed) return refreshed;
  }
  return rows.map(publicMember);
 }

 async function parentExternalEventId(bridgeId, messageId) {
  if (!messageId) return null;
  const rows = await getDb().unsafe(
   `select external_message_id from bridge_messages
     where bridge_id = $1 and message_id = $2 limit 1`,
   [String(bridgeId), String(messageId)],
  );
  const value = String(rows[0]?.external_message_id || '');
  return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
 }

 async function send(bridge, text, meta) {
  if (!bridge?.nostr_connection_id) throw inputError('Nostr bridge has no community connection', 500);
  const row = await connectionById(bridge.nostr_connection_id);
  if (!row || row.status === 'disconnected') throw inputError('Nostr community is disconnected', 409);
  const secretKeyHex = await connectionSecret(row);
  let members = await membersForSession(bridge.session_id);
  if (String(text || '').includes('@')) {
   members = await refreshMembers(row.id, bridge.external_id);
  }
  const event = buildOutboundMessageEvent({
   secretKeyHex,
   channelId: bridge.external_id,
   content: text,
   authorName: meta?.authorName,
   members,
   channelType: bridge.config?.channelType || 'stream',
   parentEventId: await parentExternalEventId(bridge.id, meta?.threadParentId),
   createdAt: Math.floor(now() / 1000),
  });
  const result = await protocol.publish({ httpUrl: row.relay_http_url, secretKeyHex, event });
  if (result?.accepted === false) throw inputError(`Nostr rejected the message: ${result.message || 'rejected'}`, 502);
  await getDb().unsafe(
   "update nostr_community_connections set last_outbound_at = now(), status = 'connected', last_error = null, updated_at = now() where id = $1",
   [row.id],
  ).catch(() => {});
  return String(result?.event_id || event.id);
 }

 async function mappedBridges(connectionId) {
  return getDb().unsafe(
   `select * from channel_bridges
     where nostr_connection_id = $1 and provider = 'nostr' and enabled = true
     order by created_at`,
   [String(connectionId)],
  );
 }

 function stopConnection(connectionId) {
  const runtime = runtimes.get(String(connectionId));
  if (!runtime) return;
  runtime.stopped = true;
  clearTimeout(runtime.reconnectTimer);
  clearTimeout(runtime.authTimer);
  try { runtime.socket?.close(1000, 'Agensis Nostr connection stopped'); } catch { /* already closed */ }
  runtimes.delete(String(connectionId));
 }

 function scheduleReconnect(row, runtime) {
  if (runtime.stopped) return;
  const delay = Math.min(RECONNECT_MAX_MS, 1_000 * (2 ** Math.min(runtime.retries, 5)));
  runtime.retries += 1;
  runtime.reconnectTimer = setTimeout(() => {
   if (!runtime.stopped) void startConnection(row.id, runtime.retries).catch(error => setConnectionError(row.id, error));
  }, delay);
  runtime.reconnectTimer.unref?.();
 }

 async function authorName(connectionId, channelId, pubkey) {
  const rows = await getDb().unsafe(
   `select name, handle from nostr_community_members
     where connection_id = $1 and channel_id = $2 and pubkey = $3 limit 1`,
   [String(connectionId), String(channelId), String(pubkey)],
  );
  if (rows[0]) return String(rows[0].name || rows[0].handle || `${pubkey.slice(0, 8)}…`);
  return `${pubkey.slice(0, 8)}…`;
 }

 async function ingestRelayEvent(row, mappingByChannel, event, dispatch = false) {
  const normalized = mapInboundNostrEvent(event, new Set(mappingByChannel.keys()));
  if (!normalized) return;
  // Never ingest our own publish if a relay echoes it before the outbound
  // bridge_messages claim becomes visible. The ordinary claim remains the
  // durable loop guard for every other case.
  if (normalized.pubkey === row.member_pubkey) return;
  const bridge = mappingByChannel.get(normalized.channelId);
  if (!bridge) return;
  const sourceCreatedAt = Math.min(
   Math.floor(now() / 1000) + 300,
   Math.max(1, Number(normalized.createdAt) || 1),
  );
  await bridges.ingestBridgeMessage({
   bridgeId: bridge.id,
   externalMessageId: normalized.eventId,
   authorName: await authorName(row.id, normalized.channelId, normalized.pubkey),
   authorHandle: normalized.pubkey,
   text: normalized.content,
   threadParentExternalId: normalized.parentEventId,
   sourceCreatedAt,
   dispatch,
  });
  bridge.nostr_last_event_at = Math.max(Number(bridge.nostr_last_event_at) || 0, normalized.createdAt);
  await getDb().unsafe(
   `update nostr_community_connections
       set last_event_at = greatest(coalesce(last_event_at, 0), $2),
           last_inbound_at = now(), status = 'connected', last_error = null, updated_at = now()
     where id = $1`,
   [row.id, normalized.createdAt],
  ).catch(() => {});
  await getDb().unsafe(
   `update channel_bridges
       set nostr_last_event_at = greatest(coalesce(nostr_last_event_at, 0), $2), updated_at = now()
     where id = $1`,
   [bridge.id, normalized.createdAt],
  ).catch(() => {});
 }

 async function startConnection(connectionId, inheritedRetries = 0) {
  const key = String(connectionId);
  const row = await connectionById(key);
  if (!row || row.status === 'disconnected') return false;
  const mappings = await mappedBridges(key);
  if (!mappings.length) {
   stopConnection(key);
   return false;
  }
  const secretKeyHex = await connectionSecret(row);
  const mappingByChannel = new Map(mappings.map(bridge => [String(bridge.external_id), bridge]));
  // Construct the replacement before stopping the working socket. A malformed
  // URL or synchronous WebSocket failure must not take every other subscribed
  // channel offline while leaving their rows marked connected.
  const socket = new WebSocketClass(row.relay_ws_url);
  stopConnection(key);
  const runtime = {
   socket, stopped: false, retries: inheritedRetries,
   reconnectTimer: null, authTimer: null, authenticated: false,
   authEventId: '', subscriptions: new Map(), backfillBuffers: new Map(), ingestQueue: Promise.resolve(),
  };
  runtimes.set(key, runtime);
  runtime.authTimer = setTimeout(() => {
   if (!runtime.authenticated) socket.close(4001, 'Nostr authentication timeout');
  }, AUTH_TIMEOUT_MS);
  runtime.authTimer.unref?.();

  socket.on('message', raw => {
   let frame;
   try { frame = JSON.parse(String(raw)); } catch { return; }
   if (!Array.isArray(frame)) return;
   if (frame[0] === 'AUTH' && typeof frame[1] === 'string') {
    try {
     const event = buildNip42AuthEvent({ challenge: frame[1], relayUrl: row.relay_ws_url, secretKeyHex });
     runtime.authEventId = event.id;
     socket.send(JSON.stringify(['AUTH', event]));
    } catch (error) {
     void setConnectionError(row.id, error);
     socket.close(4001, 'Nostr authentication failed');
    }
    return;
   }
   if (frame[0] === 'OK' && frame[1] === runtime.authEventId) {
    if (frame[2] !== true) {
     void setConnectionError(row.id, new Error(`Nostr authentication rejected: ${frame[3] || 'rejected'}`));
     socket.close(4001, 'Nostr authentication rejected');
     return;
    }
    runtime.authenticated = true;
    runtime.retries = 0;
    clearTimeout(runtime.authTimer);
    const filters = [...mappingByChannel.entries()].map(([channelId, bridge]) => {
     const filter = { kinds: NOSTR_MESSAGE_KINDS, '#h': [channelId], limit: INITIAL_HISTORY_LIMIT };
     if (Number(bridge.nostr_last_event_at) > 0) {
      filter.since = Math.max(0, Number(bridge.nostr_last_event_at) - 5);
     }
     return filter;
    });
    for (let index = 0; index < filters.length; index += MAX_FILTERS_PER_SUBSCRIPTION) {
     const batchNumber = Math.floor(index / MAX_FILTERS_PER_SUBSCRIPTION);
     const subscriptionId = `nostr-${row.id.slice(0, 8)}-${batchNumber}-${randomUUID().slice(0, 8)}`;
     const batch = filters.slice(index, index + MAX_FILTERS_PER_SUBSCRIPTION);
     const channelIds = batch.map(filter => filter['#h'][0]);
     runtime.subscriptions.set(subscriptionId, channelIds);
     runtime.backfillBuffers.set(subscriptionId, []);
     socket.send(JSON.stringify(['REQ', subscriptionId, ...batch]));
    }
    void getDb().unsafe(
     "update nostr_community_connections set status = 'connected', last_error = null, updated_at = now() where id = $1",
     [row.id],
    ).catch(() => {});
    return;
   }
   if (frame[0] === 'EVENT' && runtime.subscriptions.has(frame[1]) && frame[2]) {
    const rawChannelId = Array.isArray(frame[2]?.tags)
     ? frame[2].tags.find(tag => Array.isArray(tag) && tag[0] === 'h')?.[1]
     : '';
    const dispatch = mappingByChannel.get(String(rawChannelId || ''))?.nostr_initial_sync_completed === true;
    if (!dispatch) {
     runtime.backfillBuffers.get(frame[1])?.push(frame[2]);
     return;
    }
    runtime.ingestQueue = runtime.ingestQueue
     .then(() => ingestRelayEvent(row, mappingByChannel, frame[2], dispatch))
     .catch(error => setConnectionError(row.id, error));
    return;
   }
   if (frame[0] === 'EOSE' && runtime.subscriptions.has(frame[1])) {
    const channelIds = runtime.subscriptions.get(frame[1]);
    const buffered = runtime.backfillBuffers.get(frame[1]) || [];
    runtime.backfillBuffers.delete(frame[1]);
    buffered.sort((left, right) => (
     Number(left?.created_at || 0) - Number(right?.created_at || 0)
     || String(left?.id || '').localeCompare(String(right?.id || ''))
    ));
    for (const event of buffered) {
     runtime.ingestQueue = runtime.ingestQueue
      .then(() => ingestRelayEvent(row, mappingByChannel, event, false))
      .catch(error => setConnectionError(row.id, error));
    }
    for (const channelId of channelIds) {
     const bridge = mappingByChannel.get(channelId);
     if (bridge) bridge.nostr_initial_sync_completed = true;
    }
    void getDb().unsafe(
     `update channel_bridges set nostr_initial_sync_completed = true, updated_at = now()
       where nostr_connection_id = $1 and external_id = any($2::text[])`,
     [row.id, channelIds],
    ).catch(() => {});
    return;
   }
   if (frame[0] === 'CLOSED' && runtime.subscriptions.has(frame[1])) {
    void setConnectionError(row.id, new Error(`Nostr subscription closed: ${frame[2] || 'closed'}`));
   }
  });
  socket.on('error', error => { void setConnectionError(row.id, error); });
  socket.on('close', () => {
   clearTimeout(runtime.authTimer);
   if (runtimes.get(key) === runtime) scheduleReconnect(row, runtime);
  });
  return true;
 }

 async function startAll() {
  const rows = await getDb().unsafe(
   "select id from nostr_community_connections where status <> 'disconnected' order by created_at",
  );
  for (const row of rows) await startConnection(row.id).catch(error => setConnectionError(row.id, error));
 }

 async function disconnectCommunity(connectionId, userId = null) {
  const row = await connectionById(connectionId);
  if (!row) throw inputError('Nostr community connection not found', 404);
  stopConnection(row.id);
  await getDb().unsafe(
   "update channel_bridges set enabled = false, status = 'disconnected', updated_at = now() where nostr_connection_id = $1",
   [row.id],
  );
  const rows = await getDb().unsafe(
   "update nostr_community_connections set status = 'disconnected', last_error = null, updated_at = now() where id = $1 returning *",
   [row.id],
  );
  await setWorkspaceSecretValue(row.workspace_id, nostrSecretKey(row.id), '', userId, 'Disconnected Nostr community identity');
  return publicConnection(rows[0] || row);
 }

 async function deleteCommunity(connectionId, userId = null) {
  const row = await connectionById(connectionId);
  if (!row) throw inputError('Nostr community connection not found', 404);
  stopConnection(row.id);

  // Capture bridge rows before the FK cascade so subscribed clients can drop
  // the corresponding sidebar entries immediately. Local chat sessions are
  // intentionally retained; deleting an integration must not erase history.
  const bridges = await getDb().unsafe(
   "select * from channel_bridges where nostr_connection_id = $1 and provider = 'nostr'",
   [String(row.id)],
  );
  const rows = await getDb().unsafe(
   'delete from nostr_community_connections where id = $1 returning *',
   [String(row.id)],
  );
  if (!rows[0]) throw inputError('Nostr community connection not found', 404);
  // Clear through the vault helper first so a failed physical cleanup cannot
  // leave the Nostr private key usable, then remove the now-empty secret row.
  await setWorkspaceSecretValue(
   row.workspace_id,
   nostrSecretKey(row.id),
   '',
   userId,
   'Deleted Nostr community identity',
  ).catch(() => {});
  await getDb().unsafe(
   'delete from workspace_secrets where workspace_id = $1 and key = $2',
   [String(row.workspace_id), nostrSecretKey(row.id)],
  );
  if (bridges.length) notifyDbSubscribers('channel_bridges', 'DELETE', bridges);
  return publicConnection(rows[0]);
 }

 function stopAll() {
  for (const connectionId of [...runtimes.keys()]) stopConnection(connectionId);
 }

 const hubAdapter = { provider: 'nostr', send };
 return {
  previewInvite,
  connectCommunity,
  connectionById,
  listConnections,
  discoverChannels,
  refreshMembers,
  mapChannels,
  setChannelSubscription,
  removeChannelSubscription,
  membersForSession,
  send,
  startConnection,
  startAll,
  stopConnection,
  stopAll,
  disconnectCommunity,
  deleteCommunity,
  hubAdapter,
  __test: { runtimes, ingestRelayEvent },
 };
}

module.exports = {
 AUTH_TIMEOUT_MS,
 INITIAL_HISTORY_LIMIT,
 MAX_FILTERS_PER_SUBSCRIPTION,
 MEMBER_CACHE_MAX_AGE_MS,
 nostrSecretKey,
 createNostrCommunityManager,
 publicConnection,
 publicSubscription,
 publicMember,
};
