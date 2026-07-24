/*
  # Encrypted workspace secrets

  workspace_secrets.secret_cipher holds the AES-256-GCM ciphertext of a
  workspace secret (encrypted with the workspace vault key); `value` is the
  legacy plaintext column and stays empty for encrypted rows. description is
  the operator-facing label shown in the secrets UI.

  Both columns previously existed only as runtime ALTERs in
  ensureRuntimeSchema (server/index.cjs), so a database provisioned via
  `npm run migrate` or `npm run db:neon:push` never got them — and the
  serverless mirror (netlify/functions/backend.mjs), which does no DDL, then
  had nowhere to put ciphertext.
*/

ALTER TABLE workspace_secrets ADD COLUMN IF NOT EXISTS secret_cipher text DEFAULT '';
ALTER TABLE workspace_secrets ADD COLUMN IF NOT EXISTS description text DEFAULT '';
