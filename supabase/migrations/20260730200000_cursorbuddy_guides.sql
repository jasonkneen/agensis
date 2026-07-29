CREATE TABLE IF NOT EXISTS cursorbuddy_guides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  site_url text NOT NULL,
  host text NOT NULL,
  path_pattern text NOT NULL DEFAULT '/*',
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'pending', 'approved', 'rejected')),
  review_notes text NOT NULL DEFAULT '',
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cursorbuddy_guides_owner
  ON cursorbuddy_guides(owner_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cursorbuddy_guides_public_match
  ON cursorbuddy_guides(host, review_status, published_at DESC);
