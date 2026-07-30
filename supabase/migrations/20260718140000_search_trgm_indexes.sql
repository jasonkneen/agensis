-- MCP search_messages / search_docs run leading-wildcard ILIKE ('%q%') which
-- can't use a btree index, so they fell back to a full sequential scan of
-- messages / documents. pg_trgm GIN indexes make those substring searches
-- index-backed. Mirrors the runtime bootstrap DDL in server/index.cjs.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
  ON messages USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_documents_title_trgm
  ON documents USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_documents_content_trgm
  ON documents USING gin (content gin_trgm_ops);
