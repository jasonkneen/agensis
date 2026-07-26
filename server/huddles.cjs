'use strict';

// Huddles — ad-hoc voice calls inside a channel, carried by LiveKit.
//
// Why a separate module: server/index.cjs is already ~10.7k lines and this
// surface is self-contained (its own two tables, its own routes, one webhook).
// index.cjs requires it and calls mountHuddleRoutes(app, deps) once; every
// dependency (db handle, auth middleware, role enforcement, realtime fanout) is
// INJECTED rather than imported, so the security contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// We do NOT hand-roll an SFU. LiveKit runs the media plane; this module only
//   (a) owns the huddle's lifecycle rows,
//   (b) mints short-lived, room-scoped join tokens server-side, and
//   (c) trusts LiveKit's signed webhook — never the browser — for who was
//       actually in the room.
//
// Design notes, learned from an earlier hand-rolled implementation elsewhere:
//
//   * APPEND-ONLY EVENTS FOLDED INTO STATE. `huddle_events` is never updated,
//     only inserted into; participant state is derived by folding the log
//     (foldHuddleState). That is what makes the card survive a reconnect and
//     out-of-order webhook delivery with no reconciliation pass: a duplicate
//     join is a no-op Map.set, a duplicate leave is a no-op Map.delete, and a
//     late-arriving event still lands in the right place because the fold sorts
//     by the event's own timestamp instead of trusting arrival order.
//
//   * SERVER-SIDE AUTHORITY. The relay — here, the LiveKit webhook — signs
//     join/leave/end, not the client. A browser cannot claim someone was in a
//     huddle; it can only ask for a token for ITSELF, and only if it is a
//     member of the workspace that owns the session.
//
//   * NO `Math.max(1, participants.size)`. An ended huddle reports
//     participantCount 0, not a phantom 1. The truthful "how many were here"
//     numbers are peakParticipants / everJoinedCount, both derived from the log.
//
//   * TWO SESSION LINKS, and they mean different things. `session_id` is the
//     channel/DM the huddle was CALLED FROM — it is what the toolbar button,
//     the live card and the "one live huddle per channel" index key off.
//     `transcript_session_id` is the huddle's OWN conversation: a chat_sessions
//     row of its own, created when the huddle starts, where speech-to-text and
//     the agents' replies land.
//
//     Why a session and not a messages column: sessions already carry realtime,
//     RBAC, history, agent dispatch, mention resolution and the composer. A
//     huddle transcript is just another session, so it inherits all of that
//     rather than re-implementing it. It copies the host's `participants` and
//     `canvas_id` verbatim (in ONE statement, via a select-into-insert, so the
//     jsonb never round-trips through a bind), which is what makes @mention
//     dispatch and the DM's `direct: true` shortcut behave identically inside
//     the huddle.
//
//     A huddle is ad-hoc; the channel is the record. So the conversation does
//     NOT go into the channel — when the huddle ends the channel gets ONE
//     marker row (message_kind='huddle') saying it happened, carrying the
//     huddle id so the transcript can be opened again later.
//
//     transcript_session_id is NULLABLE and older huddles have none. Every
//     reader must treat "no transcript session" as "fall back to the host
//     session", which is exactly the pre-existing behaviour.
//
// Agents in huddles is PHASE 2 and intentionally not built here.

const crypto = require('crypto');

// The LiveKit project is shared with other apps, so every room this app creates
// is namespaced. Never derive a room name any other way.
const ROOM_PREFIX = 'agensis-';

// Join tokens are only presented at connect time — LiveKit keeps the session
// alive afterwards — so they can be short. Bounded so a bad env var cannot mint
// a month-long credential.
const DEFAULT_TOKEN_TTL_SECONDS = 600;
const MIN_TOKEN_TTL_SECONDS = 60;
const MAX_TOKEN_TTL_SECONDS = 3600;

// Clock skew tolerated when checking a webhook token's nbf/exp.
const WEBHOOK_CLOCK_SKEW_SECONDS = 60;

const EVENT_KINDS = new Set(['started', 'participant_joined', 'participant_left', 'ended']);

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — unit-testable without a DB, a network, or the SDK)
// ---------------------------------------------------------------------------

function roomNameForHuddle(huddleId) {
 return `${ROOM_PREFIX}${String(huddleId || '').trim()}`;
}

// The huddle id embedded in a room name, or '' if this room is not ours. The
// shared LiveKit project means the webhook receives rooms from other apps; those
// must be ignored rather than guessed at.
function huddleIdFromRoomName(roomName) {
 const name = String(roomName || '').trim();
 if (!name.startsWith(ROOM_PREFIX)) return '';
 return name.slice(ROOM_PREFIX.length);
}

// Participant identity is server-assigned so the webhook can attribute a join to
// a real workspace user instead of a self-declared display name.
function participantIdentity(userId) {
 return `user:${String(userId || '').trim()}`;
}

function userIdFromIdentity(identity) {
 const value = String(identity || '');
 return value.startsWith('user:') ? value.slice(5) : '';
}

function tokenTtlSeconds() {
 const raw = Number(process.env.LIVEKIT_TOKEN_TTL_SECONDS || DEFAULT_TOKEN_TTL_SECONDS);
 if (!Number.isFinite(raw)) return DEFAULT_TOKEN_TTL_SECONDS;
 return Math.min(MAX_TOKEN_TTL_SECONDS, Math.max(MIN_TOKEN_TTL_SECONDS, Math.floor(raw)));
}

