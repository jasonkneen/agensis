/*
  # Task start date and dependencies

  Adds the two columns the Tasks screen's Gantt + dependency features need:
    - `start_date` — Gantt bar start; the UI falls back to `created_at` when null.
    - `depends_on` — array of task ids this task depends on. An array column
      (rather than a join table) matches the existing lightweight tasks style
      and rides the same generic /backend/db access rules.
*/

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depends_on uuid[] DEFAULT '{}';
