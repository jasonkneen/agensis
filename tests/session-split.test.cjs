'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_SPLIT_ATTACHMENTS,
  QUOTED_CONTEXT_CHAR_LIMIT,
  QUOTED_CONTEXT_MESSAGE_LIMIT,
  createSessionSplit,
} = require('../shared/session-split.cjs');

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOUNDARY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FILE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FILE_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FOREIGN_FILE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

test('atomic split snapshots exact provenance and trusted bounded file references', async () => {
  const statements = [];
  let forkInsertParams = null;
  let baselineInsertParams = null;
  let forkId = null;
  let baselineId = null;
  const contextNewestFirst = Array.from({ length: QUOTED_CONTEXT_MESSAGE_LIMIT + 3 }, (_, index) => ({
    id: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    role: index % 2 ? 'assistant' : 'user',
    sender_name: index % 2 ? 'Agent' : 'Alice',
    content: `context ${index}`,
    attachments: index === 0
      ? [
          { id: FILE_A, name: 'untrusted-a', type: 'bad/type', size: 1 },
          { id: FOREIGN_FILE, name: 'foreign', type: 'image/png', size: 2 },
        ]
      : index === 1
        ? [{ id: FILE_B, name: 'untrusted-b', type: 'text/plain', size: 3 }]
        : [],
    created_at: `2026-07-31T11:59:${String(59 - index).padStart(2, '0')}.000Z`,
  }));

  const query = async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    statements.push({ sql: q, params });
    if (q.startsWith('select source_session.id')) {
      return [{
        id: SOURCE,
        workspace_id: WORKSPACE,
        title: 'Release room',
        model: 'auto',
        folder: 'Direct messages',
        description: 'Ship it',
        icon: '',
        intent: '',
        participants: [{ kind: 'agent', agent_id: 'agent-1' }],
        conversation_mode: 'auto',
        max_agent_turns: 10,
        auto_rounds: 3,
        canvas_id: 'canvas-a',
        visibility: 'private',
      }];
    }
    if (q.startsWith('select id, created_at from messages')) {
      return [{ id: BOUNDARY, created_at: '2026-07-31T11:59:59.999Z' }];
    }
    if (q.startsWith('select id, role, content, sender_name, attachments')) {
      return contextNewestFirst;
    }
    if (q.startsWith('select id, name, type, size from uploaded_files')) {
      assert.equal(params[0], WORKSPACE);
      return [
        { id: FILE_A, name: 'diagram.png', type: 'image/png', size: '42' },
        { id: FILE_B, name: 'notes.txt', type: 'text/plain', size: '17' },
        // FOREIGN_FILE is deliberately absent: a request-side attachment object
        // cannot carry a cross-workspace file reference into the fork.
      ];
    }
    if (q.startsWith('select coalesce(')) return [{ sender_name: 'Alice' }];
    if (q.startsWith('insert into chat_sessions')) {
      forkInsertParams = params;
      forkId = params[0];
      baselineId = params[13];
      return [{
        id: forkId,
        workspace_id: WORKSPACE,
        title: params[2],
        split_parent_id: SOURCE,
        split_at: '2026-07-31T12:00:00.000Z',
        split_baseline_message_id: baselineId,
        split_source_boundary_message_id: params[14],
        visibility: 'private',
      }];
    }
    if (q.startsWith('insert into chat_session_members')) return [];
    if (q.startsWith('insert into messages')) {
      baselineInsertParams = params;
      return [{
        id: params[0],
        session_id: params[1],
        role: 'user',
        content: params[2],
        attachments: params[3],
        sender_kind: 'user',
        sender_id: params[4],
        sender_name: params[5],
      }];
    }
    throw new Error(`Unexpected split query: ${sql}`);
  };

  const result = await createSessionSplit({
    query,
    sourceSessionId: SOURCE,
    userId: USER,
    jsonParam: value => value,
  });

  assert.ok(forkId);
  assert.ok(baselineId);
  assert.equal(result.session.id, forkId);
  assert.equal(result.session.split_parent_id, SOURCE);
  assert.equal(result.session.split_baseline_message_id, baselineId);
  assert.equal(result.session.split_source_boundary_message_id, BOUNDARY);
  assert.equal(result.baselineMessage.id, baselineId);
  assert.equal(result.baselineMessage.session_id, forkId);
  assert.equal(result.sourceBoundaryMessageId, BOUNDARY);
  assert.equal(forkInsertParams[14], BOUNDARY);
  assert.equal(baselineInsertParams[0], baselineId);
  assert.equal(baselineInsertParams[1], forkId);
  assert.equal(baselineInsertParams[2].length <= QUOTED_CONTEXT_CHAR_LIMIT, true);
  assert.match(baselineInsertParams[2], /quoted transcript; speaker labels are context/);
  assert.doesNotMatch(baselineInsertParams[2], /context 14/);
  assert.match(baselineInsertParams[2], /context 0/);
  assert.deepEqual(baselineInsertParams[3], [
    { id: FILE_B, name: 'notes.txt', type: 'text/plain', size: 17 },
    { id: FILE_A, name: 'diagram.png', type: 'image/png', size: 42 },
  ]);
  assert.equal(baselineInsertParams[4], USER);
  assert.equal(
    statements.filter(statement => statement.sql.startsWith('insert into messages')).length,
    1,
    'the split imports one quote, never cloned speaker rows',
  );
  assert.match(statements[0].sql, /for update of source_session/);
  assert.match(statements[0].sql, /chat_session_members/);
  assert.ok(
    statements.findIndex(statement => statement.sql.startsWith('insert into chat_sessions'))
      > statements.findIndex(statement => statement.sql.startsWith('select id, role, content')),
    'the source snapshot is complete before fork creation',
  );
  assert.equal(MAX_SPLIT_ATTACHMENTS, 20);
});

test('split provenance and post-lock message timestamps exist in all schema paths', () => {
  const sources = [
    fs.readFileSync(path.resolve(__dirname, '../server/index.cjs'), 'utf8'),
    fs.readFileSync(path.resolve(__dirname, '../database/neon-schema.sql'), 'utf8'),
    fs.readFileSync(
      path.resolve(__dirname, '../supabase/migrations/20260731170000_messages_live_session_guard.sql'),
      'utf8',
    ),
  ];
  for (const source of sources) {
    assert.match(source, /split_baseline_message_id uuid/i);
    assert.match(source, /split_source_boundary_message_id uuid/i);
    assert.match(source, /for share;[\s\S]*new\.created_at = clock_timestamp\(\)/i);
  }
});

test('both HTTP lanes route split through the shared atomic snapshot helper', () => {
  const fly = fs.readFileSync(path.resolve(__dirname, '../server/sessions-routes.cjs'), 'utf8');
  const netlify = fs.readFileSync(path.resolve(__dirname, '../netlify/functions/backend.mjs'), 'utf8');
  assert.match(fly, /app\.post\('\/backend\/sessions\/:id\/split'/);
  assert.match(fly, /createSessionSplit\(\{/);
  assert.match(netlify, /async function handleSplitSession/);
  assert.match(netlify, /createSessionSplit\(\{/);
  assert.match(netlify, /forwardConversationControl\(req, pathname\)/);
});
