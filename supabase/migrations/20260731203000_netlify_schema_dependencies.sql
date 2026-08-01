-- Netlify is an HTTP mirror over the primary Neon database. It must not repair
-- schema inside a request, so dependencies that were previously created by the
-- serverless handler need an explicit forward migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz DEFAULT now()
);
