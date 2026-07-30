'use strict';
// Reset the onboarding test account: deletes the user and ALL of their
// workspaces (workspace deletes cascade to sessions/messages/agents/tasks/etc),
// so the next sign-up starts completely fresh and the onboarding tour replays.
//
//   npm run reset:test-account                    # testing@bouncingfish.com
//   npm run reset:test-account -- someone@x.com   # another email
//
// Reads DATABASE_URL from .env (node --env-file=.env).
//
// After running this, also clear the browser's localStorage keys
// (agensis_tour_complete, agensis_getstarted_dismissed,
// agensis_getstarted_collapsed) — or just use a fresh incognito window — or the
// tour won't re-show for that browser.

const postgres = require('postgres');

const email = (process.argv[2] || 'testing@bouncingfish.com').trim().toLowerCase();
const DB = process.env.DATABASE_URL;
if (!DB) { console.error('DATABASE_URL required (run via npm run reset:test-account)'); process.exit(1); }

const sql = postgres(DB);

async function main() {
  const users = await sql.unsafe('select id, email from app_users where lower(email) = $1', [email]);
  if (users.length === 0) {
    console.log(`No account found for ${email} — nothing to reset.`);
    await sql.end({ timeout: 5 });
    return;
  }

  for (const user of users) {
    const workspaces = await sql.unsafe('select id, name from workspaces where user_id = $1', [user.id]);
    for (const ws of workspaces) {
      // Explicit pre-deletes are belt-and-braces; the workspaces delete cascades.
      await sql.unsafe('delete from messages where session_id in (select id from chat_sessions where workspace_id = $1)', [ws.id]).catch(() => {});
      await sql.unsafe('delete from chat_sessions where workspace_id = $1', [ws.id]).catch(() => {});
      await sql.unsafe('delete from documents where workspace_id = $1', [ws.id]).catch(() => {});
      await sql.unsafe('delete from tasks where workspace_id = $1', [ws.id]).catch(() => {});
      await sql.unsafe('delete from memory_facts where workspace_id = $1', [ws.id]).catch(() => {});
      await sql.unsafe('delete from workspace_agents where workspace_id = $1', [ws.id]).catch(() => {});
      await sql.unsafe('delete from workspaces where id = $1', [ws.id]);
      console.log(`  deleted workspace ${ws.name} (${ws.id})`);
    }
    await sql.unsafe('delete from app_users where id = $1', [user.id]);
    console.log(`  deleted user ${user.email} (${user.id})`);
  }

  await sql.end({ timeout: 5 });
  console.log(`\nReset complete for ${email}. Sign up again in the app, and clear the`);
  console.log('onboarding localStorage keys (or use incognito) to replay the tour.');
}

main().catch((err) => { console.error('RESET FAILED:', err.message); process.exit(1); });
