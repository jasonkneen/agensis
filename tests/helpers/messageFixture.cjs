'use strict';

// ============================================================================
// tests/helpers/messageFixture.cjs
// ----------------------------------------------------------------------------
// Message rows for tests that drive continueConversation over a fake DB, plus
// the channel harness that feeds it.
//
// WHY THIS EXISTS, rather than each test hand-rolling an object literal.
//
// A fake DB answers whatever the test tells it to, so a test can pass forever
// while asserting a row shape production never produces. That is not
// hypothetical here: a realtime broadcast in this repo never fired ONCE in
// months because it guarded on `messages.workspace_id` — a column the table
// does not have — and its test passed because the fixtures invented that
// column. The guard was vacuous and the test proved the guard.
//
// So every row goes through `messageRow`, whose allowed keys are EXACTLY the
// `loadChannelMessages` projection, and which THROWS on anything else. Invent a
// column and the test dies at construction instead of going green for the wrong
// reason. `assertProjectionMatchesSource` (used by ambient-loop-invariant)
// re-derives that key list from server/index.cjs itself, so changing the real
// select without changing this file is also caught.
//
// Two columns are absent and must STAY absent:
//   workspace_id — `messages` has no such column; a message is reachable only
//                  through session_id -> chat_sessions.workspace_id.
//   deleted_at   — filtered in the WHERE clause, so a RETURNED row never
//                  carries a meaningful one. Soft-delete behaviour therefore
//                  has to be asserted through the query (omit the row), never
//                  by setting a field on a fixture.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

/** Exactly the columns `loadChannelMessages` selects, in source order. */
const LOADED_MESSAGE_COLUMNS = Object.freeze([
 'id',
 'role',
 'content',
 'sender_kind',
 'sender_id',
 'sender_name',
 'message_kind',
 'tool_name',
 'tool_detail',
 'broadcast_to_channel',
 'created_at',
]);

const ALLOWED = new Set(LOADED_MESSAGE_COLUMNS);

let autoId = 0;

/**
 * One row as loadChannelMessages would return it. Throws on any key the real
 * projection does not contain.
 */
function messageRow(fields = {}) {
 for (const key of Object.keys(fields)) {
  if (!ALLOWED.has(key)) {
   throw new Error(
    `messageFixture: "${key}" is not a column loadChannelMessages returns.\n`
    + `Allowed: ${LOADED_MESSAGE_COLUMNS.join(', ')}.\n`
    + 'A fixture column that production never produces makes every assertion that '
    + 'reads it vacuous — see the header of tests/helpers/messageFixture.cjs.',
   );
  }
 }
 autoId += 1;
 return {
  id: `m${autoId}`,
  role: 'user',
  content: '',
  sender_kind: 'user',
  sender_id: '',
  sender_name: '',
  message_kind: null,
  tool_name: null,
  tool_detail: null,
  broadcast_to_channel: false,
  created_at: new Date().toISOString(),
  ...fields,
 };
}

/** A human post. `who` is the user id, so C6 ("is it YOUR conversation") is testable. */
function human(content, { who = 'u-alice', at = null } = {}) {
 return messageRow({
  role: 'user',
  sender_kind: 'user',
  sender_id: who,
  sender_name: who,
  content,
  ...(at ? { created_at: at } : {}),
 });
}

/** A machine-written seed that still lands as role='user' (schedules, C1). */
function systemSeed(content, { at = null } = {}) {
 return messageRow({
  role: 'user',
  sender_kind: 'system',
  sender_name: 'Schedule',
  content,
  ...(at ? { created_at: at } : {}),
 });
}

/** An automation post — role='assistant', sender_kind='automation'. */
function automationPost(content, { at = null } = {}) {
 return messageRow({
  role: 'assistant',
  sender_kind: 'automation',
  sender_id: 'auto-1',
  sender_name: 'Automation',
  content,
  ...(at ? { created_at: at } : {}),
 });
}

/** An agent's answer. */
function agentSays(agent, content = 'here you go', { at = null } = {}) {
 return messageRow({
  role: 'assistant',
  sender_kind: 'agent',
  sender_id: agent.id,
  sender_name: agent.name,
  content,
  ...(at ? { created_at: at } : {}),
 });
}

/**
 * A tool chip. The SAME row shape both lanes insert (agent-jobs.cjs and
 * builtin-turn.cjs): role='assistant', sender_kind='agent', with a
 * message_kind of 'tool_step'. Indistinguishable from an answer to any counter
 * that does not look at message_kind — which is the whole point of the C0 tests.
 */
function toolStep(agent, detail = 'npm test', { at = null } = {}) {
 return messageRow({
  role: 'assistant',
  sender_kind: 'agent',
  sender_id: agent.id,
  sender_name: agent.name,
  content: `Bash · ${detail}`,
  message_kind: 'tool_step',
  tool_name: 'Bash',
  tool_detail: detail,
  ...(at ? { created_at: at } : {}),
 });
}

/** Timestamp `ms` milliseconds before `base`. */
function agoMs(ms, base = Date.now()) {
 return new Date(base - ms).toISOString();
}

/**
 * A UUID-shaped id from one hex digit. Not decoration: inferThreadAgentTarget
 * refuses a sender_id that is not a valid UUID (server/index.cjs, validUuid), so
 * an agent fixture with a friendly id like 'a-scout' would silently fail the
 * thread-reply path and make that test prove nothing.
 */
