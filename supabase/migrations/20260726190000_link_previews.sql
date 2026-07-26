-- Link preview cards: the server-side unfurl cache.
--
-- One row per NORMALIZED url (fragment dropped, query kept), keyed by a sha256
-- of it. Deliberately NOT workspace-scoped — the point of the cache is one
-- outbound fetch per URL for the whole install rather than one per workspace,
-- per reader, per render, and nothing stored here is private to a workspace: it
-- is metadata a public page publishes about itself.
--
-- The table is absent from ALLOWED_TABLES in shared/backend-core.cjs on purpose,
-- so it is unreachable through the generic /backend/db gate and cannot be
-- enumerated. It is read only by POST /backend/link-previews, which answers for
-- URLs the caller supplied.
--
-- expires_at carries the TTL rather than a separate column: ok/empty rows last a
-- week, failures an hour, so a host that was briefly down is retried soon
-- instead of being un-previewable until next week (see linkPreviewTtlMs in
-- server/link-preview.cjs).
--
-- Mirrors ensureRuntimeSchema in server/index.cjs and database/neon-schema.sql.

CREATE TABLE IF NOT EXISTS link_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url_hash text NOT NULL UNIQUE,
  url text NOT NULL,
  final_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok', 'empty', 'failed', 'blocked')),
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  site_name text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_previews_expires ON link_previews(expires_at);
