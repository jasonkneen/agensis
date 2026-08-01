'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('MCP neither discovers nor reads deleted conversations', () => {
  const source = read('server/mcp.cjs');
  const pinnedStart = source.indexOf("if (identity.kind === 'integration' && identity.channelId)");
  const pinnedEnd = source.indexOf('// Enumerating channels leaks', pinnedStart);
  const pinnedListBranch = source.slice(pinnedStart, pinnedEnd);

  assert.match(
    source,
    /from chat_sessions\s+where workspace_id = \$1 and deleted_at is null/,
    'general list_channels must hide deleted sessions',
  );
  assert.match(
    pinnedListBranch,
    /where workspace_id = \$1 and id = \$2 and deleted_at is null/,
    'a channel-pinned integration must not enumerate its channel after deletion',
  );
  assert.match(
    source,
    /join chat_sessions read_channel_scope[\s\S]*where \$\{where\} and messages\.deleted_at is null/,
    'read_channel must hide deleted message bodies',
  );
  assert.match(
    source,
    /where id = \$1 and workspace_id = \$2 and deleted_at is null and \$\{scope\}/,
    'the common MCP channel gate must reject deleted sessions',
  );
});

test('MCP posts validate the live channel and same-session live parent atomically', () => {
  const source = read('server/mcp.cjs');
  const start = source.indexOf('async function insertAgentMessage(');
  const end = source.indexOf('\nasync function ', start + 10);
  const body = source.slice(start, end);

  assert.match(body, /with live_channel as materialized/);
  assert.match(body, /from chat_sessions live_channel[\s\S]*live_channel\.id = \$1[\s\S]*live_channel\.deleted_at is null/);
  assert.match(body, /parent_message\.session_id = live_channel\.id/);
  assert.match(body, /parent_message\.deleted_at is null/);
  assert.match(body, /for share/);
  assert.match(body, /if \(!rows\[0\]\) throw new ToolError\('Channel not found in this workspace'\)/);
});

test('internal dispatch never reuses a deleted DM or deleted thread parent', () => {
  const source = read('server/index.cjs');

  assert.match(
    source,
    /folder = 'Direct messages' and archived_at is null and deleted_at is null/,
    'findOrCreateDirectSession must not resurrect a deleted DM',
  );
  assert.match(
    source,
    /from chat_sessions where id = \$1 and deleted_at is null limit 1/,
    'continueConversation must stop when its session has been deleted',
  );
  assert.match(
    source,
    /select id from messages where id = \$1 and session_id = \$2 and deleted_at is null limit 1/,
    'verifyThreadParent must not retain a deleted anchor as a writable parent',
  );
});

test('daemon cleanup and relay paths preserve tombstones and live-session boundaries', () => {
  const source = read('server/agent-jobs.cjs');

  assert.match(
    source,
    /delete from messages[\s\S]*sender_kind = 'agent'[\s\S]*deleted_at is null[\s\S]*content ~ \$3/,
    'placeholder cleanup must not physically delete tombstones',
  );
  assert.match(
    source,
    /join chat_sessions transcript_session[\s\S]*transcript_session\.deleted_at is null/,
    'ended-huddle relay must require a live source transcript',
  );
  assert.match(
    source,
    /join chat_sessions host_session[\s\S]*host_session\.deleted_at is null/,
    'ended-huddle relay must require a live destination',
  );
  assert.match(
    source,
    /select thread_parent_id from messages where id = \$1 and session_id = \$2 and deleted_at is null/,
    'tool steps must not attach to deleted messages',
  );
});

test('a cancelled built-in turn cannot overwrite its terminal state or append a final notice', () => {
  const source = read('server/builtin-turn.cjs');

  assert.match(
    source,
    /set status = 'done'[\s\S]*where id = \$1 and status = 'running' returning \*/,
    'success completion must compare-and-set the running job',
  );
  assert.match(
    source,
    /set status = 'error'[\s\S]*where id = \$1 and status = 'running' returning \*/,
    'failure completion must compare-and-set the running job',
  );
  const zeroRowReturns = source.match(/if \(updatedRows\.length === 0\) return \{ ok: false, pending: false \};/g) || [];
  assert.equal(zeroRowReturns.length, 2, 'both terminal paths must stop before writing a message after cancellation');
});
