'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
 AI_CHAT_CONTEXT_MAX_BYTES,
 aiChatMessageBytes,
 loadStoredAiChatContext,
 lockAiChatRunScope,
 normalizeAndBoundAiChatMessages,
 utf8Bytes,
} = require('../shared/ai-chat-context.cjs');

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SEED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('direct AI history is byte-bounded and preserves both ends of an oversized newest request', () => {
 const newest = `REQUEST_START ${'x'.repeat(AI_CHAT_CONTEXT_MAX_BYTES * 3)} REQUEST_END`;
 const chat = normalizeAndBoundAiChatMessages([
  { role: 'user', content: 'older request that should fall outside the bound' },
  { role: 'assistant', content: 'older response' },
  { role: 'user', content: newest },
  { role: 'system', content: `SYSTEM_START ${'s'.repeat(AI_CHAT_CONTEXT_MAX_BYTES * 2)} SYSTEM_END` },
 ]);
 const totalBytes = chat.messages.reduce((total, message) => total + aiChatMessageBytes(message), 0);
 assert.ok(totalBytes <= AI_CHAT_CONTEXT_MAX_BYTES);
 assert.equal(chat.messages.length, 1);
 assert.match(chat.messages[0].content, /REQUEST_START/);
 assert.match(chat.messages[0].content, /REQUEST_END/);
 assert.match(chat.messages[0].content, /middle truncated/);
 assert.ok(utf8Bytes(chat.systemPrompt) <= AI_CHAT_CONTEXT_MAX_BYTES);
 assert.match(chat.systemPrompt, /SYSTEM_START/);
 assert.match(chat.systemPrompt, /SYSTEM_END/);
});

test('stored AI context is anchored to the exact caller-owned seed and ignores browser history', async () => {
 let captured = null;
 const result = await loadStoredAiChatContext({
  db: async (sql, params) => {
   captured = { sql: String(sql), params };
   return [
    {
     id: SEED,
     role: 'user',
     content: 'durable seed',
     created_at: '2026-07-31T12:00:00.000Z',
     seed_content: 'durable seed',
    },
    {
     id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
     role: 'assistant',
     content: 'durable prior answer',
     created_at: '2026-07-31T11:59:00.000Z',
     seed_content: 'durable seed',
    },
    {
     id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
     role: 'user',
     content: 'durable prior question',
     created_at: '2026-07-31T11:58:00.000Z',
     seed_content: 'durable seed',
    },
   ];
  },
  sessionId: SESSION,
  seedMessageId: SEED,
  userId: USER,
 });
 assert.deepEqual(captured.params, [SESSION, SEED, null, USER]);
 assert.match(captured.sql, /sender_kind = 'user'/);
 assert.match(captured.sql, /sender_id::text = \$4::text/);
 assert.match(captured.sql, /context_message\.created_at < seed\.created_at/);
 assert.deepEqual(result, {
  seedContent: 'durable seed',
  messages: [
   { role: 'user', content: 'durable prior question' },
   { role: 'assistant', content: 'durable prior answer' },
   { role: 'user', content: 'durable seed' },
  ],
 });
});

test('persisted AI writes lock and require an editor-capable direct or inherited role', async () => {
 let sql = '';
 await lockAiChatRunScope({
  db: async (statement, params) => {
   sql = String(statement);
   assert.deepEqual(params, [WORKSPACE, USER]);
   return [{ role: 'editor' }];
  },
  workspaceId: WORKSPACE,
  userId: USER,
 });
 assert.match(sql, /for share of workspace/);
 assert.match(sql, /for share of membership/);

 await assert.rejects(
  lockAiChatRunScope({
   db: async () => [{ role: 'viewer' }],
   workspaceId: WORKSPACE,
   userId: USER,
  }),
  error => error?.status === 403 && /access changed/.test(error.message),
 );
});
