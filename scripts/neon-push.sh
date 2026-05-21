#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-}"

if [ -z "$DATABASE_URL" ] && [ -f .env ]; then
  DATABASE_URL="$(node -e "const fs=require('fs'); const path='.env'; const raw=fs.readFileSync(path,'utf8').split(/\r?\n/).find(line=>line.startsWith('DATABASE_URL=')); if (raw) process.stdout.write(raw.slice('DATABASE_URL='.length));")"
fi

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set"
  exit 1
fi

/opt/homebrew/opt/libpq/bin/psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/neon-schema.sql

echo "Neon schema applied successfully"
