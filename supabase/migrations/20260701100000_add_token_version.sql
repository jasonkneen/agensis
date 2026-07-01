-- Plan 005: token expiry and revocation. A per-user counter embedded in every
-- issued session token; bumping it (sign-out, password change) invalidates
-- every outstanding token for that user in one shot. See server/index.cjs's
-- issueToken/verifyToken and the `/backend/auth/signout` route.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;
