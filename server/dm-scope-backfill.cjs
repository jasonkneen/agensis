'use strict';

// ============================================================================
// server/dm-scope-backfill.cjs — the one-time migration behind DM privacy.
// ----------------------------------------------------------------------------
// Turning "every member can read every session" into "a private session is
// readable by its members" is only safe if the member list is right on the FIRST
// boot. A session that reads as private with nobody in it is a conversation its
// own owner cannot open, and no amount of correct gating downstream recovers
// from that.
//
// THE ASSUMPTION, AND WHY IT IS NOT A GUESS. No DM in this schema has ever
// recorded a human — findOrCreateDirectSession writes a participants array
// holding the AGENT alone — so there is no stored answer to "whose DM is this".
// Measured against production before this was written:
//
//   * 76 DM rows, ZERO with any human participant
//   * 75 of 76 created at a moment when the workspace owner was the only human
//     who existed in that workspace
//   * not one DM containing a message authored by a non-owner human
//
// So seeding the workspace owner restores exactly the access people already had.
//
// WHY THIS FILE EXISTS RATHER THAN A BLOCK OF SQL IN ensureRuntimeSchema. The
// three bullets above are true of TODAY's data. They are not laws. A dataset
// that violates them would, under a blind owner-seed, silently orphan somebody's
// DM — the exact failure this migration must not cause. So the assumption is
// executable here: step 3 SEEDS the humans who demonstrably participated
// (evidence beats inference), and step 4 REPORTS anything left that the
// owner-only story cannot explain, loudly, with ids. Extracting it also makes it
// testable, which prose in a template literal never was.
// ============================================================================

/** Mark every DM private. Cheap and idempotent: the WHERE makes re-runs no-ops. */
const MARK_DMS_SQL = `
  UPDATE chat_sessions SET visibility = 'private'
   WHERE folder = 'Direct messages' AND visibility <> 'private'`;

/**
 * Seed the workspace owner into any private session that has NO members.
 *
 * `NOT EXISTS` is what makes this fill-the-void rather than restore-the-world: a
 * session that already has members has been curated (a grant given, a revoke
 * applied) and a later boot must never resurrect somebody a revoke removed.
 */
const SEED_OWNERS_SQL = `
  INSERT INTO chat_session_members (session_id, user_id, source)
  SELECT s.id, w.user_id, 'participant'
    FROM chat_sessions s
    JOIN workspaces w ON w.id = s.workspace_id
   WHERE s.visibility = 'private'
     AND w.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM chat_session_members m WHERE m.session_id = s.id)
  ON CONFLICT DO NOTHING`;

/**
 * Seed every human who actually SPOKE in a private session.
 *
 * This is the step that makes the migration correct by construction instead of
 * correct by luck. If a second human ever posted in someone's DM, they were
 * participating in it, and inferring "the owner owns it" would take away access
 * they demonstrably used. Evidence beats the assumption, so the evidence wins.
 *
 * Returns zero rows against today's production data — which is the point: it
 * costs nothing now and is already in place for the dataset that needs it.
 */
const SEED_SPEAKERS_SQL = `
  INSERT INTO chat_session_members (session_id, user_id, source)
  SELECT DISTINCT m.session_id, m.sender_id::uuid, 'participant'
    FROM messages m
    JOIN chat_sessions s ON s.id = m.session_id
   WHERE s.visibility = 'private'
     AND m.sender_kind = 'user'
     AND coalesce(m.sender_id, '') <> ''
     AND m.sender_id ~ '^[0-9a-fA-F-]{36}$'
     AND m.deleted_at IS NULL
  ON CONFLICT DO NOTHING
  RETURNING session_id, user_id`;

/**
 * Private sessions whose membership the owner-only story cannot explain: a
 * human spoke in one who is neither the workspace owner nor a member of it.
 *
 * Reported rather than thrown. Throwing here would abort the schema bootstrap
 * and take the whole backend down over a data-shape surprise, and the seeding
 * above has ALREADY given these people access — so the safe outcome has
 * happened and what is left is telling somebody about it.
 */
const ASSUMPTION_VIOLATIONS_SQL = `
  SELECT s.id AS session_id, s.workspace_id, m.sender_id
    FROM messages m
    JOIN chat_sessions s ON s.id = m.session_id
    JOIN workspaces w ON w.id = s.workspace_id
   WHERE s.visibility = 'private'
     AND m.sender_kind = 'user'
     AND coalesce(m.sender_id, '') <> ''
     AND m.sender_id <> w.user_id::text
     AND m.deleted_at IS NULL
   GROUP BY s.id, s.workspace_id, m.sender_id
   LIMIT 50`;

/**
 * A session derived from a private one inherits its privacy: a sub-thread
 * (parent_message_id -> the message's session), a fork (split_parent_id), or a
 * huddle transcript (huddles.transcript_session_id off huddles.session_id).
 *
 * Production had 12 sub-thread sessions hanging off DM messages and 38 huddle
 * sessions carrying a copied DM roster. Scope the 'Direct messages' folder alone
 * and every one of those keeps leaking the conversation it was split out of —
 * a partial fix, which reads as privacy while leaving paths open.
 *
 * `edges` is built non-recursively so the recursive term references `lineage`
 * exactly once, which is all Postgres allows. UNION (not UNION ALL) terminates
 * the walk if a split chain is ever cyclic.
 */
