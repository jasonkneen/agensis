'use strict';

// ============================================================================
// tests/message-tool-steps.test.cjs
// ----------------------------------------------------------------------------
// Agent tool calls arrive as real messages, and each one used to render as a
// FULL chat bubble — avatar, agent name, timestamp, wrapped raw bash command.
// Four in a row filled the screen. The fix gives a step row structure the
// renderer can draw as a compact chip:
//
//   message_kind  '' for a normal message, 'tool_step' for one agent tool call
//   tool_name     'Bash' | 'Read' | 'Grep' | ...
//   tool_detail   short single-line summary, e.g. 'src/App.tsx'
//
// `content` keeps its human-readable line ("Bash · npm test") as the FALLBACK,
// so already-inserted step rows and older clients still read sensibly.
//
// Pinned here:
//   1. All three columns exist in ALL THREE schema places (AGENTS.md), each
//      defaulting to '' so every pre-existing row stays valid.
//   2. handleAgentJobStep populates them AND still writes `content`.
//   3. Every explicit `select ... from messages` column list that names
//      sender_kind also names message_kind/tool_name/tool_detail — a new column
//      omitted from an explicit list loads BLANK, which would silently blank
//      every chip. The paged transcript route stays `select *` for the same reason.
//   4. The realtime fanout does not strip the new fields — a step's whole point
//      is arriving live.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { __test } = require('../server/index.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const STEP_COLUMNS = ['message_kind', 'tool_name', 'tool_detail'];

test.afterEach(() => __test.resetTestState());

test('the tool-step columns exist in all three schema places', () => {
  // 1. Runtime bootstrap — what actually runs on Fly boot, so this is the only
  //    one that reaches an already-provisioned production DB.
  const runtime = require('./helpers/fly-lane.cjs').flyLaneSource();
  for (const column of STEP_COLUMNS) {
    assert.match(
      runtime,
      new RegExp(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS ${column} text DEFAULT ''`),
      `ensureRuntimeSchema is missing messages.${column}`,
    );
  }

  // 2. Canonical schema — what `npm run db:neon:push` applies to a fresh DB.
  const canonical = read('database/neon-schema.sql');
  for (const column of STEP_COLUMNS) {
    assert.match(canonical, new RegExp(`${column} text DEFAULT ''`), `neon-schema.sql is missing messages.${column}`);
  }

  // 3. Migration — what a DB provisioned from supabase/migrations alone gets.
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter((name) => name.endsWith('_message_tool_steps.sql'));
  assert.equal(migrations.length, 1, 'expected exactly one message_tool_steps migration');
  const migration = read(path.join('supabase/migrations', migrations[0]));
  for (const column of STEP_COLUMNS) {
    assert.match(
      migration,
      new RegExp(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS ${column} text DEFAULT ''`),
      `the migration is missing messages.${column}`,
    );
  }
});

// The canonical schema declares the columns inside CREATE TABLE messages, which
// only helps a FRESH database. Every existing row must still be valid, so the
// default has to be '' rather than NOT NULL with no default.
test('the tool-step columns land on the messages table itself', () => {
  const canonical = read('database/neon-schema.sql');
  const create = /CREATE TABLE IF NOT EXISTS messages \(([\s\S]*?)\n\);/.exec(canonical);
  assert.ok(create, 'CREATE TABLE messages not found in neon-schema.sql');
  for (const column of STEP_COLUMNS) {
    assert.match(create[1], new RegExp(`^\\s*${column} text DEFAULT ''`, 'm'));
  }
  assert.doesNotMatch(create[1], /message_kind[^,]*NOT NULL/, 'a NOT NULL step column would reject existing rows');
});

// ----------------------------------------------------------------------------
// The blank-chip regression. A column that a query does not name comes back
// undefined, so ONE explicit column list left un-updated blanks every chip
// while every other path looks fine.
// ----------------------------------------------------------------------------

/** Every `select <columns> from messages` list in a source file, whitespace-normalized. */
function messageSelectLists(source) {
  const flat = source.replace(/\s+/g, ' ');
  const pattern = /select\s+((?:(?!\bfrom\b).)*?)\s+from\s+messages\b/gi;
  const lists = [];
  let match;
  while ((match = pattern.exec(flat)) !== null) lists.push(match[1].trim());
  return lists;
}

test('every explicit message column list that selects sender_kind also selects the step columns', () => {
  const lists = messageSelectLists(require('./helpers/fly-lane.cjs').flyLaneSource());
  assert.ok(lists.length > 0, 'no `select ... from messages` statements found — the scanner is broken');

  const explicit = lists.filter((list) => /\bsender_kind\b/.test(list));
  assert.ok(explicit.length > 0, 'expected at least one explicit message column list naming sender_kind');

  for (const list of explicit) {
    for (const column of STEP_COLUMNS) {
      assert.ok(
        new RegExp(`\\b${column}\\b`).test(list),
        `message column list omits ${column} (it would load blank): select ${list} from messages`,
      );
    }
  }
});