function livekitConfig() {
 return {
  url: String(process.env.LIVEKIT_URL || '').trim(),
  apiKey: String(process.env.LIVEKIT_API_KEY || '').trim(),
  apiSecret: String(process.env.LIVEKIT_API_SECRET || '').trim(),
 };
}

// True when all three secrets are present. Callers report only this boolean —
// the values themselves must never be logged or returned to a client.
function livekitConfigured() {
 const { url, apiKey, apiSecret } = livekitConfig();
 return Boolean(url && apiKey && apiSecret);
}

function isoOf(value) {
 if (!value) return null;
 if (value instanceof Date) return value.toISOString();
 const parsed = new Date(value);
 return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function timeOf(value) {
 const iso = isoOf(value);
 return iso ? Date.parse(iso) : 0;
}

// Ascending by the event's OWN timestamp, then by its monotonic seq as a
// tie-break. Sorting here (not trusting insertion order) is what makes the fold
// tolerant of out-of-order webhook delivery.
function compareEvents(a, b) {
 const ta = timeOf(a && a.created_at);
 const tb = timeOf(b && b.created_at);
 if (ta !== tb) return ta - tb;
 return Number(a && a.seq ? a.seq : 0) - Number(b && b.seq ? b.seq : 0);
}

/**
 * Fold an append-only event log into the huddle state the UI renders.
 *
 * Deliberately NOT `Math.max(1, present.size)`: an ended huddle has zero
 * participants and says so. "How many people were in this" is answered by
 * peakParticipants / everJoinedCount, which are facts derived from the log.
 */
function foldHuddleState(huddle, events = []) {
 if (!huddle) return null;
 const rows = Array.isArray(events) ? [...events].sort(compareEvents) : [];
 const present = new Map();
 const everJoined = new Set();
 let peakParticipants = 0;
 let endedAt = isoOf(huddle.ended_at);

 for (const event of rows) {
  const kind = String((event && event.kind) || '');
  const identity = String((event && event.identity) || '');
  if (kind === 'participant_joined' && identity) {
   everJoined.add(identity);
   // Idempotent: a redelivered join overwrites its own entry, it does not
   // double-count.
   present.set(identity, {
    identity,
    userId: userIdFromIdentity(identity),
    name: String((event && event.display_name) || '') || identity,
    joinedAt: isoOf(event.created_at),
   });
   if (present.size > peakParticipants) peakParticipants = present.size;
  } else if (kind === 'participant_left' && identity) {
   present.delete(identity);
  } else if (kind === 'ended') {
   present.clear();
   if (!endedAt) endedAt = isoOf(event.created_at);
  }
 }

 const active = !endedAt;
 const participants = active
  ? [...present.values()].sort((a, b) => timeOf(a.joinedAt) - timeOf(b.joinedAt))
  : [];

 return {
  id: huddle.id,
  workspaceId: huddle.workspace_id,
  sessionId: huddle.session_id,
  // Null for every huddle started before transcript sessions existed. Readers
  // fall back to sessionId, which is exactly what those huddles actually did.
  transcriptSessionId: huddle.transcript_session_id || null,
  roomName: huddle.room_name,
  startedBy: huddle.started_by || null,
  startedAt: isoOf(huddle.started_at),
  endedAt,
  active,
  participants,
  participantCount: participants.length,
  peakParticipants,
  everJoinedCount: everJoined.size,
 };
}

// ---------------------------------------------------------------------------
// The channel marker
// ---------------------------------------------------------------------------

// `messages.message_kind` for the one row a finished huddle leaves in the
// channel it was called from. The client renders it as a single compact line
// with a link to the transcript, not as a chat bubble.
const HUDDLE_MARKER_KIND = 'huddle';

/** "1:23" / "1:02:03". Same shape as huddleDuration in src/lib/huddleState.ts. */
function formatDuration(ms) {
 const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
 const hours = Math.floor(seconds / 3600);
 const minutes = Math.floor((seconds % 3600) / 60);
 const secs = seconds % 60;
 const pad = (n) => String(n).padStart(2, '0');
 return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * The marker sentence, composed here and stored verbatim in `content`.
 *
 * Deliberately server-side and deliberately plain text. The row is a permanent
 * part of the channel's history: it is read by search, by exports, and by every
 * agent whose context includes the channel, none of which can run the client's
 * renderer. A client that does not understand message_kind='huddle' still shows
 * a sentence that reads correctly, which is the same fallback contract
 * tool_step rows already rely on.
 *
 * Counts come from the folded event log, so they are facts: "how many were
 * here" is everJoinedCount, never a floored 1, and never the live roster (which
 * is empty by the time a huddle ends).
 *
 * `names` is optional because participant display names live in the event log
 * only when LiveKit's webhook delivered them; with none we still say the true
 * thing about how many people joined.
 */
function huddleMarkerContent(state, names = []) {
 if (!state) return '';
 const started = timeOf(state.startedAt);
 const ended = state.endedAt ? timeOf(state.endedAt) : 0;
 const parts = ['You were in a huddle'];
 if (started && ended && ended >= started) parts.push(formatDuration(ended - started));
 const roster = (Array.isArray(names) ? names : [])
  .map((name) => String(name || '').trim())
  .filter(Boolean);
 const joined = Number(state.everJoinedCount || 0);
 if (roster.length > 0) {
  parts.push(roster.length <= 3
   ? roster.join(', ')
   : `${roster.slice(0, 2).join(', ')} and ${roster.length - 2} others`);
 } else if (joined > 0) {
  parts.push(`${joined} ${joined === 1 ? 'person' : 'people'} joined`);
 }
 return parts.join(' · ');
}

/**
 * Everyone who was ever in the room, in join order, deduped by identity.
 *
 * Derived from the append-only log rather than from `state.participants`, which
 * is EMPTY for an ended huddle by design — reading it here is how the marker
 * would end up claiming nobody was in a call that four people attended.
 */
function everJoinedNames(events = []) {
 const rows = Array.isArray(events) ? [...events].sort(compareEvents) : [];
 const names = new Map();
 for (const event of rows) {
  if (String((event && event.kind) || '') !== 'participant_joined') continue;
  const identity = String((event && event.identity) || '');
  if (!identity || names.has(identity)) continue;
  names.set(identity, String((event && event.display_name) || '').trim() || identity);
 }
 return [...names.values()];
}

/**
 * Is this huddle worth a marker at all?
 *
 * A huddle that was opened and closed with nobody joining and nothing said is a
 * misclick. Leaving "You were in a huddle · 0:03" in the channel for it is
 * exactly the noise this whole change exists to remove.
 *
 * Both halves matter. `everJoinedCount` is 0 whenever LiveKit's webhook is not
 * configured (or has not arrived yet), so on its own it would suppress the
 * marker for a real conversation; the transcript's message count is the
 * independent witness that something happened.
 */
function huddleLeftATrace(state, transcriptMessageCount = 0) {
 if (!state) return false;
 return Number(state.everJoinedCount || 0) > 0 || Number(transcriptMessageCount || 0) > 0;
}

// The video grant a join token carries. Room-scoped, publish+subscribe audio,
// nothing else — no room admin, no room list, no recording.
function buildJoinGrant(roomName) {
 return {
  roomJoin: true,
  room: roomName,
  canPublish: true,
  canSubscribe: true,
  canPublishData: true,
  canUpdateOwnMetadata: false,
 };
}

function base64UrlDecode(value) {
 return Buffer.from(String(value || ''), 'base64url');
}

function timingSafeEqualStrings(a, b) {
 const bufA = Buffer.from(String(a || ''));
 const bufB = Buffer.from(String(b || ''));
 if (bufA.length !== bufB.length) return false;
 return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a LiveKit webhook.
 *
 * LiveKit signs its webhooks the same way it signs access tokens: the request
 * carries `Authorization: <compact JWS>` (HS256 over the API secret) whose
 * claims include `iss` (the API key) and `sha256` — the **base64** SHA-256 of
 * the exact request body. So we (a) verify the HS256 signature proves it came
 * from our LiveKit project, (b) confirm `iss` is our API key, (c) honour
 * nbf/exp, and (d) bind the token to this exact body. All four must hold.
 *
 * Implemented with node crypto rather than the SDK's WebhookReceiver on
 * purpose: this is the security boundary, it must be verifiable in a unit test
 * with no network and no optional dependency installed, and it mirrors
 * verifyNetlifyDeploySignature which already lives in this repo.
 *
 * Returns the parsed claims on success and null on ANY failure — callers must
 * treat null as "reject", never as "unsigned, probably fine".
 */
function verifyLivekitWebhook(authHeader, rawBody, apiKey, apiSecret, nowMs = Date.now()) {
 if (!apiKey || !apiSecret) return null;
 let header = String(authHeader || '').trim();
 if (!header) return null;
 // LiveKit sends the bare JWT; tolerate a `Bearer ` prefix from a proxy.
 if (/^bearer\s+/i.test(header)) header = header.replace(/^bearer\s+/i, '').trim();

 const parts = header.split('.');
 if (parts.length !== 3) return null;
 const [encodedHeader, encodedPayload, encodedSignature] = parts;
 if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

 let jwtHeader;
 try {
  jwtHeader = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
 } catch {
  return null;
 }
 // Pin the algorithm: without this, an attacker picks `alg` and `none`/RS256
 // confusion becomes reachable.
 if (!jwtHeader || jwtHeader.alg !== 'HS256') return null;

 const expected = crypto
  .createHmac('sha256', apiSecret)
  .update(`${encodedHeader}.${encodedPayload}`)
  .digest('base64url');
 if (!timingSafeEqualStrings(encodedSignature, expected)) return null;

 let claims;
 try {
  claims = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
 } catch {
  return null;
 }
 if (!claims || typeof claims !== 'object') return null;

 // Authentic signature, but it must be OUR project's key.
 if (!timingSafeEqualStrings(claims.iss, apiKey)) return null;

 const nowSec = Math.floor(nowMs / 1000);
 if (Number.isFinite(claims.exp) && nowSec > Number(claims.exp) + WEBHOOK_CLOCK_SKEW_SECONDS) return null;
 if (Number.isFinite(claims.nbf) && nowSec + WEBHOOK_CLOCK_SKEW_SECONDS < Number(claims.nbf)) return null;

 // Bind the token to this exact body so a valid signature cannot be replayed
 // over a swapped payload. LiveKit hashes the body and base64-encodes it.
 const bodyHash = crypto
  .createHash('sha256')
  .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody)))
  .digest('base64');
 if (typeof claims.sha256 !== 'string' || !timingSafeEqualStrings(claims.sha256, bodyHash)) return null;

 return claims;
}

