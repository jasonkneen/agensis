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
//     member of the workspace that owns the session and may read that session.
//
//   * PRESENCE EXPIRES. The webhook was the only thing that could notice a
//     browser that CRASHED, and the project's webhook has since been deleted —
//     it never delivered a single participant event anyway (it needs a LiveKit
//     dashboard step nobody performed). So a connected browser now HEARTBEATS,
//     and presence that stops being refreshed is reaped: see the liveness
//     section below. Self-reports say "I am here", heartbeats keep saying it,
//     and silence is what removes you. The webhook path is untouched and still
//     honoured if it is ever switched back on.
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
const huddleAgents = require('./huddle-agents.cjs');

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

// --- liveness windows -------------------------------------------------------
//
// How often a connected browser says "still here", and how long silence is
// tolerated before that presence is expired. Both numbers are chosen against
// ONE hard constraint: browsers throttle timers in hidden tabs, and Chrome's
// intensive throttling clamps a background page to ONE wake per minute. A
// participant who alt-tabs away is still in the call, so the threshold must
// survive that clamp with room to spare.
//
//   interval 30s  — a foreground tab gets FIVE attempts inside the window, so a
//                   handful of failed posts on a flaky connection never expires
//                   anyone. Two writes per participant per minute is the whole
//                   cost of the feature.
//   stale   150s  — 2.5x the worst-case 60s background clamp. A hidden tab has
//                   to miss TWO consecutive clamped wakes AND the headroom
//                   before it is touched, which does not happen to a tab that
//                   is merely backgrounded. Shorter (60-90s) reaps live people;
//                   much longer and the ghost outlives the conversation.
//
// A flaky connection therefore behaves like this: drops under 150s are
// invisible (the next heartbeat refreshes the row and the roster never
// flickers); a drop longer than 150s expires the participant, and when the
// browser comes back its next heartbeat sees `reaped_at` set and re-announces
// it, so a long tunnel costs a roster row for a moment, not for the call.
const HUDDLE_HEARTBEAT_INTERVAL_MS = 30_000;
const HUDDLE_PRESENCE_STALE_MS = 150_000;
// How long a huddle with nobody in it may sit "live" before it closes itself.
// Measured from the last thing that happened (start, any event, any presence
// write) so a room briefly between participants is not swept out from under a
// rejoin.
const HUDDLE_EMPTY_GRACE_MS = 150_000;

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

// Connection epochs come from browsers, so they are untrusted input. Current
// clients use a millisecond integer, while older test/SDK callers used opaque
// retry labels. Accept both bounded forms, canonicalize decimal strings (so
// `001` and `1` cannot evade a stale-leave check), and reject values that could
// be ambiguous or expensive to compare in SQL.
const CONNECTION_EPOCH_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DECIMAL_EPOCH_RE = /^\d+$/;

function normalizeConnectionEpoch(value, { fallback = '0' } = {}) {
 const rawValue = value === undefined || value === null || value === '' ? fallback : value;
 if (typeof rawValue === 'number') {
  return Number.isSafeInteger(rawValue) && rawValue >= 0 ? String(rawValue) : null;
 }
 if (typeof rawValue !== 'string') return null;
 const raw = rawValue.trim();
 if (!raw || !CONNECTION_EPOCH_RE.test(raw)) return null;
 if (!DECIMAL_EPOCH_RE.test(raw)) return raw;
 try {
  return String(BigInt(raw));
 } catch {
  return null;
 }
}

// Returns -1/0/1 for a safely comparable pair, or null when two different
// opaque epochs cannot be ordered. A null result is fail-closed at the SQL
// upsert and treated as stale by the caller.
function compareConnectionEpochs(current, incoming) {
 const left = String(current || '');
 const right = String(incoming || '');
 if (!left || !right) return null;
 if (DECIMAL_EPOCH_RE.test(left) && DECIMAL_EPOCH_RE.test(right)) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
 }
 return left === right ? 0 : null;
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
 *
 * `workContinuing` says an agent was still mid-turn when the call was hung up.
 * Ending a huddle does not cancel its work — the turn runs on and its answer is
 * carried into this channel when it lands (relayEndedHuddleWorkToChannel in
 * server/agent-jobs.cjs) — but without saying so, hanging up looks like
 * throwing the work away. Optional, so an older caller composes the same
 * sentence it always did.
 */