const MARK_DERIVED_SQL = `
  WITH RECURSIVE edges AS (
    SELECT c.id AS child, c.split_parent_id AS parent
      FROM chat_sessions c WHERE c.split_parent_id IS NOT NULL
    UNION ALL
    SELECT c.id, m.session_id
      FROM chat_sessions c JOIN messages m ON m.id = c.parent_message_id
    UNION ALL
    SELECT h.transcript_session_id, h.session_id
      FROM huddles h
     WHERE h.transcript_session_id IS NOT NULL AND h.session_id IS NOT NULL
  ), lineage AS (
    SELECT id FROM chat_sessions WHERE visibility = 'private'
    UNION
    SELECT e.child FROM edges e JOIN lineage l ON e.parent = l.id
  )
  UPDATE chat_sessions s SET visibility = 'private'
    FROM lineage l
   WHERE s.id = l.id AND s.visibility <> 'private'`;

/**
 * Run the migration. `db(sql, params)` is the thin adapter both backends use.
 *
 * ORDERING IS LOad-BEARING and each step is independently wrapped:
 *
 *   1+2 mark DMs and seed owners — TOGETHER. A failure between them is the one
 *       genuinely dangerous outcome (private, no members, nobody can read it).
 *   3+4 seed the humans who spoke, then report what is left unexplained. Runs
 *       after 1 so `visibility` is set to select on.
 *   5   derived lineage, then owners again for the newly private rows. Isolated
 *       last because it touches `messages` and `huddles`: if those are not ready
 *       on a fresh database, DMs are already correctly private and the
 *       fail-closed folder check in isPrivateSessionRow still covers them.
 */
// Scrub message bodies that a members-only session already mirrored into the
// workspace-wide activity feed.
//
// `logMessageActivity` used to copy every message into `activity_events` twice:
// the whole body in `metadata.content`, and its first 80 characters into
// `title`. That table is workspace-scoped and selectable at `read`, is not in
// SELECTABLE_COLUMNS_BY_TABLE (so `columns:"*"` returns `metadata` intact), and
// is reached by neither appendSessionAccessClause nor the realtime private
// lane. One /backend/db/select returned every private conversation in the
// workspace. The write path is fixed, but every row written before that fix
// still holds the text, so the rows have to be rewritten too — a code fix alone
// leaves the data sitting there.
//
// Both carriers are cut. Idempotent: once `content` is gone the row stops
// matching, so this is a no-op on every subsequent boot.
const SCRUB_PRIVATE_ACTIVITY_SQL = `
  update activity_events ae
     set metadata = ae.metadata - 'content',
         title = coalesce(
                   nullif(ae.metadata->>'sender_name', ''),
                   nullif(split_part(coalesce(ae.title, ''), ':', 1), ''),
                   'Someone'
                 ) || ': (private conversation)'
    from chat_sessions cs
   where cs.id::text = ae.metadata->>'session_id'
     and (coalesce(cs.visibility, '') = 'private' or coalesce(cs.folder, '') = 'Direct messages')
     and (ae.metadata->>'content') is not null
  returning ae.id
`;

async function runDmScopeBackfill(db, { warn = console.warn } = {}) {
 const report = { markedDms: false, seededOwners: false, speakersSeeded: 0, violations: [], markedDerived: false, activityScrubbed: 0 };

 try {
  await db(MARK_DMS_SQL, []);
  await db(SEED_OWNERS_SQL, []);
  report.markedDms = true;
  report.seededOwners = true;
 } catch (error) {
  warn('[backend] DM visibility backfill failed:', error?.message || error);
  return report;
 }

 try {
  const seeded = await db(SEED_SPEAKERS_SQL, []);
  report.speakersSeeded = Array.isArray(seeded) ? seeded.length : 0;
  if (report.speakersSeeded > 0) {
   warn(`[backend] DM scope: seeded ${report.speakersSeeded} human participant(s) from message authorship — a private session had a speaker the owner-only assumption did not cover`);
  }

  const violations = await db(ASSUMPTION_VIOLATIONS_SQL, []);
  report.violations = Array.isArray(violations) ? violations : [];
  if (report.violations.length > 0) {
   // Loud, with ids, and stated as what it is: not a crash, but the one thing
   // a human should look at after this migration.
   warn(
    `[backend] DM scope: ${report.violations.length} private session(s) contain messages from a human who is not the workspace owner. `
    + 'They have been granted access (they demonstrably participated), but the owner-only migration assumption does not hold for this dataset — review: '
    + report.violations.map((row) => `${row.session_id}<-${row.sender_id}`).join(', '),
   );
  }
 } catch (error) {
  warn('[backend] DM scope participant evidence pass failed:', error?.message || error);
 }

 try {
  await db(MARK_DERIVED_SQL, []);
  await db(SEED_OWNERS_SQL, []);
  report.markedDerived = true;
 } catch (error) {
  warn('[backend] derived-session visibility backfill failed:', error?.message || error);
 }

 // Runs AFTER the visibility passes above, and that order is load-bearing: the
 // scrub matches on `visibility`/`folder`, so a DM only just marked private by
 // MARK_DMS_SQL or MARK_DERIVED_SQL would be missed if this ran first.
 try {
  const scrubbed = await db(SCRUB_PRIVATE_ACTIVITY_SQL, []);
  report.activityScrubbed = Array.isArray(scrubbed) ? scrubbed.length : 0;
  if (report.activityScrubbed > 0) {
   warn(
    `[backend] DM scope: removed message bodies from ${report.activityScrubbed} activity feed row(s) that mirrored a private conversation. `
    + 'Those rows were readable by any workspace member holding `read` until now.',
   );
  }
 } catch (error) {
  warn('[backend] private activity scrub failed:', error?.message || error);
 }

 return report;
}

module.exports = {
 runDmScopeBackfill,
 MARK_DMS_SQL,
 SEED_OWNERS_SQL,
 SEED_SPEAKERS_SQL,
 ASSUMPTION_VIOLATIONS_SQL,
 MARK_DERIVED_SQL,
 SCRUB_PRIVATE_ACTIVITY_SQL,
};
