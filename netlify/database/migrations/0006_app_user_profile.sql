ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name text DEFAULT '';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS accent_color text DEFAULT '';
