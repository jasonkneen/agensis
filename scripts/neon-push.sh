#!/usr/bin/env bash
set -euo pipefail

# Run from the repo root so .env and database/neon-schema.sql resolve regardless
# of the caller's cwd (the script lives in scripts/).
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DATABASE_URL="${DATABASE_URL:-}"

if [ -z "$DATABASE_URL" ] && [ -f .env ]; then
  DATABASE_URL="$(node -e "const fs=require('fs'); const path='.env'; const raw=fs.readFileSync(path,'utf8').split(/\r?\n/).find(line=>line.startsWith('DATABASE_URL=')); if (raw) process.stdout.write(raw.slice('DATABASE_URL='.length));")"
fi

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set"
  exit 1
fi

# Resolve psql portably: PATH first, then common Homebrew libpq keg locations
# (libpq is keg-only, so it is not linked onto PATH by default).
PSQL="$(command -v psql || true)"
for candidate in /opt/homebrew/opt/libpq/bin/psql /usr/local/opt/libpq/bin/psql; do
  [ -n "$PSQL" ] && break
  [ -x "$candidate" ] && PSQL="$candidate"
done
if [ -z "$PSQL" ]; then
  echo "psql not found. Install PostgreSQL client tools (e.g. 'brew install libpq') or add psql to PATH." >&2
  exit 1
fi

"$PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/neon-schema.sql

echo "Neon schema applied successfully"
