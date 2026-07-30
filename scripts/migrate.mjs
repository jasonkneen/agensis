#!/usr/bin/env node
// Lightweight SQL migration runner for Agensis.
//
// Why this exists (review H6): the backend currently applies schema changes at
// runtime via ensureRuntimeSchema() (a big block of `ALTER TABLE ... ADD COLUMN
// IF NOT EXISTS`). The canonical schema lives in supabase/migrations/*.sql. This
// runner makes those .sql files the source of truth so production can disable the
// runtime fallback (AGENSIS_RUNTIME_SCHEMA=false) and run `npm run migrate` instead.
//
// Design notes:
//   - Reuses the existing Supabase .sql files verbatim (no format conversion).
//   - Tracks applied migrations in `_schema_migrations` (name PK + applied_at).
//   - Each pending migration runs inside its own transaction; on error it rolls
//     back, prints the failing file, and exits non-zero.
//   - Idempotent + safe to re-run.
//
// First-run backfill (important):
//   Most of the live DB's schema already exists (historically via
//   ensureRuntimeSchema + manual pushes). A brand-new `_schema_migrations` table
//   starts EMPTY, which would otherwise re-run every .sql file. To avoid that we
//   detect "fresh tracking table + a COMPLETE core schema" and BACKFILL
//   `_schema_migrations`, WITHOUT running them, for the subset of current
//   filenames listed in the frozen `.baseline-manifest.json` (see H7 below —
//   this is NOT "every file currently on disk"). Everything else — including
//   any migration not in that manifest — is left pending and actually runs,
//   same as any other pass. On a truly empty database (no core schema at all)
//   nothing is backfilled and all migrations run normally.
//
//   H5 (2026-07 review): "complete" used to mean a single probe — does the
//   `workspaces` table exist. A database left half-built by an aborted
//   `npm run db:neon:push` HAS workspaces, so the backfill fired, marked every
//   migration as applied without running it, printed a green "Up to date", and
//   made the missing tables unrepairable by this tool forever. The probe now
//   requires EVERY table in CORE_BOOTSTRAP_TABLES; a partially-provisioned
//   database is loudly refused instead, and only an explicit `--baseline` flag
//   can record migrations as applied over a schema that is missing core tables.
//
//   H7 (2026-07-30 incident): the backfill above used to mark EVERY .sql file
//   *currently on disk* as applied-without-running — including one added in
//   the very same deploy that first creates `_schema_migrations`. That bit for
//   real: 20260730210000_rename_skills_folder_to_playbooks.sql shipped with
//   this runner's first-ever production run, got silently recorded as
//   "already applied," and its UPDATE never executed (caught by hand, fixed
//   out of band). "It's a file in supabase/migrations/" is not evidence a
//   migration's effect already exists anywhere else — only migrations present
//   in the FROZEN `.baseline-manifest.json` (files known, at the time that
//   manifest was written, to already be true via ensureRuntimeSchema() or
//   database/neon-schema.sql) are eligible for silent backfill. Anything not
//   in that manifest — including every future migration, forever, since the
//   manifest is never auto-grown — is left pending and actually runs, even on
//   a first-ever run. `--baseline` is gated the same way: it can still assert
//   "the schema is fine despite looking incomplete" for manifest files, but it
//   cannot wave through a migration the manifest doesn't vouch for.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const BASELINE_MANIFEST_PATH = join(MIGRATIONS_DIR, '.baseline-manifest.json');
// Serializes concurrent `npm run migrate` runs (e.g. parallel deploys) via a
// session-scoped Postgres advisory lock so two processes can't apply the same
// migration at once.
const MIGRATION_LOCK_KEY = 4242042042;
// Evidence of a COMPLETED bootstrap. Every one of these is created by the
// supabase/migrations set (and by database/neon-schema.sql), and they are spread
// across the whole of neon-schema.sql — so if that file aborted part-way, at
// least one of them is missing and the backfill below refuses to run.
const CORE_BOOTSTRAP_TABLES = [
  'workspaces',
  'chat_sessions',
  'messages',
  'workspace_agents',
  'workspace_members',
  'canvas_objects',
  'tasks',
  'document_comments',
  'activity_events',
];

/**
 * Splits `files` into what's safe to silently mark applied ("eligible" — it
 * appears in the frozen manifest) versus what must actually run even on a
 * first-ever `_schema_migrations` run ("notEligible" — anything the manifest
 * doesn't vouch for, most importantly a migration nobody has run yet). Pure
 * and DB-free on purpose so it's unit-testable without postgres.
 */
export function partitionForBaseline(files, manifestFiles) {
  const manifest = new Set(manifestFiles);
  const eligible = files.filter((f) => manifest.has(f));
  const notEligible = files.filter((f) => !manifest.has(f));
  return { eligible, notEligible };
}

/**
 * Reads the frozen baseline manifest. Throws (rather than returning an empty
 * list) when it's missing or malformed — silently treating "no manifest" as
 * "nothing is eligible" would be the safer failure mode data-wise, but this
 * runner's whole house style (see H5 above) is to refuse loudly rather than
 * guess, so a missing manifest stops the run instead of quietly changing
 * behavior.
 */
