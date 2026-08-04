'use strict';

// ----------------------------------------------------------------------------
// The atomic reaction toggle — ONE implementation, both backends.
//
// WHY THIS FILE EXISTS
//
// `messages.reactions` is a jsonb MAP (`{ "<reaction>": ["<userId>", …] }`), and
// until now the only writer was the browser: read the map out of React state,
// splice your id in or out, PUT the whole map back through /backend/db/update.
// That is a read-modify-write across a network round trip with the read taken
// from a replica of the truth, so two people reacting to the same message inside
// the realtime propagation window each computed a full map from a stale base and
// the second write silently erased the first. It also meant the map was
// caller-authored, so any client could write any user's id into it —
// shared/reaction-events.cjs says so out loud at `actorUserId`.
//
// Both defects come from the same root: the mutation lived on the client. Moving
// it into ONE SQL statement fixes both. The statement mutates the stored map in
// place (so there is no stale base), and the user id is bound from `req.userId`
// (so there is nothing to forge).
//
// THE CONTRACT WITH shared/reaction-events.cjs
//
// The flow-webhook feature derives events by DIFFING the map before the write
// against the map after it (`diffReactionMaps`), and that diff is what makes
// emission idempotent. A single-statement UPDATE returns only the AFTER map, so
// the obvious move — a SELECT for the before-image — would reintroduce exactly
// the race we came here to kill.
//
// It is not needed. The statement's WHERE guard makes the transition EXACT: the
// row is written if and only if the named user was absent (add) or present
// (remove) for that reaction. So the before-image is a pure function of the
// after-image and the operation, and `priorReactionMap` below computes it with
// no query at all. `emitReactionFlowEventsForUpdate` still receives two real
// maps and still diffs them; the contract holds verbatim, and it now holds on a
// before-image that cannot be stale.
//
// CONCURRENCY, precisely
//
// Under READ COMMITTED a second concurrent UPDATE of the same row blocks on the
// row lock, then re-evaluates its WHERE against the COMMITTED row rather than
// its original snapshot. So two people adding different reactions both land, two
// people adding the same one land once, and a double-click is a no-op instead of
// a duplicate id in the array.
//
// One deliberate note on the distinct-reaction cap: it is the only correlated
// sub-select in the qual. It re-evaluates with the rest of the WHERE, but even
// if it did not, the worst case is a message reaching 25 distinct reactions
// instead of 24. The lost-update guard — the `@>` containment test — is a plain
// scalar predicate on the row's own column, which is the part that has to be
// exactly right.
// ----------------------------------------------------------------------------

const { MAX_REACTION_LENGTH } = require('./reaction-events.cjs');
const { sessionReadableSql } = require('./backend-core.cjs');

const REACTION_OPS = Object.freeze(['add', 'remove']);

// A message may carry at most this many DISTINCT reactions. Not a limit on how
// many people react — that is the product working — but on how wide the jsonb
// object can get, because the map is rebroadcast in full on every change and
// there was no bound on it at all before this route existed.
const MAX_DISTINCT_REACTIONS_PER_MESSAGE = 24;

// The columns shared/reaction-events.cjs reads off the row to build an event.
// Named here rather than at each call site so the two lanes cannot drift into
// returning different shapes to the same event builder.
const REACTION_RETURNING_COLUMNS = 'id, session_id, reactions, sender_kind, sender_id, sender_name, thread_parent_id, created_at';
const REACTION_CURRENT_SQL = `select ${REACTION_RETURNING_COLUMNS}
  from messages
 where id = $1::uuid
   and session_id = $2::uuid
   and deleted_at is null
   and exists (
     select 1
       from chat_sessions reaction_session_scope
      where reaction_session_scope.id = messages.session_id
        and ${sessionReadableSql('reaction_session_scope', '$3')}
   )
 limit 1`;

