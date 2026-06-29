const BE = 'https://agensis-backend.fly.dev';
const PW = process.env.PW;
const wsId = '3c4cdf0d-ea54-4c63-b21a-55f3fe8fac6d';
const j = (r) => r.json();
const post = (p, b, t) => fetch(`${BE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }).then(j);
const token = (await post('/backend/auth/signin', { email: 'jason@bouncingfish.com', password: PW })).data.token;
const agents = await post('/backend/db/select', { table: 'workspace_agents', filters: [{ column: 'workspace_id', operator: 'eq', value: wsId }] }, token);
const coder = (agents.data || []).find(a => (a.handle || '').toLowerCase() === 'coder');

const sess = await post('/backend/db/insert', { table: 'chat_sessions', values: { workspace_id: wsId, title: 'verify DM', folder: 'Direct messages', participants: [{ id: `agent:${coder.id}`, kind: 'agent', name: 'Coder', handle: 'coder', agent_id: coder.id, direct: true }] } }, token);
const sessionId = sess.data[0].id;

const getMsgs = async () => (await post('/backend/db/select', { table: 'messages', filters: [{ column: 'session_id', operator: 'eq', value: sessionId }] }, token)).data || [];

// --- DM turn ---
await post('/backend/db/insert', { table: 'messages', values: { session_id: sessionId, role: 'user', content: 'say hi in one short sentence' } }, token);
await post('/backend/agents/dispatch', { workspaceId: wsId, sessionId, content: 'say hi in one short sentence' }, token);
let coderMsg = null;
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const m = await getMsgs();
  const coderMsgs = m.filter(x => x.sender_kind === 'agent');
  const resolved = coderMsgs.find(x => !/^Thinking \d/.test(String(x.content)));
  if (resolved) { coderMsg = resolved; console.log(`DM resolved at t+${(i + 1) * 5}s | coder messages: ${coderMsgs.length} | thinking-stuck: ${coderMsgs.filter(x => /^Thinking \d/.test(String(x.content))).length}`); break; }
}
const after = await getMsgs();
console.log('DM final messages:');
for (const m of after) console.log(`  [${m.sender_name || m.role}] tp=${m.thread_parent_id ? 'Y' : '-'} :: ${String(m.content).slice(0, 60)}`);

// --- Threading: reply in thread to coder's answer, NO @mention ---
if (coderMsg) {
  const replyContent = 'thanks, can you say it again?';
  await post('/backend/db/insert', { table: 'messages', values: { session_id: sessionId, role: 'user', content: replyContent, thread_parent_id: coderMsg.id } }, token);
  const td = await post('/backend/agents/dispatch', { workspaceId: wsId, sessionId, content: replyContent, threadParentId: coderMsg.id }, token);
  console.log('thread dispatch:', JSON.stringify(td.data || td.error));
  let threadReply = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const m = await getMsgs();
    threadReply = m.find(x => x.sender_kind === 'agent' && x.thread_parent_id === coderMsg.id && !/^Thinking \d/.test(String(x.content)));
    if (threadReply) { console.log(`THREAD reply resolved at t+${(i + 1) * 5}s | in-thread=${threadReply.thread_parent_id === coderMsg.id}`); break; }
  }
  if (!threadReply) console.log('THREAD reply: NONE (still thinking or landed at root)');
}
process.exit(0);