test('the paged transcript route selects * and retains redacted deleted anchors', () => {
  const flat = require('./helpers/fly-lane.cjs').flyLaneSource().replace(/\s+/g, ' ');
  assert.match(
    flat,
    /select \* from messages where session_id = \$1/,
    '/backend/sessions/:id/messages must stay `select *` or new columns load blank',
  );
  assert.doesNotMatch(
    flat,
    /select \* from messages where session_id = \$1 and deleted_at is null/,
    'deleted roots must remain as redacted tombstones so replies keep their anchor',
  );
  assert.match(
    flat,
    /const page = redactDeletedMessageRows\(/,
    'the paged transcript route must redact retained deleted rows',
  );
});

// ----------------------------------------------------------------------------
// The writer.
// ----------------------------------------------------------------------------

const AUTH = { agentId: 'agent-1', workspaceId: 'ws-1', name: 'Coder', handle: 'coder' };
const JOB = {
  id: 'job-1',
  agent_id: 'agent-1',
  workspace_id: 'ws-1',
  session_id: 'session-1',
  agent_name: 'Coder',
  agent_handle: 'coder',
  metadata: { mode: 'daemon', responseMessageId: 'msg-placeholder' },
};

function installDb() {
  const calls = [];
  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('select j.*, a.name as agent_name')) return [JOB];
      if (n.startsWith('update agent_jobs set updated_at')) return [{ id: params[0] }];
      if (n.startsWith('insert into messages')) {
        return [{
          id: 'msg-step-1',
          session_id: params[0],
          role: 'assistant',
          content: params[1],
          thread_parent_id: params[2],
          sender_kind: 'agent',
          sender_id: params[3],
          sender_name: params[4],
          message_kind: 'tool_step',
          tool_name: params[5],
          tool_detail: params[6],
        }];
      }
      return [];
    },
  };
  db.begin = async (work) => work(db);
  __test.setTestDb(db);
  return calls;
}

test('a step row carries message_kind/tool_name/tool_detail AND the content fallback', async () => {
  const calls = installDb();

  await __test.handleAgentJobStep({ agentAuth: AUTH, agentConnectionId: 'conn-1' }, {
    action: 'agent_job_step',
    jobId: 'job-1',
    kind: 'tool',
    name: 'Bash',
    detail: 'cd ~/src && git log',
  });

  const insert = calls.find((c) => c.n.startsWith('insert into messages'));
  assert.ok(insert, 'the step was inserted');
  assert.match(insert.n, /message_kind, tool_name, tool_detail\)/);
  assert.match(insert.n, /'tool_step', \$6, \$7\)/, 'message_kind is written as the literal discriminator');
  // `content` keeps the joined human-readable line: older clients and rows
  // inserted before these columns existed read off it alone.
  assert.equal(insert.params[1], 'Bash · cd ~/src && git log');
  assert.equal(insert.params[5], 'Bash');
  assert.equal(insert.params[6], 'cd ~/src && git log');
});

test('a step with only one half still writes the half it has', async () => {
  const calls = installDb();

  await __test.handleAgentJobStep({ agentAuth: AUTH, agentConnectionId: 'conn-1' }, {
    jobId: 'job-1', kind: 'tool', name: 'Grep',
  });

  const insert = calls.find((c) => c.n.startsWith('insert into messages'));
  assert.equal(insert.params[1], 'Grep', 'the content fallback is unchanged');
  assert.equal(insert.params[5], 'Grep');
  assert.equal(insert.params[6], '', 'an absent detail is stored empty, never null');
});

test('agentStepParts splits the same halves the content line is built from', () => {
  const { agentStepParts, agentStepContent } = __test;
  assert.deepEqual(agentStepParts({ name: 'Read', detail: 'src/App.tsx' }), { name: 'Read', detail: 'src/App.tsx' });
  assert.deepEqual(agentStepParts({}), { name: '', detail: '' });
  // Multi-line tool input collapses to one line and long input is clipped, in
  // the columns exactly as it already was in `content`.
  const parts = agentStepParts({ name: 'Bash', detail: 'npm test\n&& npm run lint' });
  assert.equal(parts.detail, 'npm test && npm run lint');
  assert.ok(agentStepParts({ name: 'Bash', detail: 'x'.repeat(400) }).detail.length <= 160);
  assert.equal(agentStepContent({ name: 'Read', detail: 'src/App.tsx' }), 'Read · src/App.tsx');
});

// ----------------------------------------------------------------------------
// The live path. A step that only shows up after a reload is worthless.
// ----------------------------------------------------------------------------

test('the realtime fanout does not strip the step columns', async () => {
  __test.setTestDb({
    async unsafe(sql) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.startsWith('select id, visibility, folder, deleted_at from chat_sessions')) {
        return [{ id: 'session-1', visibility: 'workspace', folder: 'General', deleted_at: null }];
      }
      if (q.startsWith('select workspace_id, visibility, folder, deleted_at from chat_sessions')) {
        return [{ workspace_id: 'ws-1', visibility: 'workspace', folder: 'General', deleted_at: null }];
      }
      if (q.startsWith('select id, visibility, folder from chat_sessions')) {
        return [{ id: 'session-1', visibility: 'workspace', folder: 'General' }];
      }
      return [];
    },
  });
  const sent = [];
  __test.registerTestWebsocketClient({
    userId: 'user-1',
    readyState: 1,
    subscriptions: [{ type: 'db_changes', schema: 'public', table: 'messages', event: '*' }],
    send: (str) => sent.push(JSON.parse(str)),
  });

  __test.notifyDbSubscribers('messages', 'INSERT', [{
    id: 'msg-step-1',
    session_id: 'session-1',
    workspace_id: 'ws-1',
    role: 'assistant',
    sender_kind: 'agent',
    sender_id: 'agent-1',
    sender_name: 'Coder',
    content: 'Bash · npm test',
    message_kind: 'tool_step',
    tool_name: 'Bash',
    tool_detail: 'npm test',
  }]);
  await new Promise(resolve => setTimeout(resolve, 20));

  const frame = sent.find((m) => m.type === 'db_changes' && m.table === 'messages');
  assert.ok(frame, 'expected a messages db_changes frame');
  assert.equal(frame.payload.new.message_kind, 'tool_step');
  assert.equal(frame.payload.new.tool_name, 'Bash');
  assert.equal(frame.payload.new.tool_detail, 'npm test');
});
