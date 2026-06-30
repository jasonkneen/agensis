const fs = require('fs');
const postgres = require('postgres');
const url = process.env.DATABASE_URL || fs.readFileSync(__dirname + '/../.env', 'utf8')
  .split('\n').find(l => l.startsWith('DATABASE_URL=')).slice('DATABASE_URL='.length).trim();
const sql = postgres(url, { ssl: 'require', max: 1 });
(async () => {
  // Backfill existing direct-message sessions to auto mode so un-mentioned
  // messages always dispatch, instead of relying solely on the direct flag.
  const updated = await sql.unsafe(
    "update chat_sessions set conversation_mode = 'auto' where folder = 'Direct messages' and conversation_mode is distinct from 'auto' returning id, title"
  );
  console.log('Updated', updated.length, 'DM session(s) to conversation_mode=auto');
  for (const r of updated) console.log('  -', r.title, r.id);
  await sql.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