// Map a LiveKit webhook event onto one of our append-only event kinds, or '' if
// it is an event we do not fold (track_published, egress_*, ...).
function huddleEventKindFor(livekitEvent) {
 switch (String(livekitEvent || '')) {
  case 'participant_joined': return 'participant_joined';
  case 'participant_left': return 'participant_left';
  case 'room_finished': return 'ended';
  default: return '';
 }
}

// LiveKit's `createdAt` is seconds (as a number or a numeric string, depending
// on the protobuf JSON encoder). Fall back to now() so a malformed timestamp
// cannot park an event at the epoch and reorder the fold.
function webhookEventTime(payload) {
 const raw = payload && payload.createdAt;
 const seconds = Number(raw);
 if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString();
 return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Schema (the runtime bootstrap half of the three-place rule)
// ---------------------------------------------------------------------------

// Idempotent DDL, in the same shape as ensureRuntimeSchema in server/index.cjs.
// Mirrored in database/neon-schema.sql and supabase/migrations/*_huddles.sql.
const HUDDLES_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS huddles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      room_name text NOT NULL UNIQUE,
      started_by uuid,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      transcript_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL
    );
    -- The ALTER is for databases created before transcript sessions existed;
    -- the column above is for fresh ones. Nullable on purpose: an old huddle
    -- has no transcript and every reader falls back to session_id.
    ALTER TABLE huddles ADD COLUMN IF NOT EXISTS transcript_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_huddles_workspace_id ON huddles(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_huddles_session_started ON huddles(session_id, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_huddles_one_live_per_session ON huddles(session_id) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS huddle_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      huddle_id uuid NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      kind text NOT NULL,
      identity text NOT NULL DEFAULT '',
      display_name text NOT NULL DEFAULT '',
      event_id text NOT NULL DEFAULT '',
      seq bigserial,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_huddle_events_huddle ON huddle_events(huddle_id, created_at, seq);
    CREATE INDEX IF NOT EXISTS idx_huddle_events_session ON huddle_events(session_id, created_at, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_huddle_events_event_id ON huddle_events(event_id) WHERE event_id <> '';

    -- The channel marker. ONE row per finished huddle, in the channel the
    -- huddle was called from, carrying the huddle it refers to so the
    -- transcript can be reopened months later.
    --
    -- Deliberately NO foreign key. messages is created long before huddles in
    -- database/neon-schema.sql, so an FK here would need the deferred-ALTER
    -- dance chat_sessions.parent_message_id already uses — and it would buy
    -- nothing: a marker whose huddle is gone degrades to a plain sentence with
    -- a dead link, which is the SAME graceful path an old huddle with no
    -- transcript session already takes. messages.sender_id stores an agent id
    -- with no FK for the same reason.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS huddle_id uuid;
    CREATE INDEX IF NOT EXISTS idx_messages_huddle ON messages(huddle_id) WHERE huddle_id IS NOT NULL;
`;

async function ensureHuddlesSchema(db) {
 await db.unsafe(HUDDLES_SCHEMA_SQL);
}

// ---------------------------------------------------------------------------
// Token minting (the only place the LiveKit SDK is touched)
// ---------------------------------------------------------------------------

// Lazily required so (a) the server still boots if the dependency has not been
// installed yet and (b) tests can exercise every route without it. Failure is
// reported as a 503 on the huddle routes only.
function loadLivekitServerSdk() {
 // Deliberately NOT a top-level require — see the comment above.
 return require('livekit-server-sdk');
}

async function mintJoinToken({ roomName, identity, name, ttlSeconds }) {
 const { apiKey, apiSecret } = livekitConfig();
 if (!apiKey || !apiSecret) {
  const error = new Error('LiveKit is not configured');
  error.status = 503;
  throw error;
 }
 let AccessToken;
 try {
  ({ AccessToken } = loadLivekitServerSdk());
 } catch {
  const error = new Error('livekit-server-sdk is not installed on the server');
  error.status = 503;
  throw error;
 }
 const token = new AccessToken(apiKey, apiSecret, {
  identity,
  name: name || identity,
  ttl: ttlSeconds || tokenTtlSeconds(),
 });
 token.addGrant(buildJoinGrant(roomName));
 // v2 returns a promise; v1 returned a string. Await handles both.
 return await token.toJwt();
}

// Ask LiveKit to tear the room down when a huddle is ended from the app, so
// stragglers are disconnected instead of talking into a room the app considers
// closed. Best-effort: the DB row is already authoritative.
async function deleteLivekitRoom(roomName) {
 const { url, apiKey, apiSecret } = livekitConfig();
 if (!url || !apiKey || !apiSecret) return false;
 let RoomServiceClient;
 try {
  ({ RoomServiceClient } = loadLivekitServerSdk());
 } catch {
  return false;
 }
 const httpUrl = url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
 const client = new RoomServiceClient(httpUrl, apiKey, apiSecret);
 await client.deleteRoom(roomName);
 return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const HUDDLE_COLUMNS = 'id, workspace_id, session_id, room_name, started_by, started_at, ended_at, transcript_session_id';
const EVENT_COLUMNS = 'id, huddle_id, workspace_id, session_id, kind, identity, display_name, event_id, seq, created_at';

/**
 * Mount the huddle surface onto an express app.
 *
 * Every dependency is injected so the security contract stays single-sourced in
 * server/index.cjs. From index.cjs:
 *
 *   mountHuddleRoutes(app, {
 *    getDb, requireAuth, enforceWorkspaceRole, jsonError, notifyDbSubscribers,
 *    rateLimitBlocked, webhookRateLimiter, clientIpFromReq,
 *   });
 */
function mountHuddleRoutes(app, deps = {}) {
 const {
  getDb,
  requireAuth,
  enforceWorkspaceRole,
  jsonError,
  notifyDbSubscribers,
  rateLimitBlocked,
  webhookRateLimiter,
  clientIpFromReq,
  // Test seam: swapped out so route tests never need the SDK or a LiveKit
  // project. Production always uses the real minter above.
  mintToken = mintJoinToken,
  endRoom = deleteLivekitRoom,
 } = deps;

 if (!app) throw new Error('mountHuddleRoutes requires an express app');
 for (const [name, value] of Object.entries({ getDb, requireAuth, enforceWorkspaceRole, jsonError })) {
  if (typeof value !== 'function') throw new Error(`mountHuddleRoutes requires deps.${name}`);
 }

 const fanout = typeof notifyDbSubscribers === 'function' ? notifyDbSubscribers : () => {};

 // Schema bootstrap runs once, lazily, on the first huddle request. Memoised so
 // a burst of clients cannot stampede the DDL, and re-armed on failure so a
 // transient error does not permanently disable the feature.
 //
 // Honours AGENSIS_RUNTIME_SCHEMA=false, which means "migrations are the sole
 // schema source" — this module must not be the one place that still writes DDL
 // behind that switch. Harmless either way: server/index.cjs also calls
 // ensureHuddlesSchema from ensureRuntimeSchema, and the DDL is idempotent.
 let schemaReady = null;
 function ensureSchemaOnce() {
  if (process.env.AGENSIS_RUNTIME_SCHEMA === 'false') return Promise.resolve();
  if (!schemaReady) {
   schemaReady = ensureHuddlesSchema(getDb()).catch((error) => {
    schemaReady = null;
    throw error;
   });
  }
  return schemaReady;
 }

 // Confirm the session exists AND belongs to the workspace whose membership we
 // just checked. Without this, a member of workspace A could open a huddle
 // against workspace B's session id.
 async function sessionInWorkspace(sessionId, workspaceId) {
  const rows = await getDb().unsafe(
   'select id, title from chat_sessions where id = $1 and workspace_id = $2 limit 1',
   [sessionId, workspaceId],
  );
  return rows[0] || null;
 }

 async function loadEvents(huddleId) {
  return getDb().unsafe(
   `select ${EVENT_COLUMNS} from huddle_events where huddle_id = $1 order by created_at asc, seq asc`,
   [huddleId],
  );
 }

 // Every huddle response carries the raw row, its append-only log, AND the
 // server's own fold of the two:
 //   - the browser folds `events` locally so a realtime join/leave updates the
 //     card with no round-trip (and so a websocket reconnect re-derives state
 //     from the log instead of reconciling a diff),
 //   - `state` is the same fold for consumers that should not reimplement it
 //     (tests, and the MCP surface when huddles are exposed there).
 // They are two readers of one source of truth, not two sources of truth.
 async function huddlePayload(huddle) {
  if (!huddle) return { huddle: null, events: [], state: null };
  const events = await loadEvents(huddle.id);
  return { huddle, events, state: foldHuddleState(huddle, events) };
 }

 async function liveHuddleForSession(sessionId) {
  const rows = await getDb().unsafe(
   `select ${HUDDLE_COLUMNS} from huddles where session_id = $1 and ended_at is null limit 1`,
   [sessionId],
  );
  return rows[0] || null;
 }

 async function latestHuddleForSession(sessionId) {
  const rows = await getDb().unsafe(
   `select ${HUDDLE_COLUMNS} from huddles where session_id = $1 order by started_at desc limit 1`,
   [sessionId],
  );
  return rows[0] || null;
 }

 async function huddleInWorkspace(huddleId, workspaceId) {
  const rows = await getDb().unsafe(
   `select ${HUDDLE_COLUMNS} from huddles where id = $1 and workspace_id = $2 limit 1`,
   [huddleId, workspaceId],
  );
  return rows[0] || null;
 }

 // Append one event and broadcast it. The insert is the ONLY write shape for
 // huddle_events — nothing ever updates or deletes a row here, which is what
 // makes the fold safe to replay.
 async function appendEvent({ huddle, kind, identity = '', displayName = '', eventId = '', createdAt = null }) {
  if (!EVENT_KINDS.has(kind)) return null;
  const rows = await getDb().unsafe(
   `insert into huddle_events (huddle_id, workspace_id, session_id, kind, identity, display_name, event_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
         on conflict do nothing
         returning ${EVENT_COLUMNS}`,
   [huddle.id, huddle.workspace_id, huddle.session_id, kind, identity, displayName, eventId, createdAt],
  );
  const row = rows[0] || null;
  // No row means the ON CONFLICT swallowed a redelivery — correct, and not
  // something to re-broadcast.
  if (row) fanout('huddle_events', 'INSERT', [row]);
  return row;
 }

 async function displayNameFor(userId) {
  if (!userId) return '';
  const rows = await getDb().unsafe('select display_name, email from app_users where id = $1 limit 1', [userId]);
  const row = rows[0];
  if (!row) return '';
  return String(row.display_name || '').trim() || String(row.email || '').trim();
 }

 /**
  * Create the huddle's own conversation session and link the huddle to it.
  *
  * ONE statement copies `participants` and `canvas_id` straight off the host
  * session. That is not an optimisation — it is how the huddle inherits agent
  * dispatch. The dispatch route resolves @mentions and the DM `direct: true`
  * shortcut from the SESSION's participants, so a transcript session with an
  * empty roster would be a room where talking to an agent silently does
  * nothing. Copying in SQL also keeps the jsonb out of a bind entirely, which
  * is the one place the two backends' jsonb binding rules disagree.
  *
  * folder='huddle' is the discriminator that keeps these out of the sidebar:
  * a huddle is reached from its channel's marker or its live card, never from
  * the channel list.
  *
  * Best-effort by design. If this fails the huddle still works — every reader
  * falls back to the host session, which is exactly what huddles did before.
  */
 async function createTranscriptSession(huddle, hostTitle) {
  const sessionId = crypto.randomUUID();
  const title = hostTitle ? `Huddle in ${hostTitle}` : 'Huddle';
  // 'mention', NEVER the host channel's mode. A channel on 'auto' has agents
  // continue the conversation between themselves for auto_rounds turns — which
  // in a live voice call means a second agent starts talking over the first
  // while the human is still listening to it. Inheriting the host's mode did
  // exactly that: one agent answered, then two.
  //
  // In a huddle the HUMAN drives turn-taking. An utterance mentions the active
  // agent and that agent answers; nothing else should speak unprompted.
  const rows = await getDb().unsafe(
   `insert into chat_sessions (id, workspace_id, title, model, conversation_mode, folder, canvas_id, participants)
        select $1, $2, $3, host.model, 'mention', 'huddle', host.canvas_id, host.participants
          from chat_sessions host
         where host.id = $4
        returning id`,
   [sessionId, huddle.workspace_id, title.slice(0, 200), huddle.session_id],
  );
  if (!rows[0]) return null;
  const updated = await getDb().unsafe(
   `update huddles set transcript_session_id = $1 where id = $2 returning ${HUDDLE_COLUMNS}`,
   [rows[0].id, huddle.id],
  );
  return updated[0] || null;
 }

 async function transcriptMessageCount(sessionId) {
  if (!sessionId) return 0;
  const rows = await getDb().unsafe(
   'select count(*)::int as count from messages where session_id = $1',
   [sessionId],
  );
  return Number((rows[0] && rows[0].count) || 0);
 }

 /**
  * Leave ONE marker in the host channel saying the huddle happened.
  *
  * Called from BOTH ways a huddle ends (the End button and LiveKit's
  * room_finished webhook), in each case only on the request that actually
  * flipped `ended_at` — the `returning` guard on those UPDATEs is what makes
  * "exactly one marker" true without a second uniqueness mechanism.
  *
  * role='assistant' because messages.role is CHECKed to ('user','assistant');
  * sender_kind='system' is what distinguishes it from something an agent said,
  * and keeps it out of the agent-status broadcast in notifyDbSubscribers.
  *
  * Best-effort: a huddle that ended must not fail to end because its epitaph
  * could not be written.
  */
 async function writeHuddleMarker(huddle) {
  try {
   const events = await loadEvents(huddle.id);
   const state = foldHuddleState(huddle, events);
   const count = await transcriptMessageCount(huddle.transcript_session_id);
   if (!huddleLeftATrace(state, count)) return null;
   const content = huddleMarkerContent(state, everJoinedNames(events));
   if (!content) return null;
   const rows = await getDb().unsafe(
    `insert into messages (session_id, role, content, message_kind, huddle_id, sender_kind, sender_name)
          values ($1, 'assistant', $2, $3, $4, 'system', 'Huddle')
          returning *`,
    [huddle.session_id, content, HUDDLE_MARKER_KIND, huddle.id],
   );
   if (rows[0]) fanout('messages', 'INSERT', [rows[0]]);
   return rows[0] || null;
  } catch (error) {
   console.warn('[huddles] could not write the channel marker:', (error && error.message) || error);
   return null;
  }
 }

 // --- read ----------------------------------------------------------------

 // Current huddle for a channel: the live one, else the most recent so the card
 // can show a truthful "ended" summary instead of vanishing mid-glance.
 app.get('/backend/workspaces/:id/sessions/:sessionId/huddle', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const sessionId = String(req.params.sessionId || '').trim();
   if (!workspaceId || !sessionId) return jsonError(res, 400, new Error('workspaceId and sessionId are required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   await ensureSchemaOnce();
   if (!(await sessionInWorkspace(sessionId, workspaceId))) {
    return jsonError(res, 404, new Error('Session not found in this workspace'));
   }
   const huddle = (await liveHuddleForSession(sessionId)) || (await latestHuddleForSession(sessionId));
   // Deliberately no "create the missing transcript session" repair here: this
   // is a read, and an old huddle without one is not broken — its conversation
   // genuinely lived in the channel.
   res.json({
    data: { ...(await huddlePayload(huddle)), configured: livekitConfigured() },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // One huddle by id, live or long finished. This is what the channel marker
 // links to: "You were in a huddle" has to still open the transcript months
 // later, when the channel has moved on and the per-session route above would
 // answer with a completely different (newer) huddle.
 app.get('/backend/workspaces/:id/huddles/:huddleId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const huddleId = String(req.params.huddleId || '').trim();
   if (!workspaceId || !huddleId) return jsonError(res, 400, new Error('workspaceId and huddleId are required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   await ensureSchemaOnce();
   const huddle = await huddleInWorkspace(huddleId, workspaceId);
   if (!huddle) return jsonError(res, 404, new Error('Huddle not found in this workspace'));
   res.json({
    data: { ...(await huddlePayload(huddle)), configured: livekitConfigured() },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- start / join --------------------------------------------------------

 // Start a huddle in a channel, or join the one already running. Idempotent by
 // design: the "Huddle" button and the "Join" button are the same call.
 app.post('/backend/workspaces/:id/sessions/:sessionId/huddle', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const sessionId = String(req.params.sessionId || '').trim();
   if (!workspaceId || !sessionId) return jsonError(res, 400, new Error('workspaceId and sessionId are required'));
   // Speaking in a channel is a write, so starting a call in it is too.
   await enforceWorkspaceRole(req.userId, workspaceId, 'write');
   await ensureSchemaOnce();
   const host = await sessionInWorkspace(sessionId, workspaceId);
   if (!host) {
    return jsonError(res, 404, new Error('Session not found in this workspace'));
   }

   let huddle = await liveHuddleForSession(sessionId);
   let created = false;
   if (!huddle) {
    const id = crypto.randomUUID();
    try {
     const rows = await getDb().unsafe(
      `insert into huddles (id, workspace_id, session_id, room_name, started_by)
             values ($1, $2, $3, $4, $5) returning ${HUDDLE_COLUMNS}`,
      [id, workspaceId, sessionId, roomNameForHuddle(id), req.userId || null],
     );
     huddle = rows[0];
     created = true;
    } catch (error) {
     // idx_huddles_one_live_per_session lost a race with a second starter —
     // that is the index doing its job. Fall in behind them.
     if (String(error && error.code) !== '23505') throw error;
     huddle = await liveHuddleForSession(sessionId);
    }
   }
   if (!huddle) return jsonError(res, 409, new Error('Could not open a huddle for this session'));

   if (created) {
    // Order matters: the huddle row is inserted FIRST so the unique index has
    // already elected one winner, and only the winner creates a transcript
    // session. Creating it before the insert would leave the loser of a race
    // holding an orphaned session that nothing points at.
    huddle = (await createTranscriptSession(huddle, host.title)) || huddle;
    fanout('huddles', 'INSERT', [huddle]);
    // A 'started' marker, not a synthetic participant_joined: nobody has
    // connected to the room yet and the card must not claim they have.
    await appendEvent({ huddle, kind: 'started', identity: participantIdentity(req.userId) });
   }

   const name = await displayNameFor(req.userId);
   const token = await mintToken({
    roomName: huddle.room_name,
    identity: participantIdentity(req.userId),
    name,
    ttlSeconds: tokenTtlSeconds(),
   });

   res.status(created ? 201 : 200).json({
    data: {
     ...(await huddlePayload(huddle)),
     token,
     url: livekitConfig().url,
     identity: participantIdentity(req.userId),
     roomName: huddle.room_name,
     created,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Join an existing huddle by id. Same token shape; refuses a huddle that has
 // already ended rather than minting a credential for a dead room.
 app.post('/backend/workspaces/:id/huddles/:huddleId/join', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const huddleId = String(req.params.huddleId || '').trim();
   if (!workspaceId || !huddleId) return jsonError(res, 400, new Error('workspaceId and huddleId are required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'write');
   await ensureSchemaOnce();
   const huddle = await huddleInWorkspace(huddleId, workspaceId);
   if (!huddle) return jsonError(res, 404, new Error('Huddle not found in this workspace'));
   if (huddle.ended_at) return jsonError(res, 409, new Error('This huddle has ended'));

   const name = await displayNameFor(req.userId);
   const token = await mintToken({
    roomName: huddle.room_name,
    identity: participantIdentity(req.userId),
    name,
    ttlSeconds: tokenTtlSeconds(),
   });
   res.json({
    data: {
     ...(await huddlePayload(huddle)),
     token,
     url: livekitConfig().url,
     identity: participantIdentity(req.userId),
     roomName: huddle.room_name,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- end -----------------------------------------------------------------

 app.post('/backend/workspaces/:id/huddles/:huddleId/end', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const huddleId = String(req.params.huddleId || '').trim();
   if (!workspaceId || !huddleId) return jsonError(res, 400, new Error('workspaceId and huddleId are required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'write');
   await ensureSchemaOnce();
   const existing = await huddleInWorkspace(huddleId, workspaceId);
   if (!existing) return jsonError(res, 404, new Error('Huddle not found in this workspace'));

   // `ended_at is null` makes this idempotent: a second End is a no-op that
   // still returns the ended state instead of moving the timestamp.
   const rows = await getDb().unsafe(
    `update huddles set ended_at = now() where id = $1 and workspace_id = $2 and ended_at is null
        returning ${HUDDLE_COLUMNS}`,
    [huddleId, workspaceId],
   );
   const huddle = rows[0] || existing;
   if (rows[0]) {
    fanout('huddles', 'UPDATE', [huddle]);
    await appendEvent({ huddle, kind: 'ended', identity: participantIdentity(req.userId) });
    // After the 'ended' event, so the fold the marker is built from already
    // knows the huddle is over and reports a real duration.
    await writeHuddleMarker(huddle);
    try {
     await endRoom(huddle.room_name);
    } catch (error) {
     // The row is authoritative; a failed teardown must not fail the request.
     console.warn('[huddles] could not delete LiveKit room:', (error && error.message) || error);
    }
   }
   res.json({ data: await huddlePayload(huddle), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- webhook -------------------------------------------------------------

 // LiveKit webhook receiver. This — not the browser — is the authority on who
 // was in a room and when it finished. Point the LiveKit project's webhook at
 // this URL; it is public because LiveKit sends no bearer token, and
 // authenticity comes entirely from the signature.
 //
 // Requires the raw request bytes: createApp() in server/index.cjs already
 // captures them as req.rawBody via express.json's `verify` hook (added for the
 // Netlify deploy hook), and the body hash is checked against those bytes.
 app.post('/backend/livekit-webhook', async (req, res) => {
  try {
   if (typeof rateLimitBlocked === 'function' && webhookRateLimiter) {
    const key = typeof clientIpFromReq === 'function' ? clientIpFromReq(req) : 'livekit-webhook';
    if (rateLimitBlocked(res, webhookRateLimiter, key)) return;
   }

   const { apiKey, apiSecret } = livekitConfig();
   if (!apiKey || !apiSecret) {
    // Fail closed. An unverifiable webhook could forge participant state for
    // any workspace, so there is no "accept it in dev" branch here.
    console.error('[huddles] LIVEKIT_API_KEY/LIVEKIT_API_SECRET not set — rejecting webhook');
    return res.status(503).json({ data: null, error: 'LiveKit webhook is not configured' });
   }
   const claims = verifyLivekitWebhook(req.get('Authorization') || '', req.rawBody, apiKey, apiSecret);
   if (!claims) return res.status(401).json({ data: null, error: 'Invalid signature' });

   const payload = req.body || {};
   const kind = huddleEventKindFor(payload.event);
   const roomName = String((payload.room && payload.room.name) || '');
   const huddleId = huddleIdFromRoomName(roomName);
   // Events we do not fold, and rooms belonging to another app sharing this
   // LiveKit project, are acked and ignored.
   if (!kind || !huddleId) return res.status(200).json({ data: { ignored: true }, error: null });

   await ensureSchemaOnce();
   const rows = await getDb().unsafe(
    `select ${HUDDLE_COLUMNS} from huddles where room_name = $1 limit 1`,
    [roomName],
   );
   const huddle = rows[0];
   if (!huddle) return res.status(200).json({ data: { ignored: true }, error: null });

   const participant = payload.participant || {};
   const event = await appendEvent({
    huddle,
    kind,
    identity: String(participant.identity || ''),
    displayName: String(participant.name || ''),
    eventId: String(payload.id || ''),
    createdAt: webhookEventTime(payload),
   });

   if (kind === 'ended' && !huddle.ended_at) {
    const updated = await getDb().unsafe(
     `update huddles set ended_at = now() where id = $1 and ended_at is null returning ${HUDDLE_COLUMNS}`,
     [huddle.id],
    );
    // `returning` is the guard: a room_finished redelivery updates zero rows,
    // so the channel cannot collect a second marker for the same huddle. This
    // is the OTHER way a huddle ends (everyone walked away rather than someone
    // pressing End) and it must leave the same record behind.
    if (updated[0]) {
     fanout('huddles', 'UPDATE', [updated[0]]);
     await writeHuddleMarker(updated[0]);
    }
   }

   return res.status(200).json({ data: { accepted: Boolean(event), kind }, error: null });
  } catch (error) {
   console.error('[huddles] webhook failed:', (error && error.message) || error);
   return res.status(500).json({ data: null, error: 'Webhook processing failed' });
  }
 });

 return app;
}

module.exports = {
 ROOM_PREFIX,
 HUDDLE_MARKER_KIND,
 DEFAULT_TOKEN_TTL_SECONDS,
 MIN_TOKEN_TTL_SECONDS,
 MAX_TOKEN_TTL_SECONDS,
 HUDDLES_SCHEMA_SQL,
 ensureHuddlesSchema,
 mountHuddleRoutes,
 // Exported for tests and for reuse by the MCP/netlify surfaces later.
 roomNameForHuddle,
 huddleIdFromRoomName,
 participantIdentity,
 userIdFromIdentity,
 foldHuddleState,
 huddleMarkerContent,
 everJoinedNames,
 huddleLeftATrace,
 buildJoinGrant,
 verifyLivekitWebhook,
 huddleEventKindFor,
 webhookEventTime,
 livekitConfigured,
 tokenTtlSeconds,
 mintJoinToken,
};