export async function loadBaselineManifest() {
  const raw = await readFile(BASELINE_MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.files)) {
    throw new Error(`${BASELINE_MANIFEST_PATH} is malformed: expected a "files" array`);
  }
  return parsed.files;
}

async function main() {
  // Explicit opt-in to record every migration as already-applied even when the
  // core schema looks incomplete. Never inferred — see the H5 note above.
  const baselineRequested = process.argv.slice(2).includes('--baseline');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] DATABASE_URL is not set. Run via `npm run migrate` (loads .env) or export it.');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {}, // suppress benign "already exists, skipping" NOTICEs
  });

  try {
    // Block until we hold the migration lock; released in finally (and implicitly
    // by sql.end()). Prevents two runners racing the same pending migration.
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    // 1. Does the tracking table already exist? (Decides backfill behavior.)
    const trackingExisted = Boolean(
      (await sql`SELECT to_regclass('public._schema_migrations') AS reg`)[0].reg,
    );

    // 2. Ensure the tracking table.
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS _schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz DEFAULT now()
       )`,
    );

    // 3. Load migration filenames, sorted (timestamp-prefixed => lexical = chronological).
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('[migrate] No .sql migrations found in', MIGRATIONS_DIR);
      return;
    }

    // 4. First-run backfill: fresh tracking table + a COMPLETE core schema.
    if (!trackingExisted) {
      const present = [];
      const missing = [];
      for (const table of CORE_BOOTSTRAP_TABLES) {
        const reg = (await sql`SELECT to_regclass(${`public.${table}`}) AS reg`)[0].reg;
        (reg ? present : missing).push(table);
      }

      if (present.length === 0) {
        if (baselineRequested) {
          console.log('[migrate] --baseline ignored: no core tables exist, so there is nothing to baseline.');
        }
        console.log('[migrate] Fresh database detected: all migrations will be applied.');
      } else if (missing.length > 0 && !baselineRequested) {
        console.error('[migrate] REFUSING TO RUN: this database is only partially provisioned.');
        console.error(`[migrate]   present (${present.length}): ${present.join(', ')}`);
        console.error(`[migrate]   MISSING (${missing.length}): ${missing.join(', ')}`);
        console.error('[migrate] Recording the migrations as applied here would hide the missing');
        console.error('[migrate] tables permanently. Finish the bootstrap first — `npm run db:neon:push`');
        console.error('[migrate] applies database/neon-schema.sql in full — then re-run `npm run migrate`.');
        console.error('[migrate] If you are certain this schema is already correct, re-run with --baseline.');
        process.exitCode = 1;
        return;
      } else {
        let manifestFiles;
        try {
          manifestFiles = await loadBaselineManifest();
        } catch (error) {
          console.error('[migrate] REFUSING TO RUN: could not read the baseline manifest.');
          console.error(`[migrate]   ${BASELINE_MANIFEST_PATH}`);
          console.error(`[migrate]   ${error.message || error}`);
          console.error('[migrate] Without it there is no way to tell which migrations are');
          console.error('[migrate] already true elsewhere versus brand new — see the H7 note at');
          console.error('[migrate] the top of this file. Restore the manifest before retrying.');
          process.exitCode = 1;
          return;
        }

        const { eligible, notEligible } = partitionForBaseline(files, manifestFiles);
        const reason = missing.length > 0
          ? `--baseline over an incomplete schema (missing: ${missing.join(', ')})`
          : 'First run on an existing database';

        if (eligible.length > 0) {
          await sql`
            INSERT INTO _schema_migrations ${sql(eligible.map((name) => ({ name })))}
            ON CONFLICT (name) DO NOTHING
          `;
        }
        console.log(
          `[migrate] ${reason}: backfilled ${eligible.length} migration(s) from the baseline manifest as already-applied (not re-run).`,
        );
        if (notEligible.length > 0) {
          console.log(
            `[migrate] ${notEligible.length} migration(s) NOT in the baseline manifest will run normally, this pass: ${notEligible.join(', ')}`,
          );
        }
      }
    }

    // 5. Determine pending migrations.
    const appliedRows = await sql`SELECT name FROM _schema_migrations`;
    const applied = new Set(appliedRows.map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log(`[migrate] Up to date. ${applied.size} applied, 0 pending.`);
      return;
    }

    console.log(`[migrate] ${pending.length} pending migration(s): ${pending.join(', ')}`);

    // 6. Apply each pending migration in its own transaction.
    for (const name of pending) {
      const body = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(body);
          await tx`INSERT INTO _schema_migrations ${tx({ name })}`;
        });
        console.log(`[migrate] applied  ${name}`);
      } catch (error) {
        console.error(`[migrate] FAILED   ${name}`);
        console.error(`[migrate] rolled back. Error: ${error.message || error}`);
        process.exitCode = 1;
        return;
      }
    }

    if (process.exitCode !== 1) {
      console.log(`[migrate] Done. ${pending.length} applied this run.`);
    }
  } finally {
    try { await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`; } catch { /* connection already closing */ }
    await sql.end({ timeout: 5 });
  }
}

// Only run as a side effect when executed directly (`node scripts/migrate.mjs`
// / `npm run migrate`), never on import — lets tests import the pure helpers
// above without opening a DB connection or calling process.exit().
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[migrate] Unexpected error:', error.message || error);
    process.exit(1);
  });
}
