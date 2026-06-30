'use strict';
// Hermetic end-to-end smoke test for the MCP server endpoint.
// Creates a throwaway workspace + agent with a known connect token, drives the
// real HTTP -> verifyAgentConnectToken -> DB path through every read/write tool,
// then deletes everything. Does NOT exercise dispatch_agent's LLM trigger.
//
//   API_PORT=3199 node --env-file=.env server/index.cjs &   # target instance
//   node --env-file=.env scripts/_mcp_smoke.cjs              # run this
//
// Override the target with MCP_URL (default http://127.0.0.1:3199/backend/mcp).

const crypto = require('crypto');
const postgres = require('postgres');

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:3199/backend/mcp';
const DB = process.env.DATABASE_URL;
if (!DB) { console.error('DATABASE_URL required'); process.exit(1); }

const sql = postgres(DB);
const token = `aga_smoke_${crypto.randomBytes(24).toString('base64url')}`;
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const stamp = Date.now();

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method} -> JSON-RPC error ${body.error.code}: ${body.error.message}`);
  return body.result;
}
async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args || {} });
  const text = result.content?.[0]?.text || '';
  if (result.isError) throw new Error(`tool ${name} isError: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const ok = (label) => console.log(`  ok  ${label}`);

async function main() {
  let userId, workspaceId, agentId;
  try {
    const u = await sql.unsafe(
      `insert into app_users (email, password_hash) values ($1, $2) returning id`,
      [`_mcp_smoke_${stamp}@example.test`, 'x']);
    userId = u[0].id;
    const w = await sql.unsafe(
      `insert into workspaces (name, user_id) values ($1, $2) returning id`,
      [`_mcp_smoke_${stamp}`, userId]);
    workspaceId = w[0].id;
    const a = await sql.unsafe(
      `insert into workspace_agents (workspace_id, name, handle, connect_token_hash, enabled, model)
       values ($1, $2, $3, $4, true, 'claude-opus-4-8') returning id`,
      [workspaceId, 'SmokeBot', 'smokebot', tokenHash]);
    agentId = a[0].id;
    console.log(`setup: workspace=${workspaceId} agent=${agentId}`);

    // --- protocol ---
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    if (init.serverInfo?.name !== 'agensis') throw new Error('bad serverInfo');
    if (init.protocolVersion !== '2025-06-18') throw new Error('protocolVersion not echoed');
    ok(`initialize (server ${init.serverInfo.name} v${init.serverInfo.version}, proto ${init.protocolVersion})`);

    const list = await rpc('tools/list', {});
    ok(`tools/list (${list.tools.length} tools)`);

    // --- identity ---
    const who = await callTool('whoami', {});
    if (who.agentId !== agentId || who.handle !== 'smokebot' || who.workspaceId !== workspaceId) {
      throw new Error(`whoami mismatch: ${JSON.stringify(who)}`);
    }
    ok(`whoami (resolved token -> ${who.handle} in correct workspace)`);

    // --- channels + messaging ---
    const ch = await callTool('create_channel', { title: '_mcp_smoke_channel' });
    const channelId = ch.channel.id;
    ok(`create_channel (${channelId})`);

    const posted = await callTool('post_message', { channel_id: channelId, content: 'hello from MCP smoke' });
    if (!posted.posted || posted.message.sender_kind !== 'agent') throw new Error('post_message shape');
    ok('post_message (inserted as agent)');

    const read = await callTool('read_channel', { channel_id: channelId, limit: 10 });
    if (!read.messages.some((m) => m.content === 'hello from MCP smoke')) throw new Error('read_channel missing msg');
    ok(`read_channel (round-tripped ${read.messages.length} msg)`);

    const channels = await callTool('list_channels', {});
    if (!channels.channels.some((c) => c.id === channelId)) throw new Error('list_channels missing channel');
    ok(`list_channels (${channels.channels.length})`);

    const found = await callTool('search_messages', { query: 'MCP smoke' });
    if (!found.results.length) throw new Error('search_messages found nothing');
    ok(`search_messages (${found.results.length} hit)`);

    // --- members + agents ---
    const members = await callTool('list_members', {});
    ok(`list_members (${members.members.length})`);
    const agents = await callTool('list_agents', {});
    if (!agents.agents.some((x) => x.id === agentId)) throw new Error('list_agents missing self');
    ok(`list_agents (${agents.agents.length})`);

    // --- docs ---
    const doc = await callTool('write_doc', { title: '_mcp_smoke_doc', content: 'doc body v1' });
    const docId = doc.document.id;
    ok(`write_doc create (${docId})`);
    const doc2 = await callTool('write_doc', { doc_id: docId, content: 'doc body v2' });
    if (doc2.document.content !== 'doc body v2' || doc2.document.version < 2) throw new Error('write_doc update');
    ok('write_doc update (version bumped)');
    const rd = await callTool('read_doc', { doc_id: docId });
    if (rd.document.content !== 'doc body v2') throw new Error('read_doc mismatch');
    ok('read_doc');
    const sd = await callTool('search_docs', { query: 'smoke_doc' });
    ok(`search_docs (${sd.results.length})`);

    // --- tasks ---
    const task = await callTool('create_task', { title: '_mcp_smoke_task', priority: 'high' });
    if (task.task.source_type !== 'ai' || task.task.created_by !== null) throw new Error('task attribution wrong');
    ok('create_task (source_type=ai, created_by=null)');
    const ut = await callTool('update_task', { task_id: task.task.id, status: 'done' });
    if (ut.task.status !== 'done' || !ut.task.completed_at) throw new Error('update_task');
    ok('update_task (status=done, completed_at set)');
    const tasks = await callTool('list_tasks', { status: 'done' });
    ok(`list_tasks (${tasks.tasks.length} done)`);

    // --- memory ---
    const mem = await callTool('add_memory', { fact: 'mcp smoke fact', category: 'test' });
    ok('add_memory');
    const mems = await callTool('get_workspace_memory', { category: 'test' });
    if (!mems.facts.some((f) => f.fact === 'mcp smoke fact')) throw new Error('memory round-trip');
    ok(`get_workspace_memory (${mems.facts.length})`);

    console.log('\nALL SMOKE CHECKS PASSED');
  } finally {
    // Cleanup (best-effort, by id). Workspace cascade also covers most, but be explicit.
    if (workspaceId) {
      await sql.unsafe('delete from messages where session_id in (select id from chat_sessions where workspace_id = $1)', [workspaceId]).catch(() => {});
      await sql.unsafe('delete from chat_sessions where workspace_id = $1', [workspaceId]).catch(() => {});
      await sql.unsafe('delete from documents where workspace_id = $1', [workspaceId]).catch(() => {});
      await sql.unsafe('delete from tasks where workspace_id = $1', [workspaceId]).catch(() => {});
      await sql.unsafe('delete from memory_facts where workspace_id = $1', [workspaceId]).catch(() => {});
      await sql.unsafe('delete from workspace_agents where workspace_id = $1', [workspaceId]).catch(() => {});
      await sql.unsafe('delete from workspaces where id = $1', [workspaceId]).catch(() => {});
    }
    if (userId) await sql.unsafe('delete from app_users where id = $1', [userId]).catch(() => {});
    await sql.end({ timeout: 5 });
    console.log('cleanup: done');
  }
}

main().catch((err) => { console.error('\nSMOKE FAILED:', err.message); process.exit(1); });
