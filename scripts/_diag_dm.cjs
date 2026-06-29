const fs = require('fs');
const postgres = require('postgres');
const url = process.env.DATABASE_URL || fs.readFileSync(__dirname + '/../.env', 'utf8')
  .split('\n').find(l => l.startsWith('DATABASE_URL=')).slice('DATABASE_URL='.length).trim();
const sql = postgres(url, { ssl: 'require', max: 1 });
(async () => {
  const dm = await sql.unsafe(
    "select id, title, conversation_mode, model, participants, archived_at, created_at from chat_sessions where folder = 'Direct messages' order by created_at desc limit 20"
  );
  console.log('DM sessions found:', dm.length);
  for (const r of dm) {
    console.log('---');
    console.log('id:', r.id);
    console.log('title:', r.title, '| mode:', r.conversation_mode, '| model:', r.model, '| archived:', !!r.archived_at);
    console.log('participants:', JSON.stringify(r.participants));
    const jobs = await sql.unsafe(
      "select id, agent_id, status, error, created_at from agent_jobs where session_id = $1 order by created_at desc limit 5",
      [r.id]
    );
    console.log('agent_jobs for this DM:', jobs.length, jobs.map(j => j.status + (j.error ? '('+String(j.error).slice(0,60)+')' : '')).join(', '));
  }
  await sql.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