// $1 message id, $2 session id, $3 reaction, $4 user id.
//
// `session_id` is in the WHERE, not merely for tenancy tidiness: the route
// resolves the workspace and the DM gate through the session the CALLER named,
// so the write must be confined to that same session or the authorization was
// performed against a different row than the one mutated.
const REACTION_ADD_SQL = `update messages
   set reactions = jsonb_set(
         coalesce(reactions, '{}'::jsonb),
         array[$3::text],
         coalesce(reactions -> $3::text, '[]'::jsonb) || to_jsonb($4::text)
       )
 where id = $1::uuid
   and session_id = $2::uuid
   and deleted_at is null
   and exists (
     select 1
       from chat_sessions reaction_session_scope
      where reaction_session_scope.id = messages.session_id
        and ${sessionReadableSql('reaction_session_scope', '$4', { lockMembership: true })}
      for share
   )
   and not coalesce(reactions -> $3::text, '[]'::jsonb) @> to_jsonb($4::text)
   and (
     coalesce(reactions, '{}'::jsonb) ? $3::text
     or (select count(*) from jsonb_object_keys(coalesce(reactions, '{}'::jsonb))) < ${MAX_DISTINCT_REACTIONS_PER_MESSAGE}
   )
returning ${REACTION_RETURNING_COLUMNS}`;

// Deletes the KEY when the last holder leaves, rather than leaving `[]` behind.
// That is the invariant normalizeReactionMap already assumes (a reaction nobody
// holds reads as ABSENT), and a row that kept an empty array would show up as a
// phantom difference on the next diff.
const REACTION_REMOVE_SQL = `update messages
   set reactions = case
         when jsonb_array_length(coalesce(reactions -> $3::text, '[]'::jsonb) - $4::text) = 0
           then coalesce(reactions, '{}'::jsonb) - $3::text
         else jsonb_set(
                coalesce(reactions, '{}'::jsonb),
                array[$3::text],
                coalesce(reactions -> $3::text, '[]'::jsonb) - $4::text
              )
       end
 where id = $1::uuid
   and session_id = $2::uuid
   and deleted_at is null
   and exists (
     select 1
       from chat_sessions reaction_session_scope
      where reaction_session_scope.id = messages.session_id
        and ${sessionReadableSql('reaction_session_scope', '$4', { lockMembership: true })}
      for share
   )
   and coalesce(reactions -> $3::text, '[]'::jsonb) @> to_jsonb($4::text)
returning ${REACTION_RETURNING_COLUMNS}`;

function reactionToggleSql(op) {
 if (op === 'add') return REACTION_ADD_SQL;
 if (op === 'remove') return REACTION_REMOVE_SQL;
 throw new Error(`Unknown reaction op: ${op}`);
}

// ----------------------------------------------------------------------------
// The AGENT lane.
//
// An agent has a row in `workspace_agents`, not in `app_users`, so it has no
// `req.userId` and every statement above is unreachable to it: `sessionReadableSql`
// authorizes a HUMAN through chat_session_members. That absence — not a
// permissions setting — is why an agent could not react at all.
//
// The map itself is unchanged. The stored value is the agent's id, exactly as a
// human's entry is the user's id, because the map is `{ reaction: [id, …] }` and
// nothing in it has ever declared which table an id came from. The client
// resolves a name for an unknown id off the agent roster, which is the same
// shape read receipts already use (a marker's reader is `user_id` OR `agent_id`
// and the client resolves both the same way).
//
// What changes is the authorization predicate, and it is deliberately the SAME
// rule the MCP surface already applies to this agent for reading and posting in
// a session (`mcpSessionScopeSql`): an open channel, or a session this agent is
// a listed participant of. A private conversation it was never added to stays
// closed, so an agent cannot annotate a DM it cannot read.
//
// Two liveness facts are joined INSIDE the statement rather than checked before
// it, so a disable or a removal landing between the caller's authorization and
// this write fails closed rather than racing it:
//   * `workspace_agents.enabled is not false` — a disabled agent writes nothing.
//   * the agent's workspace must be the SESSION's workspace — an agent cannot
//     reach across tenants even if a caller names a foreign message id.
// `for share` holds both rows for the duration, matching ADVANCE_AGENT_READ_MARKER_SQL.
//
// `mcp_approved` is deliberately NOT required here, for the same reason
// insertAgentMessage does not require it of a per-agent token: it authorizes an
// external client acting AS an agent, and that check belongs at the identity
// resolution (`resolveActingAgent`), not on the row write. Putting it here too
// would silently suppress reactions for the default builtin agent whose turn is
// already fully authorized to post in the channel.
//
// $agentParam is the agent id, bound as text and as uuid.
function agentReactionScopeSql(agentParam) {
 return `exists (
     select 1
       from chat_sessions reaction_session_scope
       join workspace_agents reacting_agent
         on reacting_agent.id = ${agentParam}::uuid
        and reacting_agent.workspace_id = reaction_session_scope.workspace_id
        and reacting_agent.enabled is not false
      where reaction_session_scope.id = messages.session_id
        and reaction_session_scope.deleted_at is null
        and (
          (coalesce(reaction_session_scope.visibility, 'workspace') <> 'private'
           and coalesce(reaction_session_scope.folder, '') <> 'Direct messages')
          or exists (
            select 1
              from jsonb_array_elements(
                case when jsonb_typeof(reaction_session_scope.participants) = 'array'
                     then reaction_session_scope.participants else '[]'::jsonb end
              ) reacting_agent_participant
             where reacting_agent_participant->>'agent_id' = ${agentParam}::text
          )
        )
      for share of reaction_session_scope, reacting_agent
   )`;
}

