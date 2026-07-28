'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// The workspace vault: every credential a workspace holds, in three groups —
// the platform-managed keys (MANAGED_SECRET_KEYS), sandbox:<provider>:<credential>
// for a provider skill's API key, and anything else as a user-defined shared
// secret. classifyVaultKey (shared
// with the Netlify mirror) decides which namespace a key is in and therefore
// which of these routes may write it.
//
// WRITE-ONLY, AND THAT IS THE POINT. No route here returns a value, in full or
// masked. The list route neither decrypts nor selects the secret columns — it
// asks Postgres for `configured` and `legacy_plaintext` as booleans, so there is
// nothing to redact. There is no maskSecret in this file because there is
// nothing to mask.
//
// Manage role only, Fly only. These dedicated routes are the ONLY doors: the
// vault tables are absent from the backendClient allowlists, and the generic
// /vault/:key charset has no colon, so it cannot address a namespaced entry.

function mountVaultRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, notifyDbSubscribers, getDb,
  dbUnsafe, MANAGED_SECRET_KEYS, SANDBOX_VAULT_PREFIX, VAULT_KEY_RE,
  classifyVaultKey, credentialLabel, listManagedSecrets,
  listWorkspaceVaultEntries, parseSandboxCredentialKey,
  providerCredentialSlots, sandboxCredentialKey,
  setWorkspaceSecretValue, settingsWorkspaceIdFromRequest,
  workspaceAuthoredProviderSkills,
 } = deps;

 app.get('/backend/settings/secrets', requireAuth, async (req, res) => {
  try {
   const workspaceId = settingsWorkspaceIdFromRequest(req);
   // App-level (platform) secrets are not readable by users — omitting workspaceId
   // used to skip authorization entirely and return a masked preview of the
   // platform ANTHROPIC_API_KEY to any signed-in account. Mirrors the POST below.
   if (!workspaceId) {
    return jsonError(res, 403, new Error('App-level secret management is not available to users'));
   }
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const keys = await listManagedSecrets(workspaceId);
   res.json({ data: { keys }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/settings/secrets', requireAuth, async (req, res) => {
  try {
   const body = req.body || {};
   const workspaceId = settingsWorkspaceIdFromRequest(req);
   // App-level (platform) secret writes are not available to ordinary users —
   // only workspace-scoped secrets with manage capability.
   if (!workspaceId) {
    return jsonError(res, 403, new Error('App-level secret management is not available to users'));
   }
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const updates = {};
   for (const key of MANAGED_SECRET_KEYS) {
    // Only apply keys that were explicitly provided. An empty string
    // intentionally clears the stored key.
    if (typeof body[key] === 'string') updates[key] = body[key].trim();
   }
   if (Object.keys(updates).length === 0) {
    return jsonError(res, 400, new Error('No managed keys provided'));
   }
   for (const [key, value] of Object.entries(updates)) {
    await setWorkspaceSecretValue(workspaceId, key, value, req.userId);
   }
   const keys = await listManagedSecrets(workspaceId);
   res.json({ data: { keys }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- The workspace vault ----------------------------------------------------
 // ONE surface for every credential the workspace holds, including the namespaced
 // ones. Manage-role only, per workspace, and WRITE-ONLY: this route decrypts
 // nothing and its SQL does not select `value` or `secret_cipher` at all
 // (VAULT_META_SELECT in shared/backend-core.cjs asks Postgres for a boolean).
 // A masked preview used to be returned here; it is gone. A preview leaks a key's
 // prefix and length, and for a credential an operator can simply re-paste that is
 // a poor trade for a bit of UI reassurance — the same reasoning the
 // /sandbox-credentials read already applied.
 //
 // Namespaced entries are no longer EXCLUDED, they are CLASSIFIED: each entry
 // carries its group ('managed' | 'provider' | 'shared'), the thing that owns it,
 // and the write lane that may change it.
 app.get('/backend/workspaces/:id/vault', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const stored = await listWorkspaceVaultEntries(workspaceId, {
    db: dbUnsafe,
    managedKeys: MANAGED_SECRET_KEYS,
   });

   // Provider credential SLOTS — the fix for "there is no way to enter Box's key".
   // A stored row is the only thing a list of rows can show, so before any
   // `sandbox:box:api_key` existed there was nothing to render and nowhere to type.
   // The skill definitions know which credentials exist, so unset slots are listed
   // too, each with the provider it belongs to and the env var name (a NAME, never
   // a value) the same credential would come from on a machine that has one.
   const byKey = new Map(stored.map((entry) => [entry.key, entry]));
   for (const slot of providerCredentialSlots(await workspaceAuthoredProviderSkills(workspaceId))) {
    const existing = byKey.get(slot.key);
    const merged = {
     ...(existing || {
      ...classifyVaultKey(slot.key, { managedKeys: MANAGED_SECRET_KEYS }),
      description: '',
      configured: false,
      legacy_plaintext: false,
      updated_at: null,
     }),
     ownerLabel: slot.providerName,
     label: credentialLabel(slot.credential),
     skill_id: slot.skillId,
     env: slot.env,
     docs_url: slot.docsUrl,
    };
    byKey.set(slot.key, merged);
   }

   const data = [...byKey.values()].sort((a, b) => (
    a.group === b.group ? a.key.localeCompare(b.key) : a.group.localeCompare(b.group)
   ));
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.put('/backend/workspaces/:id/vault/:key', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const key = String(req.params.key || '').trim();
   if (!workspaceId || !key) return jsonError(res, 400, new Error('workspace id and key are required'));
   // The charset is the namespace guard: no colon means this route can never
   // reach a `sandbox:` entry, whatever the caller sends.
   if (!VAULT_KEY_RE.test(key)) {
    return jsonError(res, 400, new Error(key.includes(':')
     ? 'Namespaced vault entries are set by the surface that owns them.'
     : 'key must be 1-128 chars of letters, digits, _ . -'));
   }
   if (MANAGED_SECRET_KEYS.includes(key)) return jsonError(res, 400, new Error('That key is managed elsewhere'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const value = typeof req.body?.value === 'string' ? req.body.value : '';
   const description = typeof req.body?.description === 'string' ? req.body.description.slice(0, 300) : undefined;
   await setWorkspaceSecretValue(workspaceId, key, value, req.userId, description);
   notifyDbSubscribers('workspace_secrets', 'UPDATE', [{ workspace_id: workspaceId, key }]);
   res.json({ data: { key, configured: !!value }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/vault/:key', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const key = String(req.params.key || '').trim();
   if (!workspaceId || !key) return jsonError(res, 400, new Error('workspace id and key are required'));
   if (!VAULT_KEY_RE.test(key)) return jsonError(res, 400, new Error('key must be 1-128 chars of letters, digits, _ . -'));
   if (MANAGED_SECRET_KEYS.includes(key)) return jsonError(res, 400, new Error('That key is managed elsewhere'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   await getDb().unsafe('delete from workspace_secrets where workspace_id = $1 and key = $2', [workspaceId, key]);
   notifyDbSubscribers('workspace_secrets', 'DELETE', [{ workspace_id: workspaceId, key }]);
   res.json({ data: { key }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- Sandbox provider credentials ------------------------------------------
 // A Sandbox Agent's provider API keys. WRITE-ONLY: there is no route, here or
 // anywhere else, that returns one. The read below reports `configured` and
 // nothing more — not a masked preview, because a preview leaks a key's prefix
 // and length, and for a provisioning credential that is a poor trade for a bit
 // of UI reassurance. Stored in the same AES-256-GCM workspace vault as every
 // other secret, under `sandbox:<provider>:<key>`; the colons keep the entries
 // out of the generic vault PUT/DELETE routes (whose key pattern is
 // [A-Za-z0-9_.-]) and out of the vault LIST above. Fly-only, like the gateway
 // routes — nothing in the frontend bundle ever holds a provider key, and no
 // VITE_ var exists for one.
 app.get('/backend/workspaces/:id/sandbox-credentials', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const rows = await getDb().unsafe(
    `select key, value, secret_cipher, updated_at from workspace_secrets
       where workspace_id = $1 and key like '${SANDBOX_VAULT_PREFIX}%' order by key asc`,
    [workspaceId],
   );
   const data = [];
   for (const row of rows) {
    const parsed = parseSandboxCredentialKey(row.key);
    if (!parsed) continue;
    data.push({
     provider: parsed.provider,
     credential: parsed.key,
     key: row.key,
     configured: Boolean(row.secret_cipher || row.value),
     updated_at: row.updated_at,
    });
   }
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.put('/backend/workspaces/:id/sandbox-credentials/:provider', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   // The credential name defaults to api_key; both halves are validated by
   // sandboxCredentialKey, which returns '' rather than building a key it is not
   // sure about — so a provider name carrying a colon can never forge a
   // different vault entry (for example ANTHROPIC_API_KEY).
   const key = sandboxCredentialKey(req.params.provider, req.body?.credential || 'api_key');
   if (!key) return jsonError(res, 400, new Error('provider must be lowercase letters, digits, - or _, and credential must be lowercase letters, digits or _'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const value = typeof req.body?.value === 'string' ? req.body.value.trim() : '';
   if (!value) return jsonError(res, 400, new Error('value is required — use DELETE to clear a credential'));
   await setWorkspaceSecretValue(workspaceId, key, value, req.userId, `Sandbox provider credential (${key})`);
   // Broadcast the KEY only. sanitizeRealtimeRow does not know about this table's
   // value column, and a fanout carrying the secret would put it in every
   // subscribed browser — which is the one thing this whole route exists to stop.
   notifyDbSubscribers('workspace_secrets', 'UPDATE', [{ workspace_id: workspaceId, key }]);
   res.json({ data: { key, configured: true }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/sandbox-credentials/:provider', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   const key = sandboxCredentialKey(req.params.provider, req.query?.credential || 'api_key');
   if (!key) return jsonError(res, 400, new Error('provider and credential must be lowercase letters, digits, - or _'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   await getDb().unsafe('delete from workspace_secrets where workspace_id = $1 and key = $2', [workspaceId, key]);
   notifyDbSubscribers('workspace_secrets', 'DELETE', [{ workspace_id: workspaceId, key }]);
   res.json({ data: { key, configured: false }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountVaultRoutes };
