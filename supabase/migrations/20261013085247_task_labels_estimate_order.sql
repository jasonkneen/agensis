-- Project-management task fields (see docs/mockups/project-management).
-- Project-management fields (gr8r merge): labels, a t-shirt style estimate, and a
-- manual ordering key for board columns. All additive and nullable-or-defaulted.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimate text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sort_order double precision NOT NULL DEFAULT 0;
