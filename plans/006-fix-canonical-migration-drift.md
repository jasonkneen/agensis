# Plan 006: Add the missing `app_users` profile migration to the canonical path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `ls supabase/migrations/ | tail -5` and
> `grep -rl display_name supabase/migrations/`. If the second command now returns a match, this
> finding has already been fixed by someone else — stop and report rather than duplicating it.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: migration / correctness
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

`scripts/migrate.mjs` states explicitly (its own header comment) that `supabase/migrations/*.sql`
is "the canonical schema," designed so production can disable the runtime `ALTER TABLE` fallback
(`AGENSIS_RUNTIME_SCHEMA=false`, following this repo's own documented hardening path from the prior
review) and rely solely on `npm run migrate`. But `supabase/migrations/` has **no** migration for
`app_users.display_name`/`app_users.accent_color` — columns two other schema sources
(`netlify/database/migrations/0006_app_user_profile.sql` and `database/neon-schema.sql`) already
have, and which the new account/profile-editing feature (`AccountDialog.tsx`,
`PATCH /backend/users/me`) actively depends on. Following the project's own recommended hardening
path — turning off the runtime-ALTER fallback — would silently break profile editing on any
deployment that relies on `npm run migrate` as its schema source of truth: `app_users.display_name`
wouldn't exist, and a profile-save call would fail with a Postgres "column does not exist" error.

## Current state

**`netlify/database/migrations/0006_app_user_profile.sql`** (in full):

```sql
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name text DEFAULT '';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS accent_color text DEFAULT '';
```

**`database/neon-schema.sql:18-19`** — the reference schema dump already includes both columns
directly in the `CREATE TABLE app_users (...)` statement.

**Confirmed at planning time**: `grep -rln display_name supabase/migrations/` returns **no
matches** across all 25 files in that directory (the latest being
`20260629203000_agent_enabled.sql`).

**`scripts/migrate.mjs:1-9`** (header comment):

```
// The canonical schema lives in supabase/migrations/*.sql. This runner makes
// those .sql files the source of truth so production can disable the runtime
// fallback (AGENSIS_RUNTIME_SCHEMA=false) and run `npm run migrate` instead.
```

**`server/index.cjs`** — `ALLOW_RUNTIME_SCHEMA = process.env.AGENSIS_RUNTIME_SCHEMA !== 'false'`
defaults to `true` (so today the gap is papered over by default via the runtime ALTER fallback —
this finding only bites once an operator follows the project's own advice to disable it).
`netlify/functions/backend.mjs`'s `ensureAppUserProfileColumns()` runs the equivalent `ALTER` with
no flag at all — so the Netlify path is unaffected either way.

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Migrate (scratch DB) | `node --env-file=.env scripts/migrate.mjs` (against a non-production `DATABASE_URL`) | exits 0, reports the new migration applied |
| Typecheck        | `npm run typecheck`               | exit 0, no errors (unaffected by this change, but keep the gate green) |

## Scope

**In scope** (the only files you should modify):
- A new file: `supabase/migrations/<timestamp>_app_user_profile.sql` (pick a timestamp later than
  `20260629203000`, matching the directory's existing `YYYYMMDDHHMMSS_description.sql` naming
  convention — e.g. `20260701000000_app_user_profile.sql`)

**Out of scope** (do NOT touch, even though they look related):
- `netlify/database/migrations/0006_app_user_profile.sql` — leave as-is; it's the source you're
  mirroring, not something to delete or modify.
- `database/neon-schema.sql` — already has the columns; no change needed there.
- The broader "three schema-of-truth locations, no doc says which is canonical" documentation gap —
  that's a separate, related finding; this plan only closes the concrete drift, not the systemic
  documentation issue.
- `server/index.cjs`'s `AGENSIS_RUNTIME_SCHEMA` flag or its runtime `ALTER TABLE` logic — do not
  change the flag's default or remove the runtime fallback as part of this plan; this plan makes it
  *safe* to disable, it doesn't disable it.

## Steps

### Step 1: Add the missing migration

Create `supabase/migrations/20260701000000_app_user_profile.sql` (adjust the timestamp only if a
file with that exact name already exists) with content mirroring
`netlify/database/migrations/0006_app_user_profile.sql` exactly:

```sql
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name text DEFAULT '';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS accent_color text DEFAULT '';
```

**Verify**: `grep -rl display_name supabase/migrations/` now returns the new file.

### Step 2: Confirm it applies cleanly against a fresh/scratch database

Run `node --env-file=.env scripts/migrate.mjs` against a **non-production** `DATABASE_URL` (a
scratch Neon branch or local Postgres instance — do NOT run this against the shared production
database as part of verifying this plan). Because the migration uses `ADD COLUMN IF NOT EXISTS`, it
is safe to run even against a database that already has these columns via the runtime-ALTER
fallback (it will no-op on those columns, and the `_schema_migrations` bookkeeping table will
correctly record the migration as applied going forward).

**Verify**: `scripts/migrate.mjs`'s output reports the new migration as applied (not skipped due to
an error); `select display_name, accent_color from app_users limit 1;` succeeds against that
scratch database even with `AGENSIS_RUNTIME_SCHEMA=false` set.

## Test plan

No new automated test is required for a pure SQL migration addition — this repo's existing test
suites don't run migrations as part of `npm test`/`npm run test:unit`. The verification in Step 2
(applying against a real scratch database) is the meaningful check here; do not attempt to write a
test that mocks Postgres DDL execution, it wouldn't prove anything a real `migrate.mjs` run doesn't
already prove better.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rl display_name supabase/migrations/` returns the new file
- [ ] `node --env-file=.env scripts/migrate.mjs` applied cleanly against a scratch/test database
      (not production)
- [ ] `npm run typecheck` still exits 0 (unaffected, but confirms no accidental unrelated change)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `grep -rl display_name supabase/migrations/` already returns a match when you start (someone
  else already fixed this — do not add a duplicate migration).
- You don't have access to any non-production database to verify against — report back rather than
  running an unverified migration against production, or skipping verification entirely.
- The `app_users` table in a scratch database you test against doesn't match the expected shape
  (e.g. missing entirely, or `display_name`/`accent_color` already present with a different type) —
  that indicates the schema has drifted further than this plan accounts for; stop and describe what
  you found.

## Maintenance notes

- This closes the *specific* drift found during this review. The *systemic* problem — three
  schema-of-truth locations with no single documented canonical source — is tracked as a separate,
  broader finding (adding a CLAUDE.md/README note naming `supabase/migrations/` + `npm run migrate`
  as canonical, and deciding whether `netlify/database/migrations/` is still live or safe to
  delete). Whoever picks up that broader plan should link back to this one.
- Going forward, any new runtime `ALTER TABLE ADD COLUMN` added to `server/index.cjs`'s
  `ensureRuntimeSchema()` or `netlify/functions/backend.mjs`'s equivalent should land a matching
  `supabase/migrations/` file in the **same PR** — there's no CI check enforcing this today; adding
  one (e.g. a script that diffs `ensureRuntimeSchema`'s columns against the latest migration state)
  would be a good, separate, future DX improvement.
