'use strict';

// ============================================================================
// tests/document-comment-agents.test.cjs
// ----------------------------------------------------------------------------
// Agents on document comment threads.
//
// Comments were a human-only surface. An agent could be @mentioned in one and
// arrive holding a quoted string with no way to read the thread, see what it was
// anchored to, or answer where the person was actually looking. Three MCP tools
// close that: list_comments, reply_to_comment, resolve_comment.
//
// What is worth testing here is not that the SQL runs — it is the two decisions
// that are easy to get quietly wrong: replies must attach to the THREAD ROOT
// (the pane renders two levels and a deeper reply would vanish), and agent
// authorship must be unforgeable (it is a loop guard, not just a byline).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PRIVILEGED_DB_COLUMNS_BY_TABLE,
  stripPrivilegedDbValues,
} = require('../shared/backend-core.cjs');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('the three comment tools exist and are registered', () => {
  const source = read('server/mcp.cjs');
  for (const name of ['list_comments', 'reply_to_comment', 'resolve_comment']) {
    assert.match(source, new RegExp(`name: '${name}'`), `${name} is not registered`);
  }
});

test('only an AGENT identity may author or resolve a comment', () => {
  // A comment written through these tools is attributed to an agent. A `user`
  // token is a human's login and has no agentId to stamp, so allowing it would
  // produce a comment attributed to nobody — and humans have the UI anyway.
  const source = read('server/mcp.cjs');
  const reply = source.slice(source.indexOf("name: 'reply_to_comment'"), source.indexOf("name: 'resolve_comment'"));
  assert.match(reply, /kinds: \['agent'\]/, 'reply_to_comment is not agent-only');
  const resolve = source.slice(source.indexOf("name: 'resolve_comment'"));
  assert.match(resolve.slice(0, 900), /kinds: \['agent'\]/, 'resolve_comment is not agent-only');
});

test('a reply attaches to the THREAD ROOT, never to a reply', () => {
  // document_comments is rendered as two levels everywhere (a comment and its
  // replies). A reply-to-a-reply that pointed at its immediate parent would
  // build a depth the pane cannot draw, and the comment would simply not appear.
  const source = read('server/mcp.cjs');
  assert.match(source, /const threadRoot = parent\[0\]\.parent_id \|\| parent\[0\]\.id;/);
  assert.match(source, /insert into document_comments[\s\S]{0,200}\$4, \$5\)/);
});

test('replying does not resolve, and resolving is its own act', () => {
  // An agent that answers a question and silently closes the thread takes the
  // decision away from the person who asked. The insert must not touch
  // `resolved` at all.
  const source = read('server/mcp.cjs');
  const reply = source.slice(source.indexOf("name: 'reply_to_comment'"), source.indexOf("name: 'resolve_comment'"));
  assert.ok(!/resolved/.test(reply.split('async run')[1] || ''), 'reply_to_comment touches resolved');
});

test('the workspace is proved from the DOCUMENT, not from the comment rows', () => {
  // Filtering only the comments would return rows anchored to a document in
  // another tenant if a comment's own workspace_id were ever written wrong.
  // Making the document the authority means the join cannot be bypassed.
  const source = read('server/mcp.cjs');
  const list = source.slice(source.indexOf("name: 'list_comments'"), source.indexOf("name: 'reply_to_comment'"));
  assert.match(list, /from documents where id = \$1 and workspace_id = \$2/);
  assert.match(list, /Document not found in this workspace/);
});

test('agent authorship on a document comment cannot be forged by a client', () => {
  // Two things break if a browser can set agent_id: a comment can be made to
  // look like an agent wrote it, and — because dispatchCommentMentions returns
  // early on any row carrying one — a comment that @mentions an agent can be
  // posted in a way that silently evades the dispatch. A loop guard that a
  // client can set is not a guard.
  assert.ok(PRIVILEGED_DB_COLUMNS_BY_TABLE.document_comments?.has('agent_id'));
  const stripped = stripPrivilegedDbValues('document_comments', {
    document_id: 'doc-1',
    content: 'hello',
    agent_id: 'a-1',
  });
  assert.equal(stripped.agent_id, undefined, 'agent_id survived a generic write');
  assert.equal(stripped.content, 'hello', 'and the rest of the comment still saves');
});

test('the agent_id column exists in all three schema places', () => {
  for (const file of [
    'server/index.cjs',
    'database/neon-schema.sql',
    'supabase/migrations/20260803140000_document_comment_agent_author.sql',
  ]) {
    assert.match(
      read(file),
      /ALTER TABLE document_comments\s*\n?\s*ADD COLUMN IF NOT EXISTS agent_id uuid;/,
      `${file} is missing document_comments.agent_id`,
    );
  }
});

test('the UI never renders an agent comment as a human', () => {
  // The pane hardcoded "Teammate" for every comment. An agent reply rendered
  // under that byline is the panel asserting a person said it.
  const source = read('src/components/editor/DocumentComments.tsx');
  assert.match(source, /comment\.agent_id \? \(agentNames\?\.\[comment\.agent_id\] \|\| 'Agent'\) : 'Teammate'/);
});