// $1 message id, $2 session id, $3 reaction, $4 agent id.
//
// The guards are the human statement's guards verbatim — the `@>` containment
// test that makes the transition exact (and therefore makes priorReactionMap a
// pure function of the after-image), and the distinct-reaction cap. Only the
// authorization `exists (…)` differs. Keeping them identical is what lets both
// lanes share priorReactionMap and explainReactionNoop rather than growing a
// second, subtly different reconstruction of the before-image.
const AGENT_REACTION_ADD_SQL = `update messages
   set reactions = jsonb_set(
         coalesce(reactions, '{}'::jsonb),
         array[$3::text],
         coalesce(reactions -> $3::text, '[]'::jsonb) || to_jsonb($4::text)
       )
 where id = $1::uuid
   and session_id = $2::uuid
   and deleted_at is null
   and ${agentReactionScopeSql('$4')}
   and not coalesce(reactions -> $3::text, '[]'::jsonb) @> to_jsonb($4::text)
   and (
     coalesce(reactions, '{}'::jsonb) ? $3::text
     or (select count(*) from jsonb_object_keys(coalesce(reactions, '{}'::jsonb))) < ${MAX_DISTINCT_REACTIONS_PER_MESSAGE}
   )
returning ${REACTION_RETURNING_COLUMNS}`;

const AGENT_REACTION_REMOVE_SQL = `update messages
   set reactions = case
         when jsonb_array_length(coalesce(reactions -> $3::text, '[]'::jsonb) - $4::text) = 0
           then coalesce(reactions, '{}'::jsonb) - $3::text
         else jsonb_set(
                coalesce(reactions, '{}'::jsonb),
                array[$3::text],
                coalesce(reactions -> $3::text, '[]'::jsonb) - $4::text
              )
       end
 where id = $1::uuid
   and session_id = $2::uuid
   and deleted_at is null
   and ${agentReactionScopeSql('$4')}
   and coalesce(reactions -> $3::text, '[]'::jsonb) @> to_jsonb($4::text)
returning ${REACTION_RETURNING_COLUMNS}`;

// The no-op read, agent-scoped. It exists for the same reason the human one
// does — to choose between "you already hold it" and "the cap is full" AFTER a
// zero-row write — and it must carry the same scope predicate, or a message an
// agent may not touch would answer it with a 409 instead of a 404 and confirm
// the message exists.
const AGENT_REACTION_CURRENT_SQL = `select ${REACTION_RETURNING_COLUMNS}
  from messages
 where id = $1::uuid
   and session_id = $2::uuid
   and deleted_at is null
   and ${agentReactionScopeSql('$3')}
 limit 1`;

function agentReactionToggleSql(op) {
 if (op === 'add') return AGENT_REACTION_ADD_SQL;
 if (op === 'remove') return AGENT_REACTION_REMOVE_SQL;
 throw new Error(`Unknown reaction op: ${op}`);
}

/**
 * Normalize the caller's op. Anything else is a 400 rather than a guess: an
 * unrecognised op that fell through to 'add' would let a typo silently mean the
 * opposite of what the button said.
 */
function normalizeReactionOp(value) {
 const op = String(value == null ? '' : value).trim().toLowerCase();
 return REACTION_OPS.includes(op) ? op : null;
}

