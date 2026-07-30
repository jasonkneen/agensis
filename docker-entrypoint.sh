#!/bin/sh
# Bootstraps the database, then hands off to the backend (see Dockerfile CMD).
#
# Schema comes from THREE places in this repo and the order below is the whole
# reason this script exists:
#
#   1. database/neon-schema.sql — the plain-Postgres bootstrap, what
#      `npm run db:neon:push` applies. It is the only one of the three that
#      creates the core tables (app_users, workspaces, chat_sessions, messages,
#      tasks, ...).
#   2. supabase/migrations/*.sql via scripts/migrate.mjs — incremental changes
#      since. Several of the early files are Supabase-flavoured (auth.uid(),
#      RLS policies against auth.users) and would fail on stock Postgres, so
#      they must never be the thing that builds a fresh database. Run AFTER
#      step 1, the runner sees a complete core schema, backfills those files
#      from its frozen baseline manifest without executing them, and applies
#      only what is genuinely new.
#   3. ensureRuntimeSchema() in server/index.cjs, on boot. It only ever ADDs to
#      an existing schema, so it cannot stand in for step 1.
#
# Reversing 1 and 2 is not a style preference: it is the difference between a
# database that builds and one that dies on the third migration.
set -e

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[docker] DATABASE_URL is not set" >&2
  exit 1
fi

# docker-compose.yml already gates this container on the db's healthcheck, but
# an externally supplied DATABASE_URL has no such gate, and a healthy Postgres
# still refuses connections for a moment while it finishes starting up.
attempt=0
until psql "$DATABASE_URL" -c 'select 1' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "[docker] database still unreachable after 60 attempts, giving up" >&2
    psql "$DATABASE_URL" -c 'select 1' >&2 || true
    exit 1
  fi
  [ "$attempt" = 1 ] && echo "[docker] waiting for postgres..."
  sleep 2
done

# Idempotent: every CREATE in it is IF NOT EXISTS and both triggers DROP first,
# so re-running it on an established database is a no-op and a database left
# half-built by an interrupted first boot repairs itself.
echo "[docker] applying database/neon-schema.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f database/neon-schema.sql

echo "[docker] applying supabase/migrations"
node scripts/migrate.mjs

exec "$@"