function huddleMarkerContent(state, names = [], { workContinuing = false } = {}) {
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
 // Last, so the durable facts about the call read first and this reads as what
 // it is: a note about what happens next.
 if (workContinuing) parts.push('work continuing');
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

// ---------------------------------------------------------------------------
// Liveness (pure — the whole reap decision, with no I/O in it)
// ---------------------------------------------------------------------------
//
// Everything that decides "is this person still here" and "should this huddle
// close" lives in these three functions, taking timestamps and returning
// answers. Deliberately NOT expressed as a WHERE clause: a rule buried in SQL
// cannot be tested against a backgrounded-tab-length gap, and this rule's whole
// job is to be right about gaps.

function presenceByIdentity(rows = []) {
 const map = new Map();
 for (const row of Array.isArray(rows) ? rows : []) {
  const identity = String((row && row.identity) || '');
  if (identity) map.set(identity, row);
 }
 return map;
}

/**
 * Which folded participants have stopped reporting, and may be removed.
 *
 * Two deliberate abstentions, both of which mean "this presence is not mine to
 * expire":
 *
 *   - NO PRESENCE ROW. Nobody self-reported this identity to this server — it
 *     came from LiveKit's webhook. The webhook is also the thing that would
 *     send its participant_left, so expiring it here would fight the authority
 *     it came from.
 *   - A ROW WITH NO HEARTBEAT. The client confirmed a join but has never beaten
 *     once, which is exactly what an older frontend does. The frontend deploys
 *     to Netlify and this server to Fly, INDEPENDENTLY — a reaper that expired
 *     anyone who does not beat would empty every live huddle in the gap between
 *     the two deploys. Liveness is opt-in, per connection, by beating.
 */
function staleHuddleIdentities({
 participants = [],
 presence = [],
 nowMs = Date.now(),
 staleAfterMs = HUDDLE_PRESENCE_STALE_MS,
} = {}) {
 const rows = presenceByIdentity(presence);
 const stale = [];
 for (const participant of Array.isArray(participants) ? participants : []) {
  const identity = String((participant && participant.identity) || '');
  // huddle_presence is the browser self-report lane. Agent liveness comes from
  // the worker/LiveKit lifecycle, never this human heartbeat table.
  if (!identity || !isHumanHuddleIdentity(identity)) continue;
  const row = rows.get(identity);
  if (!row) continue;
  const beat = timeOf(row.heartbeat_at);
  if (!beat) continue;
  if (nowMs - beat > staleAfterMs) stale.push(identity);
 }
 return stale;
}

/**
 * The most recent moment this huddle showed ANY sign of life.
 *
 * Must be computed from the state BEFORE a reap runs: the reap's own
 * participant_left rows are written at now(), so folding them in first would
 * make every reap reset the clock it is about to be measured against, and an
 * empty huddle could never reach its grace.
 */
function isHumanHuddleIdentity(identity) {
 return String(identity || '').startsWith('user:');
}

function huddleLastActivityAt(huddle, events = [], presence = []) {
 let latest = timeOf(huddle && huddle.started_at);
 for (const event of Array.isArray(events) ? events : []) {
  // Agent joins are room implementation detail, not human activity. If they
  // were allowed to keep the clock alive, an agent left in LiveKit would keep
  // an otherwise empty huddle open forever.
  if (String(event?.kind || '') === 'ended'
    || !String(event?.identity || '').trim()
    || isHumanHuddleIdentity(event?.identity)) {
   latest = Math.max(latest, timeOf(event && event.created_at));
  }
 }
 for (const row of Array.isArray(presence) ? presence : []) {
  // Older adapters omit identity on synthetic activity rows. Count those for
  // compatibility, but never let an explicitly identified agent heartbeat
  // keep a human-empty huddle alive.
  if (String(row?.identity || '').trim() && !isHumanHuddleIdentity(row.identity)) continue;
  latest = Math.max(latest, timeOf(row && row.last_seen_at), timeOf(row && row.heartbeat_at));
 }
 return latest;
}

/**
 * Should a huddle with nobody left in it close itself?
 *
 * `agentBusy` is the one thing that outranks an empty roster: an agent
 * mid-turn is still writing into the huddle's transcript, and ending the room
 * out from under it would file the marker before the answer arrived.
 *
 * An undatable huddle is never ended — a call we cannot put a clock on is not
 * one to guess about.
 */
function shouldEndEmptyHuddle({
 participantCount = 0,
 agentBusy = false,
 lastActivityAtMs = 0,
 nowMs = Date.now(),
 graceMs = HUDDLE_EMPTY_GRACE_MS,
} = {}) {
 if (Number(participantCount) > 0) return false;
 if (agentBusy) return false;
 if (!lastActivityAtMs) return false;
 return nowMs - lastActivityAtMs > graceMs;
}

// The video grant a join token carries. Room-scoped, publish+subscribe audio,
// plus data for target/control packets, nothing else — no camera, room admin,
// room list, or recording. TrackSource.MICROPHONE is enum value 2 in the
// LiveKit protocol; the server SDK serializes it to "microphone" in the JWT.
function buildJoinGrant(roomName) {
 return {
  roomJoin: true,
  room: roomName,
  canPublish: true,
  canPublishSources: [2],
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
    -- Shared notes for the call — the Notes tab in the dock. Plain text, not
    -- jsonb: there is no structure to it, just what whoever is typing wrote.
    -- Written ONLY through PATCH .../huddles/:id/notes (gated to 'write'), never
    -- through the generic /backend/db path — that path is 'manage'-only for this
    -- table on purpose (see DB_TABLE_ACCESS.huddles), and notes should be
    -- editable by anyone who could speak in the call, not just workspace admins.
    ALTER TABLE huddles ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '';
    -- Voice transcript idempotency is bootstrapped here because this module owns
    -- the Fly huddle route. The canonical schema and migration carry the same
    -- full (not partial) unique index.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS huddle_id uuid;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS huddle_transcript_event_id text;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_huddle_transcript_event
      ON messages(huddle_id, huddle_transcript_event_id);
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

    -- Liveness, and the ONE mutable table in this module.
    --
    -- huddle_events is history and is never updated; "is this person still
    -- there" is not history, it is a current value, and modelling it as an
    -- append-only log would mean a row per participant per heartbeat forever.
    -- So: one row per (huddle, identity), updated in place, deleted when they
    -- leave, and cascaded away with the huddle.
    CREATE TABLE IF NOT EXISTS huddle_presence (
      huddle_id uuid NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
      identity text NOT NULL,
      -- Which browser connection this row is about, so a reap and a rejoin from
      -- the same person cannot collide on an event id.
      connection_epoch text NOT NULL DEFAULT '',
      -- Seeded by /confirm and refreshed by every heartbeat. This is the "the
      -- room is not abandoned" clock the empty-huddle grace measures from.
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      -- NULL until this connection's FIRST heartbeat, and the ONLY thing the
      -- reaper keys on. A client that confirms but never beats (an older
      -- frontend — Netlify and Fly deploy independently) is never expired.
      heartbeat_at timestamptz,
      -- Stamped when the reaper expired this row. The next heartbeat sees it,
      -- re-announces the participant and clears it, so a browser that was away
      -- longer than the window comes back to the roster instead of being live
      -- in the room and invisible on the card.
      reaped_at timestamptz,
      PRIMARY KEY (huddle_id, identity)
    );

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

const HUDDLE_COLUMNS = 'id, workspace_id, session_id, room_name, started_by, started_at, ended_at, transcript_session_id, notes';

const VOICE_TRANSCRIPT_WINDOW_MS = 60_000;
const VOICE_TRANSCRIPT_MAX_EVENTS_PER_WINDOW = 120;
const VOICE_TRANSCRIPT_MAX_CHARS_PER_WINDOW = 256_000;
const voiceTranscriptBuckets = new Map();

function allowVoiceTranscript({ workspaceId, huddleId, agentId, chars }) {
 const key = `${workspaceId}:${huddleId}:${agentId}`;
 const now = Date.now();
 let bucket = voiceTranscriptBuckets.get(key);
 if (!bucket || now - bucket.startedAt >= VOICE_TRANSCRIPT_WINDOW_MS) {
  bucket = { startedAt: now, events: 0, chars: 0 };
  voiceTranscriptBuckets.set(key, bucket);
 }
 if (bucket.events >= VOICE_TRANSCRIPT_MAX_EVENTS_PER_WINDOW
   || bucket.chars + chars > VOICE_TRANSCRIPT_MAX_CHARS_PER_WINDOW) {
  const error = new Error('Voice transcript rate limit exceeded');
  error.status = 429;
  throw error;
 }
 bucket.events += 1;
 bucket.chars += chars;
 // Bound the process-local map if a hostile fleet creates many short-lived keys.
 if (voiceTranscriptBuckets.size > 10_000) {
  for (const [candidate, value] of voiceTranscriptBuckets) {
   if (now - value.startedAt >= VOICE_TRANSCRIPT_WINDOW_MS) voiceTranscriptBuckets.delete(candidate);
  }
 }
}
// Notes are quick call notes, not a document editor — generous enough for a
// long meeting's worth of typing, small enough that nobody can park megabytes
// of text on a huddle row through a request the 50mb express.json limit would
// otherwise wave through.
const NOTES_MAX_LENGTH = 20000;
const EVENT_COLUMNS = 'id, huddle_id, workspace_id, session_id, kind, identity, display_name, event_id, seq, created_at';
const PRESENCE_COLUMNS = 'huddle_id, identity, connection_epoch, last_seen_at, heartbeat_at, reaped_at';

/**
 * Mount the huddle surface onto an express app.
 *
 * Every dependency is injected so the security contract stays single-sourced in
 * server/index.cjs. From index.cjs:
 *
 *   mountHuddleRoutes(app, {
 *    getDb, requireAuth, enforceWorkspaceRole, enforceSessionRead, sessionReadableSql, jsonError,
 *    notifyDbSubscribers, rateLimitBlocked, webhookRateLimiter, clientIpFromReq,
 *   });
 */
function mountHuddleRoutes(app, deps = {}) {
 const {
  getDb,
  requireAuth,
  enforceWorkspaceRole,
  enforceSessionRead,
  sessionReadableSql,
  assertWorkspaceRoleLocked,
  installCreatedSessionMemberships,
  lockPrivateSessionRoster,
  jsonError,
  notifyDbSubscribers,
  rateLimitBlocked,
  webhookRateLimiter,
  clientIpFromReq,
  // Test seam: swapped out so route tests never need the SDK or a LiveKit
  // project. Production always uses the real minter above.
  mintToken = mintJoinToken,
  endRoom = deleteLivekitRoom,
  // Putting the channel's agents INTO the room. Injected for the same reason as
  // mintToken, and optional: a deployment with no LiveKit agent service still
  // serves human huddles, it just has nobody to talk to.
  createVoiceSessionToken = null,
  verifyVoiceSessionToken = null,
  parseJsonArray = null,
  parseJsonObject = null,
  publicBaseUrl = '',
  dispatchAgents = huddleAgents.dispatchVoiceAgents,
 } = deps;

 /**
  * Fire the agents into a room. Never awaited by a request handler: a human
  * pressing "Huddle" must get their room back immediately, and an agent that
  * takes a second to join is not a reason to hold the response open.
  */
 const dispatchIntoRoom = (huddle) => {
  if (!huddle || !createVoiceSessionToken || typeof dispatchAgents !== 'function') return;
  Promise.resolve(dispatchAgents({
   db: getDb(),
   workspaceId: huddle.workspace_id,
   sessionId: huddle.session_id,
   transcriptSessionId: huddle.transcript_session_id || huddle.session_id,
   targetControllerIdentity: huddle.started_by ? `user:${String(huddle.started_by)}` : '',
   huddleId: huddle.id,
   roomName: huddle.room_name,
   livekitConfig,
   createVoiceSessionToken,
   parseJsonArray,
   parseJsonObject,
   baseUrl: publicBaseUrl,
  })).catch((error) => {
   console.error(`[huddle] agent dispatch failed for ${huddle.room_name}: ${error?.message || error}`);
  });
 };

 if (!app) throw new Error('mountHuddleRoutes requires an express app');
 for (const [name, value] of Object.entries({
  getDb, requireAuth, enforceWorkspaceRole, enforceSessionRead,
  sessionReadableSql,
  assertWorkspaceRoleLocked, installCreatedSessionMemberships,
  lockPrivateSessionRoster, jsonError,
 })) {
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
   'select id, title, visibility, folder, deleted_at from chat_sessions where id = $1 and workspace_id = $2 limit 1',
   [sessionId, workspaceId],
  );
  return rows[0] || null;
 }

 // Workspace capability is always checked first. This is the second,
 // narrower gate: a huddle inherits the audience of the host session it was
 // called from, including the "no implicit owner oversight" rule for DMs.
 async function enforceHuddleRead(userId, huddle) {
  if (huddle?.session_id) await enforceSessionRead(userId, huddle.session_id);
 }

 // The starter is the target-controller authority carried in every dispatch.
 // LiveKit does not re-check our workspace/session membership after minting a
 // room token, so the worker's transcript/liveness request re-checks it here.
 // A revoked starter therefore cannot keep an already-connected worker talking
 // or publishing target packets indefinitely.
 async function controllerStillAuthorized(huddle) {
  const starter = String(huddle?.started_by || '').trim();
  if (!starter) return true; // legacy/headless huddles elect a live human.
  try {
   await enforceWorkspaceRole(starter, huddle.workspace_id, 'read');
   await enforceHuddleRead(starter, huddle);
   return true;
  } catch {
   return false;
  }
 }

 // A route-level access check is only a useful early error. It is not authority
 // for a token or a later mutation: the host can be deleted, made private, or
 // have this member revoked while the request is still running. These helpers
 // take row locks inside the operation's transaction and re-use the one
 // canonical session predicate rather than spelling the DM rule again here.
 function accessChanged(message = 'Huddle access changed before the operation completed') {
  const error = new Error(message);
  error.status = 403;
  return error;
 }

 function isPrivateHost(host) {
  return String(host?.visibility || '') === 'private'
   || String(host?.folder || '') === 'Direct messages';
 }

 async function lockCurrentMember(tx, host, userId) {
  if (!isPrivateHost(host)) return;
  const rows = await tx.unsafe(
   `select 1
      from chat_session_members huddle_member
     where huddle_member.session_id = $1
       and huddle_member.user_id = $2::uuid
       and (huddle_member.expires_at is null or huddle_member.expires_at > now())
     for share of huddle_member`,
   [host.id, userId],
  );
  if (rows.length !== 1) throw accessChanged();
 }

 async function lockActorSession(tx, { sessionId, workspaceId, userId }) {
  const rows = await tx.unsafe(
   `select host.id, host.title, host.visibility, host.folder, host.deleted_at
      from chat_sessions host
     where host.id = $1
       and host.workspace_id = $2
       and ${sessionReadableSql('host', '$3')}
     for share of host`,
   [sessionId, workspaceId, userId],
  );
  const host = rows[0] || null;
  if (!host) throw accessChanged();
  // The canonical predicate proves the membership at the statement snapshot;
  // this second lock proves it still exists and keeps a concurrent revoke from
  // committing until the protected operation is complete.
  await lockCurrentMember(tx, host, userId);
  return host;
 }

 async function lockActorHuddle(tx, {
  huddleId,
  workspaceId,
  sessionId,
  userId,
  requireLive = true,
  forUpdate = false,
 }) {
  // Lock every row in one order across every actor path: host, private member,
  // then huddle. Besides making the access decision stable, the order matters
  // to clear-session, which also starts with the host before it settles linked
  // huddles. A joined SELECT leaves PostgreSQL free to acquire those row locks
  // in a plan-dependent order.
  await lockActorSession(tx, { sessionId, workspaceId, userId });
  const liveSql = requireLive ? 'and h.ended_at is null' : '';
  // A route that will UPDATE the huddle must take the write-compatible lock
  // now. Taking SHARE here and upgrading in the next statement lets two Notes
  // or End requests each hold SHARE while each waits to upgrade: a real
  // PostgreSQL deadlock. Read/token/presence paths keep the weaker SHARE lock.
  const rowLock = forUpdate ? 'for update of h' : 'for share of h';
  const rows = await tx.unsafe(
   `select ${HUDDLE_COLUMNS.split(', ').map((column) => `h.${column}`).join(', ')}
      from huddles h
     where h.id = $1
       and h.workspace_id = $2
       and h.session_id = $3
       ${liveSql}
     ${rowLock}`,
   [huddleId, workspaceId, sessionId],
  );
  const row = rows[0] || null;
  if (!row) throw accessChanged();
  return row;
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
 //   - `state` is the same fold for consumers that should not duplicate it
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
 async function appendEvent(
  { huddle, kind, identity = '', displayName = '', eventId = '', createdAt = null },
  {
   db = getDb(),
   actorUserId = '',
   requireLiveHost = false,
   requireLiveHuddle = false,
   deferFanout = false,
  } = {},
 ) {
  if (!EVENT_KINDS.has(kind)) return null;
  const liveHuddleSql = requireLiveHuddle ? 'and h.ended_at is null' : '';
  let scopeSql;
  const params = [
   huddle.id,
   huddle.workspace_id,
   huddle.session_id,
   kind,
   identity,
   displayName,
   eventId,
   createdAt,
  ];
  if (actorUserId) {
   params.push(actorUserId);
   scopeSql = `
      from huddles h
      join chat_sessions host
        on host.id = h.session_id
       and host.workspace_id = h.workspace_id
     where h.id = $1
       and h.workspace_id = $2
       and h.session_id = $3
       ${liveHuddleSql}
       and ${sessionReadableSql('host', '$9')}`;
  } else if (requireLiveHost) {
   scopeSql = `
      from huddles h
      join chat_sessions host
        on host.id = h.session_id
       and host.workspace_id = h.workspace_id
     where h.id = $1
       and h.workspace_id = $2
       and h.session_id = $3
       ${liveHuddleSql}
       and host.deleted_at is null`;
  } else {
   // Cleanup-only writes (leave, reap, ended) deliberately survive the host
   // closing, but still resolve the exact huddle/workspace/session tuple from
   // the database rather than trusting the caller's copied row values.
   scopeSql = `
      from huddles h
     where h.id = $1
       and h.workspace_id = $2
       and h.session_id = $3
       ${liveHuddleSql}`;
  }
  const lockSql = actorUserId || requireLiveHost ? 'for share of h, host' : 'for share of h';
  const rows = await db.unsafe(
   `with event_scope as (
       select h.id, h.workspace_id, h.session_id
         ${scopeSql}
       ${lockSql}
     )
     insert into huddle_events (huddle_id, workspace_id, session_id, kind, identity, display_name, event_id, created_at)
         select event_scope.id, event_scope.workspace_id, event_scope.session_id, $4, $5, $6, $7,
                coalesce($8::timestamptz, now())
           from event_scope
         on conflict do nothing
         returning ${EVENT_COLUMNS}`,
   params,
  );
  const row = rows[0] || null;
  // No row means the ON CONFLICT swallowed a redelivery — correct, and not
  // something to re-broadcast.
  if (row && !deferFanout) fanout('huddle_events', 'INSERT', [row]);
  return row;
 }

 async function displayNameFor(userId) {
  if (!userId) return '';
  const rows = await getDb().unsafe('select display_name, email from app_users where id = $1 limit 1', [userId]);
  const row = rows[0];
  if (!row) return '';
  return String(row.display_name || '').trim() || String(row.email || '').trim();
 }

 // Token minting is the one non-database side effect on this surface. Keep the
 // host, huddle, and (for a private session) member row locked until the minter
 // has finished, so a concurrent clear/revoke has a serial order with the
 // credential: it either commits first and no token is minted, or waits until
 // this already-authorized mint completes.
 async function mintLockedJoin({ huddle, workspaceId, userId, name }) {
  return getDb().begin(async (tx) => {
   const locked = await lockActorHuddle(tx, {
    huddleId: huddle.id,
    workspaceId,
    sessionId: huddle.session_id,
    userId,
    requireLive: true,
   });
   const token = await mintToken({
    roomName: locked.room_name,
    identity: participantIdentity(userId),
    name,
    ttlSeconds: tokenTtlSeconds(),
   });
   return { huddle: locked, token };
  });
 }

 /**
  * Create the huddle's own conversation session and link the huddle to it.
  *
  * The caller holds the authoritative host-session and complete private-roster
  * locks, and runs this inside a savepoint of the huddle-creation transaction.
  * A failure rolls back the complete transcript/member graph while preserving
  * the huddle row, whose readers deliberately fall back to the host session.
  * No private transcript can commit without its inherited members.
  */
 async function createTranscriptSession(db, huddle, host) {
  const sessionId = crypto.randomUUID();
  const title = host.title ? `Huddle in ${host.title}` : 'Huddle';
  // 'mention', NEVER the host channel's mode. A channel on 'auto' has agents
  // continue the conversation between themselves for auto_rounds turns — which
  // in a live voice call means a second agent starts talking over the first
  // while the human is still listening to it. Inheriting the host's mode did
  // exactly that: one agent answered, then two.
  //
  // In a huddle the HUMAN drives turn-taking. An utterance mentions the active
  // agent and that agent answers; nothing else should speak unprompted.
  const rows = await db(
   // Privacy is inherited from the CANONICAL predicate, not the raw visibility
   // column. A legacy DM whose folder is the fail-closed signal must produce a
   // private transcript too.
   `insert into chat_sessions (id, workspace_id, title, model, conversation_mode, folder, canvas_id, participants, visibility)
        select $1, $2, $3, host.model, 'mention', 'huddle',
               host.canvas_id, host.participants,
               case
                when host.visibility = 'private' or host.folder = 'Direct messages'
                then 'private'
                else 'workspace'
               end
          from chat_sessions host
         where host.id = $4::uuid
           and host.workspace_id = $2::uuid
           and host.deleted_at is null
        returning id, visibility, folder`,
   [sessionId, huddle.workspace_id, title.slice(0, 200), host.id],
  );
  if (!rows[0]) return null;
  await installCreatedSessionMemberships({
   db,
   userId: huddle.started_by,
   createdRows: rows,
   lineage: [{ kind: 'huddle', parentSessionId: host.id }],
  });
  const updated = await db(
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
  * room_finished webhook). The lifecycle UPDATE elects the first writer, and
  * the marker itself has a deterministic transcript-event key so a retry can
  * repair a crash between the `ended_at` commit and this insert.
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
   // Read AFTER ended_at is set, so this is exactly "still running now that the
   // call is over" — the state the sentence is describing.
   const existing = await getDb().unsafe(
    `select id, session_id, role, content, message_kind, huddle_id, sender_kind, sender_name, created_at
       from messages
      where huddle_id = $1 and message_kind = $2
      limit 1`,
    [huddle.id, HUDDLE_MARKER_KIND],
   );
   if (existing[0]) return existing[0];
   const content = huddleMarkerContent(state, everJoinedNames(events), {
    workContinuing: await agentBusyInHuddle(huddle),
   });
   if (!content) return null;
   const markerEventId = `huddle-marker:${huddle.id}`;
   const rows = await getDb().unsafe(
    `insert into messages (session_id, role, content, message_kind, huddle_id, huddle_transcript_event_id, sender_kind, sender_name)
          values ($1, 'assistant', $2, $3, $4, $5, 'system', 'Huddle')
       on conflict (huddle_id, huddle_transcript_event_id) do nothing
          returning *`,
    [huddle.session_id, content, HUDDLE_MARKER_KIND, huddle.id, markerEventId],
   );
   if (rows[0]) fanout('messages', 'INSERT', [rows[0]]);
   return rows[0] || null;
  } catch (error) {
   console.warn('[huddles] could not write the channel marker:', (error && error.message) || error);
   return null;
  }
 }

 // --- liveness -------------------------------------------------------------

 async function loadPresence(huddleId) {
  return getDb().unsafe(
   `select ${PRESENCE_COLUMNS} from huddle_presence where huddle_id = $1`,
   [huddleId],
  );
 }

 /**
  * Record that this identity is here.
  *
  * `beat` is what separates the two callers, and it is the whole opt-in:
  * /confirm seeds the row (so the empty-huddle grace has a clock) but leaves
  * heartbeat_at NULL, while /heartbeat sets it and thereby accepts being
  * reaped. Returns the row's PREVIOUS reaped_at — RETURNING hands back the new
  * row and this statement never clears that column, so what comes back is the
  * value the reaper last wrote.
  */
 async function touchPresence({ db = getDb(), huddle, userId, identity, connectionEpoch, beat }) {
  // Confirm/heartbeat calls can cross on the network. Never let an older
  // connection epoch overwrite a newer row, even though both requests are
  // otherwise authenticated as the same user.
  const incomingEpoch = normalizeConnectionEpoch(connectionEpoch, { fallback: '' });
  if (!incomingEpoch) return null;
  const existing = await db.unsafe(
   `select connection_epoch from huddle_presence
       where huddle_id = $1 and identity = $2
       for update`,
   [huddle.id, identity],
  );
  const currentRaw = String(existing[0]?.connection_epoch || '').trim();
  const ordering = compareConnectionEpochs(currentRaw, incomingEpoch);
  if (currentRaw && (ordering === null || ordering > 0)) {
   return { ...existing[0], _staleConnectionEpoch: true };
  }
  const rows = await db.unsafe(
   // $6 is cast EXPLICITLY: a bare parameter inside a CASE has no column to
   // infer its type from, and Postgres answers "could not determine data type
   // of parameter" — which this module's best-effort catch would swallow,
   // shipping a heartbeat that silently records nothing.
   `insert into huddle_presence (huddle_id, identity, connection_epoch, last_seen_at, heartbeat_at)
         select h.id, $4, $5, now(), case when $6::boolean then now() else null end
           from huddles h
           join chat_sessions host
             on host.id = h.session_id
            and host.workspace_id = h.workspace_id
          where h.id = $1
            and h.workspace_id = $2
            and h.session_id = $3
            and h.ended_at is null
            and ${sessionReadableSql('host', '$7')}
         on conflict (huddle_id, identity) do update
            set connection_epoch = excluded.connection_epoch,
                last_seen_at = now(),
                heartbeat_at = case when $6::boolean then now() else huddle_presence.heartbeat_at end
          where huddle_presence.connection_epoch = ''
             or huddle_presence.connection_epoch = excluded.connection_epoch
             or (
               huddle_presence.connection_epoch ~ '^\\d+$'
               and excluded.connection_epoch ~ '^\\d+$'
               and huddle_presence.connection_epoch::numeric <= excluded.connection_epoch::numeric
             )
         returning ${PRESENCE_COLUMNS}`,
   [
    huddle.id,
    huddle.workspace_id,
    huddle.session_id,
    identity,
    incomingEpoch,
    Boolean(beat),
    userId,
   ],
  );
  if (rows[0]) return rows[0];
  // If the initial SELECT saw no row, another transaction may have inserted a
  // newer epoch before this UPSERT reached its conflict clause. Re-read under
  // the transaction lock so the route can treat that no-op as an idempotent
  // stale request rather than appending a false join or returning a misleading
  // authorization failure.
  const current = await db.unsafe(
   `select connection_epoch from huddle_presence
       where huddle_id = $1 and identity = $2
       for update`,
   [huddle.id, identity],
  );
  const currentAfter = String(current[0]?.connection_epoch || '').trim();
  const afterOrdering = compareConnectionEpochs(currentAfter, incomingEpoch);
  if (currentAfter && (afterOrdering === null || afterOrdering > 0)) {
   return { ...current[0], _staleConnectionEpoch: true };
  }
  return null;
 }

 async function clearPresence(huddle, identity, { db = getDb(), connectionEpoch = null } = {}) {
  const normalizedEpoch = connectionEpoch == null
   ? null
   : normalizeConnectionEpoch(connectionEpoch, { fallback: '' });
  if (connectionEpoch != null && !normalizedEpoch) return;
  const epochClause = normalizedEpoch == null ? '' : `and (
           p.connection_epoch = $5
           or case
                when p.connection_epoch ~ '^\\d+$' and $5 ~ '^\\d+$'
                then p.connection_epoch::numeric = $5::numeric
                else false
              end
         )`;
  await db.unsafe(
   `delete from huddle_presence p
          using huddles h
          where p.huddle_id = h.id
            and h.id = $1
            and h.workspace_id = $2
            and h.session_id = $3
            and p.identity = $4
            ${epochClause}`,
   normalizedEpoch == null
     ? [huddle.id, huddle.workspace_id, huddle.session_id, identity]
     : [huddle.id, huddle.workspace_id, huddle.session_id, identity, normalizedEpoch],
  );
 }

 // An ended huddle has no live presence by definition, so the rows are dropped
 // with it — the table means "who is in a call right now", not "who ever was"
 // (that is the event log's job, and it is the one that must be permanent).
 // Best-effort: a huddle must still end if this fails.
 async function clearAllPresence(huddle) {
  try {
   await getDb().unsafe(
    `delete from huddle_presence p
           using huddles h
           where p.huddle_id = h.id
             and h.id = $1
             and h.workspace_id = $2
             and h.session_id = $3`,
    [huddle.id, huddle.workspace_id, huddle.session_id],
   );
  } catch (error) {
   console.warn('[huddles] could not clear presence:', (error && error.message) || error);
  }
 }

 async function markPresenceReaped(huddle, identities) {
  for (const identity of identities) {
   await getDb().unsafe(
    `update huddle_presence p
        set reaped_at = now()
       from huddles h
      where p.huddle_id = h.id
        and h.id = $1
        and h.workspace_id = $2
        and h.session_id = $3
        and p.identity = $4`,
    [huddle.id, huddle.workspace_id, huddle.session_id, identity],
   );
  }
 }

 // Is an agent mid-turn in this huddle? Checked ONLY when the roster is already
 // empty, so it costs nothing on the normal path. Both sessions count: the
 // huddle's own transcript session is where an agent answers, and the host
 // channel is where huddles that predate transcript sessions answered.
 // Deliberately `= $1 or = $2` rather than `= any(array)` — a JS array bound
 // through .unsafe is not array-serialised by postgres.js.
 async function agentBusyInHuddle(huddle) {
  try {
   const rows = await getDb().unsafe(
    `select 1 from agent_jobs
        where status in ('queued', 'running') and (session_id = $1 or session_id = $2) limit 1`,
    [huddle.session_id, huddle.transcript_session_id || null],
   );
   return rows.length > 0;
  } catch {
   // Unknown => assume busy. Getting this wrong in the other direction ends a
   // live conversation.
   return true;
  }
 }

 /**
  * Expire presence that has stopped reporting, and close the huddle if that
  * leaves nobody in it. Returns the huddle row, updated if it was ended.
  *
  * REAP ON READ, not on a tick. Three reasons, in order of weight:
  *
  *   1. A tick is a loop whose existence proves nothing — the recorded lesson
  *      from the agent-job reaper in server/index.cjs is that liveness must key
  *      on real activity timestamps, not on something running. This server
  *      sleeps, redeploys and runs on more than one Fly machine; a reaper that
  *      only works while a particular interval is alive is a reaper you cannot
  *      reason about.
  *   2. A ghost only exists when somebody LOOKS. Every path that can show a
  *      roster — the two GETs, start-or-join, join-by-id, confirm — runs this
  *      first, so what a client can see has been reaped by construction. There
  *      is no window in which the API returns a participant it knows is gone.
  *   3. It cannot double-run. Two Fly machines reaping concurrently write the
  *      same deterministic event ids (deduped by idx_huddle_events_event_id)
  *      and race on one `ended_at is null` UPDATE, which elects one winner —
  *      the same guard that already makes "exactly one channel marker" true.
  *
  * The cost of choosing reads is that a huddle in a channel nobody ever opens
  * again stays `live` in the table until someone does. That is a row, not a
  * ghost: nothing is displaying it, and the moment anything does, it is
  * already correct.
  *
  * Best-effort throughout. A failing reap must never fail the read it is
  * attached to — a huddle you cannot see is worse than a huddle with a ghost.
  */
 async function reapHuddle(huddle, { endIfEmpty = true } = {}) {
  if (!huddle) return huddle;
  if (huddle.ended_at) {
   // A process can die after the lifecycle UPDATE commits but before its
   // marker insert. Reads are a repair opportunity; writeHuddleMarker is
   // idempotent and returns immediately when the marker already exists.
   await writeHuddleMarker(huddle);
   return huddle;
  }
  try {
   const events = await loadEvents(huddle.id);
   const presence = await loadPresence(huddle.id);
   const state = foldHuddleState(huddle, events);
   const nowMs = Date.now();
   // Computed BEFORE anything is appended: the reap's own leave rows are
   // written at now(), and folding them in would reset the very clock the
   // grace below is measured against.
   const lastActivityAtMs = huddleLastActivityAt(huddle, events, presence);
   const stale = staleHuddleIdentities({ participants: state.participants, presence, nowMs });

   const rowsByIdentity = presenceByIdentity(presence);
   const namesByIdentity = new Map(state.participants.map((p) => [p.identity, p.name]));
   for (const identity of stale) {
    const row = rowsByIdentity.get(identity);
    await appendEvent({
     huddle,
     kind: 'participant_left',
     identity,
     // From the fold, so the leave carries the same name the join did.
     displayName: String(namesByIdentity.get(identity) || ''),
     // Deterministic and namespaced: a retry (or a second machine) collapses on
     // the unique index, and it can never collide with the browser's own
     // `self:leave:` id for the same connection.
     eventId: `reap:leave:${identity}:${String((row && row.connection_epoch) || '')}`,
    });
   }
   if (stale.length > 0) await markPresenceReaped(huddle, stale);

   const humanParticipants = state.participants.filter((participant) => isHumanHuddleIdentity(participant.identity));
   const remaining = humanParticipants.length - stale.length;
   if (!endIfEmpty) return huddle;
   if (!shouldEndEmptyHuddle({ participantCount: remaining, lastActivityAtMs, nowMs })) return huddle;
   if (await agentBusyInHuddle(huddle)) return huddle;
   return (await endEmptyHuddle(huddle)) || huddle;
  } catch (error) {
   console.warn('[huddles] presence reap skipped:', (error && error.message) || error);
   return huddle;
  }
 }

 /**
  * Close a huddle nobody is in. Same shape as the End button and the
  * room_finished webhook — including the `returning` guard that makes exactly
  * one of the three write the channel marker.
  */
 async function endEmptyHuddle(huddle) {
  const rows = await getDb().unsafe(
   `update huddles
       set ended_at = now()
     where id = $1
       and workspace_id = $2
       and session_id = $3
       and ended_at is null
     returning ${HUDDLE_COLUMNS}`,
   [huddle.id, huddle.workspace_id, huddle.session_id],
  );
  if (!rows[0]) return null;
  const ended = rows[0];
  fanout('huddles', 'UPDATE', [ended]);
  await appendEvent({ huddle: ended, kind: 'ended', identity: '', eventId: `reap:ended:${ended.id}` });
  await writeHuddleMarker(ended);
  await clearAllPresence(ended);
  try {
   await endRoom(ended.room_name);
  } catch (error) {
   console.warn('[huddles] could not delete LiveKit room after a reap:', (error && error.message) || error);
  }
  return ended;
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
   const host = await sessionInWorkspace(sessionId, workspaceId);
   if (!host) {
    return jsonError(res, 404, new Error('Session not found in this workspace'));
   }
   await enforceSessionRead(req.userId, sessionId, host);
   // Reap BEFORE folding: a roster is the one thing this route exists to
   // render, so it must never hand back a participant whose browser has
   // stopped reporting.
   const huddle = await reapHuddle((await liveHuddleForSession(sessionId)) || (await latestHuddleForSession(sessionId)));
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
   const existing = await huddleInWorkspace(huddleId, workspaceId);
   if (!existing) return jsonError(res, 404, new Error('Huddle not found in this workspace'));
   await enforceHuddleRead(req.userId, existing);
   const huddle = await reapHuddle(existing);
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
   await enforceSessionRead(req.userId, sessionId, host);
   const name = await displayNameFor(req.userId);

   // Reap first. Pressing "Huddle" on a channel whose last call is a room full
   // of crashed browsers must open a NEW one, not enrol you in the wake — and
   // the reap is what frees idx_huddles_one_live_per_session to allow it.
   let huddle = await reapHuddle(await liveHuddleForSession(sessionId));
   if (huddle && huddle.ended_at) huddle = null;
   let created = false;
   let token = '';
   if (!huddle) {
    const id = crypto.randomUUID();
    try {
     huddle = await getDb().begin(async (transaction) => {
      const tx = (sql, params = []) => transaction.unsafe(sql, params);

      // Authorization evidence and the source conversation are locked before
      // either the huddle or transcript exists. A concurrent role/member revoke
      // or session close therefore has a serial boundary, not a check/write gap.
      await assertWorkspaceRoleLocked({
       userId: req.userId,
       workspaceId,
       capability: 'write',
       db: tx,
      });
      const hosts = await tx(
       `select host.id, host.workspace_id, host.title, host.model, host.folder,
               host.canvas_id, host.participants, host.visibility,
               host.deleted_at
          from chat_sessions host
         where host.id = $1::uuid
           and host.workspace_id = $2::uuid
           and host.deleted_at is null
         for share of host`,
       [sessionId, workspaceId],
      );
      const lockedHost = hosts[0] || null;
      if (!lockedHost) {
       const error = new Error('Session not found in this workspace');
       error.status = 404;
       throw error;
      }
      await lockPrivateSessionRoster({
       db: tx,
       userId: req.userId,
       parent: lockedHost,
      });

      const rows = await tx(
       `insert into huddles (id, workspace_id, session_id, room_name, started_by)
              values ($1, $2, $3, $4, $5) returning ${HUDDLE_COLUMNS}`,
       [id, workspaceId, sessionId, roomNameForHuddle(id), req.userId || null],
      );
      const createdHuddle = rows[0] || null;
      if (!createdHuddle) return null;

      // A transcript failure rolls back only the savepoint. The huddle commits
      // without transcript_session_id and all readers use the host session,
      // preserving availability without committing a private orphan.
      try {
       const linked = await transaction.savepoint(async (savepoint) => (
        createTranscriptSession(
         (sql, params = []) => savepoint.unsafe(sql, params),
         createdHuddle,
         lockedHost,
        )
       ));
       return linked || createdHuddle;
      } catch (error) {
       console.error('huddle transcript creation failed', error?.message || error);
       return createdHuddle;
      }
     });
     created = Boolean(huddle);
    } catch (error) {
     // idx_huddles_one_live_per_session lost a race with a second starter —
     // that is the index doing its job. Fall in behind them.
     if (String(error && error.code) !== '23505') throw error;
     huddle = await liveHuddleForSession(sessionId);
    }
   }
   if (!huddle) return jsonError(res, 409, new Error('Could not open a huddle for this session'));

   // Creation committed before this external side effect. Re-lock the host,
   // private membership (when applicable), and live huddle for both new and
   // existing calls so a concurrent revoke has a serial order with token minting.
   const lockedJoin = await mintLockedJoin({ huddle, workspaceId, userId: req.userId, name });
   huddle = lockedJoin.huddle;
   token = lockedJoin.token;

  if (created) {
    // The huddle, transcript, private member graph, and transcript link have
    // committed before any durable huddle state becomes visible to subscribers.
    fanout('huddles', 'INSERT', [huddle]);
    // A 'started' marker, not a synthetic participant_joined: nobody has
    // connected to the room yet and the card must not claim they have.
    await appendEvent(
     { huddle, kind: 'started', identity: participantIdentity(req.userId) },
     { actorUserId: req.userId, requireLiveHuddle: true },
    );
   }

   // The agents join the moment the room exists, not when someone speaks — a
   // huddle should already have its people in it when the human arrives. Only on
   // creation: joining an existing huddle must not dispatch a second copy of
   // every agent into a room they are already in.
   if (created) dispatchIntoRoom(huddle);

   res.status(created ? 201 : 200).json({
    data: {
     ...(await huddlePayload(huddle)),
     token,
     url: livekitConfig().url,
     identity: participantIdentity(req.userId),
     roomName: huddle.room_name,
     // The client beats at the interval the SERVER names, so the window and the
     // threshold it is measured against can only ever be changed together —
     // and changing them does not need a frontend deploy.
     heartbeatIntervalMs: HUDDLE_HEARTBEAT_INTERVAL_MS,
     created,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // What was SAID in the huddle, written into its dedicated transcript session.
 //
 // The voice worker posts here as each turn finalises. The dedicated huddle
 // transcript is durable and searchable — without this, the spoken half dies
 // with the room: nobody who missed the call can read it or search it.
 //
 // Authenticated by the per-agent voice credential, NOT a human session: the
 // caller is a worker process, and the credential already names exactly which
 // agent it is allowed to be. It is scoped to one workspace, so a token from one
 // workspace cannot write into another's channel however it is aimed.
 app.post('/backend/huddles/transcript', async (req, res) => {
  try {
   if (typeof verifyVoiceSessionToken !== 'function') {
    return jsonError(res, 503, new Error('Voice transcript ingest is not configured'));
   }
   const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
   const identity = bearer ? await verifyVoiceSessionToken(bearer) : null;
   if (!identity) return jsonError(res, 401, new Error('A voice session credential is required'));

   const huddleId = String(req.body?.huddleId || '').trim();
   const rawEventId = String(req.body?.eventId || '').trim();
   const requestedRole = String(req.body?.role || '');
   if (requestedRole !== 'assistant' && requestedRole !== 'user') return jsonError(res, 400, new Error('role must be user or assistant'));
   const role = requestedRole;
   const content = String(req.body?.content || '').trim();
   if (!huddleId) return jsonError(res, 400, new Error('huddleId is required'));

   const rows = await getDb().unsafe(
    `select ${HUDDLE_COLUMNS.split(', ').map((column) => `h.${column}`).join(', ')}, transcript_scope.participants as transcript_participants
       from huddles h
       left join chat_sessions transcript_scope
         on transcript_scope.id = coalesce(h.transcript_session_id, h.session_id)
        and transcript_scope.workspace_id = h.workspace_id
      where h.id = $1 and h.workspace_id = $2 limit 1`,
    [huddleId, identity.workspaceId],
   );
   const huddle = rows[0];
   if (!huddle) return jsonError(res, 404, new Error('Huddle not found in this workspace'));
   if (identity.huddleId && String(identity.huddleId) !== huddleId) return jsonError(res, 403, new Error('Voice credential is for another huddle'));
   if (huddle.ended_at) return res.json({ data: { written: false, reason: 'ended' }, error: null });
   if (!(await controllerStillAuthorized(huddle))) {
    return jsonError(res, 403, new Error('Huddle controller is no longer authorized'));
   }

   let participantIds = huddle.transcript_participants;
   if (typeof parseJsonArray === 'function') participantIds = parseJsonArray(participantIds);
   if (typeof participantIds === 'string') {
    try { participantIds = JSON.parse(participantIds); } catch { participantIds = []; }
   }
   participantIds = (Array.isArray(participantIds) ? participantIds : []).map((value) => String(value || '').trim()).filter(Boolean);
   const agentId = String(identity.agentId || '');
   if (!agentId || !participantIds.includes(agentId)) return jsonError(res, 403, new Error('Agent is not a participant in this huddle'));
   // Empty authenticated probes are used by the worker to detect huddle and
   // credential revocation. They must pass lifecycle/roster checks above, but
   // must not consume a transcript budget or require speaker attribution.
   if (!content) return res.json({ data: { written: false, reason: 'empty' }, error: null });
   // Any dispatched roster agent may mirror a user row. RoomIO target gating
   // ensures only the active worker receives that turn; this also preserves
   // transcripts when the first roster worker fails or the active target changes.

   // New workers always supply an event id. A legacy caller without one gets a
   // unique fallback rather than collapsing two identical human utterances; it
   // cannot promise retry idempotency without a source id.
   const eventId = rawEventId || `legacy:${crypto.randomUUID()}`;
   if (!/^[A-Za-z0-9._:-]{1,256}$/.test(eventId) || eventId.startsWith('huddle-marker:')) {
    return jsonError(res, 400, new Error('eventId is invalid'));
   }

   let speakerId = '';
   let speakerName = 'Participant';
   if (role === 'user') {
    const candidate = String(req.body?.speakerId || '').trim();
    if (!candidate) return jsonError(res, 400, new Error('speakerId is required for a user voice entry'));
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(candidate)) return jsonError(res, 400, new Error('speakerId is invalid'));
    if (!candidate.startsWith('user:')) return jsonError(res, 403, new Error('A user voice entry needs a human participant'));
    // A final STT event can be queued just as a participant leaves. The live
    // presence row may already be reaped, but a historical join event is still
    // the huddle-scoped proof that this identity belonged here.
    const participant = await getDb().unsafe(
     `select identity from huddle_presence
        where huddle_id = $1 and identity = $2 and reaped_at is null
      union all
      select identity from huddle_events
        where huddle_id = $1 and identity = $2 and kind = 'participant_joined'
      limit 1`,
     [huddle.id, candidate],
    );
    if (!participant[0]?.identity) return jsonError(res, 403, new Error('Speaker is not a participant in this huddle'));
    speakerId = String(participant[0].identity);
    const names = await getDb().unsafe(
     `select display_name from huddle_events
        where huddle_id = $1 and identity = $2 and kind = 'participant_joined'
        order by created_at desc, seq desc limit 1`,
     [huddle.id, speakerId],
    );
    speakerName = String(names[0]?.display_name || speakerName).slice(0, 200);
   }
   const sessionId = huddle.transcript_session_id || huddle.session_id;
   const isAgent = role === 'assistant';
   const marker = '\\n… [voice result truncated]';
   const cappedContent = content.length > 8000 ? `${content.slice(0, 8000 - marker.length)}${marker}` : content;
   // A roster worker is a trusted mirror capability, not an unbounded write
   // endpoint. Rate-limit BOTH user STT and assistant output after attribution
   // checks, so a bad worker cannot grow a transcript or realtime fanout even
   // when it uses a valid read-only voice credential.
   allowVoiceTranscript({
    workspaceId: identity.workspaceId,
    huddleId: huddle.id,
    agentId,
    chars: cappedContent.length,
   });

   const inserted = await getDb().unsafe(
    `with inserted as (
       insert into messages (session_id, role, content, sender_kind, sender_id, sender_name, huddle_id, huddle_transcript_event_id)
            values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (huddle_id, huddle_transcript_event_id) do nothing
         returning *, true as _huddle_transcript_inserted
     )
     select * from inserted
     union all
     select messages.*, false as _huddle_transcript_inserted
       from messages
      where not exists (select 1 from inserted)
        and messages.huddle_id = $7 and messages.huddle_transcript_event_id = $8
      limit 1`,
    [
     sessionId,
     role,
     cappedContent,
     isAgent ? 'agent' : 'user',
     isAgent ? agentId : speakerId,
     isAgent ? (identity.name || identity.handle || 'Agent') : speakerName,
     huddle.id,
     eventId,
    ],
   );
   const row = inserted[0];
   const insertedNow = row?._huddle_transcript_inserted === true;
   if (insertedNow) {
    const realtimeRow = { ...row };
    delete realtimeRow._huddle_transcript_inserted;
    notifyDbSubscribers('messages', 'INSERT', [realtimeRow]);
   }
   res.json({ data: { written: Boolean(row), duplicate: row?._huddle_transcript_inserted === false, sessionId }, error: null });
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
   const existing = await huddleInWorkspace(huddleId, workspaceId);
   if (!existing) return jsonError(res, 404, new Error('Huddle not found in this workspace'));
   await enforceHuddleRead(req.userId, existing);
   const huddle = await reapHuddle(existing);
   // Also the reap's answer: joining a room whose occupants all crashed ten
   // minutes ago is refused, truthfully, instead of putting you alone in it.
   if (huddle.ended_at) return jsonError(res, 409, new Error('This huddle has ended'));

   const name = await displayNameFor(req.userId);
   const lockedJoin = await mintLockedJoin({ huddle, workspaceId, userId: req.userId, name });
   const lockedHuddle = lockedJoin.huddle;
   const token = lockedJoin.token;
   res.json({
    data: {
     ...(await huddlePayload(lockedHuddle)),
     token,
     url: livekitConfig().url,
     identity: participantIdentity(req.userId),
     roomName: lockedHuddle.room_name,
     heartbeatIntervalMs: HUDDLE_HEARTBEAT_INTERVAL_MS,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- self-reported presence ----------------------------------------------
 //
 // In 48 huddles the LiveKit webhook delivered ZERO participant events (it has
 // to be configured in LiveKit Cloud's dashboard, an external step nobody can
 // automate). The roster therefore always read "Waiting for the first person
 // to connect" — while the person it was waiting for was live and talking.
 //
 // The browser knows its own connection state, so it reports its OWN join and
 // leave here. The webhook remains the authority for participants this client
 // cannot see; fold order does not matter because the fold is idempotent per
 // (kind, identity) and appendEvent dedupes on event_id. A hostile client can
 // only lie about ITSELF, which the webhook could then contradict — it cannot
 // add or remove anyone else: identity is derived from the verified session,
 // never from the body.
 app.post('/backend/workspaces/:id/huddles/:huddleId/confirm', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const huddleId = String(req.params.huddleId || '').trim();
   if (!workspaceId || !huddleId) return jsonError(res, 400, new Error('workspaceId and huddleId are required'));
   const rawEpoch = req.body?.connectionEpoch;
   if (rawEpoch === undefined || rawEpoch === null || rawEpoch === '') {
    return jsonError(res, 400, new Error('connectionEpoch is required'));
   }
   const epoch = normalizeConnectionEpoch(rawEpoch, { fallback: '' });
   if (!epoch) return jsonError(res, 400, new Error('connectionEpoch is invalid'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'write');
   await ensureSchemaOnce();
   const huddle = await huddleInWorkspace(huddleId, workspaceId);
   if (!huddle) return jsonError(res, 404, new Error('Huddle not found in this workspace'));
   await enforceHuddleRead(req.userId, huddle);
   if (huddle.ended_at) return jsonError(res, 409, new Error('This huddle has ended'));
   // Clear out anyone who has stopped reporting, so the roster the arriving
   // participant is handed is already correct — but never END the huddle from
   // here: somebody is walking in the door as this runs.
   await reapHuddle(huddle, { endIfEmpty: false });
   const identity = participantIdentity(req.userId);
   const displayName = await displayNameFor(req.userId);
   const confirmed = await getDb().begin(async (tx) => {
    const locked = await lockActorHuddle(tx, {
     huddleId,
     workspaceId,
     sessionId: huddle.session_id,
     userId: req.userId,
     requireLive: true,
     forUpdate: true,
    });
    const presence = await touchPresence({
     db: tx,
     huddle: locked,
     userId: req.userId,
     identity,
     connectionEpoch: epoch,
     beat: false,
    });
    if (!presence) throw accessChanged();
    if (presence._staleConnectionEpoch) return { huddle: locked, event: null };
    const event = await appendEvent({
     huddle: locked,
     kind: 'participant_joined',
     identity,
     displayName,
     // Per-connection, not per-user: rejoin after a drop is a NEW event, while
     // the same connection re-confirming (a retry) stays one row.
     eventId: `self:join:${identity}:${epoch}`,
    }, {
     db: tx,
     actorUserId: req.userId,
     requireLiveHuddle: true,
     deferFanout: true,
    });
    return { huddle: locked, event };
   });
   if (confirmed.event) fanout('huddle_events', 'INSERT', [confirmed.event]);
   res.json({
    data: {
     ...(await huddlePayload(confirmed.huddle)),
     heartbeatIntervalMs: HUDDLE_HEARTBEAT_INTERVAL_MS,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/huddles/:huddleId/leave', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const huddleId = String(req.params.huddleId || '').trim();
   if (!workspaceId || !huddleId) return jsonError(res, 400, new Error('workspaceId and huddleId are required'));
   const epoch = normalizeConnectionEpoch(req.body?.connectionEpoch, { fallback: '' });
   if (!epoch) return jsonError(res, 400, new Error('connectionEpoch is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'write');
   await ensureSchemaOnce();
   const huddle = await huddleInWorkspace(huddleId, workspaceId);
   if (!huddle) return jsonError(res, 404, new Error('Huddle not found in this workspace'));
   await enforceHuddleRead(req.userId, huddle);
   const identity = participantIdentity(req.userId);
   const departed = await getDb().begin(async (tx) => {
    const locked = await lockActorHuddle(tx, {
     huddleId,
     workspaceId,
     sessionId: huddle.session_id,
     userId: req.userId,
     requireLive: false,
     forUpdate: true,
    });
    const presence = await tx.unsafe(
     `select connection_epoch from huddle_presence
         where huddle_id = $1 and identity = $2
         for update`,
     [locked.id, identity],
    );
    // A delayed tab may leave after this user has rejoined with a newer epoch.
    // It must not append a false leave or delete the current presence row.
    if (presence[0] && compareConnectionEpochs(presence[0].connection_epoch, epoch) !== 0) {
     return { huddle: locked, event: null, stale: true };
    }
    const event = await appendEvent({
     huddle: locked,
     kind: 'participant_left',
     identity,
     displayName: await displayNameFor(req.userId),
     eventId: `self:leave:${identity}:${epoch}`,
    }, { db: tx, deferFanout: true });
    await clearPresence(locked, identity, { db: tx, connectionEpoch: epoch });
    return { huddle: locked, event, stale: false };
   });
   if (departed.event) fanout('huddle_events', 'INSERT', [departed.event]);
   res.json({ data: await huddlePayload(await huddleInWorkspace(huddleId, workspaceId)), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 /**
  * "Still here." The smallest write in the module, and the only one that runs
  * on a timer in the browser.
  *
  * Identity comes from the verified session, exactly like /confirm — a client
  * may only ever speak about itself, so the worst a hostile one can do is keep
  * ITSELF in a huddle it is a member of.
  *
  * A 409 is load-bearing: it is how a browser whose websocket died finds out
  * the huddle is over and stops beating into it.
  */
 app.post('/backend/workspaces/:id/huddles/:huddleId/heartbeat', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const huddleId = String(req.params.huddleId || '').trim();
   if (!workspaceId || !huddleId) return jsonError(res, 400, new Error('workspaceId and huddleId are required'));
   const rawEpoch = req.body?.connectionEpoch;
   if (rawEpoch === undefined || rawEpoch === null || rawEpoch === '') {
    return jsonError(res, 400, new Error('connectionEpoch is required'));
   }
   const epoch = normalizeConnectionEpoch(rawEpoch, { fallback: '' });
   if (!epoch) return jsonError(res, 400, new Error('connectionEpoch is invalid'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'write');
   await ensureSchemaOnce();
   const huddle = await huddleInWorkspace(huddleId, workspaceId);
   if (!huddle) return jsonError(res, 404, new Error('Huddle not found in this workspace'));
   await enforceHuddleRead(req.userId, huddle);
   if (huddle.ended_at) return jsonError(res, 409, new Error('This huddle has ended'));

   const identity = participantIdentity(req.userId);
   const displayName = await displayNameFor(req.userId);
   const heartbeat = await getDb().begin(async (tx) => {
    const locked = await lockActorHuddle(tx, {
     huddleId,
     workspaceId,
     sessionId: huddle.session_id,
     userId: req.userId,
     requireLive: true,
     forUpdate: true,
    });
    const row = await touchPresence({
     db: tx,
     huddle: locked,
     userId: req.userId,
     identity,
     connectionEpoch: epoch,
     beat: true,
    });
    if (!row) throw accessChanged();
    if (row._staleConnectionEpoch || !row.reaped_at) return { rejoined: false, event: null };

    // We were expired while away — longer than the window, so the roster has
    // already been told we left. Say we are back rather than staying live in
    // the room and invisible on the card. The event id is keyed on the reap
    // that caused it, so the retry of a failed beat collapses onto one row.
    const event = await appendEvent({
      huddle: locked,
      kind: 'participant_joined',
      identity,
      displayName,
      eventId: `reap:rejoin:${identity}:${isoOf(row.reaped_at) || ''}`,
     }, {
      db: tx,
      actorUserId: req.userId,
      requireLiveHuddle: true,
      deferFanout: true,
     });
    const cleared = await tx.unsafe(
      `update huddle_presence p
          set reaped_at = null
         from huddles h
         join chat_sessions host
           on host.id = h.session_id
          and host.workspace_id = h.workspace_id
        where p.huddle_id = h.id
          and h.id = $1
          and h.workspace_id = $2
          and h.session_id = $3
          and h.ended_at is null
          and p.identity = $4
          and ${sessionReadableSql('host', '$5')}
        returning p.huddle_id`,
      [locked.id, locked.workspace_id, locked.session_id, identity, req.userId],
     );
    if (cleared.length !== 1) throw accessChanged();
    return { rejoined: true, event };
   });
   if (heartbeat.event) fanout('huddle_events', 'INSERT', [heartbeat.event]);

   // Deliberately NOT the folded payload. This runs every 30 seconds per
   // participant; loading the whole event log to answer it would turn the
   // cheapest write in the module into the most expensive read.
   res.json({
    data: { ok: true, rejoined: heartbeat.rejoined, heartbeatIntervalMs: HUDDLE_HEARTBEAT_INTERVAL_MS },
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
   await enforceHuddleRead(req.userId, existing);

   // `ended_at is null` makes this idempotent. The current host/member scope is
   // locked first and repeated in the UPDATE, so a clear or revoke cannot land
   // between the route check and the authoritative lifecycle transition.
   const ended = await getDb().begin(async (tx) => {
    const locked = await lockActorHuddle(tx, {
     huddleId,
     workspaceId,
     sessionId: existing.session_id,
     userId: req.userId,
     requireLive: false,
     forUpdate: true,
    });
    const rows = await tx.unsafe(
     `update huddles h
         set ended_at = now()
        from chat_sessions host
       where h.id = $1
         and h.workspace_id = $2
         and h.session_id = $3
         and h.ended_at is null
         and host.id = h.session_id
         and host.workspace_id = h.workspace_id
         and ${sessionReadableSql('host', '$4')}
       returning ${HUDDLE_COLUMNS.split(', ').map((column) => `h.${column}`).join(', ')}`,
     [huddleId, workspaceId, existing.session_id, req.userId],
    );
    if (!locked.ended_at && rows.length !== 1) throw accessChanged();
    return { huddle: rows[0] || locked, changed: Boolean(rows[0]) };
   });
   const huddle = ended.huddle;
   if (ended.changed) {
    fanout('huddles', 'UPDATE', [huddle]);
    await appendEvent({ huddle, kind: 'ended', identity: participantIdentity(req.userId) });
    // After the 'ended' event, so the fold the marker is built from already
    // knows the huddle is over and reports a real duration.
    await writeHuddleMarker(huddle);
    await clearAllPresence(huddle);
    try {
     await endRoom(huddle.room_name);
    } catch (error) {
     // The row is authoritative; a failed teardown must not fail the request.
     console.warn('[huddles] could not delete LiveKit room:', (error && error.message) || error);
    }
   } else {
    // Repair a marker lost after a previous request committed ended_at.
    await writeHuddleMarker(huddle);
   }
   res.json({ data: await huddlePayload(huddle), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- notes -----------------------------------------------------------------

 // Shared notes for the call. Deliberately its OWN route rather than a generic
 // /backend/db/update refuses huddle writes entirely: the row carries
 // LiveKit/webhook authority no generic mutation may touch. Notes are just text
 // anyone in the call could have said out loud, so this dedicated route gates
 // on 'write' — the same bar as posting in the channel the huddle was called
 // from — and touches nothing but the one column.
 app.post('/backend/workspaces/:id/huddles/:huddleId/notes', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const huddleId = String(req.params.huddleId || '').trim();
   if (!workspaceId || !huddleId) return jsonError(res, 400, new Error('workspaceId and huddleId are required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'write');
   await ensureSchemaOnce();

   const notes = typeof req.body?.notes === 'string' ? req.body.notes : '';
   if (notes.length > NOTES_MAX_LENGTH) {
    return jsonError(res, 400, new Error(`notes must be ${NOTES_MAX_LENGTH} characters or fewer`));
   }

   const existing = await huddleInWorkspace(huddleId, workspaceId);
   if (!existing) return jsonError(res, 404, new Error('Huddle not found in this workspace'));
   await enforceHuddleRead(req.userId, existing);

   const huddle = await getDb().begin(async (tx) => {
    const locked = await lockActorHuddle(tx, {
     huddleId,
     workspaceId,
     sessionId: existing.session_id,
     userId: req.userId,
     requireLive: false,
     forUpdate: true,
    });
    const rows = await tx.unsafe(
     `update huddles h
         set notes = $1
        from chat_sessions host
       where h.id = $2
         and h.workspace_id = $3
         and h.session_id = $4
         and host.id = h.session_id
         and host.workspace_id = h.workspace_id
         and ${sessionReadableSql('host', '$5')}
       returning ${HUDDLE_COLUMNS.split(', ').map((column) => `h.${column}`).join(', ')}`,
     [notes, huddleId, workspaceId, existing.session_id, req.userId],
    );
    if (rows.length !== 1) throw accessChanged();
    return rows[0] || locked;
   });
   fanout('huddles', 'UPDATE', [huddle]);
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
    `select ${HUDDLE_COLUMNS} from huddles where room_name = $1 and id = $2 limit 1`,
    [roomName, huddleId],
   );
   const huddle = rows[0];
   if (!huddle) return res.status(200).json({ data: { ignored: true }, error: null });

   let event = null;
   if (kind === 'ended' && !huddle.ended_at) {
    const updated = await getDb().unsafe(
     `update huddles
         set ended_at = now()
       where id = $1
         and workspace_id = $2
         and session_id = $3
         and ended_at is null
       returning ${HUDDLE_COLUMNS}`,
     [huddle.id, huddle.workspace_id, huddle.session_id],
    );
    // `returning` is the guard: a room_finished redelivery updates zero rows,
    // so the channel cannot collect a second marker for the same huddle. This
    // is the OTHER way a huddle ends (everyone walked away rather than someone
    // pressing End) and it must leave the same record behind.
    if (updated[0]) {
     event = await appendEvent({
      huddle: updated[0],
      kind,
      identity: '',
      displayName: '',
      eventId: String(payload.id || ''),
      createdAt: webhookEventTime(payload),
     });
     fanout('huddles', 'UPDATE', [updated[0]]);
     await writeHuddleMarker(updated[0]);
     await clearAllPresence(updated[0]);
    }
   } else if (kind === 'ended') {
    // Redelivery after a crash may find ended_at already committed while the
    // marker is still missing; repair it without appending another event.
    await writeHuddleMarker(huddle);
   } else if (kind !== 'ended') {
    const participant = payload.participant || {};
    // An ordinary join/leave is not cleanup. It may only extend the append-only
    // log while both the huddle and its host are currently live; late webhook
    // delivery after End/clear is acknowledged but writes nothing.
    event = await appendEvent({
     huddle,
     kind,
     identity: String(participant.identity || ''),
     displayName: String(participant.name || ''),
     eventId: String(payload.id || ''),
     createdAt: webhookEventTime(payload),
    }, { requireLiveHost: true, requireLiveHuddle: true });
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
 HUDDLE_HEARTBEAT_INTERVAL_MS,
 HUDDLE_PRESENCE_STALE_MS,
 HUDDLE_EMPTY_GRACE_MS,
 HUDDLES_SCHEMA_SQL,
 NOTES_MAX_LENGTH,
 ensureHuddlesSchema,
 mountHuddleRoutes,
 // Exported for tests and for reuse by the MCP/netlify surfaces later.
 roomNameForHuddle,
 huddleIdFromRoomName,
 participantIdentity,
 userIdFromIdentity,
 normalizeConnectionEpoch,
 compareConnectionEpochs,
 foldHuddleState,
 huddleMarkerContent,
 everJoinedNames,
 huddleLeftATrace,
 staleHuddleIdentities,
 huddleLastActivityAt,
 isHumanHuddleIdentity,
 shouldEndEmptyHuddle,
 buildJoinGrant,
 verifyLivekitWebhook,
 huddleEventKindFor,
 webhookEventTime,
 livekitConfigured,
 deleteLivekitRoom,
 tokenTtlSeconds,
 mintJoinToken,
};