function fakeUuid(digit) {
 const d = String(digit)[0];
 return `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
}

/** An agent row as `select * from workspace_agents` returns it. */
function agentFixture(id, name, extra = {}) {
 return {
  id,
  workspace_id: 'w1',
  name,
  handle: name.toLowerCase(),
  description: `${name} does things`,
  enabled: true,
  model: 'auto',
  run_mode: 'builtin',
  created_at: '2026-01-01T00:00:00.000Z',
  ...extra,
 };
}

/** `{ kind: 'agent', agent_id }` roster entries for chat_sessions.participants. */
function participants(agents) {
 return agents.map((agent) => ({ kind: 'agent', agent_id: agent.id, handle: agent.handle }));
}

const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim();

/**
 * A fake DB + fetch stub that answers everything continueConversation asks, and
 * records the two things worth observing:
 *
 *   electedAgentIds — captured from the hasActiveBurstJob query, which runs
 *                     AFTER every election branch and BEFORE the cadence gate
 *                     and runAgentTurn. Returning a live job there makes the
 *                     dispatcher stop with reason 'agent_busy', so the election
 *                     is observed without a turn ever running.
 *   anthropicCalls  — every request the paid tier makes. Counting attempts (not
 *                     outcomes) is the only honest way to measure cost: with no
 *                     API key the call throws and fails closed, which looks
 *                     exactly like never having made it.
 *
 * `rows` are given OLDEST-FIRST because that is how a conversation reads; the
 * harness reverses them, because the real query is `order by created_at desc`
 * and loadChannelMessages reverses what it gets.
 */
function channelHarness({
 rows = [],
 agents = [],
 session = {},
 threadRows = null,
 autoInterjectPick = null,
} = {}) {
 const state = {
  electedAgentIds: [],
  anthropicCalls: [],
  sessionRow: {
   id: 's1',
   workspace_id: 'w1',
   participants: participants(agents),
   conversation_mode: 'auto',
   max_agent_turns: 10,
   folder: 'General',
   ...session,
  },
 };

 const db = {
  async unsafe(sql, params = []) {
   const q = normalizeSql(sql);
   if (q.startsWith('select id, workspace_id, title, participants, conversation_mode')) {
    return [state.sessionRow];
   }
   // loadChannelMessages. Three params = the THREAD branch, two = the channel
   // branch. Rows are held oldest-first and reversed here, because the real
   // query is `order by created_at desc` and the caller reverses what it gets.
   if (q.startsWith('select id, role, content, sender_kind')) {
    const source = params.length > 2 ? (threadRows || []) : rows;
    return [...source].reverse();
   }
   // inferThreadAgentTarget — a different projection over the same rows.
   if (q.startsWith('select id, sender_kind, sender_id')) {
    return [...(threadRows || [])].reverse();
   }
   if (q.startsWith('select * from workspace_agents')) return agents;
   if (q.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs')) {
    state.electedAgentIds.push(String(params[1]));
    // mode:'builtin' => isAgentJobLive is true => 'agent_busy', so the
    // dispatcher stops here rather than running a turn against a fake DB.
    return [{ id: 'job-1', status: 'running', connection_id: null, metadata: { mode: 'builtin' }, started_at: new Date().toISOString() }];
   }
   return [];
  },
 };

 let realFetch;
 return {
  db,
  get electedAgentIds() { return state.electedAgentIds; },
  get electedAgentId() { return state.electedAgentIds[0] ?? null; },
  get anthropicCalls() { return state.anthropicCalls; },
  session: state.sessionRow,

  install() {
   realFetch = globalThis.fetch;
   process.env.ANTHROPIC_API_KEY = 'test-key';
   globalThis.fetch = async (url, init) => {
    state.anthropicCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const agent = typeof autoInterjectPick === 'function' ? autoInterjectPick() : autoInterjectPick;
    const handle = agent && agent.handle ? agent.handle : null;
    return {
     ok: true,
     async json() {
      return {
       content: [{ type: 'text', text: JSON.stringify({ agent: handle, reason: 'test' }) }],
       usage: { input_tokens: 10, output_tokens: 5 },
      };
     },
     async text() { return ''; },
    };
   };
  },
  restore() {
   globalThis.fetch = realFetch;
   delete process.env.ANTHROPIC_API_KEY;
  },
 };
}

/**
 * Fails if the fixture's allowed key list has drifted from the real
 * `loadChannelMessages` projection in server/index.cjs.
 *
 * Parsed out of source rather than compared against a hand-copied constant:
 * a constant copied twice is two constants, and this file's whole value is that
 * it cannot silently disagree with production.
 */
function assertProjectionMatchesSource() {
 const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server', 'index.cjs'), 'utf8');
 const start = source.indexOf('async function loadChannelMessages(');
 assert.ok(start >= 0, 'could not find loadChannelMessages in server/index.cjs');
 const body = source.slice(start, start + 2500);
 const matches = [...body.matchAll(/select ([^;`]*?)\s+from messages/gi)];
 assert.ok(matches.length >= 2, `expected both loadChannelMessages selects, found ${matches.length}`);
 for (const match of matches) {
  const columns = match[1].split(',').map((column) => column.trim()).filter(Boolean);
  assert.deepEqual(
   columns, [...LOADED_MESSAGE_COLUMNS],
   'tests/helpers/messageFixture.cjs LOADED_MESSAGE_COLUMNS has drifted from the '
   + 'real loadChannelMessages projection — update the helper, or every fixture '
   + 'built from it is asserting a row shape production does not produce',
  );
 }
}

module.exports = {
 LOADED_MESSAGE_COLUMNS,
 agentFixture,
 agentSays,
 agoMs,
 assertProjectionMatchesSource,
 automationPost,
 channelHarness,
 fakeUuid,
 human,
 messageRow,
 participants,
 systemSeed,
 toolStep,
};
