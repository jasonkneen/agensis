-- Event-driven orbs (plans/021-event-driven-orbs.md).
--
-- Turns agent_webhooks into orbs: an agent woken by a VERIFIED external event,
-- routed into a thread, deduplicated against provider retries, and told plainly
-- which half of its prompt is untrusted.
--
-- Every default here reproduces the pre-orb behaviour exactly — provider
-- 'generic' (unsigned accepted, as today), routing 'new' (a fresh session per
-- delivery, as today) — so no existing row changes meaning when this applies.
--
-- The signing secret is deliberately NOT a column on agent_webhooks. That table
-- is in the backendClient allowlists and the frontend does a literal
-- select('*'), so anything stored on it ships to the browser. Orb secrets live
-- in the workspace vault (workspace_secrets) under the key `orb:<webhook id>`;
-- the colon makes that namespace uncollidable with user-defined vault keys,
-- which the vault route restricts to [A-Za-z0-9_.-].

ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'generic';
ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS prompt text NOT NULL DEFAULT '';
ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS payload_fields jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS routing text NOT NULL DEFAULT 'new';
ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS rate_limit_per_hour integer NOT NULL DEFAULT 60;
-- Advisory UI hint ("is a signing secret configured for this orb"). A boolean, not
-- key material, so it is safe to ship to the browser via select('*'), and it
-- survives a reload. The trigger route never consults it: it reads the vault entry
-- itself, so a drifted flag cannot weaken verification.
ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS has_signing_secret boolean NOT NULL DEFAULT false;
ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS thread_root_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;

-- Inbound delivery ledger: the deduplication gate AND the delivery log.
--
-- Dedupe has to be in the database. claimTaskDispatch (server/index.cjs) is a
-- process-local Map with a 15-second window: correct for swallowing one human's
-- double-click, useless against a GitHub or Stripe retry that arrives minutes
-- later, after a Fly restart, or on a second machine. flow_webhook_deliveries
-- already solves exactly this in the outbound direction with UNIQUE +
-- `on conflict do nothing`; this is that, inbound.
--
-- delivery_key is NULL when the provider supplies no delivery id, and the unique
-- index is PARTIAL so those rows never claim the idempotency slot — a hard
-- uniqueness constraint on body_hash would permanently swallow two genuinely
-- distinct byte-identical events (a bare "deploy finished" ping). Rejected and
-- throttled rows are written with a NULL key for the same reason: a delivery
-- refused now must still be accepted when the provider retries it legitimately.
CREATE TABLE IF NOT EXISTS orb_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES agent_webhooks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_key text,
  body_hash text NOT NULL DEFAULT '',
  event_type text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'duplicate', 'rejected', 'throttled', 'failed')),
  session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orb_deliveries_key
  ON orb_deliveries(webhook_id, delivery_key) WHERE delivery_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orb_deliveries_webhook
  ON orb_deliveries(webhook_id, created_at DESC);