/**
 * Normalize the reaction itself. Returns the string to store, or null when the
 * input cannot be one.
 *
 * Truncation (not refusal) at MAX_REACTION_LENGTH matches what the webhook
 * payload already does, and reuses the same surrogate-safe cut so half an astral
 * pair is never stored as a map key. Control characters are refused outright:
 * they are not emoji, they render as nothing, and a key carrying a newline is a
 * display hazard everywhere the map is shown.
 */
function normalizeReactionValue(value) {
 if (typeof value !== 'string') return null;
 if (value === '' || value.trim() === '') return null;
 // eslint-disable-next-line no-control-regex
 if (/[\u0000-\u001f\u007f]/.test(value)) return null;
 if (value.length <= MAX_REACTION_LENGTH) return value;
 const cut = value.slice(0, MAX_REACTION_LENGTH);
 const last = cut.charCodeAt(cut.length - 1);
 const safe = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
 return safe === '' ? null : safe;
}

function cloneReactionMap(value) {
 const out = {};
 if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
 for (const [reaction, users] of Object.entries(value)) {
  if (!Array.isArray(users)) continue;
  out[reaction] = users.map((user) => String(user));
 }
 return out;
}

/**
 * The map as it stood BEFORE the write, reconstructed from the map the write
 * returned plus the operation that produced it.
 *
 * Exact, not approximate: the statement's WHERE guard only lets the row change
 * when the transition is the one named, so inverting that one transition is the
 * whole before-image. Callers pass the result to
 * `emitReactionFlowEventsForUpdate` as `priorRows[n].reactions`, which is why
 * this returns a plain map rather than a diff — the flow module owns the diff,
 * and it must keep owning it.
 *
 * `after` may arrive as a jsonb string on the Netlify lane, so it is parsed
 * defensively rather than assumed to be an object.
 */
function priorReactionMap(after, { op, reaction, userId }) {
 let source = after;
 if (typeof source === 'string') {
  try { source = JSON.parse(source); } catch { source = {}; }
 }
 const map = cloneReactionMap(source);
 const uid = String(userId);
 if (op === 'add') {
  const remaining = (map[reaction] || []).filter((user) => user !== uid);
  if (remaining.length === 0) delete map[reaction];
  else map[reaction] = remaining;
  return map;
 }
 if (op === 'remove') {
  const held = map[reaction] || [];
  map[reaction] = held.includes(uid) ? held : [...held, uid];
  return map;
 }
 throw new Error(`Unknown reaction op: ${op}`);
}

/**
 * Why did a toggle change nothing? Both outcomes return zero rows from the
 * statement, and they mean opposite things to the person who clicked, so the
 * route asks this on the (rare) no-op path with the row it re-read.
 *
 * Deliberately a READ, taken after the fact: it decides an error message, never
 * whether a write happens. Reading it before the write is what would make the
 * cap racy.
 */
function explainReactionNoop(row, { op, reaction, userId }) {
 if (!row) return { status: 404, message: 'Message not found' };
 let map = row.reactions;
 if (typeof map === 'string') {
  try { map = JSON.parse(map); } catch { map = {}; }
 }
 const current = cloneReactionMap(map);
 const holders = current[reaction] || [];
 const holds = holders.includes(String(userId));
 // The client and the server agree about the world; the click was a repeat.
 if (op === 'add' && holds) return null;
 if (op === 'remove' && !holds) return null;
 if (op === 'add' && Object.keys(current).length >= MAX_DISTINCT_REACTIONS_PER_MESSAGE) {
  return {
   status: 409,
   message: `A message can carry at most ${MAX_DISTINCT_REACTIONS_PER_MESSAGE} different reactions`,
  };
 }
 return { status: 404, message: 'Message not found' };
}

module.exports = {
 AGENT_REACTION_ADD_SQL,
 AGENT_REACTION_CURRENT_SQL,
 AGENT_REACTION_REMOVE_SQL,
 MAX_DISTINCT_REACTIONS_PER_MESSAGE,
 REACTION_ADD_SQL,
 agentReactionToggleSql,
 REACTION_CURRENT_SQL,
 REACTION_OPS,
 REACTION_REMOVE_SQL,
 REACTION_RETURNING_COLUMNS,
 explainReactionNoop,
 normalizeReactionOp,
 normalizeReactionValue,
 priorReactionMap,
 reactionToggleSql,
};
