const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const cors = require('cors');
const postgres = require('postgres');
const { createMcpHandler, createBuiltinToolset } = require('./mcp.cjs');
const { createInferenceBroker } = require('./inference-broker.cjs');
const { createFarmIntegrationCore } = require('./farm-integration.cjs');
const {
 createFlowConnectionCore,
 flowWebhookRetryDecision,
 normalizeFlowWebhookUrl,
 signFlowWebhook,
 // The event vocabulary. One list, two consumers: outbound webhook connections
 // ("who wants to know") and automations ("what should happen").
 FLOW_EVENTS,
} = require('./flow-integration.cjs');
const { createAutomations, mountAutomationRoutes } = require('./automations.cjs');
const { createAgentTemplates, mountAgentTemplateRoutes } = require('./agent-templates-routes.cjs');
const { normalizeAgentTemplate, agentToTemplateDraft } = require('../shared/agentTemplates.cjs');
// Reactions are written through the generic /backend/db/update route as a whole
// jsonb map, so their flow events come from diffing that map — see the module
// header. Shared with netlify/functions/backend.mjs; the two lanes differ only
// in the `encodeJsonb` bind (porsager wants the object, @netlify/database the
// string).
const { emitReactionFlowEventsForUpdate } = require('../shared/reaction-events.cjs');
const { renderSkillMd, skillManifest, configBlock, claudeMcpAddCommand, mcpEndpoint } = require('./skills.cjs');
const {
 agentNextSteps,
 joinDescriptor,
 previewDescriptor,
 invalidDescriptor,
 machinePayload,
 renderJoinHtml,
 joinUrlFor,
} = require('./join-page.cjs');
const {
 PROVIDER_CALL_REDIRECT_NOTE,
 SANDBOX_VAULT_PREFIX,
 applyProviderCredential,
 bundledCredentialEnvVar,
 describeProviderCall,
 envConfiguredCredentialKeys,
 fenceProviderOutput,
 parseSandboxCredentialKey,
 providerCredentialSlots,
 planProviderCall,
 redactSandboxSecrets,
 renderSandboxSkillPrompt,
 sanitizeSandboxMeta,
 sandboxCredentialKey,
 sandboxCredentialKeysForSkills,
 sandboxSkillsForAgent,
 unknownProviderCallArgs,
} = require('./sandbox-skills.cjs');
const {
 SKILL_CONTENT_MAX_BYTES,
 fenceSkillContent,
 findReadableLibrary,
 listLibraryEntries,
 listWorkspaceSkills,
 loadSkillContent,
 normalizeSkillDocuments,
 readLibraryEntry,
 unavailable: skillContentUnavailable,
} = require('./skill-content.cjs');
const { mountHuddleRoutes, ensureHuddlesSchema } = require('./huddles.cjs');
const {
 createAgentPermissions,
 ensureAgentPermissionsSchema,
 mountAgentPermissionRoutes,
} = require('./agent-permissions.cjs');
const { channelIntentNote } = require('../shared/channelIntent.cjs');
const {
 THREAD_INBOX_DEFAULT_LIMIT,
 buildThreadInboxSql,
 toThreadInboxItem,
} = require('./thread-inbox.cjs');
const {
 LINK_PREVIEW_MAX_DESCRIPTION_CHARS,
 LINK_PREVIEW_MAX_PER_REQUEST,
 LINK_PREVIEW_MAX_SITE_CHARS,
 LINK_PREVIEW_MAX_TITLE_CHARS,
 LINK_PREVIEW_MAX_URL_CHARS,
 LINK_PREVIEW_STATUSES,
 clampPreviewText,
 fetchLinkPreview,
 fetchPreviewImage,
 linkPreviewCacheKey,
 linkPreviewTtlMs,
 normalizeUnfurlUrl,
} = require('./link-preview.cjs');
const { mountVoiceRoutes, createVoiceRelay } = require('./voice.cjs');
const { isBlockedAddress, assertSafeOutboundUrl } = require('./lib/net-guard.cjs');
const { createGatewayResolver } = require('./lib/gateways.cjs');
const { createRealtime } = require('./realtime.cjs');
const { createAgentConnections } = require('./agent-connections.cjs');
const { createTaskDispatch } = require('./task-dispatch.cjs');
const { createAgentJobs } = require('./agent-jobs.cjs');
const { createBuiltinTurn } = require('./builtin-turn.cjs');
const {
 createThreadHarvest, isDiscardTransition, mountThreadHarvestRoutes,
 SUGGEST_SWEEP_INTERVAL_MS,
} = require('./thread-harvest.cjs');

const TASK_MENTION_CLAIM_MS = 5_000;
const { mountFeedbackRoutes } = require('./feedback-routes.cjs');
const { mountAiChatRoutes } = require('./ai-chat-routes.cjs');
const { installBrowserProxy } = require('./browser-proxy.cjs');
const { mountVaultRoutes } = require('./vault-routes.cjs');
const { mountAuditRoutes } = require('./audit-routes.cjs');
const { mountTenantsRoutes } = require('./tenants-routes.cjs');
const { mountSchedulesRoutes } = require('./schedules-routes.cjs');
const { mountCursorbuddyRoutes } = require('./cursorbuddy-routes.cjs');
const { mountInferenceRoutes } = require('./inference-routes.cjs');
const { mountFarmRoutes } = require('./farm-routes.cjs');
const { mountFilesRoutes } = require('./files-routes.cjs');
const { mountProjectGitRoutes } = require('./project-git-routes.cjs');
const { mountAuthRoutes } = require('./auth-routes.cjs');
const { mountMembersInvitesRoutes } = require('./members-invites-routes.cjs');
const { mountJoinLinksRoutes } = require('./join-links-routes.cjs');
const { mountFlowRoutes } = require('./flow-routes.cjs');
const { mountSystemRoutes } = require('./system-routes.cjs');
const { mountWorkspacesRoutes } = require('./workspaces-routes.cjs');
const { mountWorkspaceMcpRoutes } = require('./workspace-mcp-routes.cjs');
const { mountInboxRoutes } = require('./inbox-routes.cjs');
const { mountSessionAccessRoutes } = require('./session-access-routes.cjs');
const { runDmScopeBackfill } = require('./dm-scope-backfill.cjs');
const { mountLinkPreviewsRoutes } = require('./link-previews-routes.cjs');
const { mountAgentsRoutes } = require('./agents-routes.cjs');
const { mountJoinPagesRoutes } = require('./join-pages-routes.cjs');
const { mountTtsRoutes } = require('./tts-routes.cjs');
const { mountMcpDoorsRoutes } = require('./mcp-doors-routes.cjs');
const { mountConnectionsRoutes } = require('./connections-routes.cjs');
const { mountSessionsRoutes } = require('./sessions-routes.cjs');
const { mountAgentWebhooksRoutes } = require('./agent-webhooks-routes.cjs');
const { createChannelBridges } = require('./channel-bridges.cjs');
const {
 telegramAdapter, telegramSetWebhook, slackAdapter, mountBridgeRoutes,
} = require('./bridge-routes.cjs');
const { mountBridgeAdminRoutes } = require('./bridge-admin-routes.cjs');
const { mountPetsRoutes } = require('./pets-routes.cjs');
const { mountHealthRoutes } = require('./health-routes.cjs');
const {
 detectSkillLibraries,
 mergeSlashCommands,
 createTtlPromiseCache,
 detectCapabilities,
} = require('./lib/capabilities.cjs');
const {
 projectFsAllowed,
 isWithinAllowedProjectRoot,
 workspaceProjectRoot,
 validFileSourceRoot,
 listProjectFiles,
} = require('./lib/project-fs.cjs');
const {
 quoteIdent,
 ensureTable,
 normalizeColumns,
 bindDbParam,
 buildWhereClause,
 appendWorkspaceAccessClause,
 buildOrderClause,
 mapDbError,
} = require('./lib/db-sql.cjs');
const {
 CODEX_PETS_ROOT,
 isPathInside,
 contentTypeForImageAsset,
 mergeLocalCodexPets,
} = require('./lib/codex-pets.cjs');
const {
 safeFileName,
 storagePathFor,
 resolveStoragePath,
 resolveStoragePathForWorkspace,
 getUploadExtension,
 lookupUploadContentType,
 FORCE_ATTACHMENT_EXTENSIONS,
 FORCE_ATTACHMENT_CONTENT_TYPES,
} = require('./lib/storage-paths.cjs');
const {
 // ALLOWED_TABLES / JSON_COLUMNS_BY_TABLE / arrayColumnElemType /
 // toPgArrayLiteral moved with the SQL builders — see server/lib/db-sql.cjs,
 // which imports them from this same shared core.
 VERSIONED_TABLES,
 WORKSPACE_SCOPED_TABLES: SHARED_WORKSPACE_SCOPED_TABLES,
 WORKSPACE_ROLE_CAPABILITIES: SHARED_WORKSPACE_ROLE_CAPABILITIES,
 DB_TABLE_ACCESS: SHARED_DB_TABLE_ACCESS,
 stripPrivilegedDbValues,
 safeSelectColumns,
 storagePathBelongsToWorkspace,
 issueAuthToken,
 verifyAuthToken,
 getTokenTtlSec,
 DEFAULT_TOKEN_TTL_SEC,
 createRateLimiter,
 createDbRateLimiter,
 evaluatePasswordServerSide,
 enforceDbOperationAccess: sharedEnforceDbOperationAccess,
 normalizeFeedbackSubmission,
 insertFeedbackReport,
 assertWorkspaceRole: sharedAssertWorkspaceRole,
 enforceSessionReadAccess: sharedEnforceSessionReadAccess,
 sessionReadableSql,
 addSessionParticipant,
 isPrivateSessionRow,
 appendSessionAccessClause,
 userCanAccessWorkspace: sharedUserCanAccessWorkspace,
 // The vault surface — one classification, shared with the Netlify mirror.
 VAULT_KEY_RE,
 VAULT_SECRET_COLUMNS,
 classifyVaultKey,
 credentialLabel,
 listWorkspaceVaultEntries,
 listWorkspaceSecretMeta,
 encryptVaultSecret: coreEncryptVaultSecret,
 decryptVaultSecret: coreDecryptVaultSecret,
 getWorkspaceSecretValue: coreGetWorkspaceSecretValue,
 setWorkspaceSecretValue: coreSetWorkspaceSecretValue,
 auditEmailDomain,
 recordAuditEntry,
} = require('../shared/backend-core.cjs');
const { normalizeTaskTitle } = require('../shared/taskTitle.cjs');
const { WORKSPACE_MAX_DEPTH } = require('../shared/workspace-tree.cjs');
const {
 applyIdentityDeclaration,
 markHumanIdentityWrite,
 identityWriteSql,
 synthesizeHumanIdentityInsert,
 repairStoredIdentity,
 FIELD_LIMITS: IDENTITY_FIELD_LIMITS,
 normalizeIdentityDeclaration,
 normalizeVoicePreference,
 resolveAgentVoice,
 isCartesiaVoiceId,
 CARTESIA_MODEL_ID,
} = require('../shared/agentIdentity.cjs');
const {
 assertSystemOwner,
 isReservedSignupEmail,
 listTenantAccounts,
 getTenantAccount,
} = require('../shared/tenant-admin.cjs');
// Cost metering. Every helper here is FAIL-OPEN by contract — see
// shared/usage-metering.cjs. Call sites deliberately do not try/catch them: a
// metering write must never be able to fail a turn somebody is paying for.
const {
 recordAnthropicUsage,
 createAnthropicUsageAccumulator,
} = require('../shared/usage-metering.cjs');
const {
 CAMPAIGN_CATEGORIES,
 normalizeSegment,
 normalizeCampaignInput,
 assertSendable,
 selectSegmentMatches,
 describeSegment,
 loadTenantFacts,
 buildSegmentPreview,
 createCampaign,
 listCampaigns,
 listUserCampaignMessages,
 dismissCampaignMessage,
} = require('../shared/tenant-campaigns.cjs');
const {
 CHANNEL_MENTION_HANDLE,
 CHANNEL_MENTION_MAX_AGENTS,
 agentMentionHandles,
 allowsUnpromptedReply,
 expandChannelMention,
 isReservedAgentHandle,
 mentionsChannel,
 parseMentionHandles,
 reservedAgentHandleMessage,
 slugMentionHandle,
} = require('../shared/channelMentions.cjs');
const { replyCadencePlan } = require('../shared/replyCadence.cjs');

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = Number(process.env.API_PORT || 3142);
const DEFAULT_AI_MODEL = process.env.AGENSIS_DEFAULT_AI_MODEL || 'claude-opus-4-8';
const OPENPETS_CATALOG_URL = 'https://openpets.dev/pets/catalog.v3/page-000.json';

let envLoaded = false;
let db;
const inferenceBroker = createInferenceBroker({
 sendToAgent(agentId, message, connectionId) {
  const exact = connectionId ? connectedAgents.get(connectionId) : null;
  const entry = exact && String(exact.agentId) === String(agentId) && exact.ws?.readyState === 1
   ? exact
   : [...connectedAgents.values()].find(
    (candidate) => !connectionId && String(candidate.agentId) === String(agentId) && candidate.ws?.readyState === 1,
   );
  if (!entry) return false;
  return sendWs(entry.ws, message);
 },
});


function applyEnvFile(envPath) {
 if (!fs.existsSync(envPath)) return false;
 const raw = fs.readFileSync(envPath, 'utf8');
 for (const line of raw.split(/\r?\n/)) {
  if (!line || line.trim().startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  if (key && process.env[key] == null) {
   process.env[key] = value;
  }
 }
 return true;
}

function loadEnvFile() {
 if (envLoaded) return;

 // A test process supplies its own environment (tests/helpers/test-env.cjs) and
 // must never inherit a developer's `.env`. This is not a convenience: reading
 // `.env` here silently rewrote what the suite was testing — a test that deletes
 // BOX_API_KEY to exercise the "credential not configured" refusal got the real
 // key handed back and took the configured path instead. It also repopulated
 // DATABASE_URL, so a code path reaching getDb() without a test db would have
 // opened a live production connection. Unset, getDb() throws instead.
 if (process.env.AGENSIS_TEST === '1') {
  envLoaded = true;
  return;
 }

 envLoaded = true;

 const candidates = [
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '..', '.env'),
 ];

 for (const envPath of candidates) {
  if (applyEnvFile(envPath)) return;
 }

 return;
}

// Secret keys that the settings dialog is allowed to read/write. Anything not
// in this list is rejected so the endpoint can't write arbitrary settings.
const MANAGED_SECRET_KEYS = ['ANTHROPIC_API_KEY'];

// Global settings are persisted in app_settings. Workspace-managed secrets live
// in workspace_secrets so member roles can gate reads/writes per workspace.
async function getSettingValue(key) {
 const rows = await getDb().unsafe('select value from app_settings where key = $1 limit 1', [key]);
 return rows[0]?.value || '';
}

async function setSettingValue(key, value) {
 await getDb().unsafe(
  `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
  [key, value],
 );
}

// Resolve a managed secret: DB value first, then env var as a fallback (so an
// ANTHROPIC_API_KEY set via the host environment still works out of the box).
async function resolveSecret(key, workspaceId = null) {
 loadEnvFile();
 const workspaceValue = await getWorkspaceSecretValue(workspaceId, key).catch(() => '');
 if (workspaceValue) return workspaceValue;
 const dbValue = await getSettingValue(key).catch(() => '');
 return dbValue || process.env[key] || '';
}

// Managed-key STATE, never any part of a value.
//
// This used to return `preview: maskSecret(value)`, and when the workspace had no
// key of its own that preview was of the PLATFORM key — so every workspace
// owner was shown the first four and last four characters of the app-level
// ANTHROPIC_API_KEY. `scope` already says which key is in play; the preview only
// leaked. Same rule as every other vault entry now: configured, when, nothing else.
async function listManagedSecrets(workspaceId = null) {
 const meta = new Map();
 if (workspaceId) {
  const rows = await listWorkspaceSecretMeta(workspaceId, { db: dbUnsafe }).catch(() => []);
  for (const row of rows) meta.set(row.key, row);
 }
 return Promise.all(MANAGED_SECRET_KEYS.map(async (key) => {
  const workspaceValue = await getWorkspaceSecretValue(workspaceId, key).catch(() => '');
  const fallbackValue = workspaceValue ? '' : await resolveSecret(key, null);
  const value = workspaceValue || fallbackValue;
  return {
   key,
   configured: !!value,
   scope: workspaceValue ? 'workspace' : fallbackValue ? 'app' : 'unset',
   updated_at: meta.get(key)?.updated_at || null,
  };
 }));
}

// ============================================================
// AUTH: signed session tokens + workspace access control
// ============================================================

let cachedAuthSecret = null;
// eslint-disable-next-line no-unused-vars -- write-only debug instrumentation for getAuthSecret()
let cachedAuthSecretSource = '';

// HMAC signing secret. In the split deploy (static frontend on Netlify + this
// long-running backend on Fly), Netlify signs user tokens with process.env.AUTH_SECRET
// and proxies dispatch here carrying the same Bearer token. To verify those tokens we
// MUST use the same secret, so an explicit env var wins. Only when no env secret is
// configured (local / single-process dev) do we fall back to one persisted in the DB,
// generating it on first use. Without this, the Netlify-issued token fails verifyToken
// here (401) and every DM / @mention dispatch is silently dropped — the daemon stays
// "connected" (its aga_ token is a separate DB-hash auth) but never receives a job.
async function getAuthSecret() {
 if (cachedAuthSecret) return cachedAuthSecret;
 const envSecret = process.env.AGENSIS_AUTH_SECRET || process.env.AUTH_SECRET || '';
 if (envSecret) {
  cachedAuthSecret = envSecret;
  cachedAuthSecretSource = 'env';
  return cachedAuthSecret;
 }
 let secret = await getSettingValue('AUTH_SECRET').catch(() => '');
 if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  await setSettingValue('AUTH_SECRET', secret);
 }
 cachedAuthSecret = secret;
 cachedAuthSecretSource = 'db';
 return cachedAuthSecret;
}

// Token revocation: `token_version` is a per-user counter stored on app_users.
// A token embeds the version that was current when it was issued; verifyToken
// rejects any token whose embedded version no longer matches the user's CURRENT
// version. Bumping the version (on sign-out or password change) invalidates
// every outstanding token for that user in one shot.
//
// verifyToken is a hot path (called on every authenticated HTTP request and
// every WebSocket auth frame) and used to be pure in-process HMAC verification
// with zero I/O. A per-request DB lookup for token_version would turn every
// authenticated request into a DB round trip, so lookups are served from a
// short-TTL in-process cache instead — this bounds revocation to "takes effect
// within TOKEN_VERSION_CACHE_TTL_MS", not instant, in exchange for bounded DB
// load. No eviction beyond TTL expiry (an unbounded Map at very large scale);
// fine for this app's expected size, revisit if that ever changes.
const tokenVersionCache = new Map(); // userId -> { version, expiresAt }
const TOKEN_VERSION_CACHE_TTL_MS = 10_000; // 10s: bounds staleness of revocation, bounds DB load

async function getCachedTokenVersion(userId) {
 const now = Date.now();
 const cached = tokenVersionCache.get(userId);
 if (cached && cached.expiresAt > now) return cached.version;
 const rows = await getDb().unsafe('select token_version from app_users where id = $1 limit 1', [userId]);
 const version = rows[0] ? String(rows[0].token_version) : null;
 tokenVersionCache.set(userId, { version, expiresAt: now + TOKEN_VERSION_CACHE_TTL_MS });
 return version;
}

// Called immediately after THIS process bumps a user's token_version (sign-out,
// password change) so revocation is instant on the instance that just did the
// write, instead of waiting out the stale cache entry's remaining TTL. Other
// instances in a multi-instance deploy still only pick up the change within
// TOKEN_VERSION_CACHE_TTL_MS — see the maintenance notes on the plan for that
// accepted trade-off.
function setCachedTokenVersion(userId, version) {
 tokenVersionCache.set(userId, { version: String(version), expiresAt: Date.now() + TOKEN_VERSION_CACHE_TTL_MS });
}

async function issueToken(userId, tokenVersion, options = {}) {
 const secret = await getAuthSecret();
 return issueAuthToken(userId, tokenVersion, secret, options);
}

async function verifyToken(token, options = {}) {
 if (!token || typeof token !== 'string') return null;
 const secret = await getAuthSecret();
 // Reuse shared verifier (TTL + signature + token_version). Auth header form
 // accepts a raw token as well as "Bearer …".
 return verifyAuthToken(token, secret, getCachedTokenVersion, options);
}

// Verify a Netlify outgoing-webhook signature. When a JWS secret is configured on
// the Netlify deploy notification, Netlify sends an `X-Webhook-Signature` header: a
// compact JWS (`base64url(header).base64url(payload).base64url(signature)`) signed
// HS256 with that secret, whose payload carries `sha256` = hex SHA-256 of the exact
// request body. We (a) verify the HS256 signature proves it came from Netlify and
// (b) confirm the body hash matches so the payload wasn't swapped in transit.
// Returns true only if both hold. Pure in-process crypto — no I/O, so the hook acks fast.
function verifyNetlifyDeploySignature(signatureHeader, rawBody, secret) {
 if (!secret || typeof signatureHeader !== 'string') return false;
 const parts = signatureHeader.split('.');
 if (parts.length !== 3) return false;
 const [encodedHeader, encodedPayload, encodedSig] = parts;
 const signingInput = `${encodedHeader}.${encodedPayload}`;
 const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
 const a = Buffer.from(encodedSig);
 const b = Buffer.from(expectedSig);
 if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
 // Signature is authentic; now bind it to this exact body.
 let claimedHash;
 try {
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  claimedHash = typeof payload?.sha256 === 'string' ? payload.sha256.toLowerCase() : '';
 } catch {
  return false;
 }
 if (!claimedHash) return false;
 const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
 const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
 const x = Buffer.from(claimedHash);
 const y = Buffer.from(bodyHash);
 return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Express middleware: require a valid Bearer token, set req.userId.
async function requireAuth(req, res, next) {
 try {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = await verifyToken(token);
  if (!userId) return jsonError(res, 401, new Error('Authentication required'));
  req.userId = userId;
  next();
  // eslint-disable-next-line no-unused-vars -- error intentionally not surfaced to the client response
 } catch (error) {
  jsonError(res, 401, new Error('Authentication failed'));
 }
}

function bearerToken(req) {
 const header = String(req.headers?.authorization || '');
 return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function requireUserOrFarm(requiredScope) {
 return async (req, res, next) => {
  try {
   const token = bearerToken(req);
   if (token.startsWith('agf_')) {
    req.farmIntegration = await getFarmIntegrationCore().authenticate(token, requiredScope);
    return next();
   }
   const userId = await verifyToken(token);
   if (!userId) return jsonError(res, 401, new Error('Authentication required'));
   req.userId = userId;
   return next();
  } catch (error) {
   return jsonError(res, error.status || 401, error);
  }
 };
}

async function authorizeUserOrFarmWorkspace(req, workspaceId, userCapability) {
 if (req.farmIntegration) {
  if (String(req.farmIntegration.workspaceId) !== String(workspaceId)) throw forbidden('Integration token does not match this workspace');
  return;
 }
 await enforceWorkspaceRole(req.userId, workspaceId, userCapability);
}

// True if the user owns the workspace, is a member of it, or holds either in an
// ANCESTOR. Single-sourced from shared/backend-core.cjs so Fly and Netlify apply
// the same inheritance rule — members flow DOWN the workspace tree, never up.
async function userCanAccessWorkspace(userId, workspaceId) {
 return sharedUserCanAccessWorkspace(userId, workspaceId, sharedDbAdapter);
}

// Tables whose rows are scoped to a workspace and therefore subject to
// membership checks. Single-sourced from shared/backend-core.cjs so Netlify
// and Fly cannot drift (parity test also locks the set).
const WORKSPACE_SCOPED_TABLES = SHARED_WORKSPACE_SCOPED_TABLES;

// Single-sourced from shared/backend-core.cjs (Wave 2 security dedup).
const WORKSPACE_ROLE_CAPABILITIES = SHARED_WORKSPACE_ROLE_CAPABILITIES;
const DB_TABLE_ACCESS = SHARED_DB_TABLE_ACCESS;

function findFilterValue(filters, column) {
 if (!Array.isArray(filters)) return undefined;
 const f = filters.find((x) => x && x.column === column && x.operator === 'eq');
 return f ? f.value : undefined;
}

// Resolve the workspace id a db operation targets, looking through parent rows
// when the table/filter doesn't carry workspace_id directly. Returns
// { workspaceId } when determinable, or { unscoped: true } when access can't be
// constrained to a single workspace (caller decides how strict to be).
async function resolveOperationWorkspace(table, { values, filters }) {
 // Insert: workspace id (or a parent that has one) comes from the row values.
 if (values) {
  if (values.workspace_id) return { workspaceId: values.workspace_id };
  if (table === 'messages' && values.session_id) {
   const rows = await getDb().unsafe('select workspace_id from chat_sessions where id = $1 limit 1', [values.session_id]);
   if (rows[0]) return { workspaceId: rows[0].workspace_id };
  }
  return { unscoped: true };
 }
 // Select/update/delete: derive from filters.
 const directWs = findFilterValue(filters, 'workspace_id');
 if (directWs) return { workspaceId: directWs };

 const parentLookups = [
  { col: 'document_id', sql: 'select workspace_id from documents where id = $1 limit 1' },
  { col: 'task_id', sql: 'select workspace_id from tasks where id = $1 limit 1' },
  { col: 'session_id', sql: 'select workspace_id from chat_sessions where id = $1 limit 1' },
  { col: 'group_id', sql: 'select workspace_id from canvas_groups where id = $1 limit 1' },
 ];
 for (const lookup of parentLookups) {
  const v = findFilterValue(filters, lookup.col);
  if (v) {
   const rows = await getDb().unsafe(lookup.sql, [v]);
   if (rows[0]) return { workspaceId: rows[0].workspace_id };
  }
 }
 // Row id filter on a workspace-scoped table → look up that row's workspace.
 const idVal = findFilterValue(filters, 'id');
 if (idVal && WORKSPACE_SCOPED_TABLES.has(table)) {
  const rows = await getDb().unsafe(`select workspace_id from ${quoteIdent(table)} where id = $1 limit 1`, [idVal]);
  if (rows[0]) return { workspaceId: rows[0].workspace_id };
 }
 return { unscoped: true };
}

// Enforce workspace membership for a db operation. Throws { status, message }
// on denial. Unscoped operations on scoped tables are rejected so a caller
// can't read/modify across all workspaces by omitting the filter.
// eslint-disable-next-line no-unused-vars -- superseded by enforceDbOperationAccess; kept pending confirmation it is fully dead
async function enforceWorkspaceAccess(userId, table, payload) {
 if (!WORKSPACE_SCOPED_TABLES.has(table) && table !== 'messages') return;
 const resolved = await resolveOperationWorkspace(table, payload);
 if (resolved.unscoped) {
  const err = new Error('A workspace filter is required for this operation');
  err.status = 400;
  throw err;
 }
 const ok = await userCanAccessWorkspace(userId, resolved.workspaceId);
 if (!ok) {
  const err = new Error('You do not have access to this workspace');
  err.status = 403;
  throw err;
 }
}

async function getWorkspaceRole(userId, workspaceId) {
 if (!userId || !workspaceId) return null;
 const ownerRows = await getDb().unsafe('select 1 from workspaces where id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
 if (ownerRows.length > 0) return 'owner';
 const memberRows = await getDb().unsafe('select role from workspace_members where workspace_id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
 return memberRows[0]?.role || null;
}

function roleHasWorkspaceCapability(role, capability) {
 return Boolean(WORKSPACE_ROLE_CAPABILITIES[role]?.has(capability));
}

function canMutateWorkspace(role) {
 return roleHasWorkspaceCapability(role, 'write');
}

function canManageWorkspace(role) {
 return roleHasWorkspaceCapability(role, 'manage');
}

function capabilityForDbOperation(table, action) {
 const access = DB_TABLE_ACCESS[table];
 return access?.[action] || (action === 'select' ? 'read' : 'write');
}

function forbidden(message) {
 const err = new Error(message);
 err.status = 403;
 return err;
}

function badRequest(message) {
 const err = new Error(message);
 err.status = 400;
 return err;
}

// Single-sourced from shared/backend-core.cjs (same error messages, same
// capability model) so the nested-workspace inheritance rule cannot be right on
// one backend and wrong on the other. A role held in an ANCESTOR grants the
// capability here; a role held in a CHILD grants nothing upward.
async function enforceWorkspaceRole(userId, workspaceId, mode) {
 return sharedAssertWorkspaceRole({ userId, workspaceId, capability: mode, db: sharedDbAdapter });
}

/**
 * 'private' when any of these about-to-be-inserted chat_sessions rows descends
 * from a private one; null when none does (leave the column's default alone).
 *
 * Two edges reach a parent at insert time: `parent_message_id` (a sub-thread
 * session hangs off a MESSAGE, so the parent session is one join away) and
 * `split_parent_id` (a fork points straight at another session). The huddle
 * edge is not here because a transcript session is created server-side and
 * copies its host's visibility in the same statement.
 *
 * Batch-wide rather than per-row on purpose: these inserts are single-row in
 * practice, and one private parent in a batch making the whole batch private is
 * the fail-closed direction.
 */
async function resolveInheritedSessionVisibility(rows) {
 const messageIds = [];
 const sessionIds = [];
 for (const row of rows) {
  if (!row || typeof row !== 'object') continue;
  if (row.parent_message_id) messageIds.push(String(row.parent_message_id));
  if (row.split_parent_id) sessionIds.push(String(row.split_parent_id));
 }
 if (messageIds.length === 0 && sessionIds.length === 0) return null;
 try {
  const params = [];
  const bind = (value) => { params.push(value); return `$${params.length}::uuid`; };
  const bySession = sessionIds.length > 0
   ? `s.id in (${sessionIds.map(bind).join(', ')})`
   : 'false';
  const byMessage = messageIds.length > 0
   ? `s.id in (select m.session_id from messages m where m.id in (${messageIds.map(bind).join(', ')}))`
   : 'false';
  const found = await getDb().unsafe(
   `select 1
      from chat_sessions s
     where (${bySession} or ${byMessage})
       and (coalesce(s.visibility, 'workspace') = 'private' or coalesce(s.folder, '') = 'Direct messages')
     limit 1`,
   params,
  );
  return found.length > 0 ? 'private' : null;
 } catch (error) {
  // Fail CLOSED. If we cannot tell whether the parent is private, the safe
  // answer is the restrictive one — an over-private sub-thread is a grant away
  // from fixed, an under-private one is a disclosure.
  console.warn('[backend] inherited session visibility lookup failed:', error?.message || error);
  return 'private';
 }
}

/**
 * Copy a newly created derived session's member list down from its parent.
 *
 * Best-effort and never throws: the creator has already been added as a member
 * by the caller, so a failure here costs other people their access to the new
 * offshoot — annoying and fixable with a grant — rather than locking everyone
 * out of it.
 */
async function copyInheritedSessionMembers(row) {
 const parentSessionId = row?.split_parent_id ? String(row.split_parent_id) : '';
 const parentMessageId = row?.parent_message_id ? String(row.parent_message_id) : '';
 if (!parentSessionId && !parentMessageId) return;
 try {
  await getDb().unsafe(
   `insert into chat_session_members (session_id, user_id, source, granted_by, expires_at)
      select $1::uuid, m.user_id, m.source, m.granted_by, m.expires_at
        from chat_session_members m
       where m.session_id = coalesce(
               $2::uuid,
               (select msg.session_id from messages msg where msg.id = $3::uuid)
             )
    on conflict (session_id, user_id) do nothing`,
   [String(row.id), parentSessionId || null, parentMessageId || null],
  );
 } catch (error) {
  console.warn('[backend] inherited session member copy failed:', error?.message || error);
 }
}

// The read gate BELOW the workspace: a private session (a DM, or a sub-thread /
// huddle transcript derived from one) is readable only by its members. Always
// called AFTER enforceWorkspaceRole, never instead of it — it narrows, it does
// not grant. Same wrapper shape as enforceWorkspaceRole so route modules keep
// taking one injected function and cannot reimplement the rule.
async function enforceSessionRead(userId, sessionId, sessionRow = null) {
 return sharedEnforceSessionReadAccess({ userId, sessionId, sessionRow, db: sharedDbAdapter });
}

/**
 * The user ids that may currently read a private session, as a Set of strings.
 *
 * Only the realtime fanout needs this shape: it holds a list of sockets and has
 * to decide, without a query per socket, which of them may receive the row.
 * Expiry is applied in SQL so an elapsed grant drops off without a sweeper.
 */
async function sessionMemberUserIds(sessionId) {
 if (!sessionId) return new Set();
 const rows = await sharedDbAdapter(
  `select user_id from chat_session_members
    where session_id = $1 and (expires_at is null or expires_at > now())`,
  [String(sessionId)],
 );
 return new Set(rows.map((row) => String(row.user_id)));
}

// Adapter so shared enforceDbOperationAccess can use postgres.js (getDb().unsafe).
function sharedDbAdapter(sql, params = []) {
 return getDb().unsafe(sql, params);
}

// Thin wrapper preserving the server call signature used throughout index.cjs
// and tests (__test.enforceDbOperationAccess(userId, table, action, payload)).
async function enforceDbOperationAccess(userId, table, action, payload = {}) {
 return sharedEnforceDbOperationAccess({
  userId,
  table,
  op: action,
  filters: payload.filters,
  payload: { values: payload.values, filters: payload.filters },
  db: sharedDbAdapter,
 });
}

function getDatabaseUrl() {
 loadEnvFile();
 return process.env.DATABASE_URL;
}

function getAnthropicApiKey(workspaceId = null) {
 // DB-stored key first (set via Settings → Secret keys), env var as fallback.
 return resolveSecret('ANTHROPIC_API_KEY', workspaceId);
}

/**
 * Encryption-at-rest backfill for the workspace vault.
 *
 * The write path has encrypted for a while (setWorkspaceSecretValue stores
 * AES-256-GCM ciphertext in `secret_cipher` and writes `value = ''`), but rows
 * created BEFORE that landed still hold plaintext in `value`, and the read path
 * still falls back to it. Nothing re-encrypted them: a legacy row was only fixed
 * if someone happened to re-enter that secret. This closes the gap on boot.
 *
 * A SQL migration cannot do this — the encryption key is derived in the app from
 * SECRETS_ENCRYPTION_KEY/AUTH_SECRET, which Postgres has no access to. So it is
 * runtime work, idempotent (the WHERE clause matches only unencrypted rows, and
 * each row it fixes stops matching), and silent about content: the count is
 * logged, never a key's value, and the plaintext is overwritten with '' in the
 * same statement that stores the cipher.
 */
async function reencryptLegacyPlaintextSecrets(db) {
 try {
  const rows = await db.unsafe(
   `select workspace_id, key, value from workspace_secrets
      where coalesce(value, '') <> '' and coalesce(secret_cipher, '') = ''`,
  );
  if (rows.length === 0) return 0;
  let fixed = 0;
  for (const row of rows) {
   try {
    const cipher = await encryptVaultSecret(row.value);
    await db.unsafe(
     `update workspace_secrets set secret_cipher = $3, value = ''
        where workspace_id = $1 and key = $2`,
     [row.workspace_id, row.key, cipher],
    );
    fixed += 1;
   } catch {
    // One unencryptable row must not stop the rest, and must not print anything:
    // the row's KEY is safe to name but its value is not, and an error object from
    // this path could carry the input. A count is enough to act on.
   }
  }
  console.log(`[vault] re-encrypted ${fixed} legacy plaintext secret row(s)`);
  return fixed;
 } catch {
  // A schema that predates secret_cipher, or a DB that is not reachable yet, must
  // not wedge boot. The read path still handles a plaintext row.
  return 0;
 }
}

async function ensureRuntimeSchema() {
 const db = getDb();
 await db.unsafe(`
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name text DEFAULT '';
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS accent_color text DEFAULT '';
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;

    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS local_path text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS project_kind text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS git_root text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS git_remote text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS background_opacity numeric DEFAULT 0.7;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS background_image text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS folder text DEFAULT 'General';
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS participants jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT '';
    -- How people and AGENTS should behave in this channel, in the owner's own
    -- words. Injected into every agent turn here (see channelIntentNote), which
    -- is why it is a channel property and not a per-agent one: the same agent
    -- is expected to be playful in one channel and terse in another.
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS intent text NOT NULL DEFAULT '';
    -- Reply eagerness for a post that named nobody: 'auto' (at once, the
    -- default), 'social' (unhurried — see shared/replyCadence.cjs) or 'mention'
    -- (not at all). UNCONSTRAINED text on purpose, normalized in
    -- shared/channelMentions.cjs: an unreadable value reads as 'auto', so a row
    -- written by a newer client cannot silence a channel — and so widening the
    -- set of values needs no DDL and no migration in either backend.
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS conversation_mode text NOT NULL DEFAULT 'auto';
    ALTER TABLE chat_sessions ALTER COLUMN conversation_mode SET DEFAULT 'auto';
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS max_agent_turns integer NOT NULL DEFAULT 10;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS auto_rounds integer NOT NULL DEFAULT 3;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS parent_message_id uuid REFERENCES messages(id) ON DELETE CASCADE;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_parent_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_at timestamptz;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS canvas_id text;
    -- Read scope one level BELOW the workspace role check. See the column
    -- comment in database/neon-schema.sql for the two values and why the
    -- authorizer ALSO treats folder='Direct messages' as private.
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace';
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_visibility ON chat_sessions(workspace_id, visibility);
    CREATE TABLE IF NOT EXISTS chat_session_members (
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      source text NOT NULL DEFAULT 'participant',
      granted_by uuid,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_session_members_user ON chat_session_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_canvas ON chat_sessions(workspace_id, canvas_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_folder ON chat_sessions(workspace_id, folder);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived ON chat_sessions(workspace_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent_message ON chat_sessions(parent_message_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_split_parent ON chat_sessions(split_parent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_deleted ON chat_sessions(workspace_id, deleted_at);

    -- Suggestions mined from a conversation, by either trigger (the thread was
    -- discarded, or it went quiet). See server/thread-harvest.cjs for why these
    -- are proposals and never direct writes into memory_facts/documents, and
    -- why the table keeps the older name while the product says "Suggestions".
    CREATE TABLE IF NOT EXISTS thread_harvests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending',
      reason text,
      requested_by uuid,
      findings jsonb NOT NULL DEFAULT '[]'::jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- The watermark: the newest message a COMPLETED analysis of this session has
    -- already considered. It is what makes a live conversation cheap to keep
    -- mining — the next run reads only what has been said since, instead of the
    -- whole channel from message 1. Nullable, and null means "read from the
    -- start", so every row that predates this column behaves as it always did.
    ALTER TABLE thread_harvests ADD COLUMN IF NOT EXISTS cursor_at timestamptz;
    CREATE INDEX IF NOT EXISTS idx_thread_harvests_pending ON thread_harvests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_thread_harvests_workspace ON thread_harvests(workspace_id, created_at DESC);
    -- Both halves of the idle sweep's per-session lookup: the watermark and the
    -- cooldown are read together, once per candidate session, every five minutes.
    CREATE INDEX IF NOT EXISTS idx_thread_harvests_session ON thread_harvests(session_id, updated_at DESC);
    -- One OPEN harvest per thread: deleting the same thread twice (two clients, a
    -- retry) must not stack a second pending row or bill a second model call.
    -- The idle sweep leans on this too — it is what makes a race between two
    -- server processes cost one row rather than two model calls.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_harvests_one_open
      ON thread_harvests(session_id) WHERE status IN ('pending', 'running');

    -- Workspace automations: "when X happens inside agensis, do Y inside
    -- agensis", without a code change. See server/automations.cjs for the
    -- engine and shared/automation-rules.cjs for the evaluator.
    --
    -- This is the one cell of the trigger/action matrix none of the three
    -- existing systems cover: agent_schedules is time -> wake an agent,
    -- agent_webhooks is inbound HTTP -> wake an agent, flow_connections is
    -- workspace event -> POST to an external URL. All three end in a model call
    -- or an outbound request. An automation ends in a deterministic internal
    -- write, which is why it can decide something for zero cost.
    --
    -- enabled defaults to FALSE. A definition that starts live means the first
    -- thing a mistyped condition does is fire on everything, and the author
    -- finds out from the channel rather than from the form.
    --
    -- trigger_event is denormalised out of the definition so the matcher's only
    -- query is a partial-index lookup rather than a jsonb scan on every write.
    CREATE TABLE IF NOT EXISTS automations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      enabled boolean NOT NULL DEFAULT false,
      trigger_event text NOT NULL,
      definition jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid,
      run_count integer NOT NULL DEFAULT 0,
      fail_count integer NOT NULL DEFAULT 0,
      last_run_at timestamptz,
      last_status text NOT NULL DEFAULT '',
      -- Set by the runaway guard. A tripped automation stays off until a human
      -- clears it, and this column is why the UI can say WHY it stopped.
      disabled_reason text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_automations_workspace ON automations(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_automations_trigger ON automations(workspace_id, trigger_event) WHERE enabled;

    -- One row per (automation, triggering event). The QUEUE and the history.
    CREATE TABLE IF NOT EXISTS automation_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      -- Stable per triggering row+version, the same shape as the flow webhook
      -- event id, so a retried write cannot enqueue the same run twice.
      event_id text NOT NULL,
      event_type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      claim_token uuid,
      lease_expires_at timestamptz,
      -- The projected event the run saw, so a run stays readable after the
      -- source row has changed or been deleted.
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      steps jsonb NOT NULL DEFAULT '[]'::jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- Idempotent enqueue. This index IS the deduplication.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_runs_event
      ON automation_runs(automation_id, event_id);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_pending ON automation_runs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace ON automation_runs(workspace_id, created_at DESC);
    -- The per-automation rate window counts rows in an interval.
    CREATE INDEX IF NOT EXISTS idx_automation_runs_recent ON automation_runs(automation_id, created_at DESC);

    ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder text DEFAULT 'General';
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(workspace_id, folder);

    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS soul text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS instructions text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS tools jsonb DEFAULT '[]'::jsonb;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS skills jsonb DEFAULT '[]'::jsonb;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
    -- How the agent presents itself, and who decided each part of it:
    --   { voice: { locale, variant, rate, pitch }, human_set: { name: true, ... } }
    -- Deliberately NOT a key in metadata: metadata is manage-only
    -- (MANAGE_ONLY_DB_COLUMNS_BY_TABLE — it carries host_folders, which widens an
    -- agent's filesystem access), and choosing an accent is not an escalation, so
    -- putting the voice there would have locked editors out of it. See
    -- shared/agentIdentity.cjs for the precedence rule human_set enforces.
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS identity jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS handle text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS openpet_avatar_id text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS accent_color text DEFAULT '#00a95c';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS connect_token_hash text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS run_mode text NOT NULL DEFAULT 'builtin';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_provider text;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_config jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS permission_mode text NOT NULL DEFAULT 'default';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE workspace_agents ALTER COLUMN avatar SET DEFAULT 'AI';
    CREATE INDEX IF NOT EXISTS idx_workspace_agents_handle ON workspace_agents(workspace_id, handle);
    CREATE INDEX IF NOT EXISTS idx_workspace_agents_connect_token_hash ON workspace_agents(connect_token_hash);

    CREATE TABLE IF NOT EXISTS agent_webhooks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      name text NOT NULL DEFAULT 'Webhook',
      token text NOT NULL UNIQUE,
      enabled boolean NOT NULL DEFAULT true,
      last_triggered_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_webhooks_workspace_id ON agent_webhooks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent_id ON agent_webhooks(agent_id);
    ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

    -- A channel fed by an OUTSIDE network. One row = one (channel, provider,
    -- external chat) triple, so a channel mirrors exactly one remote room and a
    -- remote room lands in exactly one channel.
    --
    -- The lane is where the transport actually runs, and it is a property of the
    -- PROVIDER, not a preference:
    --   'hub'    Telegram, Slack — the network pushes to a public URL, so Fly
    --            can own the socket and the credential.
    --   'daemon' WhatsApp, Signal, OpenClaw — these need to be a linked DEVICE
    --            (or, for OpenClaw, to reach 127.0.0.1:18789). No hosted server
    --            can hold that; it runs on the user's machine and relays over
    --            the daemon's existing WS.
    --
    -- The config column holds provider credentials the USER supplies (bot token,
    -- signing secret, gateway url). external_id is the remote chat id — always
    -- the stable id, never a display name, because names get renamed.
    CREATE TABLE IF NOT EXISTS channel_bridges (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      provider text NOT NULL,
      lane text NOT NULL,
      external_id text NOT NULL DEFAULT '',
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- The daemon currently carrying this bridge. ON DELETE SET NULL so pruning
      -- an offline connection marks the bridge unattached instead of deleting it.
      connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending',
      last_error text,
      last_inbound_at timestamptz,
      last_outbound_at timestamptz,
      enabled boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_channel_bridges_workspace_id ON channel_bridges(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_channel_bridges_session_id ON channel_bridges(session_id);
    -- Outbound reads this on every message insert; keep it a single index hit.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_bridges_session ON channel_bridges(session_id);
    ALTER TABLE channel_bridges DROP CONSTRAINT IF EXISTS channel_bridges_provider_check;
    ALTER TABLE channel_bridges ADD CONSTRAINT channel_bridges_provider_check
      CHECK (provider IN ('telegram', 'slack', 'whatsapp', 'signal', 'openclaw'));
    ALTER TABLE channel_bridges DROP CONSTRAINT IF EXISTS channel_bridges_lane_check;
    ALTER TABLE channel_bridges ADD CONSTRAINT channel_bridges_lane_check
      CHECK (lane IN ('hub', 'daemon'));

    -- The loop guard. Every message that crosses the bridge in EITHER direction
    -- is recorded here, and the unique index is what makes ingest idempotent:
    -- Telegram retries a webhook it thinks failed, Baileys replays on reconnect,
    -- and signal-cli re-delivers on restart. Without this, one flaky delivery
    -- becomes a duplicate message and — worse — an agent turn that runs twice.
    CREATE TABLE IF NOT EXISTS bridge_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bridge_id uuid NOT NULL REFERENCES channel_bridges(id) ON DELETE CASCADE,
      external_message_id text NOT NULL,
      direction text NOT NULL,
      message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      created_at timestamptz DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bridge_messages_external
      ON bridge_messages(bridge_id, external_message_id);
    CREATE INDEX IF NOT EXISTS idx_bridge_messages_message_id ON bridge_messages(message_id);

    -- Link preview (unfurl) cache. Keyed by a hash of the NORMALIZED url and
    -- deliberately NOT workspace-scoped: the whole point is one outbound fetch
    -- per URL for the whole install rather than one per workspace, per reader,
    -- per render. Nothing in a row is private to a workspace — it is metadata a
    -- public page publishes about itself.
    --
    -- The table is absent from ALLOWED_TABLES on purpose, so it is unreachable
    -- through the generic /backend/db gate and cannot be enumerated. It is read
    -- only by POST /backend/link-previews, which answers for URLs the caller
    -- supplied and never lists. (A caller who already knows an exact URL can
    -- still infer "somebody unfurled this in the last week" from the response
    -- latency; that oracle is not worth duplicating every fetch per workspace.)
    --
    -- expires_at is the TTL: ok/empty rows last a week, failures an hour, so a
    -- host that was down for one minute is not un-previewable until Tuesday.
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

    CREATE TABLE IF NOT EXISTS agent_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT 'Agent',
      handle text NOT NULL DEFAULT '',
      host text DEFAULT '',
      cwd text DEFAULT '',
      status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'busy')),
      metadata jsonb DEFAULT '{}'::jsonb,
      capabilities jsonb DEFAULT '{}'::jsonb,
      connected_at timestamptz DEFAULT now(),
      last_seen_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS farm_integration_device_codes (
      id uuid PRIMARY KEY,
      device_code_hash text NOT NULL UNIQUE,
      user_code text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'Agent Farm',
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
      workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
      approved_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      denied_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      integration_id uuid,
      expires_at timestamptz NOT NULL,
      approved_at timestamptz,
      denied_at timestamptz,
      consumed_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_farm_device_user_code ON farm_integration_device_codes(user_code);
    CREATE INDEX IF NOT EXISTS idx_farm_device_expires_at ON farm_integration_device_codes(expires_at);

    CREATE TABLE IF NOT EXISTS farm_integrations (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT 'Agent Farm',
      token_hash text NOT NULL UNIQUE,
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      approved_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      revoked_at timestamptz,
      last_seen_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_farm_integrations_workspace ON farm_integrations(workspace_id, revoked_at);
    CREATE TABLE IF NOT EXISTS flow_connections (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      channel_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT 'Flows',
      token_hash text NOT NULL UNIQUE,
      signing_secret_cipher text NOT NULL,
      webhook_url text,
      events jsonb NOT NULL DEFAULT '[]'::jsonb,
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      revoked_at timestamptz,
      last_seen_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_flow_connections_workspace ON flow_connections(workspace_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_flow_connections_channel ON flow_connections(channel_id, revoked_at);
    CREATE TABLE IF NOT EXISTS flow_webhook_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id uuid NOT NULL REFERENCES flow_connections(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      event_id text NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'inflight', 'delivered', 'dead')),
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      claim_token uuid,
      lease_expires_at timestamptz,
      last_http_status integer,
      last_error text,
      delivered_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (connection_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_flow_deliveries_due ON flow_webhook_deliveries(status, next_attempt_at);
    ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS capabilities jsonb DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_agent_connections_workspace_id ON agent_connections(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_connections_agent_id ON agent_connections(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_connections_status ON agent_connections(workspace_id, status);

    CREATE TABLE IF NOT EXISTS cursorbuddy_connection_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      key_hash text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'CursorBuddy runtime',
      surface text NOT NULL DEFAULT 'machine',
      scope text NOT NULL DEFAULT 'machine',
      domain text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'claimed', 'expired', 'revoked')),
      metadata jsonb DEFAULT '{}'::jsonb,
      expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
      claimed_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_cursorbuddy_connection_keys_workspace ON cursorbuddy_connection_keys(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_cursorbuddy_connection_keys_hash ON cursorbuddy_connection_keys(key_hash);

    CREATE TABLE IF NOT EXISTS agent_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
      session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
      message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      created_by uuid,
      prompt text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
      response text DEFAULT '',
      error text DEFAULT '',
      metadata jsonb DEFAULT '{}'::jsonb,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_workspace_id ON agent_jobs(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_agent_id ON agent_jobs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_session_id ON agent_jobs(session_id);

    -- Scheduled agent runs. A schedule posts a prompt into a session on a
    -- cadence (interval_seconds) and lets the orchestrator dispatch as usual.
    -- next_run_at drives the runner; running/last_* track execution + history.
    CREATE TABLE IF NOT EXISTS agent_schedules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
      created_by uuid,
      name text NOT NULL DEFAULT '',
      prompt text NOT NULL DEFAULT '',
      interval_seconds integer NOT NULL DEFAULT 86400,
      enabled boolean NOT NULL DEFAULT true,
      running boolean NOT NULL DEFAULT false,
      next_run_at timestamptz NOT NULL DEFAULT now(),
      last_run_at timestamptz,
      last_status text DEFAULT '',
      run_count integer NOT NULL DEFAULT 0,
      fail_count integer NOT NULL DEFAULT 0,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_schedules_workspace_id ON agent_schedules(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(next_run_at) WHERE enabled;

    CREATE TABLE IF NOT EXISTS agent_schedule_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      schedule_id uuid NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'ok',
      detail text DEFAULT '',
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_schedule ON agent_schedule_runs(schedule_id, created_at desc);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_schedules_interval_bounds') THEN
        ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_interval_bounds
          CHECK (interval_seconds >= 60 AND interval_seconds <= 2592000);
      END IF;
    END $$;

    -- Per-thread widget items surfaced in the chat's right-hand widget rail.
    -- kind: 'todo' | 'plan' | 'blocker'. Todos/plan use status open|done;
    -- blockers use open|answered|dismissed and can carry a human response.
    -- message_id optionally anchors an item to a message for jump-to-scroll.
    CREATE TABLE IF NOT EXISTS thread_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      kind text NOT NULL DEFAULT 'todo' CHECK (kind IN ('todo', 'plan', 'blocker')),
      content text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'open',
      order_index double precision NOT NULL DEFAULT 0,
      message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      response text DEFAULT '',
      created_by uuid,
      created_by_agent text DEFAULT '',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_thread_items_session ON thread_items(session_id, kind, order_index);
    CREATE INDEX IF NOT EXISTS idx_thread_items_workspace ON thread_items(workspace_id);

    -- Canvas layers (the "projects"/canvases a workspace is split into). Layer
    -- definitions used to live only in each browser's localStorage while the
    -- objects drawn on them lived in the shared canvas_objects table keyed by
    -- that browser-generated layer id — so a canvas one member created was
    -- invisible to everyone else. layer_id is that same text id
    -- (canvas_objects.layer_id, 'base' for the default layer); the uuid id is
    -- the row's own key so every generic /backend/db row id stays globally
    -- unique. Active-layer state stays per-browser in localStorage.
    CREATE TABLE IF NOT EXISTS canvas_layers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      layer_id text NOT NULL,
      name text NOT NULL DEFAULT 'Workspace',
      sort_order double precision NOT NULL DEFAULT 0,
      description text DEFAULT '',
      icon text DEFAULT '',
      local_path text DEFAULT '',
      project_kind text DEFAULT '',
      git_root text DEFAULT '',
      git_remote text DEFAULT '',
      background_opacity double precision DEFAULT 0.7,
      background_image text DEFAULT '',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (workspace_id, layer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_layers_workspace_id ON canvas_layers(workspace_id);

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_kind text DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id text DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name text DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions jsonb DEFAULT '{}';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    -- Attachment REFERENCES (2026-07): [{id, name, type, size}] pointing at
    -- uploaded_files rows, so a bubble can render a real thumbnail or a download
    -- chip. Never file bytes. The human-readable "[Linked files]" block folded
    -- into the content column stays exactly as it was -- that block is how an
    -- AGENT learns a file came with the turn; this column is only how a BROWSER
    -- draws it.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb DEFAULT '[]';
    -- Agent tool steps (2026-07): one row per tool call, rendered as a compact
    -- chip instead of a full chat bubble. message_kind='tool_step' is the
    -- discriminator; tool_name/tool_detail are the structured halves of the
    -- human-readable content line, which stays populated as the fallback for
    -- older clients and for rows written before these columns existed.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_kind text DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_name text DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_detail text DEFAULT '';
    -- "Send to channel" (2026-07): an agent WORKS inside a thread and only its
    -- final answer is broadcast to the channel/DM. A broadcast reply KEEPS its
    -- thread_parent_id (it is still part of the thread) and is additionally shown
    -- in the channel view, so the channel reads as message → answer while every
    -- "Thinking …" placeholder, tool-step chip and intermediate text block stays
    -- in the thread. Humans get the same switch from the thread composer.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS broadcast_to_channel boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, pinned);
    CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(session_id, deleted_at);
    -- Trigram indexes so MCP search_messages / search_docs (leading-wildcard
    -- ILIKE '%q%') use a GIN index instead of a full sequential scan.
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages USING gin (content gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING gin (title gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_documents_content_trgm ON documents USING gin (content gin_trgm_ops);

    ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS content_sha256 text DEFAULT '';
    ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE canvas_groups ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE canvas_objects ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date timestamptz;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depends_on uuid[] DEFAULT '{}';
    -- Sub-tasks / nesting. The column shipped in database/neon-schema.sql only,
    -- so a DB built from migrations + this bootstrap never got it; MCP now
    -- writes parent_id, which would fail there. Idempotent, so a no-op on any
    -- DB that already has it.
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES tasks(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
    -- References to uploaded_files rows, same shape and same rules as
    -- messages.attachments (see JSON_COLUMNS_BY_TABLE / parseMessageAttachments):
    -- never file bytes, just { id, name, type, size } chips the client renders.
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE document_comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

    -- Tasks <-> subthread <-> comments loop (2026-07): a task @mention runs the
    -- agent inside a per-task SUBTHREAD (messages.source_task_id ties the thread
    -- root to its task), and the agent's reply is mirrored back as an
    -- agent-authored task comment (task_comments.agent_id).
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_task_id uuid;
    CREATE INDEX IF NOT EXISTS idx_messages_source_task_id ON messages(session_id, source_task_id);
    CREATE INDEX IF NOT EXISTS idx_messages_source_task_root
      ON messages(source_task_id)
      WHERE source_task_id IS NOT NULL AND thread_parent_id IS NULL;
    ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS agent_id uuid;

    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS memory_dir text DEFAULT '';

    CREATE TABLE IF NOT EXISTS agent_memory_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
      path text NOT NULL,
      kind text NOT NULL DEFAULT 'memory',
      summary text DEFAULT '',
      content_cache text DEFAULT '',
      byte_size bigint DEFAULT 0,
      editable boolean NOT NULL DEFAULT false,
      last_synced timestamptz DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (agent_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memory_files_workspace_id ON agent_memory_files(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_files_agent_id ON agent_memory_files(agent_id);

    -- The BODY behind a skill NAME a daemon advertises. capabilities.skills is
    -- names only, so the Skills browser had nothing to show for them; a daemon
    -- mirrors the real SKILL.md here via agent_skill_sync, the same way it
    -- mirrors its memory palace above. Daemon-write / browser-read only.
    CREATE TABLE IF NOT EXISTS agent_skill_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
      skill text NOT NULL,
      path text DEFAULT '',
      summary text DEFAULT '',
      content text DEFAULT '',
      byte_size bigint DEFAULT 0,
      truncated boolean NOT NULL DEFAULT false,
      last_synced timestamptz DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (agent_id, skill)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_skill_documents_workspace_id ON agent_skill_documents(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_skill_documents_agent_id ON agent_skill_documents(agent_id);

    -- Agent templates ("persona packs") as DATA rather than code. The 15
    -- bundled templates live in a frontend array and can only be changed by a
    -- deploy; this table lets a workspace author its own and save a tuned agent
    -- as a starting point for the next one. See shared/agentTemplates.cjs for
    -- the validator and server/agent-templates-routes.cjs for the routes.
    --
    -- THE ABSENT COLUMNS ARE THE SECURITY CONTROL, and adding one later is a
    -- security decision rather than a schema tidy-up.
    --
    -- There is deliberately no permission_mode, no metadata, no
    -- sandbox_provider, no sandbox_config, no connect_token_hash, no
    -- mcp_approved, no memory_dir and no identity. A template carries prose and
    -- requests; it never carries authority. metadata is the one that looks
    -- harmless and is not: it holds host_folders, which the daemon turns into
    -- an --add-dir argument on somebody's actual machine, and sandbox_skills, whose
    -- definitions carry a baseUrl the server will fetch and a credential naming
    -- a workspace-vault key. permission_mode is 'yolo', which is unrestricted
    -- shell on the daemon host. Both are guarded on workspace_agents itself
    -- (PRIVILEGED_DB_COLUMNS_BY_TABLE / MANAGE_ONLY_DB_COLUMNS_BY_TABLE), and a
    -- template that could carry them would be a way around those guards.
    --
    -- Instantiating a template prefills the existing Agents window form; the
    -- write still goes through the generic /backend/db/insert where those guards
    -- apply. This feature adds NO new write path to workspace_agents.
    CREATE TABLE IF NOT EXISTS workspace_agent_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      slug text NOT NULL,
      name text NOT NULL,
      category text NOT NULL DEFAULT 'Custom',
      description text DEFAULT '',
      handle_hint text DEFAULT '',
      system_prompt text DEFAULT '',
      soul text DEFAULT '',
      instructions text DEFAULT '',
      -- Both string[] and both jsonb. skills MUST stay string[]: the Agents
      -- window round-trips it through a comma-separated text input, so an object
      -- in that array renders '[object Object]' and is saved back over the real
      -- definition on the next unrelated edit.
      tools jsonb NOT NULL DEFAULT '[]'::jsonb,
      skills jsonb NOT NULL DEFAULT '[]'::jsonb,
      model text NOT NULL DEFAULT 'auto',
      run_mode text NOT NULL DEFAULT 'builtin',
      runtime text DEFAULT '',
      avatar text DEFAULT '',
      accent_color text DEFAULT '',
      revision integer NOT NULL DEFAULT 1,
      -- 'authored' (typed here), 'derived' (saved from an agent), 'imported'
      -- (crossed a workspace boundary). Provenance, so "where did this prompt
      -- come from" has an answer when an agent later behaves oddly.
      source text NOT NULL DEFAULT 'authored',
      origin jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (workspace_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_agent_templates_workspace_id
      ON workspace_agent_templates(workspace_id);

    CREATE TABLE IF NOT EXISTS memory_file_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
      path text NOT NULL,
      user_id uuid,
      parent_id uuid REFERENCES memory_file_comments(id) ON DELETE CASCADE,
      content text NOT NULL,
      anchor_text text DEFAULT '',
      resolved boolean DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_memory_file_comments_workspace_id ON memory_file_comments(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_memory_file_comments_agent_path ON memory_file_comments(agent_id, path);
    CREATE INDEX IF NOT EXISTS idx_memory_file_comments_parent_id ON memory_file_comments(parent_id);

    -- Notes on an activity log entry ("comment I can look at later"), anchored to
    -- the activity_events row itself rather than the underlying entity, so a note
    -- left on e.g. a "message sent" log line doesn't require the message to carry
    -- comment support of its own. Mirrors memory_file_comments' shape so it drops
    -- straight into the generic useRealtimeComments hook.
    CREATE TABLE IF NOT EXISTS activity_event_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      event_id uuid NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
      user_id uuid,
      parent_id uuid REFERENCES activity_event_comments(id) ON DELETE CASCADE,
      content text NOT NULL,
      resolved boolean DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_activity_event_comments_workspace_id ON activity_event_comments(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_activity_event_comments_event_id ON activity_event_comments(event_id);
    CREATE INDEX IF NOT EXISTS idx_activity_event_comments_parent_id ON activity_event_comments(parent_id);

    -- Inbox read state: one MONOTONIC marker per (user, workspace, context_key).
    -- The inbox aggregates five existing sources (blockers, comments, mentions,
    -- agent-job errors, activity) and has no rows of its own — read/unread is
    -- entirely this table: an item is unread when its created_at is newer than
    -- the marker for its context_key, or when no marker exists. Markers only
    -- ever move FORWARD (the upsert carries a "read_at < excluded.read_at"
    -- guard) so an out-of-order write from a second device cannot un-read
    -- something. The primary key IS the read-path index: the inbox query looks
    -- markers up by the (user_id, workspace_id) prefix, which the PK btree
    -- covers, so no second index is created.
    CREATE TABLE IF NOT EXISTS inbox_read_state (
      user_id uuid NOT NULL,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      context_key text NOT NULL,
      read_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, workspace_id, context_key)
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_read_state_workspace ON inbox_read_state(workspace_id);
  `);
 // Owner broadcasts (shared/tenant-campaigns.cjs). The only rows in this
 // database addressed to ACCOUNTS rather than scoped to a workspace, which is why
 // neither table is in the backendClient allowlists — the dedicated owner-gated
 // routes are the only door.
 //
 // The campaign row IS the audit trail: who sent it (created_by plus the email as
 // it read at send time, so a later rename cannot rewrite history), what it said,
 // the segment and its plain-English summary, and how many accounts it reached.
 //
 // The comments stay OUT of the SQL string on purpose: several tests mock the DB
 // and classify a bootstrap statement by its first keyword, so a block beginning
 // with `--` reads as an unknown query rather than as DDL.
 await db.unsafe(`
    CREATE TABLE IF NOT EXISTS tenant_campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL DEFAULT '',
      body text NOT NULL DEFAULT '',
      surface text NOT NULL DEFAULT 'tip',
      segment jsonb NOT NULL DEFAULT '{}'::jsonb,
      segment_summary text NOT NULL DEFAULT '',
      recipient_count integer NOT NULL DEFAULT 0,
      created_by uuid,
      created_by_email text NOT NULL DEFAULT '',
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_campaigns_created_at ON tenant_campaigns(created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_campaign_recipients (
      campaign_id uuid NOT NULL REFERENCES tenant_campaigns(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      dismissed_at timestamptz,
      PRIMARY KEY (user_id, campaign_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_campaign_recipients_campaign
      ON tenant_campaign_recipients(campaign_id);
  `);
 // tenant_campaign_recipients above is BOTH the frozen audience (written once at
 // send time) and the per-user dismissal record. One table on purpose: a user can
 // only dismiss a message that was actually sent to them, because the row they
 // update is the row that made them a recipient. Server-side rather than a
 // localStorage key so a dismissal survives a different browser and two accounts
 // sharing one browser never share one. The composite PK is the delivery index.
 await db.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_secrets (
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      key text NOT NULL,
      value text NOT NULL DEFAULT '',
      updated_by uuid,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (workspace_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_secrets_workspace_id ON workspace_secrets(workspace_id);
    ALTER TABLE workspace_secrets ADD COLUMN IF NOT EXISTS secret_cipher text DEFAULT '';
    ALTER TABLE workspace_secrets ADD COLUMN IF NOT EXISTS description text DEFAULT '';
  `);
 // The audit log lives next to workspace_secrets because it is the same
 // sensitivity: server-written only, manage-gated to read, reachable through no
 // generic /backend/db/* route (audit_log is absent from ALLOWED_TABLES, so
 // ensureTable rejects it before any handler runs). See the block above
 // recordAuditEntry in shared/backend-core.cjs for what this is and is not worth.
 //
 // workspace_id is ON DELETE SET NULL, NOT CASCADE, and that is the one line here
 // worth defending at review. Every other workspace-scoped table cascades.
 // "Someone deleted the workspace" is the single most audit-worthy action there
 // is, and CASCADE would erase the evidence of it as a side effect of committing
 // it. That is also why the column is nullable.
 //
 // before_value/after_value are text, not jsonb, so they hold the short scalars
 // they are for ('editor' -> 'admin', 'default' -> 'yolo') and cannot quietly
 // become the place someone dumps a whole row — and with it, a secret.
 await db.unsafe(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seq bigserial NOT NULL,
      workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
      actor_user_id uuid,
      actor_agent_id uuid,
      actor_label text NOT NULL DEFAULT '',
      action text NOT NULL,
      target_type text NOT NULL DEFAULT '',
      target_id text,
      target_label text NOT NULL DEFAULT '',
      before_value text NOT NULL DEFAULT '',
      after_value text NOT NULL DEFAULT '',
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      request_ip text NOT NULL DEFAULT '',
      entry_hash text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_created ON audit_log(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_log_seq ON audit_log(seq);

    CREATE OR REPLACE FUNCTION audit_log_refuse_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'audit_log rows are immutable'
          USING ERRCODE = 'check_violation';
      END IF;
      -- DELETE is permitted only past the retention horizon, so pruning never
      -- requires dropping this trigger by hand — and a trigger dropped for
      -- maintenance is a trigger that stays off.
      IF OLD.created_at > now() - interval '400 days' THEN
        RAISE EXCEPTION 'audit_log rows younger than the retention horizon cannot be deleted'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN OLD;
    END $$;

    DROP TRIGGER IF EXISTS trg_audit_log_refuse_mutation ON audit_log;
    CREATE TRIGGER trg_audit_log_refuse_mutation
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW
      EXECUTE FUNCTION audit_log_refuse_mutation();
  `);
 await reencryptLegacyPlaintextSecrets(db);
 await db.unsafe(`
    CREATE TABLE IF NOT EXISTS gateway_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT 'Gateway',
      base_url text NOT NULL DEFAULT '',
      api_key_cipher text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT '',
      protocol text NOT NULL DEFAULT 'openai-chat',
      headers jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_configs_workspace_id ON gateway_configs(workspace_id);
  `);
 await db.unsafe(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      bucket text NOT NULL,
      window_start timestamptz NOT NULL,
      count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits (window_start);
  `);
 await db.unsafe(`
    ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
    ALTER TABLE workspace_members
      ADD CONSTRAINT workspace_members_role_check
      CHECK (role IN ('owner', 'admin', 'editor', 'commenter', 'viewer'));
  `);
 await db.unsafe(`
    DO $$
    DECLARE constraint_name text;
    BEGIN
      SELECT con.conname INTO constraint_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'canvas_objects'
        AND con.conname = 'canvas_objects_type_check'
      LIMIT 1;

      IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE canvas_objects DROP CONSTRAINT %I', constraint_name);
      END IF;

      ALTER TABLE canvas_objects
        ADD CONSTRAINT canvas_objects_type_check
        CHECK (type IN ('rect', 'ellipse', 'diamond', 'arrow', 'line', 'pen', 'text', 'image', 'video', 'file', 'applet', 'sticky_note'));
    END $$;
  `);
 await db.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_invites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE,
      email text DEFAULT '',
      role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'commenter', 'viewer')),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      accepted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      accepted_at timestamptz,
      expires_at timestamptz,
      dismissed_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    -- Soft-dismiss: a SPENT invite link (revoked / accepted / already past
    -- expires_at) can be cleared out of the Users window without destroying the
    -- row — an accepted invite is the record of how a member got in. NULL =
    -- shown. Never set for a still-active link: the routes carry the predicate
    -- in SQL so a live link cannot vanish from the only place it can be seen.
    ALTER TABLE workspace_invites ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
    CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace_id ON workspace_invites(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_invites_token ON workspace_invites(token);

    -- The ONE join link: a single URL a human OR an agent can redeem, which
    -- provisions the real credential server-side and never displays it.
    -- (Deliberately kept inside THIS statement block rather than opening a new
    -- db.unsafe: a block whose text begins with a comment breaks every strict
    -- mock database in tests/, all of which dispatch on the leading keyword.)
    --
    -- Deliberately a separate table from workspace_invites rather than more
    -- columns on it, because the two have opposite security properties and
    -- merging them would have meant one row type with two lifetimes:
    --   * workspace_invites lives 14 DAYS and is itself a usable MCP bearer for
    --     that whole window (verifyInviteToken) — a long-lived credential that
    --     has to be rendered somewhere, which is the exact shape of the leak
    --     this feature exists to remove.
    --   * a join link lives MINUTES, works exactly once, and is never a bearer
    --     anywhere: it is not in verifyMcpToken's chain and cannot authenticate
    --     a single API call. The only thing it can do is be redeemed, once, at
    --     its own endpoint.
    --
    -- Only the HASH is stored, like connect_token_hash / mcp_token_hash. The
    -- plaintext exists in the mint response and in the URL its creator copies;
    -- nothing can recover it afterwards, including us.
    CREATE TABLE IF NOT EXISTS workspace_join_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      label text NOT NULL DEFAULT '',
      -- The role a HUMAN gets on redeeming. An agent's abilities are governed by
      -- agent RBAC (kinds: ['agent']), not by this.
      role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'commenter', 'viewer')),
      audience text NOT NULL DEFAULT 'both' CHECK (audience IN ('both', 'human', 'agent')),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed', 'revoked')),
      redeemed_as text NOT NULL DEFAULT '' CHECK (redeemed_as IN ('', 'human', 'agent')),
      redeemed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      redeemed_agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      redeemed_at timestamptz,
      expires_at timestamptz NOT NULL,
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_join_links_workspace_id ON workspace_join_links(workspace_id, created_at DESC);

    -- MCP "connect a client" model. ONE workspace token (or your agensis login, or an
    -- invite link) authenticates an MCP client; it then calls register_agent to become an
    -- agent (new or existing). You approve via a popup unless auto-approve / invite link.
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_token_hash text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_auto_approve boolean NOT NULL DEFAULT false;
    -- An agent becomes claimable over MCP once its registration is approved.
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS mcp_approved boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS agent_registrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      requested_handle text DEFAULT '',
      requested_name text DEFAULT '',
      client_label text DEFAULT '',
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      decided_at timestamptz
    );
    -- The identity the client declared in register_agent. Approval is
    -- asynchronous (pending -> a popup -> approved), so the declaration has to
    -- survive the round trip or a brand new agent loses the avatar and voice it
    -- asked for at the exact moment its row is created.
    ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_identity jsonb NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_agent_registrations_workspace ON agent_registrations(workspace_id, status);
  `);
 // C3 — make message-activity logging idempotent. A retried daemon finalization
 // re-logs the same message id; the partial unique index lets the logging insert
 // use ON CONFLICT DO NOTHING (see logMessageActivity). Wrapped on its own so a
 // failure (e.g. pre-existing duplicates) never blocks the rest of the schema
 // bootstrap. Mirrored by supabase/migrations and backend.mjs.
 try {
  await db.unsafe(`
      DELETE FROM activity_events a
      USING activity_events b
      WHERE a.event_type = 'message_sent'
        AND a.entity_type = 'message'
        AND b.event_type = 'message_sent'
        AND b.entity_type = 'message'
        AND a.entity_id IS NOT NULL
        AND a.entity_id = b.entity_id
        AND a.ctid > b.ctid;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_events_message_sent
        ON activity_events (entity_id)
        WHERE event_type = 'message_sent' AND entity_type = 'message';
    `);
 } catch (error) {
  console.warn('[backend] activity_events idempotency index migration failed:', error.message || error);
 }

 // M15 — enforce at most one ACTIVE (queued/running) job per (session, agent)
 // so two concurrent triggers can't produce duplicate agent turns even across
 // Fly instances (the in-process guard hasActiveBurstJob is per-process only).
 // Dedupe any pre-existing duplicates first (keep the newest) so the unique
 // index can be created; wrapped on its own so a failure never blocks boot,
 // and the app stays correct via hasActiveBurstJob if the index isn't present.
 try {
  await db.unsafe(`
      DELETE FROM agent_jobs a
      USING agent_jobs b
      WHERE a.status IN ('queued','running')
        AND b.status IN ('queued','running')
        AND a.session_id = b.session_id
        AND a.agent_id = b.agent_id
        AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.ctid > b.ctid));
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_jobs_active_per_session_agent
        ON agent_jobs (session_id, agent_id)
        WHERE status IN ('queued','running');
    `);
 } catch (error) {
  console.warn('[backend] agent_jobs active-job unique index migration failed:', error.message || error);
 }

 // DM read scope — the one-time backfill that turns 'every member can read every
 // session' into 'a private session is readable by its members'.
 //
 // Lives in server/dm-scope-backfill.cjs, not inline here, because its central
 // claim — that the workspace owner is the right member to seed — is a fact
 // about TODAY's data rather than a law. Extracted, that claim is executable and
 // tested: the migration seeds the humans who demonstrably SPOKE in a private
 // session, and reports loudly (with ids) anything the owner-only story cannot
 // explain, instead of silently orphaning somebody's DM.
 //
 // Never throws: a data-shape surprise must not take the schema bootstrap down.
 await runDmScopeBackfill(sharedDbAdapter);

 // In-app feedback -> System workspace.
 //
 // The System workspace is an ORDINARY workspace carrying `is_system = true`, so
 // membership, roles, invites and the whole task UI apply to it unchanged. The
 // PARTIAL unique index is what makes "the System workspace" singular and makes
 // ensureSystemWorkspace race-safe across Fly machines and Netlify lambdas: two
 // concurrent first-ever submissions cannot create two of them.
 //
 // tasks.source_type gains 'feedback' because a report IS a task — reusing the
 // existing table is what gives assignment and agent dispatch for free. The
 // CHECK is dropped and re-added rather than altered (Postgres has no ALTER
 // CONSTRAINT for CHECK); the name is deterministic for both an inline column
 // check and this statement, so it stays idempotent across re-runs.
 await db.unsafe(`
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_system ON workspaces (is_system) WHERE is_system;

    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_source_type_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_source_type_check
      CHECK (source_type IN ('manual', 'chat', 'document', 'canvas', 'ai', 'feedback'));

    CREATE TABLE IF NOT EXISTS feedback_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
      reporter_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
      source_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
      description text NOT NULL DEFAULT '',
      page jsonb NOT NULL DEFAULT '{}'::jsonb,
      selections jsonb NOT NULL DEFAULT '[]'::jsonb,
      diagnostics jsonb,
      build_id text DEFAULT '',
      user_agent text DEFAULT '',
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_reports_workspace_id ON feedback_reports(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_reports_task_id ON feedback_reports(task_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_reports_reporter_id ON feedback_reports(reporter_id);
  `);

 // --------------------------------------------------------------------------
 // Groupable workspaces — workspaces.parent_id (foundation; no UI yet).
 //
 // A workspace is the Slack account; channels are the projects. Grouping is
 // EMERGENT rather than a new tier: the same entity gains a nullable
 // self-reference, so a workspace with children renders as a group and one
 // without renders as a leaf. A parent may hold its own content as well as
 // children — that is allowed, not a degenerate case.
 //
 // ON DELETE RESTRICT, deliberately. The three candidates:
 //   CASCADE   — deleting the agency workspace silently destroys every client
 //               workspace under it, and all their channels, tasks and memory.
 //   SET NULL  — children survive but are silently PROMOTED to top level, and
 //               because members inherit downward, everyone whose access came
 //               only from the parent silently loses it. A workspace whose only
 //               members were inherited would be left with nobody in it.
 //   RESTRICT  — deleting a parent that still has children FAILS.
 // RESTRICT is the only one that cannot lose or leak data behind the operator's
 // back: re-parenting or deleting the children first is an explicit act. It
 // costs nothing today (no user can create a child yet), and the shared gate
 // turns the FK violation into a readable 409 rather than an opaque 500.
 //
 // Cycle prevention is BELT AND BRACES:
 //   1. CHECK  — the 1-cycle (parent_id = id), declaratively.
 //   2. TRIGGER — every longer cycle (A->B->A and deeper), at the DB, so it
 //      holds for the daemon, the MCP server, migrations and psql alike.
 //   3. shared/backend-core.cjs — the same rule at the API gate, with a 400 and
 //      a message instead of a raised exception.
 // The trigger is not redundant with (3): a cycle makes the `WITH RECURSIVE`
 // ancestor walk in the AUTHORIZATION path spin to statement_timeout on every
 // request touching that workspace, so one bad row is a denial of service. The
 // readers are depth-capped too, but the row must never exist in the first place.
 await db.unsafe(`
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS parent_id uuid;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_parent_id_fkey'
      ) THEN
        ALTER TABLE workspaces
          ADD CONSTRAINT workspaces_parent_id_fkey
          FOREIGN KEY (parent_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_parent_id_not_self'
      ) THEN
        ALTER TABLE workspaces
          ADD CONSTRAINT workspaces_parent_id_not_self
          CHECK (parent_id IS NULL OR parent_id <> id);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_workspaces_parent_id ON workspaces(parent_id);

    CREATE OR REPLACE FUNCTION workspaces_reject_parent_cycle()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      cursor_id uuid := NEW.parent_id;
      steps int := 0;
    BEGIN
      WHILE cursor_id IS NOT NULL LOOP
        IF cursor_id = NEW.id THEN
          RAISE EXCEPTION 'workspace % cannot be its own ancestor', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        steps := steps + 1;
        IF steps > ${WORKSPACE_MAX_DEPTH} THEN
          RAISE EXCEPTION 'workspace nesting exceeds the maximum depth of ${WORKSPACE_MAX_DEPTH}'
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT parent_id INTO cursor_id FROM workspaces WHERE id = cursor_id;
      END LOOP;
      RETURN NEW;
    END $$;

    DROP TRIGGER IF EXISTS trg_workspaces_reject_parent_cycle ON workspaces;
    CREATE TRIGGER trg_workspaces_reject_parent_cycle
      BEFORE INSERT OR UPDATE OF parent_id ON workspaces
      FOR EACH ROW
      WHEN (NEW.parent_id IS NOT NULL)
      EXECUTE FUNCTION workspaces_reject_parent_cycle();
  `);

 // Huddle tables live in server/huddles.cjs so the LiveKit surface stays in one
 // module, but the DDL runs HERE so the three-place rule holds and a fresh Fly
 // boot provisions them like everything else.
 try {
  await ensureHuddlesSchema(getDb());
 } catch (error) {
  console.warn('[backend] huddles schema migration failed:', error.message || error);
 }

 // Interactive tool approvals, same arrangement: the table lives with its
 // module (server/agent-permissions.cjs) and its DDL runs here.
 try {
  await ensureAgentPermissionsSchema(getDb());
 } catch (error) {
  console.warn('[backend] agent permissions schema migration failed:', error.message || error);
 }

 // --- Cost metering -------------------------------------------------------
 //
 // The ledger behind the Tenants window's usage figures. One row per provider
 // call, recording COUNTS ONLY — tokens/characters/seconds plus the provider
 // and the resource. Never a price: rates move, and a stored price becomes a
 // lie with no way to tell which rows are stale. Money is computed at display
 // time from shared/usage-rates.cjs (see shared/usage-metering.cjs).
 //
 // Every column is a scalar. There is deliberately no jsonb here, so this
 // table cannot reproduce the repo's most-repeated bind bug (an object bind
 // that Fly needs and Netlify must have as a string).
 //
 // workspace_id is ON DELETE SET NULL, not CASCADE: deleting a workspace must
 // not delete the record of what it cost. Such a row drops out of the
 // per-account rollup (it can no longer be attributed) and stays in the
 // deployment total, which is the honest place for it.
 //
 // NOT in the backendClient allowlists — there is no generic /backend/db route
 // to this table. It is read only through the owner-gated tenant routes.
 try {
  await getDb().unsafe(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
      provider text NOT NULL,
      resource text NOT NULL DEFAULT '',
      kind text NOT NULL DEFAULT '',
      unit text NOT NULL DEFAULT 'tokens',
      input_units bigint NOT NULL DEFAULT 0,
      output_units bigint NOT NULL DEFAULT 0,
      cache_write_units bigint NOT NULL DEFAULT 0,
      cache_read_units bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_created ON usage_events(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_provider_created ON usage_events(provider, created_at DESC);
  `);
  // The metering epoch, written ONCE. Every cost figure on the Tenants screen
  // is labelled "since <this date>" because there is no usage history before
  // it — no backfill is possible, and a total presented without this date
  // would read as an all-time figure and be false.
  await getDb().unsafe(
   `insert into app_settings (key, value)
         values ('usage.metering_started_at', now()::text)
    on conflict (key) do nothing`,
  );
 } catch (error) {
  console.warn('[backend] usage metering schema migration failed:', error.message || error);
 }
}

function getDb() {
 if (db) return db;
 const databaseUrl = getDatabaseUrl();
 if (!databaseUrl) throw new Error('DATABASE_URL is not set');
 db = postgres(databaseUrl, {
  max: 10,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 15,
 });
 return db;
}

function farmDeviceRecord(row) {
 if (!row) return null;
 return {
  id: row.id,
  deviceCodeHash: row.device_code_hash,
  userCode: row.user_code,
  name: row.name,
  status: row.status,
  workspaceId: row.workspace_id,
  approvedBy: row.approved_by,
  deniedBy: row.denied_by,
  scopes: parseJsonArray(row.scopes),
  integrationId: row.integration_id,
  expiresAt: Date.parse(row.expires_at),
  approvedAt: row.approved_at ? Date.parse(row.approved_at) : null,
  deniedAt: row.denied_at ? Date.parse(row.denied_at) : null,
  consumedAt: row.consumed_at ? Date.parse(row.consumed_at) : null,
  createdAt: Date.parse(row.created_at),
 };
}

function farmIntegrationRecord(row) {
 if (!row) return null;
 return {
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  tokenHash: row.token_hash,
  scopes: parseJsonArray(row.scopes),
  approvedBy: row.approved_by,
  revokedAt: row.revoked_at ? Date.parse(row.revoked_at) : null,
  lastSeenAt: row.last_seen_at ? Date.parse(row.last_seen_at) : null,
  createdAt: Date.parse(row.created_at),
 };
}

function createPostgresFarmIntegrationStore() {
 return {
  async insertDevice(record) {
   const rows = await getDb().unsafe(
    `insert into farm_integration_device_codes
         (id, device_code_hash, user_code, name, status, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), now()) returning *`,
    [record.id, record.deviceCodeHash, record.userCode, record.name, record.status, record.expiresAt, record.createdAt],
   );
   return farmDeviceRecord(rows[0]);
  },
  async pruneDevices(expiredBefore) {
   await getDb().unsafe(
    'delete from farm_integration_device_codes where expires_at < to_timestamp($1 / 1000.0)',
    [expiredBefore],
   );
  },
  async findDeviceByHash(hash) {
   const rows = await getDb().unsafe('select * from farm_integration_device_codes where device_code_hash = $1 limit 1', [hash]);
   return farmDeviceRecord(rows[0]);
  },
  async findDeviceByUserCode(code) {
   const rows = await getDb().unsafe('select * from farm_integration_device_codes where upper(user_code) = upper($1) limit 1', [code]);
   return farmDeviceRecord(rows[0]);
  },
  async updateDevice(id, patch) {
   const currentRows = await getDb().unsafe('select * from farm_integration_device_codes where id = $1 limit 1', [id]);
   const current = farmDeviceRecord(currentRows[0]);
   if (!current) return null;
   const next = { ...current, ...patch };
   const rows = await getDb().unsafe(
    `update farm_integration_device_codes set
          status = $2, workspace_id = $3, approved_by = $4, denied_by = $5,
          scopes = $6::jsonb, integration_id = $7,
          approved_at = case when $8::bigint is null then null else to_timestamp($8 / 1000.0) end,
          denied_at = case when $9::bigint is null then null else to_timestamp($9 / 1000.0) end,
          consumed_at = case when $10::bigint is null then null else to_timestamp($10 / 1000.0) end,
          updated_at = now() where id = $1 returning *`,
    [id, next.status, next.workspaceId || null, next.approvedBy || null, next.deniedBy || null, next.scopes || [], next.integrationId || null, next.approvedAt || null, next.deniedAt || null, next.consumedAt || null],
   );
   return farmDeviceRecord(rows[0]);
  },
  async insertIntegration(record) {
   const rows = await getDb().unsafe(
    `insert into farm_integrations
         (id, workspace_id, name, token_hash, scopes, approved_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, to_timestamp($7 / 1000.0), now()) returning *`,
    [record.id, record.workspaceId, record.name, record.tokenHash, record.scopes, record.approvedBy || null, record.createdAt],
   );
   return farmIntegrationRecord(rows[0]);
  },
  async consumeApprovedDevice(id, integration, consumedAt) {
   const rows = await getDb().unsafe(
    `with claimed as (
           update farm_integration_device_codes
              set status = 'consumed', integration_id = $2,
                  consumed_at = to_timestamp($8 / 1000.0), updated_at = now()
            where id = $1 and status = 'approved'
            returning workspace_id
         )
         insert into farm_integrations
           (id, workspace_id, name, token_hash, scopes, approved_by, created_at, updated_at)
         select $2, $3, $4, $5, $6::jsonb, $7, to_timestamp($8 / 1000.0), now()
           from claimed
         returning *`,
    [id, integration.id, integration.workspaceId, integration.name, integration.tokenHash, integration.scopes, integration.approvedBy || null, consumedAt],
   );
   return farmIntegrationRecord(rows[0]);
  },
  async findIntegrationByHash(hash) {
   const rows = await getDb().unsafe('select * from farm_integrations where token_hash = $1 limit 1', [hash]);
   return farmIntegrationRecord(rows[0]);
  },
  async revokeIntegration(id, revokedAt) {
   const rows = await getDb().unsafe('update farm_integrations set revoked_at = to_timestamp($2 / 1000.0), updated_at = now() where id = $1 returning *', [id, revokedAt]);
   return farmIntegrationRecord(rows[0]);
  },
  async touchIntegration(id, lastSeenAt) {
   const rows = await getDb().unsafe('update farm_integrations set last_seen_at = to_timestamp($2 / 1000.0), updated_at = now() where id = $1 returning *', [id, lastSeenAt]);
   return farmIntegrationRecord(rows[0]);
  },
  async listIntegrations(workspaceId) {
   const rows = await getDb().unsafe('select * from farm_integrations where workspace_id = $1 order by created_at desc', [workspaceId]);
   return rows.map(farmIntegrationRecord);
  },
 };
}

let farmIntegrationCoreInstance;
function getFarmIntegrationCore() {
 if (!farmIntegrationCoreInstance) {
  farmIntegrationCoreInstance = createFarmIntegrationCore({ store: createPostgresFarmIntegrationStore() });
 }
 return farmIntegrationCoreInstance;
}

function flowConnectionRecord(row) {
 if (!row) return null;
 return {
  id: row.id,
  workspaceId: row.workspace_id,
  channelId: row.channel_id || null,
  name: row.name,
  tokenHash: row.token_hash,
  signingSecretCipher: row.signing_secret_cipher,
  webhookUrl: row.webhook_url || null,
  events: parseJsonArray(row.events),
  scopes: parseJsonArray(row.scopes),
  createdBy: row.created_by || null,
  revokedAt: row.revoked_at ? Date.parse(row.revoked_at) : null,
  lastSeenAt: row.last_seen_at ? Date.parse(row.last_seen_at) : null,
  createdAt: Date.parse(row.created_at),
 };
}
// Both vault helpers delegate to shared/backend-core.cjs. They used to be a
// second copy of the same SQL + the same AES-256-GCM derivation, which is how the
// Netlify mirror once ended up writing plaintext next to a stale cipher. One
// implementation, two callers. `loadEnvFile()` first because a locally-run server
// reads SECRETS_ENCRYPTION_KEY out of `.env`, and the core reads only process.env.
async function getWorkspaceSecretValue(workspaceId, key) {
 loadEnvFile();
 return coreGetWorkspaceSecretValue(workspaceId, key, { db: dbUnsafe, getAuthSecret });
}

async function setWorkspaceSecretValue(workspaceId, key, value, userId, description) {
 loadEnvFile();
 await coreSetWorkspaceSecretValue(workspaceId, key, value, {
  db: dbUnsafe,
  getAuthSecret,
  userId: userId || null,
  description: description ?? null,
 });
}

// The shared core takes a `db(sql, params)` function; this server holds a
// postgres.js instance whose `.unsafe` has that shape.
function dbUnsafe(sql, params) {
 return getDb().unsafe(sql, params);
}

/**
 * The audit writer, bound to this backend's db handle.
 *
 * Injected into the extracted route modules through coreDeps rather than
 * imported by them, so the audit surface follows the same dependency contract as
 * auth, RBAC and realtime and cannot drift per module.
 *
 * `jsonParam` is left at its default (identity) because every audit call site is
 * on the Fly/postgres.js side, where binding the OBJECT is the correct half of
 * the two-driver rule documented on insertFeedbackReport. A Netlify caller would
 * have to pass JSON.stringify.
 *
 * Fire-and-forget: recordAuditEntry never rejects, so no caller needs to await
 * it defensively and no audit failure can turn a successful role change into a
 * 500. Awaited at the call sites anyway, so an ordinary failure reaches the log
 * in order.
 */
function recordAudit(entry) {
 return recordAuditEntry({ ...entry, db: dbUnsafe });
}
async function flowSecretKey() {
 const authSecret = await getAuthSecret();
 return crypto.createHash('sha256').update(`agensis-flow-webhook:${authSecret}`).digest();
}
// AES-256-GCM at rest for the workspace vault (and for gateway api_key_cipher,
// which shares the derivation). The derivation itself lives in the shared core:
// it prefers a dedicated SECRETS_ENCRYPTION_KEY so secrets survive an AUTH_SECRET
// rotation, and falls back to AUTH_SECRET only when unset. Both hosts must derive
// the SAME key or a secret written on one is undecryptable on the other — the
// Netlify write lane refuses rather than risk it (see backend.mjs).
//
// `loadEnvFile()` first: a locally-run server keeps SECRETS_ENCRYPTION_KEY in
// `.env`, and the core reads only process.env.
async function encryptVaultSecret(value) {
 loadEnvFile();
 return coreEncryptVaultSecret(value, { getAuthSecret });
}
async function decryptVaultSecret(value) {
 loadEnvFile();
 return coreDecryptVaultSecret(value, { getAuthSecret });
}

async function encryptFlowSecret(value) {
 const iv = crypto.randomBytes(12);
 const cipher = crypto.createCipheriv('aes-256-gcm', await flowSecretKey(), iv);
 const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
 return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

async function decryptFlowSecret(value) {
 const [iv, tag, encrypted] = String(value || '').split('.').map(part => Buffer.from(part, 'base64url'));
 if (!iv || !tag || !encrypted) throw new Error('Invalid encrypted Flows webhook secret');
 const decipher = crypto.createDecipheriv('aes-256-gcm', await flowSecretKey(), iv);
 decipher.setAuthTag(tag);
 return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function createPostgresFlowConnectionStore() {
 return {
  async insertConnection(record) {
   const rows = await getDb().unsafe(
    `insert into flow_connections
         (id, workspace_id, channel_id, name, token_hash, signing_secret_cipher,
          webhook_url, events, scopes, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
                 to_timestamp($11 / 1000.0), now()) returning *`,
    [
     record.id,
     record.workspaceId,
     record.channelId || null,
     record.name,
     record.tokenHash,
     await encryptFlowSecret(record.signingSecret),
     record.webhookUrl || null,
     record.events || [],
     record.scopes || [],
     record.createdBy || null,
     record.createdAt,
    ],
   );
   return flowConnectionRecord(rows[0]);
  },
  async findConnectionByHash(hash) {
   const rows = await getDb().unsafe('select * from flow_connections where token_hash = $1 limit 1', [hash]);
   return flowConnectionRecord(rows[0]);
  },
  async touchConnection(id, lastSeenAt) {
   const rows = await getDb().unsafe(
    'update flow_connections set last_seen_at = to_timestamp($2 / 1000.0), updated_at = now() where id = $1 returning *',
    [id, lastSeenAt],
   );
   return flowConnectionRecord(rows[0]);
  },
  async revokeConnection(id, revokedAt) {
   const rows = await getDb().unsafe(
    'update flow_connections set revoked_at = to_timestamp($2 / 1000.0), updated_at = now() where id = $1 returning *',
    [id, revokedAt],
   );
   return flowConnectionRecord(rows[0]);
  },
  async listConnections(workspaceId) {
   const rows = await getDb().unsafe(
    'select * from flow_connections where workspace_id = $1 order by created_at desc',
    [workspaceId],
   );
   return rows.map(flowConnectionRecord);
  },
 };
}

let flowConnectionCoreInstance;
function getFlowConnectionCore() {
 if (!flowConnectionCoreInstance) {
  flowConnectionCoreInstance = createFlowConnectionCore({ store: createPostgresFlowConnectionStore() });
 }
 return flowConnectionCoreInstance;
}

function jsonError(res, status, error) {
 res.status(status).json({ data: null, error: mapDbError(error) });
}

// H4 — Rate limiting. createRateLimiter is single-sourced from shared/backend-core.cjs
// (Wave 2). In-memory state remains per-process — multi-instance needs Redis later.
const aiChatRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const dispatchRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const webhookRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
// Bridge deliveries are machine traffic and legitimately bursty — a busy Slack
// channel or a Telegram group mid-argument outruns a human webhook by a lot.
const bridgeRateLimiter = createRateLimiter({ windowMs: 60_000, max: 600 });
const mcpRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
// A credentialed outbound call is not comparable to the DB reads the rest of the
// MCP surface makes: it spends a provider's rate limit, it can provision billable
// infrastructure, and a loop stuck on a 500 would hammer someone else's API with
// our key attached. Keyed per-agent, and tighter than mcpRateLimiter on purpose —
// the general MCP limiter still applies on top.
const providerCallRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
// One page view is many requests — a single site load in the spike was 230-460
// subresources — so this is sized per-page, not per-click. It exists to stop the
// route being used as a general-purpose relay, not to ration browsing.
const browserProxyRateLimiter = createRateLimiter({ windowMs: 60_000, max: 900 });
// The voice preview spends real money per press, so it is capped harder than
// anything else here. Twenty presses a minute is far more than auditioning
// voices needs and far less than a stuck retry loop would cost.
const ttsPreviewRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
const skillRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
// Join links. Two budgets, because the two halves are different risks:
//   * the PAGE is unauthenticated and public, but reading it changes nothing —
//     120/min per IP is generous and only there to stop a scrape.
//   * REDEEM is a credential-issuing surface reached with no authentication at
//     all beyond the URL itself. 10/min per IP is far above any real join (a
//     link works once, so a caller needs at most one success) and low enough
//     that guessing is hopeless: the token is 256 bits of base64url, so even
//     unlimited attempts would not find one, but the limiter is what keeps a
//     brute-force attempt from being free load on the database.
const joinLinkRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const joinRedeemRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
// The audit log read. Manage-gated already, so this is not an authorization
// control — it bounds how fast an admin (or a stolen admin session) can page the
// whole log out, which is the one cheap way to bulk-exfiltrate it.
const auditReadRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
// Plan 004 — auth hardening: signin is keyed per-email (matches the client's
// documented "5 attempts" lockout intent); signup is keyed per-IP and looser,
// to slow down bulk account creation without punishing normal signup retries.
const signinRateLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
// Per-IP FAILED-attempt limiter (L2 review): bounds credential-stuffing across
// many different emails from one host, which the per-email limiter can't catch.
const signinIpFailureLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const signupRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
const farmDeviceRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
// F9: curb email-enumeration via lookup_user_by_email — per-caller budget, on
// top of the 'manage' capability gate below.
const emailLookupRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
// CSP violation reports are browser-generated and unauthenticated, so they are
// keyed per-IP and kept cheap — a page in a redirect loop can emit a lot.
const cspReportRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const feedbackRateLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
// Tenants (the system-owner admin surface). Every request runs a DB lookup of
// the caller's own email before it is refused, so the limiter is what stops an
// authenticated non-owner turning the 403 into a free query loop. Keyed per
// caller, and low: the owner browses a list, they do not poll it.
const tenantsRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
// The DELIVERY side of owner broadcasts — read by EVERY signed-in session on
// load, not by the operator. Separate budget from tenantsRateLimiter for that
// reason: one operator browsing an admin list and every user in the deployment
// asking "is there a message for me" are not the same traffic, and sharing a
// bucket would let ordinary polling starve the admin surface (or vice versa).
const campaignMessageRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
// Voice: minting a Cartesia token and opening a Deepgram stream both cost money
// at a provider we do not control, so both are bounded per user. 20/min is far
// above a real huddle (one token per socket connect, one stream per mic unmute)
// and far below anything worth farming a token from.
const voiceTokenRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
const voiceStreamRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
// Link previews: the only route in the app where a request from a browser makes
// this machine fetch a URL that browser chose. The cache absorbs the normal case
// (one fetch per URL for the whole install, for a week), so a caller hitting this
// limit is a caller feeding it URLs nobody has posted — which is the abuse shape,
// not the product. 30 requests x 8 URLs a minute is far above scrolling a channel.
const linkPreviewRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
// The image proxy re-fetches on every cache miss in the reader's browser, so its
// budget is per-image rather than per-batch and sits higher.
const linkPreviewImageRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

// H4 follow-up — cross-instance layer. The in-memory limiters above bound a
// single warm process (fast, and enough on single-machine Fly); these DB-backed
// limiters add a shared counter so a horizontally-scaled deploy (or Netlify
// lambdas) enforces ONE budget. Layered: the in-memory check runs first (cheap
// burst protection), then the DB check (cross-instance quota). DB errors fail
// open (see createDbRateLimiter), so the in-memory layer is always a floor.
const dbQuery = (sql, params) => getDb().unsafe(sql, params);
const aiChatDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 30, db: dbQuery, namespace: 'ai-chat' });
const dispatchDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 60, db: dbQuery, namespace: 'dispatch' });
// Feedback: any signed-in user may submit, so this is the only thing standing
// between one account and an unbounded write into the System workspace's task
// list. Tight on purpose — nobody files five genuine bug reports a minute.
const feedbackDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 5, db: dbQuery, namespace: 'feedback' });
const tenantsDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 30, db: dbQuery, namespace: 'tenants' });
const campaignMessageDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 60, db: dbQuery, namespace: 'campaign-messages' });
// Outbound fetches cost this machine's time and put its IP in someone else's
// logs, so the unfurl budget is enforced across instances too, not only per warm
// process.
const linkPreviewDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 30, db: dbQuery, namespace: 'link-preview' });
const linkPreviewImageDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 120, db: dbQuery, namespace: 'link-preview-image' });
// Redemption issues a long-lived credential with no authentication in front of
// it, so its budget must hold across every Fly machine, not per warm process.
// This is the one limiter here where a single-instance bound would be a real gap.
const joinRedeemDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 10, db: dbQuery, namespace: 'join-redeem' });

// Async layered gate: returns true (and writes 429) when EITHER layer blocks.
// Callers MUST `await` this — an un-awaited call returns a truthy Promise and
// would 429 every request.
async function dbRateLimitBlocked(res, memLimiter, dbLimiter, key) {
 const k = String(key || 'unknown');
 const mem = memLimiter.check(k);
 const result = mem.allowed ? await dbLimiter.check(k) : mem;
 if (result.allowed) return false;
 const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
 res.setHeader('Retry-After', String(retryAfter));
 res.status(429).json({ data: null, error: { message: 'Rate limit exceeded. Please retry shortly.', code: 'rate_limited' } });
 return true;
}

// Returns true (and writes a 429 with Retry-After) when the key is over budget.
function rateLimitBlocked(res, limiter, key) {
 const result = limiter.check(String(key || 'unknown'));
 if (result.allowed) return false;
 const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
 res.setHeader('Retry-After', String(retryAfter));
 res.status(429).json({ data: null, error: { message: 'Rate limit exceeded. Please retry shortly.', code: 'rate_limited' } });
 return true;
}

function clientIpFromReq(req) {
 // H2 (2026-07 review): the leftmost X-Forwarded-For segment is supplied by the
 // client and trivially spoofable, so it must never key a rate limiter. Fly
 // sets Fly-Client-IP to the real client address at its edge and overwrites any
 // incoming value, so prefer it; fall back to the socket peer for local/non-Fly
 // runs (where there is no untrusted proxy in front).
 const flyClientIp = String(req.headers?.['fly-client-ip'] || '').trim();
 if (flyClientIp) return flyClientIp;
 return req.socket?.remoteAddress || req.ip || 'unknown';
}

// Plan 004 password policy: evaluatePasswordServerSide imported from shared.

function workspaceIdFromSettingsRequest(req) {
 return String(req.query?.workspaceId || req.body?.workspace_id || req.body?.workspaceId || '').trim();
}

function settingsWorkspaceIdFromRequest(req) {
 const workspaceId = workspaceIdFromSettingsRequest(req);
 return workspaceId === 'base' ? '' : workspaceId;
}

const scryptAsync = promisify(crypto.scrypt);

async function createPasswordHash(password) {
 const salt = crypto.randomBytes(16).toString('hex');
 const hash = (await scryptAsync(password, salt, 64)).toString('hex');
 return `${salt}:${hash}`;
}

async function verifyPassword(password, passwordHash) {
 if (!passwordHash || !passwordHash.includes(':')) return false;
 const [salt, storedHash] = passwordHash.split(':');
 const hash = (await scryptAsync(password, salt, 64)).toString('hex');
 const computed = Buffer.from(hash, 'hex');
 const stored = Buffer.from(storedHash, 'hex');
 // timingSafeEqual throws on a length mismatch (legacy/foreign hash formats);
 // treat any mismatch as a failed verification instead of crashing the request.
 if (computed.length !== stored.length) return false;
 return crypto.timingSafeEqual(computed, stored);
}

function resolveAnthropicModel(model) {
 const value = String(model || '').trim();
 if (!value || value === 'auto') return DEFAULT_AI_MODEL;
 return value;
}

function normalizeAgentPermissionMode(value) {
 const mode = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
 if (['yolo', 'no_sandbox', 'danger', 'danger_full_access', 'dangerously_skip_permissions'].includes(mode)) return 'yolo';
 if (['accept_edits', 'acceptedits', 'auto_approve', 'auto_approve_edits'].includes(mode)) return 'accept_edits';
 return 'default';
}

function agentPermissionFlags(permissionMode) {
 return normalizeAgentPermissionMode(permissionMode) === 'yolo' ? ['--no-sandbox', '--yolo'] : [];
}

function formatElapsedMs(ms) {
 const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
 const minutes = Math.floor(totalSeconds / 60);
 const seconds = totalSeconds % 60;
 if (minutes > 0) return `${minutes}m ${seconds}s`;
 return `${seconds}s`;
}

// The canonical implementation now lives in shared/channelMentions.cjs, beside
// the mention parser and the reserved-handle check that must agree with it — a
// handle minted here has to be the same string the parser produces from an
// @mention of it, and Netlify has to mint it identically. Kept as a wrapper
// rather than renamed at ~40 call sites.
function slugHandle(value) {
 return slugMentionHandle(value);
}

function hashAgentToken(token) {
 return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

// Invite-token lookup params (L4). $1 is always the hash of the presented token
// (matches new hashed invites). $2 is the raw presented value ONLY when it is
// NOT itself a 64-hex hash — so a real legacy plaintext token (32-char base64url)
// still matches its stored plaintext, but a stored hash leaked from the DB and
// submitted verbatim gets hashed again and matches nothing. Without this guard,
// `token in (plaintext, hash)` let a leaked stored hash authenticate as itself.
function inviteTokenLookupParams(token) {
 const hashed = hashAgentToken(token);
 const legacy = /^[a-f0-9]{64}$/i.test(String(token || '')) ? hashed : token;
 return [hashed, legacy];
}

function createAgentConnectToken() {
 return `aga_${crypto.randomBytes(32).toString('base64url')}`;
}

// --- Join links -------------------------------------------------------------
// A join link is NOT a credential. It authenticates nothing: it is absent from
// verifyMcpToken's chain, from requireAuth, and from every other verify* in this
// file. The only thing holding one lets you do is redeem it, once, at its own
// endpoint — which then provisions the real credential server-side.
//
// The `agj_` prefix is not decoration. It makes a leaked link greppable in a
// transcript, a CI log or a secret scanner, and it lets a malformed token be
// rejected before it costs a database round trip.

function createJoinLinkToken() {
 return `agj_${crypto.randomBytes(32).toString('base64url')}`;
}

// Shape check only — cheap, and it means garbage in the URL path never reaches
// Postgres. A token that fails this is treated EXACTLY like one that fails the
// lookup: same status, same body, same page. (See joinLinkRefused.)
function isJoinLinkToken(value) {
 return /^agj_[A-Za-z0-9_-]{32,128}$/.test(String(value || ''));
}

// How long a join link lives.
//
// FIFTEEN MINUTES, and the reasoning is the whole point of this feature:
//
// A join link is handed over in a live exchange — pasted into a chat, read out
// in a call, dropped into an agent's prompt. Every one of those completes in
// well under fifteen minutes. Nothing legitimate needs longer, because the link
// is not something you keep: the moment it works, it is spent, and what you keep
// afterwards is your own session (human) or your own bearer token (agent).
//
// What the short window buys is the failure case. The incident that produced
// this feature was a credential pasted into a transcript. Transcripts get saved,
// summarised, replayed into other models, and read by people days later. A
// 14-day invite link (which is what workspace_invites still is, AND which is a
// live MCP bearer for that whole window) pasted into one is a standing door. The
// same paste of a join link is, fifteen minutes later, a dead string.
//
// Overridable for deployments that need a courier window, clamped to [1m, 24h]:
// below a minute it would fail honest users on a slow sign-up, and a link that
// outlives a day has stopped being short-lived in any meaningful sense.
const JOIN_LINK_DEFAULT_TTL_MS = 15 * 60_000;
const JOIN_LINK_MIN_TTL_MS = 60_000;
const JOIN_LINK_MAX_TTL_MS = 24 * 60 * 60_000;
function joinLinkTtlMs() {
 const raw = Number(process.env.AGENSIS_JOIN_LINK_TTL_MS);
 if (!Number.isFinite(raw) || raw <= 0) return JOIN_LINK_DEFAULT_TTL_MS;
 return Math.min(JOIN_LINK_MAX_TTL_MS, Math.max(JOIN_LINK_MIN_TTL_MS, Math.round(raw)));
}

// Read a join link for DISPLAY only. Returns a row only for a link that is still
// live; expired / revoked / already-redeemed all come back null, so the page
// route has one nullish branch and therefore one rendering for every way a link
// can be dead. Selects no token column: only the hash is stored, and even that
// stays here.
async function loadJoinLinkForDisplay(token) {
 const rows = await getDb().unsafe(
  `select l.id, l.workspace_id, l.role, l.label, l.audience, l.expires_at,
            w.name as workspace_name
       from workspace_join_links l
       join workspaces w on w.id = l.workspace_id
      where l.token_hash = $1
        and l.status = 'pending'
        and l.expires_at > now()
      limit 1`,
  [hashAgentToken(token)],
 );
 return rows[0] || null;
}

// Pick a handle that is not already taken in this workspace.
//
// workspace_agents has an INDEX on (workspace_id, handle) but no unique
// constraint, so a collision does not throw — it silently creates a second
// @backend, and every @mention of it becomes ambiguous. That risk is specific to
// self-service joining: the farm enrolment path takes an operator-supplied
// handle, whereas a join link is redeemed by whoever holds the URL, choosing
// their own name, with nobody looking. Hence the dedupe lives here.
//
// Capped at 50 attempts and then allowed through: an unresolvable handle must
// not fail a redemption that has already consumed the link.
async function uniqueAgentHandle(workspaceId, desired) {
 const base = slugHandle(desired) || 'agent';
 const rows = await getDb().unsafe(
  'select handle, name from workspace_agents where workspace_id = $1',
  [workspaceId],
 );
 const taken = new Set(rows.map((row) => slugHandle(row.handle || row.name)));
 if (!taken.has(base)) return base;
 for (let n = 2; n <= 50; n += 1) {
  const candidate = `${base}-${n}`;
  if (!taken.has(candidate)) return candidate;
 }
 return base;
}

// Audit. Records the link's ID, never its token — the id is a database key that
// grants nothing, the token is the credential. Fire-and-forget in the sense that
// a failed audit write must not fail a redemption the user already completed,
// but it is awaited so an ordinary failure still surfaces in the server log.
async function logJoinLinkActivity({ workspaceId, userId = null, eventType, title, metadata = {} }) {
 try {
  if (!workspaceId) return;
  const inserted = await getDb().unsafe(
   `insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
      values ($1, $2, $3, 'join_link', $4, $5, $6::jsonb, now())
      returning *`,
   // Bind the OBJECT: a stringified ::jsonb bind lands as a jsonb string scalar
   // on porsager (tests/jsonb-bind-hygiene.test.cjs).
   [workspaceId, userId, eventType, metadata.join_link_id || null, String(title).slice(0, 120), metadata],
  );
  if (inserted.length > 0) notifyDbSubscribers('activity_events', 'INSERT', inserted);
 } catch (error) {
  // No token is in scope here to leak, and none is passed in.
  console.error('[agensis] join link activity write failed:', error?.message || error);
 }
}

function createCursorBuddyConnectionKey(surface = 'machine') {
 const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
 const bytes = crypto.randomBytes(18);
 let suffix = '';
 for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
 const normalizedSurface = String(surface || 'machine')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 32) || 'machine';
 return `cbk_${normalizedSurface}_${suffix}`;
}

function normalizeCursorBuddySurface(value) {
 const surface = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
 if (['website_avatar', 'browser_extension', 'extension', 'local_cli', 'cli', 'desktop_app', 'desktop', 'machine', 'embedded_site', 'embedded'].includes(surface)) {
  if (surface === 'extension') return 'browser_extension';
  if (surface === 'cli') return 'local_cli';
  if (surface === 'desktop') return 'desktop_app';
  if (surface === 'embedded') return 'embedded_site';
  return surface;
 }
 return 'machine';
}

function normalizeCursorBuddyScope(value) {
 const scope = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
 if (['machine', 'global', 'domain', 'embedded', 'workspace'].includes(scope)) return scope;
 return 'machine';
}

function normalizeCursorBuddyDomain(value) {
 return String(value || '')
  .trim()
  .toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/\/.*$/, '')
  .replace(/[^a-z0-9._-]+/g, '')
  .slice(0, 255);
}

function publicWorkspace(row) {
 if (!row) return row;
 return {
  id: row.id,
  name: row.name,
  description: row.description || '',
  // The workspace switcher rail paints `icon` (an emoji) on each tile and
  // groups `is_system` apart. Both must survive this projection — the rail
  // reads the list route, and a dropped column shows up as a wall of
  // identical initials rather than as an error.
  icon: row.icon || '',
  is_system: row.is_system === true,
  // Groupable workspaces: null = top level, otherwise the group this workspace
  // sits inside. No UI reads it yet — it is here so the client already receives
  // the shape, because `icon` and `is_system` were BOTH missing from this
  // projection while the columns existed, and the rail silently degraded
  // instead of erroring.
  parent_id: row.parent_id || null,
  local_path: row.local_path || '',
  project_kind: row.project_kind || '',
  git_root: row.git_root || '',
  git_remote: row.git_remote || '',
  role: row.role || 'viewer',
  created_at: row.created_at,
  updated_at: row.updated_at,
 };
}

function publicCursorBuddyConnectionKey(row) {
 if (!row) return row;
 return {
  id: row.id,
  workspace_id: row.workspace_id,
  agent_id: row.agent_id,
  created_by: row.created_by,
  name: row.name,
  surface: row.surface,
  scope: row.scope,
  domain: row.domain,
  status: row.status,
  metadata: parseJsonObject(row.metadata),
  expires_at: row.expires_at,
  claimed_at: row.claimed_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
 };
}

async function ensureCursorBuddyAgentForKey(connectionKey, claim = {}) {
 if (connectionKey?.agent_id) {
  const rows = await getDb().unsafe(
   'select * from workspace_agents where id = $1 and workspace_id = $2 limit 1',
   [connectionKey.agent_id, connectionKey.workspace_id],
  );
  if (rows[0]) return rows[0];
 }

 const surface = normalizeCursorBuddySurface(connectionKey?.surface || claim.surface);
 const scope = normalizeCursorBuddyScope(connectionKey?.scope || claim.scope);
 const label = String(connectionKey?.name || claim.name || 'CursorBuddy runtime').trim().slice(0, 80) || 'CursorBuddy runtime';
 const handleBase = scope === 'domain' && connectionKey?.domain
  ? `cursorbuddy-${connectionKey.domain.replace(/[^a-z0-9]+/g, '-')}`
  : `cursorbuddy-${surface.replace(/_/g, '-')}`;
 const handle = slugHandle(handleBase);
 const existingRows = await getDb().unsafe(
  'select * from workspace_agents where workspace_id = $1 and handle = $2 limit 1',
  [connectionKey.workspace_id, handle],
 );
 if (existingRows[0]) return existingRows[0];

 const metadata = {
  runtime: 'cursorbuddy',
  surface,
  scope,
  domain: connectionKey?.domain || '',
  host: String(claim.host || '').trim().slice(0, 160),
  cwd: String(claim.cwd || '').trim().slice(0, 500),
 };
 const rows = await getDb().unsafe(
  `insert into workspace_agents
       (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, avatar, accent_color, enabled, created_by, tools, skills, metadata)
     values
       ($1, $2, $3, $4, $5, 'auto', 'daemon', $6, 'AI', '#ffe04a', true, $7, $8::jsonb, $9::jsonb, $10::jsonb)
     returning *`,
  [
   connectionKey.workspace_id,
   label,
   handle,
   `CursorBuddy ${surface.replace(/_/g, ' ')} runtime connected through Agensis.`,
   'You are CursorBuddy, a local-machine agent connected through Agensis. Route browser, desktop, and embedded-site context through the hub, use local source paths when authorized, and keep all actions logged.',
   normalizeAgentPermissionMode(claim.permissionMode || claim.permission_mode || 'default'),
   connectionKey.created_by || null,
   ['cursorbuddy'],
   ['cursorbuddy', 'local-source-edit', 'surface-routing', 'agent-mesh'],
   { cursorbuddyRuntime: metadata },
  ],
 );
 notifyDbSubscribers('workspace_agents', 'INSERT', rows);
 return rows[0];
}

function cursorBuddyProviderAgentMetadata(body = {}, userId = '') {
 const requestMetadata = parseJsonObject(body?.metadata);
 const page = parseJsonObject(body?.page || requestMetadata.page);
 const client = parseJsonObject(body?.client || requestMetadata.client);
 const manifest = parseJsonObject(body?.manifest || requestMetadata.manifest);
 const runtime = parseJsonObject(requestMetadata.runtime);
 const surface = normalizeCursorBuddySurface(body?.surface || runtime.surface || requestMetadata.surface);
 const scope = normalizeCursorBuddyScope(body?.scope || requestMetadata.scope);
 const domain = normalizeCursorBuddyDomain(body?.domain || page.hostname || requestMetadata.domain);
 const websiteSource = String(body?.websiteSource || requestMetadata.websiteSource || page.url || '').trim().slice(0, 2048);
 return {
  surface,
  scope,
  domain,
  metadata: {
   ...requestMetadata,
   requestedBy: userId,
   setup: 'cursorbuddy-provider',
   provider: 'cursorbuddy',
   mode: 'built_in_provider',
   runtimeKind: String(body?.runtimeKind || requestMetadata.runtimeKind || 'cursorbuddy-provider').trim().slice(0, 80),
   websiteSource,
   page,
   client,
   manifest,
  },
 };
}

function mergeCursorBuddyProviderMetadata(existingAgent, nextMetadata) {
 const existingTool = parseJsonArray(existingAgent?.tools).find(tool => (
  tool && tool.type === 'provider' && tool.name === 'cursorbuddy'
 ));
 const existingAgentMetadata = parseJsonObject(existingAgent?.metadata);
 const previousMetadata = {
  ...parseJsonObject(existingTool?.metadata),
  ...parseJsonObject(existingAgentMetadata.cursorbuddyProvider),
 };
 const merged = { ...previousMetadata, ...nextMetadata };
 if (!nextMetadata.websiteSource && previousMetadata.websiteSource) merged.websiteSource = previousMetadata.websiteSource;
 for (const key of ['page', 'client', 'manifest']) {
  const nextObject = parseJsonObject(nextMetadata[key]);
  const previousObject = parseJsonObject(previousMetadata[key]);
  if (Object.keys(nextObject).length === 0 && Object.keys(previousObject).length > 0) {
   merged[key] = previousObject;
  }
 }
 return merged;
}

async function ensureCursorBuddyProviderAgent({ workspaceId, userId, body = {} }) {
 const { scope, domain, metadata } = cursorBuddyProviderAgentMetadata(body, userId);
 const resolvedScope = scope === 'domain' && domain ? 'domain' : scope === 'global' ? 'global' : 'workspace';
 metadata.providerScope = resolvedScope;
 const label = resolvedScope === 'domain'
  ? `CursorBuddy Provider ${domain}`
  : resolvedScope === 'global'
   ? 'CursorBuddy Provider Global'
   : 'CursorBuddy Provider Workspace';
 const handle = slugHandle(resolvedScope === 'domain'
  ? `cursorbuddy-provider-${domain.replace(/[^a-z0-9]+/g, '-')}`
  : resolvedScope === 'global'
   ? 'cursorbuddy-provider-global'
   : 'cursorbuddy-provider-workspace');
 const existingRows = await getDb().unsafe(
  'select * from workspace_agents where workspace_id = $1 and handle = $2 limit 1',
  [workspaceId, handle],
 );
 if (existingRows[0]) {
  const mergedMetadata = mergeCursorBuddyProviderMetadata(existingRows[0], metadata);
  const rows = await getDb().unsafe(
   `update workspace_agents
       set name = coalesce(nullif(name, ''), $2),
           description = $3,
           system_prompt = $4,
           model = 'auto',
           run_mode = 'builtin',
           permission_mode = 'default',
           enabled = true,
           tools = $5::jsonb,
           skills = $6::jsonb,
           metadata = $7::jsonb,
           updated_at = now(),
           version = coalesce(version, 0) + 1
       where id = $1
       returning *`,
   [
    existingRows[0].id,
    label,
    'Built-in CursorBuddy Provider agent for hosted Agensis inference.',
    'You are CursorBuddy Provider, a built-in Agensis agent for the CursorBuddy avatar. Use supplied browser, page, and site metadata to answer through the avatar. Prefer concise, directly useful guidance. Do not claim local machine access unless a local bridge is connected.',
    ['cursorbuddy'],
    ['cursorbuddy', 'surface-routing', 'agent-mesh'],
    { ...parseJsonObject(existingRows[0].metadata), cursorbuddyProvider: mergedMetadata },
   ],
  );
  notifyDbSubscribers('workspace_agents', 'UPDATE', rows);
  return rows[0];
 }

 const rows = await getDb().unsafe(
  `insert into workspace_agents
       (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, avatar, accent_color, enabled, created_by, tools, skills, metadata)
     values
       ($1, $2, $3, $4, $5, 'auto', 'builtin', 'default', 'CB', '#6fd6e8', true, $6, $7::jsonb, $8::jsonb, $9::jsonb)
     returning *`,
  [
   workspaceId,
   label,
   handle,
   'Built-in CursorBuddy Provider agent for hosted Agensis inference.',
   'You are CursorBuddy Provider, a built-in Agensis agent for the CursorBuddy avatar. Use supplied browser, page, and site metadata to answer through the avatar. Prefer concise, directly useful guidance. Do not claim local machine access unless a local bridge is connected.',
   userId || null,
   ['cursorbuddy'],
   ['cursorbuddy', 'surface-routing', 'agent-mesh'],
   { cursorbuddyProvider: metadata },
  ],
 );
 notifyDbSubscribers('workspace_agents', 'INSERT', rows);
 return rows[0];
}

async function resolveSetupWorkspace(userId, requestedWorkspaceId = '') {
 const requested = String(requestedWorkspaceId || '').trim();
 if (requested) {
  await enforceWorkspaceRole(userId, requested, 'manage');
  return requested;
 }

 const rows = await getDb().unsafe(
  `select w.id
     from workspaces w
     left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = $1
     where w.user_id = $1 or (wm.user_id = $1 and wm.role in ('owner', 'admin'))
     order by w.user_id = $1 desc, w.created_at asc
     limit 1`,
  [userId],
 );
 if (rows[0]?.id) return rows[0].id;

 const created = await getDb().unsafe(
  `insert into workspaces (name, description, icon, user_id)
     values ('Work', 'Primary Agensis workspace', 'home', $1)
     returning id`,
  [userId],
 );
 const workspaceId = created[0].id;
 await seedDefaultAgents(workspaceId, userId);
 return workspaceId;
}

async function ensurePrimaryDaemonAgent({ workspaceId, userId, handle, name, host, cwd, permissionMode }) {
 const resolvedHandle = slugHandle(handle || host || 'agensis');
 const resolvedName = String(name || host || 'Agensis daemon').trim().slice(0, 80) || 'Agensis daemon';
 const existing = await getDb().unsafe(
  'select * from workspace_agents where workspace_id = $1 and handle = $2 limit 1',
  [workspaceId, resolvedHandle],
 );
 if (existing[0]) return existing[0];

 const metadata = {
  runtime: 'agensis-cli',
  host: String(host || '').trim().slice(0, 160),
  cwd: String(cwd || '').trim().slice(0, 500),
  primary: true,
 };
 const rows = await getDb().unsafe(
  `insert into workspace_agents
       (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, avatar, accent_color, enabled, created_by, tools, skills)
     values
       ($1, $2, $3, $4, $5, 'auto', 'daemon', $6, 'AI', '#ffe04a', true, $7, $8::jsonb, $9::jsonb)
     returning *`,
  [
   workspaceId,
   resolvedName,
   resolvedHandle,
   'Primary local Agensis CLI daemon for this machine.',
   'You are the primary local Agensis daemon for this machine. Coordinate local CLIs, CursorBuddy surfaces, browser extensions, desktop clients, and subagents through Agensis. Keep actions logged and route source edits through the authorized local checkout.',
   normalizeAgentPermissionMode(permissionMode || 'default'),
   userId,
   [{ type: 'runtime', name: 'agensis-cli', metadata }],
   ['primary-daemon', 'cursorbuddy', 'agent-mesh', 'local-source-edit'],
  ],
 );
 notifyDbSubscribers('workspace_agents', 'INSERT', rows);
 return rows[0];
}

function normalizeBaseUrl(value) {
 const text = String(value || '').trim().replace(/\/+$/, '');
 if (!text) return '';
 try {
  const url = new URL(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
 } catch {
  return '';
 }
}

function normalizeAgentBackendBaseUrl(value) {
 const baseUrl = normalizeBaseUrl(value);
 if (!baseUrl) return '';
 try {
  const url = new URL(baseUrl);
  if (
   (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0')
   && (url.port === '8888' || url.port === '5173')
  ) {
   url.protocol = 'http:';
   url.hostname = '127.0.0.1';
   url.port = String(DEFAULT_PORT);
  }
  return url.toString().replace(/\/+$/, '');
 } catch {
  return baseUrl;
 }
}

function requestBaseUrl(req) {
 const publicUrl = normalizeBaseUrl(process.env.AGENSIS_PUBLIC_URL || process.env.PUBLIC_URL || '');
 if (publicUrl) return publicUrl;
 const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
 const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
 const proto = forwardedProto || req.protocol || 'http';
 const host = forwardedHost || req.get('host') || `127.0.0.1:${DEFAULT_PORT}`;
 return `${proto}://${host}`;
}

function shellQuote(value) {
 const text = String(value || '');
 if (/^[A-Za-z0-9_/:.,=@%+-]+$/.test(text)) return text;
 return `'${text.replace(/'/g, `'\\''`)}'`;
}

function normalizeExecutionRuntime(value) {
 const runtime = String(value || '').trim().toLowerCase();
 return runtime === 'claude' || runtime === 'codex' || runtime === 'amp' ? runtime : '';
}

function resolveExecutionModel(model, runtime) {
 const value = String(model || '').trim();
 return runtime && runtime !== 'claude'
  ? (value || 'auto')
  : resolveAnthropicModel(value);
}

function agentConnectionCommand({ baseUrl, token, workspaceId, agentId, handle, name, model, permissionMode, runtime = null, profile = null }) {
 const resolvedRuntime = normalizeExecutionRuntime(runtime);
 const resolvedModel = resolveExecutionModel(model, resolvedRuntime);
 const resolvedPermissionMode = normalizeAgentPermissionMode(permissionMode);
 const commandPermissionArgs = ['--permission-mode', shellQuote(resolvedPermissionMode)];
 const commandModelArgs = resolvedRuntime === 'amp' || (resolvedRuntime === 'codex' && resolvedModel === 'auto')
  ? []
  : ['--model', shellQuote(resolvedModel)];
 const displayName = String(name || handle || 'Agensis Agent').trim() || 'Agensis Agent';
 const profileName = profile === false ? '' : slugHandle(profile || handle || displayName || 'agent');
 if (resolvedPermissionMode === 'yolo') {
  commandPermissionArgs.push('--no-sandbox');
 }
 const portableCommand = [
  'agensis',
  'connect',
  ...(profileName ? ['--profile', shellQuote(profileName)] : []),
  ...(resolvedRuntime ? ['--runtime', shellQuote(resolvedRuntime)] : []),
  '--url',
  shellQuote(baseUrl),
  '--token',
  shellQuote(token),
  '--workspace',
  shellQuote(workspaceId),
  '--agent',
  shellQuote(agentId),
  '--handle',
  shellQuote(handle),
  '--name',
  shellQuote(displayName),
  ...commandModelArgs,
  ...commandPermissionArgs,
 ].join(' ');
 return { localCommand: portableCommand, portableCommand };
}

// Mint a daemon connect token for an agent and return the full connect payload
// (command + one-time token + resolved settings). Shared by the HTTP
// connection-command route and the MCP `get_connect_command` tool so the two can
// never drift. Side effects: ROTATES the agent's connect token (any running daemon
// must be restarted with the new one) and flips run_mode to 'daemon' so a connected
// daemon takes over from the builtin server runner. Authorization is the caller's
// responsibility (HTTP route enforces manage role; MCP scopes by workspace token).
// `actorUserId` is threaded in by every caller that has a verified session, for
// the audit row at the end. It is recorded HERE rather than at the four call
// sites so a new way to mint a token cannot ship without an audit row — an
// unattributed mint ('' actor) is still a recorded mint, which is the property
// that matters. Note the connect token itself is minted in this function and is
// never, anywhere below, put in the audit row.
async function buildAgentConnectionCommand({ agentId, workspaceId = null, handle = null, model = null, permissionMode = null, baseUrl = null, profile = null, actorUserId = null } = {}) {
 const id = String(agentId || '').trim();
 if (!id) throw new Error('agentId is required');
 const rows = await getDb().unsafe('select * from workspace_agents where id = $1 limit 1', [id]);
 const agent = rows[0];
 if (!agent) throw new Error('Agent not found');
 if (workspaceId && agent.workspace_id !== workspaceId) throw new Error('Agent is not in this workspace');
 if (!isAgentEnabled(agent)) throw new Error('Agent is deactivated');
 const token = createAgentConnectToken();
 const resolvedHandle = slugHandle(handle || agent.handle || agent.name);
 const resolvedRuntime = normalizeExecutionRuntime(parseJsonObject(agent.metadata).runtime);
 const resolvedModel = resolveExecutionModel(model || agent.model, resolvedRuntime);
 // F7: do NOT silently escalate. An unspecified mode stays 'default' (least
 // privilege), matching the Netlify connect path (normalizeAgentPermissionMode).
 // A caller wanting full host access must pass permission_mode: 'yolo' explicitly.
 const resolvedPermissionMode = normalizeAgentPermissionMode(permissionMode || agent.permission_mode);
 const updateRows = await getDb().unsafe(
  `update workspace_agents
     set handle = $2,
         connect_token_hash = $3,
         run_mode = 'daemon',
         model = $4,
         permission_mode = $5,
         updated_at = now(),
         version = coalesce(version, 0) + 1
     where id = $1
     returning *`,
  [id, resolvedHandle, hashAgentToken(token), resolvedModel, resolvedPermissionMode],
 );
 notifyDbSubscribers('workspace_agents', 'UPDATE', updateRows);
 // A connect token is a real credential: it is the daemon's whole identity, and
 // this UPDATE also (re)sets permission_mode, so a mint is how an agent can end
 // up in 'yolo'. Recorded: the agent, its handle, and the RESULTING mode.
 // Never recorded: the token, and never its hash either.
 await recordAudit({
  workspaceId: agent.workspace_id ? String(agent.workspace_id) : null,
  actor: { userId: actorUserId ? String(actorUserId) : '' },
  action: 'agent.connect_token_minted',
  target: { type: 'agent', id, label: resolvedHandle },
  before: String(agent.permission_mode || ''),
  after: resolvedPermissionMode,
  detail: { handle: resolvedHandle, model: resolvedModel, runtime: resolvedRuntime || '' },
 });
 const resolvedBaseUrl = normalizeAgentBackendBaseUrl(baseUrl)
  || normalizeAgentBackendBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
  || '';
 const commands = agentConnectionCommand({
  baseUrl: resolvedBaseUrl,
  token,
  workspaceId: agent.workspace_id,
  agentId: id,
  handle: resolvedHandle,
  name: updateRows[0]?.name || agent.name,
  model: resolvedModel,
  permissionMode: resolvedPermissionMode,
  runtime: resolvedRuntime,
  profile: profile === null ? resolvedHandle : profile,
 });
 return {
  agent: updateRows[0],
  handle: resolvedHandle,
  token,
  command: commands.portableCommand,
  localCommand: commands.localCommand,
  portableCommand: commands.portableCommand,
  baseUrl: resolvedBaseUrl,
  model: resolvedModel,
  permissionMode: resolvedPermissionMode,
  permission_mode: resolvedPermissionMode,
  runtime: resolvedRuntime || null,
  permissionFlags: agentPermissionFlags(resolvedPermissionMode),
 };
}

async function verifyAgentConnectToken(token, req = null) {
 if (!token || typeof token !== 'string') return null;
 const rows = await getDb().unsafe(
  `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, identity, model, handle, run_mode, sandbox_provider, sandbox_config, memory_dir, permission_mode, version, enabled, created_by
     from workspace_agents
     where connect_token_hash = $1
     limit 1`,
  [hashAgentToken(token)],
 );
 let agent = rows[0];
 if (!agent && allowLoopbackAgentDevFallback(req, token)) {
  const { workspaceId, agentId } = agentIdsFromWsRequest(req);
  if (workspaceId && agentId) {
   const fallbackRows = await getDb().unsafe(
    `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, identity, model, handle, run_mode, sandbox_provider, sandbox_config, memory_dir, permission_mode, version, enabled, created_by
         from workspace_agents
         where id = $1 and workspace_id = $2
         limit 1`,
    [agentId, workspaceId],
   );
   agent = fallbackRows[0];
   if (agent) console.warn('[agensis] Using loopback-only dev agent auth fallback for', agent.id);
  }
 }
 if (!agent || !isAgentEnabled(agent)) return null;
 return {
  kind: 'agent',
  agentId: agent.id,
  workspaceId: agent.workspace_id,
  name: agent.name,
  handle: agent.handle || slugHandle(agent.name),
  agent: agentRuntimePayload(agent),
 };
}

// The SAME invite link a human accepts can be used by an MCP client as its Bearer.
// It grants workspace access; the client then works AS an agent (claim_job { as }).
async function verifyInviteToken(token) {
 if (!token || typeof token !== 'string') return null;
 const rows = await getDb().unsafe(
  // Dual-path (L4): new invites store the token hash; legacy invites store the
  // plaintext. Match either so both keep working during the transition.
  // F8 (P7): only a still-pending invite may authenticate as an MCP bearer — once
  // accepted (single-use consume in the /invites/:token/accept route) the link dies
  // as a live 14-day credential; the human keeps access via their own session token.
  `select id, workspace_id, email, role from workspace_invites
      where token in ($1, $2) and status = 'pending'
        and (expires_at is null or expires_at > now())
      limit 1`,
  inviteTokenLookupParams(token),
 );
 const invite = rows[0];
 if (!invite) return null;
 // An invite link is pre-authorization → a client joining through it is auto-approved.
 return { kind: 'invite', workspaceId: invite.workspace_id, inviteId: invite.id, name: invite.email || 'MCP client', autoApprove: true, role: invite.role };
}

// The one workspace MCP token (issued in settings). Authenticates any client into the
// workspace; the client then registers as an agent (popup approval unless auto-approve).
async function verifyWorkspaceMcpToken(token) {
 if (!token || typeof token !== 'string') return null;
 const rows = await getDb().unsafe(
  `select id, user_id, mcp_auto_approve from workspaces where mcp_token_hash = $1 and mcp_token_hash <> '' limit 1`,
  [hashAgentToken(token)],
 );
 const ws = rows[0];
 if (!ws) return null;
 // ownerUserId is what this token reads PRIVATE sessions as (mcpSubjectUserId in
 // server/mcp.cjs). The workspace token is the workspace's own credential, so
 // reading as its owner is what it already is — not an elevation. Without it,
 // pointing an MCP client at your own workspace would stop being able to open
 // your own DMs.
 return {
  kind: 'workspace',
  workspaceId: ws.id,
  ownerUserId: ws.user_id || '',
  name: 'MCP client',
  autoApprove: Boolean(ws.mcp_auto_approve),
 };
}

// "Agensis login": the client authenticates with the user's own auth token. Resolves to
// the workspace they own (the common case is one). Registrations still pop up for them.
async function verifyUserAuthMcpToken(token) {
 const userId = await verifyToken(token);
 if (!userId) return null;
 const rows = await getDb().unsafe(
  'select id, mcp_auto_approve from workspaces where user_id = $1 order by created_at asc limit 1',
  [userId],
 );
 const ws = rows[0];
 if (!ws) return null;
 return { kind: 'user', userId, workspaceId: ws.id, name: 'MCP client', autoApprove: Boolean(ws.mcp_auto_approve) };
}

async function verifyFlowConnectionToken(token) {
 if (!String(token || '').startsWith('agx_')) return null;
 try {
  return await getFlowConnectionCore().authenticate(token);
 } catch (error) {
  if (error && error.status === 401) return null;
  throw error;
 }
}

// The MCP endpoint accepts, in priority order: a per-agent connect token (acts AS that
// agent), the one workspace MCP token, an invite link (auto-approve), or the user's
// agensis login. The latter three authenticate into the workspace; the client then
// calls register_agent to become an agent.
async function verifyMcpToken(token, req = null) {
 return (await verifyAgentConnectToken(token, req))
  || (await verifyFlowConnectionToken(token))
  || (await verifyWorkspaceMcpToken(token))
  || (await verifyInviteToken(token))
  || (await verifyUserAuthMcpToken(token));
}

function createWorkspaceMcpToken() {
 return `agw_${crypto.randomBytes(32).toString('base64url')}`;
}

// In-memory MCP presence: which agents have a live MCP poller right now. A client
// "working as @q" stamps this every time it polls claim_job; dispatch enqueues a pull
// job when an agent is present, and any number of polling clients drain that queue —
// so "3× Q all working as Q" just works. Process-local, like the daemon connection map.

async function resolveWorkspaceAgentByHandle(workspaceId, handle) {
 if (!handle) return null;
 const wanted = slugHandle(handle);
 const rows = await getDb().unsafe(
  'select * from workspace_agents where workspace_id = $1 and enabled = true',
  [workspaceId],
 );
 return rows.find((a) => slugHandle(a.handle || a.name) === wanted) || null;
}

function agentTokenFromWsRequest(req) {
 try {
  const url = new URL(req.url || '', 'http://localhost');
  return url.searchParams.get('agentToken') || '';
 } catch {
  return '';
 }
}

function agentIdsFromWsRequest(req) {
 try {
  const url = new URL(req?.url || '', 'http://localhost');
  return {
   workspaceId: url.searchParams.get('workspaceId') || '',
   agentId: url.searchParams.get('agentId') || '',
  };
 } catch {
  return { workspaceId: '', agentId: '' };
 }
}

function allowLoopbackAgentDevFallback(req, token) {
 if (process.env.NODE_ENV === 'production') return false;
 if (!String(token || '').startsWith('aga_')) return false;
 const remote = req?.socket?.remoteAddress || '';
 return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function publicAgentConnection(row) {
 if (!row) return row;
 const capabilities = parseJsonObject(row.capabilities);
 // Direct-reach (LAN ip/port) is daemon-only — NEVER publish it to browsers. It rides
 // agent_connections.capabilities.reach (agent-mesh F2) and reaches peer daemons only
 // via the hub peer_list channel (F7). Every browser-facing row (INSERT/UPDATE/DELETE
 // notify + REST) funnels through here, so strip it once, here.
 if (capabilities && typeof capabilities === 'object') delete capabilities.reach;
 // A fresh connection stores a null/partial capabilities blob before the daemon pushes its
 // full payload. Backfill the array fields the browser treats as always-present (AgentCapabilities
 // declares skills/clis/mcpServers as required arrays) so it can never read `.length` of undefined.
 capabilities.skills = Array.isArray(capabilities.skills) ? capabilities.skills : [];
 capabilities.clis = Array.isArray(capabilities.clis) ? capabilities.clis : [];
 capabilities.mcpServers = Array.isArray(capabilities.mcpServers) ? capabilities.mcpServers : [];
 capabilities.sharedModels = sharedModelsFromMessage(capabilities.sharedModels);
 return {
  id: row.id,
  workspace_id: row.workspace_id,
  agent_id: row.agent_id,
  name: row.name,
  handle: row.handle,
  host: row.host,
  cwd: row.cwd,
  status: row.status,
  metadata: parseJsonObject(row.metadata),
  capabilities,
  connected_at: row.connected_at,
  last_seen_at: row.last_seen_at,
  updated_at: row.updated_at,
 };
}

function publicFarmEnrolledAgent(row) {
 if (!row) return row;
 const { connect_token_hash: _connectTokenHash, ...agent } = row;
 return agent;
}

function parseJsonObject(value) {
 if (!value) return {};
 if (Array.isArray(value)) {
  // jsonb `string || string` concatenation corrupts an object into an array of
  // JSON-string fragments (seen on agent_jobs.metadata after a delta update).
  // Merge the fragments back so callers still read the original keys.
  return value.reduce((acc, part) => Object.assign(acc, parseJsonObject(part)), {});
 }
 if (typeof value === 'object') return value;
 if (typeof value !== 'string') return {};
 try {
  const parsed = JSON.parse(value);
  if (Array.isArray(parsed)) return parseJsonObject(parsed);
  return parsed && typeof parsed === 'object' ? parsed : {};
 } catch {
  return {};
 }
}

function parseJsonArray(value) {
 if (Array.isArray(value)) return value;
 if (typeof value !== 'string') return [];
 try {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
 } catch {
  return [];
 }
}

function isAgentEnabled(agent) {
 return agent?.enabled !== false;
}









function agentRuntimePayload(agent) {
 if (!agent) return null;
 const permissionMode = normalizeAgentPermissionMode(agent.permission_mode || agent.permissionMode);
 return {
  id: agent.id,
  workspace_id: agent.workspace_id,
  name: agent.name,
  avatar: agent.avatar || 'AI',
  openpet_avatar_id: agent.openpet_avatar_id || '',
  // Selected by every agents query but previously dropped here, so a reload
  // blanked the accent until a realtime row happened to restore it.
  accent_color: agent.accent_color || '',
  handle: agent.handle || slugHandle(agent.name),
  description: agent.description || '',
  system_prompt: agent.system_prompt || '',
  soul: agent.soul || '',
  instructions: agent.instructions || '',
  tools: parseJsonArray(agent.tools),
  skills: parseJsonArray(agent.skills),
  metadata: parseJsonObject(agent.metadata),
  // { voice, human_set } — see shared/agentIdentity.cjs. Every explicit
  // workspace_agents select above lists `identity` too; a column left out of
  // one of them reads blank in exactly one screen, which is how host_folders
  // and canvas_id each got shipped broken.
  identity: parseJsonObject(agent.identity),
  model: resolveAnthropicModel(agent.model),
  run_mode: agent.run_mode === 'daemon' ? 'daemon'
   : agent.run_mode === 'sandbox' ? 'sandbox'
    : 'builtin',
  sandbox_provider: agent.sandbox_provider || null,
  sandbox_config: parseJsonObject(agent.sandbox_config),
  permissionMode,
  permission_mode: permissionMode,
  permissionFlags: agentPermissionFlags(permissionMode),
  version: Number(agent.version || 0),
  enabled: isAgentEnabled(agent),
 };
}

/** Caps for workspace bootstrap snapshot lists (cold-load fan-in). */
const BOOTSTRAP_LIMITS = {
 agents: 200,
 sessions: 200,
 documents: 100,
 tasks: 200,
 files: 100,
 connections: 100,
 memoryFacts: 100,
};

/**
 * Single workspace snapshot for SPA cold load. Metadata only for docs/files
 * (no full document bodies / file bytes). Messages stay per-session lazy.
 */
async function buildWorkspaceBootstrap(workspaceId, userId) {
 const db = getDb();
 const [
  workspaceRows,
  agentRows,
  sessionRows,
  documentRows,
  taskRows,
  fileRows,
  connectionRows,
  memoryRows,
 ] = await Promise.all([
  db.unsafe(
   `select w.id, w.name, w.description, w.local_path, w.project_kind, w.git_root, w.git_remote,
              w.created_at, w.updated_at,
              case when w.user_id = $2 then 'owner' else coalesce(wm.role, 'viewer') end as role
       from workspaces w
       left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = $2
       where w.id = $1
       limit 1`,
   [workspaceId, userId],
  ),
  db.unsafe(
   `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, identity, model, handle, run_mode, sandbox_provider, sandbox_config, memory_dir, permission_mode, metadata, version, enabled, created_by
       from workspace_agents
       where workspace_id = $1
       order by created_at asc, name asc
       limit ${BOOTSTRAP_LIMITS.agents}`,
   [workspaceId],
  ),
  // The session list is where DM privacy leaks WITHOUT reading a message: a
  // title is "Coder", a roster names the agent, and the existence of the
  // conversation is itself the disclosure. Filtered here rather than after the
  // fact so the rows never reach the payload builder.
  db.unsafe(
   `select id, workspace_id, title, model, folder, description, icon, intent, is_favorite, participants, conversation_mode, max_agent_turns, auto_rounds, parent_message_id, split_parent_id, split_at, archived_at, deleted_at, canvas_id, visibility, version, created_at, updated_at
       from chat_sessions
       where workspace_id = $1 and deleted_at is null
         and ${sessionReadableSql('chat_sessions', '$2')}
       order by updated_at desc nulls last
       limit ${BOOTSTRAP_LIMITS.sessions}`,
   [workspaceId, userId],
  ),
  db.unsafe(
   `select id, workspace_id, title, folder, is_favorite, created_at, updated_at
       from documents
       where workspace_id = $1
       order by updated_at desc nulls last
       limit ${BOOTSTRAP_LIMITS.documents}`,
   [workspaceId],
  ),
  db.unsafe(
   `select id, workspace_id, title, description, status, priority, due_date, start_date, depends_on, assignee_id, parent_id, source_type, source_id, created_at, updated_at
       from tasks
       where workspace_id = $1
       order by created_at desc
       limit ${BOOTSTRAP_LIMITS.tasks}`,
   [workspaceId],
  ),
  db.unsafe(
   `select id, workspace_id, name, size, type, content_sha256, created_at
       from uploaded_files
       where workspace_id = $1
       order by created_at desc
       limit ${BOOTSTRAP_LIMITS.files}`,
   [workspaceId],
  ),
  db.unsafe(
   `select id, workspace_id, agent_id, name, handle, host, cwd, status, last_seen_at, connected_at, updated_at
       from agent_connections
       where workspace_id = $1
       order by last_seen_at desc nulls last
       limit ${BOOTSTRAP_LIMITS.connections}`,
   [workspaceId],
  ),
  db.unsafe(
   `select id, workspace_id, fact, category, created_at, updated_at
       from memory_facts
       where workspace_id = $1
       order by updated_at desc nulls last
       limit ${BOOTSTRAP_LIMITS.memoryFacts}`,
   [workspaceId],
  ),
 ]);

 return {
  workspace: workspaceRows[0] ? publicWorkspace(workspaceRows[0]) : null,
  agents: agentRows.map(agentRuntimePayload),
  sessions: sessionRows,
  documents: documentRows,
  tasks: taskRows,
  files: fileRows,
  connections: connectionRows.map(publicAgentConnection),
  memoryFacts: memoryRows,
  limits: BOOTSTRAP_LIMITS,
 };
}

// --- Inbox (triage surface) --------------------------------------------------
// The inbox aggregates five sources that ALREADY produce rows — it has no
// producers of its own and writes nothing except read state. Categories:
//
//   blocker  thread_items.kind='blocker'  — an agent hit a decision it can't make
//   comment  document_comments / task_comments / memory_file_comments
//   mention  activity_events 'message_sent' whose message text @s the caller
//   error    agent_jobs.status='error'
//   activity activity_events, minus the message firehose
//
// VISIBILITY: this app's only ACL boundary is the workspace — every member can
// already read every session, task, document and comment in it (see the
// bootstrap + /backend/sessions/:id/messages routes, which gate on
// enforceWorkspaceRole 'read' and nothing finer). So workspace membership IS the
// correct scope for four of the five categories. The genuinely per-user surfaces
// are (a) mentions, which are filtered to the caller's own @handle, and (b) read
// state, which is keyed by user_id. Self-authored comments are dropped: you do
// not need to triage your own comment.
//
// BOUNDEDNESS: every category is a separate LIMIT-ed subquery, the merged set is
// capped again, and the two firehose-backed categories (mention, activity) plus
// agent_jobs errors carry a lookback window. Worst case the endpoint returns
// INBOX_CATEGORY_BRANCHES x INBOX_MAX_LIMIT rows. These tables grow without
// bound, so an unbounded scan here would be a production hazard.
const INBOX_DEFAULT_LIMIT = 50;
const INBOX_MAX_LIMIT = 100;
// Union branches in buildInboxSql (comment fans out over three tables), used to
// cap the merged set at perCategory x branches.
const INBOX_CATEGORY_BRANCHES = 7;
const INBOX_LOOKBACK_DAYS = 30;
const INBOX_TITLE_CHARS = 160;
const INBOX_BODY_CHARS = 280;
const INBOX_FILTERS = new Set(['all', 'blocker', 'comment', 'mention', 'error']);

// The @handle a message would use to mention this user. Users have no handle
// column, so it is derived the same way the composer renders them: display name
// first, else the local part of the email. Returns '' when nothing usable
// exists, which disables the mention category rather than matching everyone.
function inboxMentionHandle(user) {
 const source = String(user?.display_name || '').trim() || String(user?.email || '').split('@')[0] || '';
 return source
  .toLowerCase()
  .replace(/^@+/, '')
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);
}

// POSIX pattern matching '@handle' on a word boundary, so @jane does not match
// @janet. slugHandle-style output is [a-z0-9_-] only, so it needs no escaping.
function inboxMentionPattern(handle) {
 return handle ? `(^|[^a-z0-9_.-])@${handle}([^a-z0-9_.-]|$)` : '';
}

// One statement, five bounded branches, unread resolved by a left join onto the
// per-user markers. $1 = workspace id, $2 = caller id, $3 = mention pattern.
function buildInboxSql(perCategory) {
 const cap = Number(perCategory);
 const window = `now() - interval '${INBOX_LOOKBACK_DAYS} days'`;
 const title = (expr) => `left(regexp_replace(coalesce(${expr}, ''), '\\s+', ' ', 'g'), ${INBOX_TITLE_CHARS})`;
 const body = (expr) => `left(coalesce(${expr}, ''), ${INBOX_BODY_CHARS})`;
 // Three of the branches below reach into a session: blockers join one, the
 // mention branch carries a message's CONTENT, and a failed agent job names the
 // session it failed in. An inbox is the easiest place to forget this, because
 // none of these branches selects from `messages`. A NULL/absent session id
 // means "not session-scoped" and stays visible.
 //
 // Joined on ::text rather than casting the metadata value to uuid: that column
 // is free-form jsonb and a non-uuid string in it would turn a bad row into a
 // query-wide 500 instead of one hidden item.
 const sessionVisible = (expr, alias) =>
  `(${expr} is null or ${expr} = '' or exists (
      select 1 from chat_sessions ${alias}
       where ${alias}.id::text = ${expr} and ${sessionReadableSql(alias, '$2')}
    ))`;
 return `
    with items as (
      (
        select 'blocker:' || ti.id::text as id,
               'blocker'::text as category,
               ${title('ti.content')} as title,
               ${body('ti.response')} as body,
               'blocker:' || ti.id::text as context_key,
               ti.session_id::text as session_id,
               'thread_item'::text as entity_type,
               ti.id::text as entity_id,
               coalesce(nullif(wa.name, ''), nullif(ti.created_by_agent, ''), '')::text as actor_name,
               ti.created_at as created_at
          from thread_items ti
          join chat_sessions cs on cs.id = ti.session_id and cs.deleted_at is null
          left join workspace_agents wa on wa.id::text = ti.created_by_agent
         where ti.workspace_id = $1::uuid
           and ti.kind = 'blocker'
           and ti.status <> 'dismissed'
           and ${sessionReadableSql('cs', '$2')}
         order by ti.created_at desc
         limit ${cap}
      )
      union all
      (
        select 'comment:' || dc.id::text,
               'comment'::text,
               ${title(`'Comment on ' || coalesce(nullif(d.title, ''), 'document')`)},
               ${body('dc.content')},
               'comment:' || dc.id::text,
               null::text,
               'document'::text,
               dc.document_id::text,
               coalesce(nullif(u.display_name, ''), u.email, '')::text,
               dc.created_at
          from document_comments dc
          join documents d on d.id = dc.document_id
          left join app_users u on u.id = dc.user_id
         where dc.workspace_id = $1::uuid
           and dc.resolved is not true
           and (dc.user_id is null or dc.user_id <> $2::uuid)
         order by dc.created_at desc
         limit ${cap}
      )
      union all
      (
        select 'comment:' || tc.id::text,
               'comment'::text,
               ${title(`'Comment on ' || coalesce(nullif(t.title, ''), 'task')`)},
               ${body('tc.content')},
               'comment:' || tc.id::text,
               null::text,
               'task'::text,
               tc.task_id::text,
               coalesce(nullif(wa.name, ''), nullif(u.display_name, ''), u.email, '')::text,
               tc.created_at
          from task_comments tc
          join tasks t on t.id = tc.task_id
          left join app_users u on u.id = tc.user_id
          left join workspace_agents wa on wa.id = tc.agent_id
         where tc.workspace_id = $1::uuid
           and tc.resolved is not true
           and (tc.user_id is null or tc.user_id <> $2::uuid)
         order by tc.created_at desc
         limit ${cap}
      )
      union all
      (
        select 'comment:' || mc.id::text,
               'comment'::text,
               ${title(`'Comment on ' || mc.path`)},
               ${body('mc.content')},
               'comment:' || mc.id::text,
               null::text,
               'memory_file'::text,
               mc.agent_id::text,
               coalesce(nullif(u.display_name, ''), u.email, '')::text,
               mc.created_at
          from memory_file_comments mc
          left join app_users u on u.id = mc.user_id
         where mc.workspace_id = $1::uuid
           and mc.resolved is not true
           and (mc.user_id is null or mc.user_id <> $2::uuid)
         order by mc.created_at desc
         limit ${cap}
      )
      union all
      (
        select 'mention:' || ae.id::text,
               'mention'::text,
               ${title('ae.title')},
               ${body(`ae.metadata->>'content'`)},
               'thread:' || coalesce(nullif(ae.metadata->>'session_id', ''), ae.id::text),
               nullif(ae.metadata->>'session_id', ''),
               'message'::text,
               ae.entity_id,
               coalesce(ae.metadata->>'sender_name', '')::text,
               ae.created_at
          from activity_events ae
         where ae.workspace_id = $1::uuid
           and ae.event_type = 'message_sent'
           and ae.created_at > ${window}
           and $3::text <> ''
           and coalesce(ae.metadata->>'content', '') ~* $3::text
           and (ae.user_id is null or ae.user_id <> $2::uuid)
           and ${sessionVisible(`nullif(ae.metadata->>'session_id', '')`, 'cs_ae')}
         order by ae.created_at desc
         limit ${cap}
      )
      union all
      (
        select 'error:' || j.id::text,
               'error'::text,
               ${title(`coalesce(nullif(a.name, ''), 'Agent') || ' run failed'`)},
               ${body('j.error')},
               'agent_job:' || j.id::text,
               j.session_id::text,
               'agent_job'::text,
               j.id::text,
               coalesce(a.name, '')::text,
               coalesce(j.finished_at, j.updated_at, j.created_at)
          from agent_jobs j
          left join workspace_agents a on a.id = j.agent_id
         where j.workspace_id = $1::uuid
           and j.status = 'error'
           and coalesce(j.finished_at, j.updated_at, j.created_at) > ${window}
           and ${sessionVisible('j.session_id::text', 'cs_job')}
         order by coalesce(j.finished_at, j.updated_at, j.created_at) desc
         limit ${cap}
      )
      /* No activity branch, deliberately. Raw workspace events — "@scout
         connected", "@coder disconnected", "Task created: …", "New document" —
         are telemetry, not things addressed to a person. Including them drowned
         the inbox: 44 of 50 rows were connection churn, and the one real blocker
         sat under a wall of it. Activity has its own home in
         ActivityWindowContent / useActivity; the inbox is only what needs YOU. */
    )
    select i.id, i.category, i.title, i.body, i.context_key, i.session_id,
           i.entity_type, i.entity_id, i.actor_name, i.created_at,
           /* MILLISECOND resolution, not microsecond — and this truncation is the
              whole reason read state persists at all.

              created_at is timestamptz (microseconds). The marker is not: it
              round-trips through the client as an ISO-8601 string from
              Date#toISOString(), which carries milliseconds. An item written at
              …:04.638748 comes back as the marker …:04.638000, and comparing
              those two raw calls it unread by 748µs — every time, forever.
              Reading an item appeared to work and never survived a reload;
              45 of 45 live markers were being defeated this way.

              So compare at the coarsest precision the wire can represent. The
              cost is that an item created in the SAME millisecond as the marker
              reads as read — a sub-millisecond race, against a marker that could
              not have addressed it either way. src/components/inbox/inboxModel.ts
              (isUnreadAt) applies the identical rule client-side, so the
              optimistic flip and the authoritative answer cannot diverge. */
           (r.read_at is null or date_trunc('milliseconds', i.created_at) > r.read_at) as unread
      from items i
      left join inbox_read_state r
        on r.user_id = $2::uuid and r.workspace_id = $1::uuid and r.context_key = i.context_key
     order by i.created_at desc
     limit ${cap * INBOX_CATEGORY_BRANCHES}`;
}

// Row -> the shared InboxItem wire shape (camelCase; both sides agree on this).
function toInboxItem(row) {
 return {
  id: String(row.id || ''),
  category: String(row.category || ''),
  title: String(row.title || ''),
  body: String(row.body || ''),
  contextKey: String(row.context_key || ''),
  sessionId: row.session_id ? String(row.session_id) : null,
  entityType: row.entity_type ? String(row.entity_type) : null,
  entityId: row.entity_id ? String(row.entity_id) : null,
  actorName: String(row.actor_name || ''),
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
  unread: row.unread !== false,
 };
}


// Handles naming an INDIVIDUAL agent. `@channel` is excluded here on purpose:
// it is not a handle, it addresses the session's roster, and every caller of
// this function looks its results up in a handle->agent map. Leaving it in would
// mean a mention of everyone resolved to whichever agent happened to be slugged
// `channel` — which is the hijack isReservedAgentHandle refuses at the door, and
// this is the second lock on the same door for rows that predate it.
function parseAgentMentions(content) {
 return agentMentionHandles(content);
}

// Every handle, `@channel` included. Only the dispatcher needs this; anything
// resolving a handle to one agent wants parseAgentMentions.
function parseAllMentions(content) {
 return parseMentionHandles(content);
}

function firstAgentMention(content) {
 return parseAgentMentions(content)[0] || '';
}

function validUuid(value) {
 return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

async function inferThreadAgentTarget(sessionId, threadParentId) {
 if (!sessionId || !threadParentId) return null;
 const rows = await getDb().unsafe(
  `select id, sender_kind, sender_id, sender_name, content, message_kind, tool_name, tool_detail, broadcast_to_channel, created_at
     from messages
     where session_id = $1
       and(id = $2 or thread_parent_id = $2)
     order by created_at desc`,
  [sessionId, threadParentId],
 );
 for (const row of rows) {
  if (row.sender_kind === 'agent' && validUuid(row.sender_id)) {
   return { agentId: String(row.sender_id), handle: slugHandle(row.sender_name || '') };
  }
 }
 for (const row of rows) {
  const handle = firstAgentMention(row.content);
  if (handle) return { agentId: '', handle };
 }
 return null;
}

function agentContextFromRow(agent, coParticipants = []) {
 if (!agent) return null;
 return {
  id: agent.id,
  name: agent.name,
  handle: agent.handle || slugHandle(agent.name),
  description: agent.description || '',
  systemPrompt: agent.system_prompt || '',
  soul: agent.soul || '',
  instructions: agent.instructions || '',
  tools: parseJsonArray(agent.tools),
  skills: parseJsonArray(agent.skills),
  model: resolveAnthropicModel(agent.model),
  permissionMode: normalizeAgentPermissionMode(agent.permission_mode),
  coParticipants: Array.isArray(coParticipants) ? coParticipants : [],
 };
}

// --- Multi-agent channel orchestration ---------------------------------------

const CHANNEL_CONTEXT_LIMIT = 40;
// This is deliberately a byte budget, not a character budget. A tokenizer can
// emit up to roughly one fallback token per input byte, so staying below 8 KiB
// also keeps conversation history below the daemon's 10 KiB complete-prompt cap.
const CHANNEL_CONTEXT_MAX_BYTES = 8 * 1024;
const conversationLocks = new Set();






function agentContextBytes(messages) {
 return (Array.isArray(messages) ? messages : []).reduce(
  (total, message) => total
   + Buffer.byteLength(String(message?.role || ''), 'utf8')
   + Buffer.byteLength(String(message?.content || ''), 'utf8')
   + 4,
  0,
 );
}

function truncateContextEnd(value, maxBytes) {
 const text = String(value || '');
 if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
 const marker = '\n\n[... message truncated at the agent context limit ...]';
 const markerBytes = Buffer.byteLength(marker, 'utf8');
 if (maxBytes <= markerBytes) return '';
 const codepoints = [...text];
 let low = 0;
 let high = codepoints.length;
 while (low < high) {
  const keep = Math.ceil((low + high) / 2);
  const candidate = codepoints.slice(0, keep).join('') + marker;
  if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) low = keep;
  else high = keep - 1;
 }
 return codepoints.slice(0, low).join('') + marker;
}

function boundAgentContextMessages(messages, maxBytes = CHANNEL_CONTEXT_MAX_BYTES) {
 const source = Array.isArray(messages) ? messages : [];
 const budget = Math.max(256, Number(maxBytes) || CHANNEL_CONTEXT_MAX_BYTES);
 const selected = [];
 let used = 0;
 for (let index = source.length - 1; index >= 0; index -= 1) {
  const message = source[index];
  const normalized = { role: message?.role === 'assistant' ? 'assistant' : 'user', content: String(message?.content || '') };
  const fullBytes = agentContextBytes([normalized]);
  if (used + fullBytes <= budget) {
   selected.unshift(normalized);
   used += fullBytes;
   continue;
  }
  // Never rewrite an older boundary message: repeatedly changing that prefix
  // destroys prompt-cache stability. Only an individually oversized newest
  // message is clipped, and it carries an explicit marker so the model cannot
  // mistake the fragment for the complete request.
  if (selected.length === 0) {
   const overhead = agentContextBytes([{ ...normalized, content: '' }]);
   const available = budget - overhead;
   const content = truncateContextEnd(normalized.content, available);
   if (content) {
    const truncated = { ...normalized, content };
   selected.unshift(truncated);
   }
  }
  break;
 }
 while (selected.length > 1 && selected[0].role !== 'user') selected.shift();
 return selected;
}

// eslint-disable-next-line no-unused-vars -- dead helper, not yet wired up; tracked for removal separately
function clampInt(value, min, max, fallback) {
 const parsed = Number.parseInt(value, 10);
 if (!Number.isFinite(parsed)) return fallback;
 return Math.min(max, Math.max(min, parsed));
}

function isAgentPlaceholder(row) {
 return row.sender_kind === 'agent' && /^Thinking \d/.test(textFromValue(row.content).trim());
}

// eslint-disable-next-line no-unused-vars -- dead helper, not yet wired up; tracked for removal separately
function dedupeAgentsById(agents) {
 const seen = new Set();
 const out = [];
 for (const agent of agents) {
  const id = String(agent?.id || '');
  if (!id || seen.has(id)) continue;
  seen.add(id);
  out.push(agent);
 }
 return out;
}

function directAgentParticipantFromSession(session) {
 const agentParticipants = parseJsonArray(session?.participants)
  .filter((participant) => participant && participant.kind === 'agent' && (participant.agent_id || participant.handle));
 if (agentParticipants.length === 0) return null;
 return agentParticipants.find((participant) => participant.direct) || (agentParticipants.length === 1 ? agentParticipants[0] : null);
}

// Comment tables that can @mention an agent, and how to describe the thing the
// comment is anchored to (so the agent's DM ping links back to the source).
const COMMENT_MENTION_TABLES = {
 task_comments: {
  anchorColumn: 'task_id',
  // A task @mention runs the agent inside this task's subthread (and assigns it).
  sourceTaskId: (row) => row.task_id || null,
  describe: async (row) => {
   const t = await getDb().unsafe('select title from tasks where id = $1 limit 1', [row.task_id]).catch(() => []);
   const title = t[0]?.title ? `"${t[0].title}"` : `#${String(row.task_id).slice(0, 8)} `;
   return { label: `task ${title} `, link: `agensis://task/${row.task_id}` };
  },
 },
 document_comments: {
  anchorColumn: 'document_id',
  describe: async (row) => {
   const d = await getDb().unsafe('select title from documents where id = $1 limit 1', [row.document_id]).catch(() => []);
   const title = d[0]?.title ? `"${d[0].title}"` : `#${String(row.document_id).slice(0, 8)}`;
   return { label: `document ${title}`, link: `agensis://document/${row.document_id}` };
  },
 },
 memory_file_comments: {
  anchorColumn: 'agent_id',
  describe: async (row) => ({
   label: `memory file "${row.path}"`,
   link: `agensis://memory/${row.agent_id}/${encodeURIComponent(String(row.path || ''))}`,
  }),
 },
};

// Resolve (or lazily create) the human↔agent Direct message session for an agent.
// Mirrors the client's find-or-create in App.tsx (handleAgentDirectMessage): a DM is
// a chat_session in the 'Direct messages' folder whose sole/direct participant is the
// agent. Workspaces are effectively single-human, so the DM keys on the agent alone.
async function findOrCreateDirectSession(workspaceId, agent) {
 const wantedId = String(agent.id || '');
 const wantedHandle = slugHandle(agent.handle || agent.name || '');
 const candidates = await getDb().unsafe(
  "select * from chat_sessions where workspace_id = $1 and folder = 'Direct messages' and archived_at is null",
  [workspaceId],
 );
 const match = candidates.find((session) => {
  const participant = directAgentParticipantFromSession(session);
  if (!participant) return false;
  const pid = String(participant.agent_id || '');
  const phandle = slugHandle(participant.handle || participant.name || '');
  return (wantedId && pid === wantedId) || (wantedHandle && phandle === wantedHandle);
 });
 if (match) return match;

 const handle = wantedHandle;
 const title = agent.name || (handle ? `@${handle}` : 'Agent');
 const participant = {
  id: agent.id ? `agent:${agent.id}` : `agent:${handle}`,
  kind: 'agent',
  name: title,
  handle: handle || null,
  agent_id: agent.id || null,
  user_id: null,
  status: null,
  direct: true,
  added_at: new Date().toISOString(),
 };
 const created = await getDb().unsafe(
  `insert into chat_sessions (workspace_id, title, model, folder, conversation_mode, participants, visibility)
     values ($1, $2, $3, 'Direct messages', 'auto', $4::jsonb, 'private')
     returning *`,
  // The ARRAY itself — see the note on the participants update above.
  [workspaceId, title, resolveAnthropicModel(agent.model), [participant]],
 );
 // A DM the SYSTEM opened (a task dispatch, a comment @mention) has no human
 // action behind it to attribute, so it belongs to the workspace owner — the
 // same answer the migration gives every pre-existing DM, so a DM created the
 // minute before this shipped and one created the minute after are owned by the
 // same person. Without this the session would be private with no members and
 // nobody could read it, agent included.
 if (created[0]) {
  const owner = await getDb().unsafe('select user_id from workspaces where id = $1 limit 1', [workspaceId]);
  if (owner[0]?.user_id) {
   await addSessionParticipant({ sessionId: created[0].id, userId: owner[0].user_id, db: sharedDbAdapter });
  }
  notifyDbSubscribers('chat_sessions', 'INSERT', created);
 }
 return created[0] || null;
}


// Option A auto-threading decision: resolve the thread_parent_id an agent's reply
// should be written under for a dispatch request. An explicit `threadParentId`
// (a follow-up typed in an open thread panel) always wins. Otherwise, when the
// chat UI flags a plain main-box message with `autoThread` and supplies the
// just-posted `messageId`, thread the reply under that message so the main
// timeline stays a list of topics with each answer tucked beneath — only
// genuinely new (unrelated) messages stay on the main timeline. Callers that omit
// `autoThread` (sub-thread sessions, MCP, legacy clients) keep flat replies.
// Returns null when there's nothing to thread under.
/**
 * Resolve a requested thread parent to one that can actually be written.
 *
 * Returns the id only if that message EXISTS and belongs to this session;
 * otherwise null, which threads the reply flat. Fails open on a query error for
 * the same reason: losing the thread nesting is a cosmetic loss, losing the
 * agent's reply is not.
 */
async function verifyThreadParent(threadParentId, sessionId) {
 if (!threadParentId || !sessionId) return null;
 try {
  const rows = await getDb().unsafe(
   'select id from messages where id = $1 and session_id = $2 limit 1',
   [String(threadParentId), String(sessionId)],
  );
  return rows.length > 0 ? String(threadParentId) : null;
 } catch {
  return null;
 }
}

function resolveDispatchThreadParent({ threadParentId, autoThread, messageId } = {}) {
 if (threadParentId) return threadParentId;
 if (autoThread && messageId) return String(messageId);
 return null;
}

// Whether a just-written message should be mirrored back to a task's comments:
// only a REAL agent reply that lives inside a subthread (thread_parent_id set)
// qualifies. Humans, main-timeline (non-subthread) replies, and the streaming
// "Thinking …" placeholder are excluded.
function shouldMirrorAgentMessage(row) {
 if (!row || row.sender_kind !== 'agent') return false;
 if (!row.thread_parent_id) return false;
 const text = String(row.content || '').trim();
 if (!text) return false;
 if (/^Thinking\b/.test(text)) return false;
 return true;
}

// Route a task @mention into a STABLE per-task subthread of the agent's session.
// The first mention on a task opens a root message (tagged with source_task_id);
// every later mention is appended under that same root, so a task's whole
// conversation — and the agent's replies — stay in one thread instead of
// scattering across the main DM timeline. Returns { threadParentId, messageRow }.
async function postTaskSubthreadMention({ session, taskId, content, authorUserId, authorName }) {
 const existing = await getDb().unsafe(
  `select id from messages
     where session_id = $1 and source_task_id = $2 and thread_parent_id is null and deleted_at is null
     order by created_at asc limit 1`,
  [session.id, String(taskId)],
 );
 const rootId = existing[0]?.id || null;
 const senderId = String(authorUserId || '');
 const messageRows = rootId
  ? await getDb().unsafe(
   `insert into messages (session_id, role, content, thread_parent_id, source_task_id, sender_kind, sender_id, sender_name)
         values ($1, 'user', $2, $3, $4, 'user', $5, $6)
         returning *`,
   [session.id, content, rootId, String(taskId), senderId, authorName],
  )
  : await getDb().unsafe(
   `insert into messages (session_id, role, content, source_task_id, sender_kind, sender_id, sender_name)
         values ($1, 'user', $2, $3, 'user', $4, $5)
         returning *`,
   [session.id, content, String(taskId), senderId, authorName],
  );
 notifyDbSubscribers('messages', 'INSERT', messageRows);
 const threadParentId = rootId || messageRows[0]?.id || null;
 return { threadParentId, messageRow: messageRows[0] || null };
}

// Mirror an agent's subthread reply back into its source task's comment stream,
// closing the loop so a human watching the task sees the response without opening
// the DM. Inserted DIRECTLY (never via the /backend/db/insert route) so it can't
// re-arm dispatchCommentMentions; attributed to the agent via task_comments.agent_id.
// No-ops for anything that isn't a real agent reply whose subthread root is tied
// to a task. Best-effort: never throws to the caller.
async function mirrorAgentReplyToTaskComment(messageRow) {
 try {
  if (!shouldMirrorAgentMessage(messageRow)) return null;
  const rootRows = await getDb().unsafe(
   'select source_task_id from messages where id = $1 limit 1',
   [messageRow.thread_parent_id],
  );
  const taskId = rootRows[0]?.source_task_id || null;
  if (!taskId) return null;
  const taskRows = await getDb().unsafe(
   'select workspace_id, status from tasks where id = $1 limit 1',
   [String(taskId)],
  );
  const workspaceId = taskRows[0]?.workspace_id || null;
  if (!workspaceId) return null;
  const commentRows = await getDb().unsafe(
   `insert into task_comments (task_id, workspace_id, content, agent_id)
       values ($1, $2, $3, $4)
       returning *`,
   [String(taskId), String(workspaceId), String(messageRow.content || ''), String(messageRow.sender_id || '')],
  );
  if (commentRows[0]) notifyDbSubscribers('task_comments', 'INSERT', commentRows);
  // An agent replying in the task's own subthread IS the task being worked, so a
  // task still reading 'todo' at this point is lying to whoever is looking at the
  // board. Dispatch already moves todo -> in_progress, but not every turn arrives
  // through dispatch: a task queued while the agent was mid-turn keeps its 'todo'
  // + assignee, and a plain human follow-up in the thread wakes the agent without
  // going near dispatchTaskAssignment. Both end here, with a visible reply on a
  // task that claims nobody has started.
  //
  // Same rule as every other transition (taskStatusOnDispatch): ONLY 'todo'
  // moves. done/cancelled/in_progress are returned unchanged, so mirroring can
  // never resurrect a finished task or un-finish one — and the update is a no-op
  // write in that case, which is why the status is compared before it is written
  // rather than blindly set.
  const priorStatus = String(taskRows[0]?.status || 'todo');
  const nextStatus = taskStatusOnDispatch(priorStatus);
  const statusRows = nextStatus !== priorStatus
   ? await getDb().unsafe(
    'update tasks set status = $1, updated_at = now() where id = $2 returning *',
    [nextStatus, String(taskId)],
   ).catch(() => [])
   : await getDb().unsafe('update tasks set updated_at = now() where id = $1 returning *', [String(taskId)]).catch(() => []);
  // The board is realtime; without this the row moves column only on refresh.
  if (statusRows[0] && nextStatus !== priorStatus) notifyDbSubscribers('tasks', 'UPDATE', statusRows);
  return commentRows[0] || null;
 } catch (error) {
  console.error('mirrorAgentReplyToTaskComment failed', error);
  return null;
 }
}

// When a human posts a comment that @mentions agents (on a task, document, or memory
// file), wake each mentioned agent in its DM with a message that quotes the comment
// and links back to the source — so "you were tagged" turns into a real, visible
// response in the DM instead of a silent flag the agent has to poll for.
// `run` is a test seam; production always uses continueConversation.
async function dispatchCommentMentions({ table, row, authorUserId, run = continueConversation }) {
 const config = COMMENT_MENTION_TABLES[table];
 if (!config || !row) return;
 // Never dispatch on an agent-authored comment (e.g. a reply this loop mirrored
 // back onto the task) — that would let the loop re-arm itself.
 if (row.agent_id) return;
 const workspaceId = row.workspace_id;
 if (!workspaceId) return;
 const handles = parseAgentMentions(row.content);
 if (handles.length === 0) return;

 // H3 (2026-07 review): running an agent from an @mention is an agent-dispatch
 // action, so it must require the run_agents capability — a commenter/viewer
 // (who can leave comments but not run agents) tagging an agent is a no-op,
 // and the dispatch is throttled per author on the same budget as the
 // dedicated /backend/agents/dispatch route. Both are enforced here because
 // the comment insert route only checks the 'comment' capability.
 const authorRole = authorUserId ? await getWorkspaceRole(authorUserId, workspaceId) : null;
 if (!roleHasWorkspaceCapability(authorRole, 'run_agents')) return;
 if (!dispatchRateLimiter.check(String(authorUserId)).allowed) return;

 let authorName = 'A teammate';
 if (authorUserId) {
  const u = await getDb()
   .unsafe('select display_name, email from app_users where id = $1 limit 1', [authorUserId])
   .catch(() => []);
  authorName = u[0]?.display_name || u[0]?.email || authorName;
 }

 let source = { label: 'a comment', link: '' };
 try {
  source = await config.describe(row);
 } catch (error) {
  console.error('describe comment source failed', error);
 }

 for (const handle of handles) {
  // Released on every path that does NOT end in a running turn — the claim's job
  // is to dedupe one human action, not to lock a task out of the queue.
  let claim = null;
  try {
   const agent = await resolveWorkspaceAgentByHandle(workspaceId, handle);
   if (!agent) continue;
   // Skip self-mentions (an agent tagging itself in its own note).
   const session = await findOrCreateDirectSession(workspaceId, agent);
   if (!session) continue;

   const linkLine = source.link ? `\n\nSource: ${source.link}` : '';
   const content =
    `@${slugHandle(agent.handle || agent.name)} — ${authorName} tagged you in a comment on ${source.label}:\n\n` +
    `> ${String(row.content || '').replace(/\n/g, '\n> ')}\n\n` +
    `Pick this up and reply here in your DM.${linkLine}`;

   const taskId = config.sourceTaskId ? config.sourceTaskId(row) : null;
   if (taskId) {
    // The same human action also writes assignee_id, which now dispatches on its
    // own — claim the pair so the agent runs ONCE. The window is short (seconds),
    // so a genuine second @mention comment still wakes the agent.
    if (!claimTaskDispatch(String(taskId), String(agent.id), TASK_MENTION_CLAIM_MS)) continue;
    claim = [String(taskId), String(agent.id)];
    const handleSlug = slugHandle(agent.handle || agent.name);

    // Read the row BEFORE writing anything: the busy check below has to be able to
    // leave the task exactly as the human left it, and a rollback needs the
    // provenance this dispatch would overwrite. task_comments.task_id is a
    // cascading FK, so a comment cannot outlive its task — no row means the task
    // just went away and there is nothing to dispatch onto.
    const cur = await getDb().unsafe(
     'select id, status, source_type, source_id from tasks where id = $1 limit 1',
     [String(taskId)],
    );
    const task = cur[0];
    if (!task) continue;
    const priorStatus = String(task.status || 'todo');

    // All of an agent's task work lands in ONE DM session, and agent_jobs carries a
    // partial unique index (one active job per session+agent), so a turn started
    // while the agent is mid-turn physically cannot create a job. Find that out
    // BEFORE writing: record the assignment, so the agent's queue owns the task,
    // but leave the status alone — 'todo' + assigned is exactly what
    // drainAgentTaskQueue selects, and it is the state the human left it in. The
    // old code flipped it to 'in_progress' and then dropped the refused turn, so
    // an @mention while the agent was busy left a task that read as "being worked
    // on" with no job attached and nothing that would ever pick it up.
    if (await agentHasActiveJob(session.id, agent.id)) {
     const queued = await getDb().unsafe(
      'update tasks set assignee_id = $1, updated_at = now() where id = $2 returning *',
      [String(agent.id), String(taskId)],
     );
     if (queued[0]) notifyDbSubscribers('tasks', 'UPDATE', queued);
     const position = await taskQueuePosition(workspaceId, agent.id, taskId);
     console.log(`[task-queue] queued task=${taskId} for @${handleSlug}: agent is mid-turn${position ? ` (queue position ${position})` : ''} (cause=mention)`);
     continue;
    }

    // Assign the task to the mentioned agent and move it into progress (never
    // clobbering a started/done/cancelled status), then run the agent inside
    // the task's own subthread so its reply mirrors back as a task comment.
    // Record the chat this task is now being worked in (see
    // TASK_SOURCE_LINK_OVERWRITABLE) so the task can offer "Open chat".
    const nextStatus = taskStatusOnDispatch(priorStatus);
    const stampSource = TASK_SOURCE_LINK_OVERWRITABLE.has(String(task.source_type || ''));
    const taskRows = stampSource
     ? await getDb().unsafe(
      "update tasks set assignee_id = $1, status = $2, source_type = 'chat', source_id = $3, updated_at = now() where id = $4 returning *",
      [String(agent.id), nextStatus, String(session.id), String(taskId)],
     )
     : await getDb().unsafe(
      'update tasks set assignee_id = $1, status = $2, updated_at = now() where id = $3 returning *',
      [String(agent.id), nextStatus, String(taskId)],
     );
    if (taskRows[0]) notifyDbSubscribers('tasks', 'UPDATE', taskRows);

    const { threadParentId, messageRow } = await postTaskSubthreadMention({
     session, taskId, content, authorUserId, authorName,
    });

    // AWAITED, unlike the fire-and-forget it replaces: the turn can still be
    // refused inside continueConversation (the agent won its own one-active-job
    // slot in the window between the check above and the job insert, or the
    // subthread's turn budget is spent). Nothing retried that, so the task sat
    // 'in_progress' with no job attached, forever. Every caller is `void`-ed, so
    // awaiting costs no request latency.
    let outcome = null;
    try {
     outcome = await run({ workspaceId, sessionId: session.id, threadParentId });
    } catch (error) {
     console.error('continueConversation (task subthread mention) failed', error);
     outcome = { started: false, reason: 'error' };
    }
    if (outcome && outcome.started === false) {
     // Compare-and-swap rollback (see undoTaskDispatch): it restores only the
     // status THIS dispatch wrote, so it can never re-open a task a human closed
     // while the refused turn was in flight. The assignee stays, so the task is
     // left as a plain 'todo' + assigned — which is what the drain picks up the
     // moment the agent frees up.
     await undoTaskDispatch({
      task, priorStatus, wroteStatus: nextStatus, stampedSource: stampSource,
      messageId: messageRow?.id || null, sessionId: session.id,
     });
     const busy = TASK_QUEUE_BUSY_RUN_REASONS.has(String(outcome.reason || ''));
     console.log(`[task-queue] ${busy ? 'requeued' : 'could not start'} task=${taskId} for @${handleSlug}: run=${outcome.reason || 'unknown'} (cause=mention); status back to ${priorStatus}`);
     continue;
    }
    claim = null; // a real turn is running; keep the claim so a re-post can't double-run it
   } else {
    const messageRows = await getDb().unsafe(
     `insert into messages (session_id, role, content, sender_kind, sender_id, sender_name)
           values ($1, 'user', $2, 'user', $3, $4)
           returning *`,
     [session.id, content, String(authorUserId || ''), authorName],
    );
    notifyDbSubscribers('messages', 'INSERT', messageRows);
    // No task, so no queue: a plain DM mention wakes the agent immediately, exactly
    // as before. There is no task status to strand if the turn is refused.
    void run({ workspaceId, sessionId: session.id }).catch((error) =>
     console.error('continueConversation (comment mention) failed', error),
    );
   }
  } catch (error) {
   console.error(`comment mention dispatch failed for @${handle}`, error);
  } finally {
   if (claim) releaseTaskDispatch(claim[0], claim[1]);
  }
 }
}










async function loadChannelMessages(sessionId, threadParentId = null, limit = CHANNEL_CONTEXT_LIMIT) {
 const rows = threadParentId
  ? await getDb().unsafe(
   `select id, role, content, sender_kind, sender_id, sender_name, message_kind, tool_name, tool_detail, broadcast_to_channel, created_at
         from messages
         where session_id = $1 and (id = $2 or thread_parent_id = $2) and deleted_at is null
         order by created_at desc
         limit $3`,
   [sessionId, threadParentId, limit],
  )
  // The CHANNEL level is "top level OR broadcast to the channel" — the same
  // predicate the client's channel view uses. Since an agent now works inside a
  // thread and only broadcasts its answer, a broadcast-only filter here would
  // hide every reply from the channel-level context: buildAgentTurnContext would
  // forget what was already answered, and continueConversation would count zero
  // agent turns in the burst and dispatch the same turn again, forever.
  : await getDb().unsafe(
   `select id, role, content, sender_kind, sender_id, sender_name, message_kind, tool_name, tool_detail, broadcast_to_channel, created_at
         from messages
         where session_id = $1 and (thread_parent_id is null or broadcast_to_channel) and deleted_at is null
         order by created_at desc
         limit $2`,
   [sessionId, limit],
  );
 return rows.filter((row) => !isAgentPlaceholder(row)).reverse();
}

// Rebuild conversation context from the running agent's point of view: its own
// messages are 'assistant', everyone else (humans and other agents) is 'user'
// with a "[@handle]:" / "[name]:" prefix so the agent can tell who said what.
async function buildAgentTurnContext(sessionId, runningAgent, threadParentId = null) {
 const rows = await loadChannelMessages(sessionId, threadParentId);
 const runningId = String(runningAgent?.id || '');
 const mapped = [];
 for (const row of rows) {
  const text = textFromValue(row.content).trim();
  if (!text) continue;
  const isOwn = row.sender_kind === 'agent' && String(row.sender_id || '') === runningId;
  if (isOwn) {
   mapped.push({ role: 'assistant', content: text });
   continue;
  }
  const label = row.sender_kind === 'agent'
   ? `@${slugHandle(row.sender_name || 'agent')}`
   : (row.sender_name ? String(row.sender_name) : 'User');
  mapped.push({ role: 'user', content: `[${label}]: ${text}` });
 }
 const merged = [];
 for (const message of mapped) {
  const last = merged[merged.length - 1];
  if (last && last.role === message.role) last.content = `${last.content}\n\n${message.content}`;
  else merged.push({ role: message.role, content: message.content });
 }
 while (merged.length > 0 && merged[0].role !== 'user') merged.shift();
 return boundAgentContextMessages(merged);
}

// Cross-session "shared brain": a short digest of what THIS agent has recently
// done in OTHER sessions (channels + DMs) in this workspace, so it has continuity
// — e.g. you can ask it in a DM what it's working on in a channel, or give pointers.
async function buildAgentActivityDigest(workspaceId, agentId, currentSessionId) {
 if (!workspaceId || !agentId) return '';
 try {
  const rows = await getDb().unsafe(
   `select distinct on (m.session_id) m.session_id, s.title, s.folder, m.content, m.created_at
       from messages m
       join chat_sessions s on s.id = m.session_id
       where s.workspace_id = $1
         and m.sender_kind = 'agent' and m.sender_id = $2
         and m.session_id <> $3
         and m.content !~ '^Thinking '
         and m.deleted_at is null and s.deleted_at is null
       order by m.session_id, m.created_at desc`,
   [workspaceId, String(agentId), currentSessionId || ''],
  );
  const recent = rows
   .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
   .slice(0, 6);
  if (recent.length === 0) return '';
  return recent
   .map((r) => {
    const where = r.folder === 'Direct messages' ? `DM "${r.title || 'Untitled'}"` : `channel "${r.title || 'Untitled'}"`;
    const text = textFromValue(r.content).replace(/\s+/g, ' ').trim().slice(0, 220);
    return `- In ${where}: "${text}"`;
   })
   .join('\n');
 } catch {
  return '';
 }
}

// Voice etiquette. A huddle turns every agent message into speech on the
// human's machine, so LATENCY is the whole experience: a perfect paragraph that
// lands six seconds later reads as a broken call, while "on it — checking the
// logs now" in 400ms reads as a conversation. Segmented turns already give the
// agent a way to say something first and keep going (each text block is its own
// message, spoken as it lands); this note is what tells it to use them.
//
// Only added while a huddle is actually live for the session — a silent channel
// must not be told to answer in half-sentences.
const VOICE_HUDDLE_NOTE = [
 'You are in a LIVE VOICE HUDDLE. Everything you write is read aloud to the person you are talking to, and what they say is transcribed into this conversation.',
 'Reply IMMEDIATELY with one short sentence — the headline or an acknowledgement — as its own message, BEFORE you go and do the work. Then keep going in short messages as you learn things.',
 // These three constraints are not style, they are the latency mechanism, and
 // each one names a specific thing that made the first word late:
 //   - the reader speaks a sentence the instant its FULL STOP arrives and cannot
 //     speak an unterminated fragment (src/lib/voiceStream.ts), so a first
 //     "sentence" that runs on for a paragraph is a paragraph of silence;
 //   - a preamble or a restatement of the question delays the first terminator
 //     by exactly its own length;
 //   - reasoning before writing anything is silence the listener cannot tell
 //     from a broken call. Answering first costs nothing: the work still happens,
 //     in the messages that follow.
 'Your FIRST sentence must be at most a dozen words and must END IN A FULL STOP. Do not open with a preamble, a restatement of the question, or a heading — the first full stop is the moment your voice is heard.',
 'Do not reason at length before that first sentence. Say it, then think, then keep talking as you learn things.',
 'It may say what you are ABOUT to do. It must never say you have already done it.',
 'Speak in plain sentences. Code blocks, tables and long lists are dropped before speaking, so say what they mean instead.',
 // The base system prompt (and, for daemon agents, the daemon's own prompt
 // suffix) both ask for markdown structure. Spoken, a heading has no full stop
 // and a bullet has no verb, so that instruction has to be cancelled here or the
 // two fight and the listener hears the loser.
 'Ignore any instruction to prefer markdown, headings, bullets or tables while this huddle is live. Structure is for reading; you are being listened to.',
 // Spoken aloud, tool narration is worse than useless: the human hears a
 // minute of "I am calling the create_thread_item MCP tool" and then learns
 // nothing was created. Announce the OUTCOME, never the mechanism, and never
 // claim an action before it has actually succeeded.
 'Never narrate your tools or plumbing out loud. Do not name tools, MCP servers, function calls, schemas or integrations — the person cannot see any of that and does not need to. Say what you are doing in ordinary words.',
 'Do not say you have done something until it has actually succeeded. If a tool is unavailable or a call fails, say plainly in ONE sentence that you cannot do it and what you can do instead. Do not speculate aloud about why, do not describe your own configuration, and do not keep trying in front of the listener.',
].join('\n');

// Is a huddle running in this conversation right now? Answered from the huddles
// table (idx_huddles_one_live_per_session covers exactly this predicate).
// Fails CLOSED: any error means "no huddle", so a missing table or a slow
// query can never break a turn — it only means the voice note is not added.
// Is this session part of a live voice call — and therefore about to be read
// aloud? Decides whether the agent gets VOICE_HUDDLE_NOTE.
//
// BOTH columns, and the second one is the load-bearing half. A huddle keeps its
// conversation in its OWN session (huddles.transcript_session_id) rather than in
// the channel, so the session an agent is answering in during a call is the
// transcript one. Matching only `session_id` silently stopped adding the note
// the moment transcripts moved out of the channel: every reply would come back
// as one long block of prose, read out six seconds after the question, and
// nothing would look broken.
//
// `session_id` still matches because a huddle that predates transcript sessions
// really did run in its channel.
async function sessionHasLiveHuddle(sessionId) {
 if (!sessionId) return false;
 try {
  const rows = await getDb().unsafe(
   `select 1 from huddles
      where (session_id = $1 or transcript_session_id = $1) and ended_at is null
      limit 1`,
   [String(sessionId)],
  );
  return rows.length > 0;
 } catch {
  return false;
 }
}

/**
 * The channel's own house style, or '' when it has none.
 *
 * Read per turn rather than cached: an owner editing the intent expects the
 * next reply to obey it, and a channel turn already costs a model call, so one
 * more indexed lookup by primary key is not the expensive part.
 */
async function loadChannelIntentNote(sessionId) {
 if (!sessionId) return '';
 try {
  const rows = await getDb().unsafe(
   'select title, intent from chat_sessions where id = $1 limit 1',
   [String(sessionId)],
  );
  if (rows.length === 0) return '';
  return channelIntentNote(rows[0].intent, rows[0].title);
 } catch {
  // A deployment whose schema has not caught up must not lose its agents.
  return '';
 }
}

// Which of the sandbox credential vault keys actually HAVE a value.
//
// Keys only — the values are never read, let alone decrypted, on this path.
// `secret_cipher` is written as '' when a key is cleared (setWorkspaceSecretValue),
// so a non-empty cipher is exactly "configured" without touching the plaintext.
// Deliberately a LIKE on the constant prefix rather than `key = any($2)`: binding
// a raw JS array through `.unsafe` does not array-serialize (see AGENTS.md), and
// the prefix is a literal, so there is nothing to bind.
async function listConfiguredSandboxCredentialKeys(workspaceId, wanted = []) {
 if (!workspaceId || wanted.length === 0) return [];
 try {
  const rows = await getDb().unsafe(
   `select key, value, secret_cipher from workspace_secrets
      where workspace_id = $1 and key like '${SANDBOX_VAULT_PREFIX}%'`,
   [String(workspaceId)],
  );
  return rows
   .filter((row) => wanted.includes(row.key) && Boolean(row.secret_cipher || row.value))
   .map((row) => row.key);
 } catch {
  // Fail closed in the useful direction: the agent is told the credential is
  // NOT configured, which makes it refuse and name the key, rather than call a
  // provider API with nothing and report a 401 it cannot explain.
  return [];
 }
}

// Every agent-authored provider skill definition in the workspace, so the vault
// surface can offer a credential slot for a provider this workspace added without
// a release (metadata.sandbox_skills — the no-DDL route host_folders took).
//
// Definitions only; no credential is read here.
async function workspaceAuthoredProviderSkills(workspaceId) {
 if (!workspaceId) return [];
 try {
  const rows = await getDb().unsafe(
   'select metadata from workspace_agents where workspace_id = $1',
   [String(workspaceId)],
  );
  const out = [];
  for (const row of rows) {
   const metadata = row?.metadata && typeof row.metadata === 'object'
    ? row.metadata
    : (() => { try { return JSON.parse(row?.metadata || 'null'); } catch { return null; } })();
   const authored = Array.isArray(metadata?.sandbox_skills) ? metadata.sandbox_skills : [];
   for (const skill of authored) out.push(skill);
  }
  return out;
 } catch {
  // The bundled slots still render — an operator can always set a Box key.
  return [];
 }
}

// The sandbox skill layer as one prompt block, or '' for every agent that does
// not carry it (which is every agent that exists today). Both lanes get the same
// text — builtin through the system prompt, daemon through the daemon prompt —
// exactly as the channel intent and voice notes do.
async function loadSandboxSkillNote(workspaceId, agent) {
 const resolved = sandboxSkillsForAgent(agent);
 if (resolved.skills.length === 0) return '';
 const vaultKeys = await listConfiguredSandboxCredentialKeys(
  workspaceId,
  sandboxCredentialKeysForSkills(resolved.skills),
 );
 // A locally-run server can resolve a credential from its own environment
 // (callProviderOperation's documented fallback). Without counting those, the
 // prompt would tell the agent the credential is missing while the proxy would in
 // fact find it, and it would refuse work it can do. The vault still comes first
 // everywhere it matters — this only affects what the agent is TOLD.
 const envKeys = envConfiguredCredentialKeys(resolved.skills);
 const configuredKeys = [...new Set([...vaultKeys, ...envKeys])];
 return renderSandboxSkillPrompt({ ...resolved, configuredKeys });
}

// ---------------------------------------------------------------------------
// What the Skills browser can show for one skill (GET /backend/system/skill-content)
// ---------------------------------------------------------------------------

// The resolution itself lives in server/skill-content.cjs so the browser route and the
// AGENT tool loop (mcp.cjs `read_skill`) share ONE implementation — a pane and an agent
// that disagree about what a skill says is the failure this feature exists to avoid.
// The vault read stays here, injected, because this is the only module that knows it.
function loadSkillContentForWorkspace(workspaceId, skill) {
 return loadSkillContent({
  db: getDb(),
  workspaceId,
  skill,
  listConfiguredCredentialKeys: listConfiguredSandboxCredentialKeys,
 });
}

async function skillContentPayload(workspaceId, skill) {
 return { kind: 'skill', ...(await loadSkillContentForWorkspace(workspaceId, skill)) };
}

// A detected skill library's entries, or one entry's markdown.
//
// The library is looked up by ID in the list detectSkillLibraries produced — the caller
// never names a path, because a proxy that takes a path from its caller is a file-read
// primitive, and this process has a home directory. Reading is additionally gated on
// AGENSIS_ALLOW_PROJECT_FS, the same flag inspectProjectPath uses: these libraries live on
// the BACKEND HOST, which is the operator's machine when self-hosted and a shared machine
// otherwise, and only the operator can say which of those it is.
async function skillLibraryPayload(libraryId, entryName) {
 if (!projectFsAllowed()) {
  return { kind: 'library', library: libraryId, entries: [], ...skillContentUnavailable('host-fs-disabled') };
 }
 const library = findReadableLibrary(detectSkillLibraries(''), libraryId);
 if (!library) {
  return { kind: 'library', library: libraryId, entries: [], ...skillContentUnavailable('not-found') };
 }
 if (!entryName) {
  return { kind: 'library', library: libraryId, path: library.path, entries: listLibraryEntries(library.path) };
 }
 return {
  kind: 'library-entry',
  library: libraryId,
  entry: entryName,
  maxBytes: SKILL_CONTENT_MAX_BYTES,
  ...readLibraryEntry(library.path, entryName),
 };
}

// ===========================================================================
// The credential-injecting provider proxy
// ---------------------------------------------------------------------------
// An agent never receives a secret; it receives a CAPABILITY. It names a
// provider skill id and one of that skill's operations; this function resolves
// the destination FROM THE SKILL DEFINITION, attaches the workspace's stored
// credential, makes the call, and hands back the response fenced as untrusted
// data. See the "THE PROVIDER CALL" section of server/sandbox-skills.cjs for the
// threat model — in one line: a proxy that takes a URL from its caller is a
// credential-exfiltration primitive, so this one cannot be given a URL.
//
// Every DECISION is in the pure module (planProviderCall / describeProviderCall /
// applyProviderCredential / unknownProviderCallArgs) so it is provable in a unit
// test. What lives here is only the I/O: the vault read, the DNS-and-fetch, the
// capped response read, and the audit row.
//
// The SSRF check on the resolved URL is assertSafeOutboundUrl — the same guard
// the gateway base_url path uses, deliberately not a second implementation.
// ===========================================================================

const PROVIDER_CALL_TIMEOUT_MS = 30_000;
// A provider response is read into memory before it is fenced, so it needs a
// ceiling well below "whatever the provider felt like sending". The fence
// truncates to 4 KiB of TEXT for the prompt; this is the transport-level cap that
// stops a hostile 1 GB body from being read at all.
const PROVIDER_CALL_MAX_RESPONSE_BYTES = 256 * 1024;

// Read a response body with a hard byte ceiling. `response.text()` has none, and
// a provider (or something impersonating one) that streams forever would hold the
// request open until the timeout while growing the heap.
async function readCappedResponseText(response, maxBytes) {
 if (!response.body || typeof response.body.getReader !== 'function') {
  const whole = await response.text().catch(() => '');
  return { text: whole.slice(0, maxBytes), truncated: whole.length > maxBytes };
 }
 const reader = response.body.getReader();
 const chunks = [];
 let size = 0;
 let truncated = false;
 for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (!value) continue;
  const remaining = maxBytes - size;
  if (value.length >= remaining) {
   chunks.push(value.subarray(0, Math.max(0, remaining)));
   truncated = true;
   await reader.cancel().catch(() => { });
   break;
  }
  chunks.push(value);
  size += value.length;
 }
 return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}

// Logs one activity_events row per credentialed outbound call, so a workspace
// owner can read what was called on an agent's behalf.
//
// activity_events rather than a new table: it is already workspace-scoped, already
// in the backendClient allowlists at select:'read', already fanned out over
// realtime, and already the surface the owner reads. A dedicated table would be a
// four-place schema change to reproduce all of that.
//
// WHAT IS RECORDED: the operation, the provider, the resolved URL, the HTTP
// status, and how long it took. WHAT IS NOT: the request body, the response body,
// and any header — the metadata blob is built from describeProviderCall, which
// has no field that could carry a credential, and the whole title goes through
// redactSandboxSecrets with the live secret as a known value as a last net.
async function logProviderCallActivity({ workspaceId, agent, plan, status, outcome, detail = '', durationMs = 0, knownSecrets = [], credentialSource = '' }) {
 try {
  if (!workspaceId || !plan) return;
  const described = describeProviderCall(plan);
  const handle = slugHandle(agent?.handle || agent?.name || 'agent');
  const statusText = status == null ? outcome : String(status);
  const title = redactSandboxSecrets(
   `@${handle} called ${described.provider} ${described.operation} (${statusText})`,
   knownSecrets,
  ).slice(0, 120);
  const metadata = {
   ...described,
   agent_id: agent?.id ? String(agent.id) : '',
   agent_handle: handle,
   status: status == null ? null : Number(status),
   outcome,
   detail: redactSandboxSecrets(String(detail || ''), knownSecrets).slice(0, 300),
   duration_ms: Math.max(0, Math.round(durationMs)),
   // WHERE the credential came from — 'vault' or 'env' — so "why is it still using
   // the old key" is answerable from the audit trail. A source, never a value and
   // never the vault key.
   credential_source: credentialSource === 'vault' || credentialSource === 'env' ? credentialSource : '',
  };
  const inserted = await getDb().unsafe(
   `insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
      values ($1, null, 'provider_call', 'agent', $2, $3, $4::jsonb, now())
      returning *`,
   [workspaceId, agent?.id != null ? String(agent.id) : null, title, metadata],
  );
  if (inserted.length > 0) notifyDbSubscribers('activity_events', 'INSERT', inserted);
 } catch (error) {
  // An audit write must never turn a successful provisioning call into a failure
  // the agent reports to the requester. It is logged loudly instead.
  console.error('logProviderCallActivity failed', error);
 }
}

// Logs the one refusal worth its own audit row: an agent that tried to name the
// destination of a credentialed call. A well-behaved agent never sends a `url` or
// a `headers` argument, so this is not noise — it is the signature of the threat
// this whole design exists to refuse, and an owner should be able to see that it
// happened and which agent did it. Ordinary validation errors (a typo'd operation,
// a missing path parameter) are NOT logged: they are frequent, harmless, and would
// bury this.
//
// The rejected VALUES are deliberately not recorded. A value here is an
// attacker-chosen URL, and an activity_events row is fanned out over realtime to
// every subscribed browser in the workspace.
async function logProviderCallRefusal({ workspaceId, agent, keys = [] }) {
 try {
  if (!workspaceId || keys.length === 0) return;
  const handle = slugHandle(agent?.handle || agent?.name || 'agent');
  const named = keys.map((key) => sanitizeSandboxMeta(key, 40)).filter(Boolean).slice(0, 8);
  const inserted = await getDb().unsafe(
   `insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
      values ($1, null, 'provider_call', 'agent', $2, $3, $4::jsonb, now())
      returning *`,
   [
    workspaceId,
    agent?.id != null ? String(agent.id) : null,
    `@${handle} provider call refused: supplied ${named.join(', ')}`.slice(0, 120),
    {
     agent_id: agent?.id ? String(agent.id) : '',
     agent_handle: handle,
     outcome: 'refused_arguments',
     status: null,
     rejected_arguments: named,
     detail: 'An agent may not name a URL, host or header on a credentialed call.',
    },
   ],
  );
  if (inserted.length > 0) notifyDbSubscribers('activity_events', 'INSERT', inserted);
 } catch (error) {
  console.error('logProviderCallRefusal failed', error);
 }
}

/**
 * Make one credentialed call on an agent's behalf.
 *
 * `workspaceId` and `agentId` come from the caller's TOKEN, never from its
 * arguments — that is what makes a cross-workspace read impossible rather than
 * merely checked. The agent row is re-read here (bound on BOTH ids) instead of
 * trusted from the token payload, because the token's cached `agent` payload
 * deliberately omits nothing but is also a snapshot, and the skill layer is the
 * authorization decision.
 *
 * Returns a plain object. It never throws for a caller error, and it never
 * returns a header, a credential, or anything derived from one.
 */
async function callProviderOperation({ workspaceId, agentId, args = {} } = {}) {
 const refuse = (error) => ({ ok: false, error: String(error) });

 // 1. Resolve the agent and its OWN skill layer. A provider skill the agent does
 //    not carry is not callable by it, so one agent can never spend another
 //    agent's provider credential. Both ids are BOUND, so a foreign workspace does
 //    not return a row to check — it returns no row.
 const rows = await getDb().unsafe(
  'select id, workspace_id, name, handle, skills, metadata, enabled from workspace_agents where id = $1 and workspace_id = $2 limit 1',
  [String(agentId || ''), String(workspaceId || '')],
 );
 const agent = rows[0];
 if (!agent || !isAgentEnabled(agent)) return refuse('Agent not found in this workspace.');

 // 2. The caller may name FOUR things. Anything else — url, base_url, host,
 //    headers, authorization — is refused BY NAME rather than trimmed, and it is
 //    AUDITED: a well-behaved agent never sends one, so an attempt is the single
 //    highest-signal event an owner could read here. Only the key NAMES are
 //    recorded — the value would be the attacker's URL, and this row fans out over
 //    realtime to every subscribed browser.
 const unknown = unknownProviderCallArgs(args);
 if (unknown.length > 0) {
  await logProviderCallRefusal({ workspaceId, agent, keys: unknown });
  return refuse(`call_provider does not accept: ${unknown.join(', ')}. The destination and the credential come from the skill definition — you name an operation, not a URL. Allowed arguments: skill_id, operation, path_params, body.`);
 }

 const skillId = String(args.skill_id || '').trim().toLowerCase();
 if (!skillId) return refuse('skill_id is required.');

 const resolved = sandboxSkillsForAgent(agent);
 const skill = resolved.providers.find((candidate) => candidate.id === skillId);
 if (!skill) {
  const available = resolved.providers.map((p) => `\`${p.id}\``);
  return refuse(available.length > 0
   ? `You do not carry a provider skill \`${skillId}\`. Yours are: ${available.join(', ')}.`
   : 'You carry no provider skills, so there is nothing to call. Ask an operator to add one.');
 }

 // 3. Plan the call. Pure: this is where the URL is built from the definition.
 const planned = planProviderCall({
  skill,
  operation: args.operation,
  pathParams: args.path_params,
  body: args.body,
 });
 if (!planned.ok) return refuse(planned.error);
 const plan = planned.plan;

 // 4. The credential. Read by the key the DEFINITION names, from the workspace the
 //    TOKEN names. Not configured is the honest, actionable answer — and the one
 //    the skill prompt already told the agent to expect.
 //
 //    THE VAULT WINS. The host env var is a fallback for a server run on someone's
 //    own machine, where the key is already in `.env`; on Fly nothing sets it, so
 //    the vault is the only source that exists there. An operator who rotates a key
 //    in the vault must not keep getting a stale value out of the environment, so
 //    the order is vault, then env — never the reverse.
 //
 //    The env NAME comes from the BUNDLED definition, not from `plan.credentialEnv`,
 //    which an agent-authored skill can set to any env-var-shaped string. Trusting
 //    the plan's name would let an agent that can write its own metadata name
 //    `AUTH_SECRET` (or `DATABASE_URL`) and have the server attach that value as a
 //    Bearer token to the definition's own base URL.
 let secret = '';
 let credentialSource = '';
 if (plan.credentialKey) {
  secret = await getWorkspaceSecretValue(workspaceId, plan.credentialKey).catch(() => '');
  if (secret) credentialSource = 'vault';
  if (!secret) {
   const envName = bundledCredentialEnvVar(plan.credentialKey);
   const fromEnv = envName ? String(process.env[envName] || '').trim() : '';
   if (fromEnv) { secret = fromEnv; credentialSource = 'env'; }
  }
  if (!secret) {
   // Names the VAULT, because that is where an operator fixes this. Naming an env
   // var here would send them to edit a file the deployed server never reads.
   return {
    ok: false,
    credential_configured: false,
    call: describeProviderCall(plan),
    error: `The \`${plan.provider}\` credential is not configured, so this call cannot be made. An operator adds it to the workspace vault as \`${plan.credentialKey}\` in Settings -> Vault, under ${plan.provider}. Report this, name that key, and stop; do not retry.`,
   };
  }
 }
 const knownSecrets = secret ? [secret] : [];

 // 5. SSRF, on the RESOLVED url, with DNS resolution. isSafeProviderBaseUrl
 //    already vetted the definition's host by NAME; only this can see a public
 //    name whose A record is 169.254.169.254.
 try {
  await assertSafeOutboundUrl(plan.url, 'the provider URL');
 } catch (error) {
  const detail = String(error?.message || 'is not a safe outbound target');
  await logProviderCallActivity({ workspaceId, agent, plan, status: null, outcome: 'blocked', detail, knownSecrets, credentialSource });
  return { ok: false, call: describeProviderCall(plan), error: `Refused before calling: ${detail}. This is a problem with the provider skill definition, not with your request.` };
 }

 // 6. The call. `redirect: 'manual'` is load-bearing, not tidiness: following a
 //    redirect re-sends the Authorization header to whatever host the redirect
 //    names, and no per-hop validation can prevent that (a public host redirecting
 //    to another public host passes every check). A 3xx is reported as a status.
 const startedAt = Date.now();
 let response;
 try {
  response = await fetch(plan.url, {
   method: plan.method,
   headers: applyProviderCredential(plan, secret),
   body: plan.bodyText || undefined,
   redirect: 'manual',
   signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
  });
 } catch (error) {
  const durationMs = Date.now() - startedAt;
  // A transport error message can quote the URL; it should never be able to quote
  // the header, but redact against the live secret anyway — the cost of being
  // wrong here is the credential in a channel.
  const detail = redactSandboxSecrets(String(error?.message || 'request failed'), knownSecrets).slice(0, 300);
  await logProviderCallActivity({ workspaceId, agent, plan, status: null, outcome: 'error', detail, durationMs, knownSecrets, credentialSource });
  return { ok: false, call: describeProviderCall(plan), error: `The provider could not be reached: ${detail}` };
 }

 const status = response.status;
 const durationMs = Date.now() - startedAt;
 const redirected = status >= 300 && status < 400;
 let bodyText = '';
 let truncated = false;
 if (!redirected) {
  const read = await readCappedResponseText(response, PROVIDER_CALL_MAX_RESPONSE_BYTES)
   .catch(() => ({ text: '', truncated: false }));
  bodyText = read.text;
  truncated = read.truncated;
 }

 // 7. Everything the provider said is UNTRUSTED and arrives fenced — a box name,
 //    a cloned repo's README echoed into a build log, or an error string are all
 //    attacker-influenced text. `knownSecrets`
 //    means a provider echoing the Authorization header it received cannot put the
 //    key back into the agent's context.
 const fenced = fenceProviderOutput({
  provider: plan.provider,
  operation: plan.operation,
  status,
  body: redirected ? PROVIDER_CALL_REDIRECT_NOTE : bodyText,
  knownSecrets,
 });

 await logProviderCallActivity({
  workspaceId,
  agent,
  plan,
  status,
  outcome: redirected ? 'redirect_refused' : (response.ok ? 'ok' : 'provider_error'),
  detail: truncated ? `response truncated at ${PROVIDER_CALL_MAX_RESPONSE_BYTES} bytes` : '',
  durationMs,
  knownSecrets,
  credentialSource,
 });

 return {
  ok: Boolean(response.ok) && !redirected,
  status,
  call: describeProviderCall(plan),
  // The ONLY provider-derived text that leaves this function, and it is fenced.
  response: fenced.content,
  truncated,
  ...(redirected ? { redirect_refused: true } : {}),
 };
}

function buildDaemonPrompt(contextMessages, agent, coParticipants, recentActivity = '', voiceHuddle = false, intentNote = '', sandboxSkillNote = '') {
 const selfHandle = slugHandle(agent.handle || agent.name);
 const lines = [];
 // Ahead of the transcript: these are the agent's operating instructions for the
 // whole turn, not context about the request.
 if (sandboxSkillNote) lines.push(sandboxSkillNote, '');
 // First, before the roster and the transcript: it changes HOW the agent answers,
 // so it must be read before what it is answering.
 // Before the voice note, the roster and the transcript: house style changes
 // HOW every following line should be read.
 if (intentNote) lines.push(intentNote, '');
 if (voiceHuddle) lines.push(VOICE_HUDDLE_NOTE, '');
 if (coParticipants.length > 0) {
  lines.push(
   `You are @${selfHandle} in a multi-agent channel. Other agents present: ${coParticipants.map((p) => `@${p.handle}`).join(', ')}.`,
   'To bring another agent in, address them by @handle. If the request is fully handled, reply without mentioning anyone.',
   '',
  );
 }
 if (recentActivity) {
  lines.push(
   "You are one continuous agent across this workspace's DMs and channels. Your recent activity elsewhere (use for continuity, and when asked what you are working on):",
   recentActivity,
   '',
  );
 }
 lines.push('Conversation so far:');
 for (const message of contextMessages) {
  lines.push(message.role === 'assistant' ? `[@${selfHandle} (you)]: ${message.content}` : message.content);
 }
 lines.push('', 'Write your next reply as @' + selfHandle + '.');
 return lines.join('\n');
}

// Who a row addresses, in the order the mentions appear. `@channel` expands to
// `channelAgents` in roster order at the position it was written, so
// "@scout then @channel" asks Scout first and everyone else after.
function agentsAddressedByRow(row, byHandle, channelAgents) {
 const out = [];
 for (const handle of parseAllMentions(row.content)) {
  if (handle === CHANNEL_MENTION_HANDLE) {
   for (const agent of channelAgents) out.push(agent);
   continue;
  }
  const agent = byHandle.get(handle);
  if (agent) out.push(agent);
 }
 return out;
}

// The ONE agent to run next, or null. Deliberately one: a burst advances by a
// single turn at a time, each next turn triggered when the previous job
// finalizes (see the continueConversation call in finalizeAgentJobResult). That
// is what keeps `@channel` from being a fan-out — N agents answer in sequence,
// each one bounded by max_agent_turns, the one-active-job-per-(session, agent)
// index and hasActiveBurstJob, exactly as N separate @mentions already were.
function pickMentionNextAgent(burst, byHandle, latestAuthorAgentId, channelAgents = []) {
 for (let i = 0; i < burst.length; i++) {
  const row = burst[i];
  const authorAgentId = row.sender_kind === 'agent' ? String(row.sender_id || '') : '';
  for (const agent of agentsAddressedByRow(row, byHandle, channelAgents)) {
   if (!agent || !isAgentEnabled(agent)) continue;
   const agentId = String(agent.id);
   if (authorAgentId && agentId === authorAgentId) continue; // ignore self-mentions
   if (agentId === latestAuthorAgentId) continue; // never reply to itself back-to-back
   let satisfied = false;
   for (let j = i + 1; j < burst.length; j++) {
    if (burst[j].sender_kind === 'agent' && String(burst[j].sender_id || '') === agentId) {
     satisfied = true;
     break;
    }
   }
   if (!satisfied) return agent;
  }
 }
 return null;
}

// --- Context-aware auto-interject -------------------------------------------
// In an 'auto' channel a human message with NO @mention can still draw a single
// "watcher" agent in unprompted, when that agent is clearly relevant. A cheap
// Haiku call is the relevance gate; it fails CLOSED (any error => no interject).
const AUTO_INTERJECT_MODEL = 'claude-haiku-4-5';

// Single cheap LLM call: decide whether ONE candidate agent should interject.
// Returns the chosen agent row or null. Never throws (fail closed).
// `lastSpeakerHandle` (when set) is the agent the human replied immediately
// after — the primary candidate for "is this for you, or do you pass it on?".
async function pickAutoInterjectWatcher({ workspaceId, humanMessage, contextLines, candidates, lastSpeakerHandle = '' }) {
 if (!Array.isArray(candidates) || candidates.length === 0) return null;
 const roster = candidates
  .map((a) => `- @${slugHandle(a.handle || a.name)}: ${textFromValue(a.description || a.soul || a.name).slice(0, 160)}`)
  .join('\n');
 const lastSpeakerLine = lastSpeakerHandle
  ? `The human posted immediately after @${lastSpeakerHandle}. If the latest message reads as a reply, answer, or follow-up to @${lastSpeakerHandle} (or continues that exchange), prefer @${lastSpeakerHandle} — unless another agent is a clearly better fit to take it or the message is plainly meant for someone else. That agent can always pass it on.`
  : '';
 const prompt = [
  'You route a team chat. A human just posted in a channel where NO agent was @mentioned.',
  'Decide whether exactly ONE of these agents should proactively chime in because it is clearly,',
  'specifically relevant to the latest human message. Most messages need NO interjection — only pick an',
  'agent when it would add real, on-topic value. When unsure, pick null.',
  lastSpeakerLine,
  '',
  'Agents in this channel:',
  roster,
  '',
  'Recent context (oldest first):',
  contextLines || '(none)',
  '',
  `Latest human message:\n${humanMessage}`,
  '',
  'Respond with STRICT JSON only, no prose: {"agent": "<handle>" | null, "reason": "<short>"}',
 ].filter(Boolean).join('\n');

 let text;
 try {
  text = await runAnthropicCompletion({
   model: AUTO_INTERJECT_MODEL,
   messages: [{ role: 'user', content: prompt }],
   memory: null,
   documents: null,
   workspaceContext: null,
   agentContext: null,
   workspaceId,
   // Its own usage kind: this is a call the human never asked for, made on
   // EVERY unaddressed message in an 'auto' channel. Small per call and easy to
   // miss in a total — which is the argument for it having its own line.
   usageKind: 'auto_interject',
  });
 } catch (error) {
  console.error('auto-interject relevance call failed', error?.message || error);
  return null; // fail closed
 }

 try {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  if (!parsed || parsed.agent == null) return null;
  const handle = slugHandle(String(parsed.agent));
  if (!handle) return null;
  return candidates.find((a) => slugHandle(a.handle || a.name) === handle) || null;
 } catch {
  return null; // unparseable => fail closed
 }
}

// When a human @mentions an agent that isn't yet a channel participant, add it
// to the session's participant roster so it shows in the channel and becomes an
// auto-interject candidate for later turns. 1:1 DMs are left isolated. Returns
// the count added (0 = nothing to do). Best-effort; never throws to the caller.
async function ensureMentionedParticipants(workspaceId, session, content) {
 try {
  const directTarget = directAgentParticipantFromSession(session);
  if (directTarget && directTarget.direct) return 0; // private DMs stay 1:1
  const handles = parseAgentMentions(content);
  if (handles.length === 0) return 0;
  const existing = parseJsonArray(session.participants);
  // Key on the agent's bare uuid whichever field carries it and whichever
  // shape wrote it. Two writers produced `agent:<uuid>` and bare `<uuid>` rows
  // for the SAME agent, and this set — keyed on agent_id alone — could not see
  // one of them, so a mention re-appended an agent that was already present.
  // continueConversation dispatches per agent row: the duplicate answered
  // every turn twice, and a huddle read both replies aloud.
  const existingAgentIds = new Set(
   existing
    .filter((p) => p && p.kind === 'agent')
    .map((p) => String(p.agent_id || p.id || '').replace(/^agent:/, ''))
    .filter(Boolean),
  );
  const agents = await getDb().unsafe(
   'select id, name, handle, enabled from workspace_agents where workspace_id = $1',
   [workspaceId],
  );
  const byHandle = new Map();
  for (const agent of agents) {
   if (!isAgentEnabled(agent)) continue;
   byHandle.set(slugHandle(agent.handle || agent.name), agent);
   const nameHandle = slugHandle(agent.name);
   if (!byHandle.has(nameHandle)) byHandle.set(nameHandle, agent);
  }
  const additions = [];
  const seen = new Set();
  for (const handle of handles) {
   const agent = byHandle.get(handle);
   if (!agent) continue;
   const id = String(agent.id);
   if (existingAgentIds.has(id) || seen.has(id)) continue;
   seen.add(id);
   additions.push({
    id: `agent:${id}`,
    kind: 'agent',
    agent_id: id,
    user_id: null,
    name: agent.name,
    handle: slugHandle(agent.handle || agent.name),
    status: null,
    direct: false,
    added_at: new Date().toISOString(),
   });
  }
  if (additions.length === 0) return 0;
  const merged = [...existing, ...additions];
  const updated = await getDb().unsafe(
   'update chat_sessions set participants = $1::jsonb, updated_at = now() where id = $2 returning *',
   // Bind the ARRAY, never JSON.stringify it. A stringified bind into a jsonb
   // column stores a jsonb STRING SCALAR, not an array — jsonb_typeof() reads
   // 'string', Array.isArray() is false on the client, and every participant
   // lookup silently finds nobody. 51 of 70 sessions were corrupted this way.
   [merged, session.id],
  );
  if (updated.length > 0) notifyDbSubscribers('chat_sessions', 'UPDATE', updated);
  return additions.length;
 } catch (error) {
  console.error('ensureMentionedParticipants failed', error?.message || error);
  return 0; // best-effort; dispatch still proceeds
 }
}






// Runs exactly one agent turn (builtin or daemon), rebuilding context from the DB.
// Returns { ok, pending }. pending=true means a daemon job is in flight and the
// conversation will resume from handleAgentJobResult.
// One agent turn runs in-process (builtin chat completion) or is dispatched to a
// connected daemon. 'sandbox' rides the daemon path — the daemon spins up the
// remote sandbox and supervises it — so only 'builtin' stays in-process.
function resolveRunTarget(agent) {
 const m = agent && agent.run_mode;
 if (m === 'daemon' || m === 'sandbox') return 'daemon';
 // 'external' = an MCP client works AS this agent (register_agent). It is NOT
 // builtin: answering such a turn with the workspace's own model would put words
 // in the registered client's mouth, indistinguishable from the real thing.
 return m === 'external' ? 'external' : 'builtin';
}

// "Send to channel": where an agent WORKS when the turn was seeded in the channel
// itself — a thread hanging off the newest top-level human message, i.e. the one
// that started this burst. Returns { parentId, broadcast }: broadcast=true means
// "post the placeholder in that thread and flag the final answer for the channel".
// A session with no such message has nothing to hang a thread off (the whole
// transcript is threaded, or it is empty), so the turn falls back to exactly the
// pre-feature behaviour: work at the top level, no broadcast flag.
async function resolveWorkThreadParent(sessionId) {
 const rows = await getDb().unsafe(
  `select id from messages
     where session_id = $1 and thread_parent_id is null and role = 'user' and deleted_at is null
     order by created_at desc, id desc
     limit 1`,
  [sessionId],
 );
 const parentId = rows[0] ? String(rows[0].id) : null;
 return parentId ? { parentId, broadcast: true } : { parentId: null, broadcast: false };
}



// =============================================================================
// The built-in tool-use loop.
//
// A built-in agent used to be sent a bare completion — model, messages, system,
// no `tools` — so it could only ever emit text. It would announce that it was
// "calling the create_thread_item tool" and then not call anything, because there
// was nothing to call. The tools were real the whole time; they were just behind
// a door (MCP) that server-run turns never went through.
//
// This is that door, opened in-process. The tools and their authorization come
// from server/mcp.cjs (createBuiltinToolset) — one list, one set of schemas, one
// execution path — and the loop below is the only thing this side adds: run the
// tools the model asked for, feed the results back, ask again, stop.
// =============================================================================










// Single entry point that advances a channel conversation by one or more turns.
// Seeded by the dispatch endpoint and resumed after every agent message lands.
// Drains a queue of agent turns under one shared budget (max_agent_turns), one
// agent at a time. Builtin turns loop here; daemon turns return and resume async.
// Returns { started, reason }: `started` is true only if this call actually put an
// agent turn in flight (or ran one to completion). Task dispatch reads it to tell
// "the agent is on it" from "the turn was refused — put the task back in the
// queue"; every other caller ignores it.
async function continueConversation({ workspaceId, sessionId, threadParentId = null }) {
 if (!workspaceId || !sessionId) return { started: false, reason: 'missing_input' };
 const lockKey = `${sessionId}::${threadParentId || ''}`;
 if (conversationLocks.has(lockKey)) return { started: false, reason: 'locked' };
 conversationLocks.add(lockKey);
 let started = false;
 try {
  // eslint-disable-next-line no-constant-condition
  while (true) {
   const sessionRows = await getDb().unsafe(
    'select id, workspace_id, participants, conversation_mode, max_agent_turns, folder from chat_sessions where id = $1 limit 1',
    [sessionId],
   );
   const session = sessionRows[0];
   if (!session || String(session.workspace_id) !== String(workspaceId)) return { started, reason: 'no_session' };
   const maxTurns = Number(session.max_agent_turns) > 0 ? Number(session.max_agent_turns) : 10;
   const directTarget = directAgentParticipantFromSession(session);

   const rows = await loadChannelMessages(sessionId, threadParentId);
   if (rows.length === 0) return { started, reason: 'no_messages' };
   let startIdx = -1;
   for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') { startIdx = i; break; }
   }
   if (startIdx === -1) return { started, reason: 'no_seed' }; // no human seed; nothing to do
   const burst = rows.slice(startIdx);
   const agentTurns = burst.filter((row) => row.sender_kind === 'agent').length;
   if (agentTurns >= maxTurns) return { started, reason: 'budget_exhausted' }; // budget exhausted

   const latest = rows[rows.length - 1];
   const latestAuthorAgentId = latest.sender_kind === 'agent' ? String(latest.sender_id || '') : '';

   const agents = await getDb().unsafe(
    'select * from workspace_agents where workspace_id = $1 order by created_at asc',
    [workspaceId],
   );
   if (agents.length === 0) return { started, reason: 'no_agents' };
   const byHandle = new Map();
   for (const agent of agents) {
    if (!isAgentEnabled(agent)) continue;
    byHandle.set(slugHandle(agent.handle || agent.name), agent);
    const nameHandle = slugHandle(agent.name);
    if (!byHandle.has(nameHandle)) byHandle.set(nameHandle, agent);
   }
   const participantAgentIds = new Set();
   for (const participant of parseJsonArray(session.participants)) {
    if (participant && participant.kind === 'agent' && participant.agent_id) {
     participantAgentIds.add(String(participant.agent_id));
    }
   }

   // A true 1:1 DM (a participant flagged direct:true) is isolated: ONLY that
   // agent ever responds. Agents routinely @mention teammates to collaborate, but
   // a private DM must not pull those others in. Channels keep full routing below.
   // A DM is identified by a direct-flagged participant OR the 'Direct messages'
   // folder (legacy DMs created before the flag). Either way the agent must
   // respond without an @mention.
   const isFolderDm = session.folder === 'Direct messages';
   const isDirectMessage = Boolean(directTarget && (directTarget.direct || isFolderDm)) || isFolderDm;
   let nextAgent = null;
   // Was the agent we end up choosing NAMED, or merely included? Reply cadence
   // turns on exactly this: an @mention, a DM and a reply inside an agent's own
   // thread are questions put to that agent and are answered at once; `@channel`
   // and an unprompted election are not, and in a social channel they are paced.
   // Set by whichever branch below picks the agent, so a new branch that forgets
   // it gets the cautious answer (paced) rather than the loud one.
   let addressedIndividually = false;
   if (isDirectMessage) {
    if (agentTurns === 0) {
     // Prefer the explicit direct participant; fall back to matching the DM
     // session's title against an enabled agent (legacy DMs whose participant
     // row lost its agent_id/handle), then to the sole enabled participant.
     nextAgent = (directTarget && agents.find((agent) => isAgentEnabled(agent) && ((directTarget.agent_id && String(agent.id) === String(directTarget.agent_id))
      || (directTarget.handle && (slugHandle(agent.handle || agent.name) === slugHandle(directTarget.handle) || slugHandle(agent.name) === slugHandle(directTarget.handle)))))) || null;
     if (!nextAgent && isFolderDm) {
      const titleSlug = slugHandle(String(session.title || '').replace(/^@+/, ''));
      if (titleSlug) {
       nextAgent = agents.find((agent) => isAgentEnabled(agent) && (slugHandle(agent.handle || agent.name) === titleSlug || slugHandle(agent.name) === titleSlug)) || null;
      }
      if (!nextAgent) {
       const enabledParticipants = agents.filter((agent) => isAgentEnabled(agent) && participantAgentIds.has(String(agent.id)));
       if (enabledParticipants.length === 1) nextAgent = enabledParticipants[0];
      }
      if (!nextAgent) {
       console.warn(`[dm] no agent resolved for DM session=${sessionId} title=${JSON.stringify(session.title)} directTarget=${JSON.stringify(directTarget)} participantAgentIds=${[...participantAgentIds].join(',')} enabledAgents=${agents.filter(isAgentEnabled).length}`);
      }
     }
    }
   } else {
    // `@channel` addresses the session's STORED agent roster — never workspace
    // presence, never every agent in the workspace. Presence leaking into
    // channel membership is a bug this repo has already shipped once
    // (buildChannelRoster), and here it would spend a paid model turn per
    // phantom member. Capped at CHANNEL_MENTION_MAX_AGENTS in roster order.
    const channelAgents = expandChannelMention({
     participantAgentIds: [...participantAgentIds],
     agents,
     isEnabled: isAgentEnabled,
     limit: CHANNEL_MENTION_MAX_AGENTS,
    });
    nextAgent = pickMentionNextAgent(burst, byHandle, latestAuthorAgentId, channelAgents);
    if (nextAgent) addressedIndividually = agentNamedInBurst(nextAgent, burst);
    // A channel with exactly ONE agent participant has a directTarget even
    // though it is not a DM (directAgentParticipantFromSession falls back to the
    // sole agent), and an un-addressed post there used to wake it
    // unconditionally. That is the same un-addressed case the mode governs, so
    // it is gated the same way — otherwise "nobody has to answer" would be a
    // setting that quietly did nothing until a second agent joined.
    const unpromptedAllowed = allowsUnpromptedReply({ conversationMode: session.conversation_mode });
    if (!nextAgent && agentTurns === 0 && directTarget && unpromptedAllowed) {
     nextAgent = agents.find((agent) => isAgentEnabled(agent) && ((directTarget.agent_id && String(agent.id) === String(directTarget.agent_id))
      || (directTarget.handle && (slugHandle(agent.handle || agent.name) === slugHandle(directTarget.handle) || slugHandle(agent.name) === slugHandle(directTarget.handle)))));
     // The sole agent in a one-agent channel is the only one who could be meant,
     // so a post there is addressed to it in everything but syntax. Paced replies
     // in a room of one would just be a laggy DM.
     if (nextAgent) addressedIndividually = true;
    }
    if (!nextAgent && agentTurns === 0 && threadParentId) {
     const target = await inferThreadAgentTarget(sessionId, threadParentId);
     if (target) {
      nextAgent = agents.find((agent) => isAgentEnabled(agent) && ((target.agentId && String(agent.id) === target.agentId)
       || (target.handle && (slugHandle(agent.handle || agent.name) === target.handle || slugHandle(agent.name) === target.handle))));
      // Replying inside an agent's own thread is asking that agent, in the same
      // way naming it is.
      if (nextAgent) addressedIndividually = true;
     }
    }
    // An UN-ADDRESSED post: nobody was @mentioned, there is no direct target and
    // no thread to answer in. Whether anyone is compelled to reply to it is the
    // channel's own choice, and conversation_mode is where that choice is stored
    // — it has been on chat_sessions since the beginning, but the dispatcher
    // stopped reading it, so every channel behaved as 'auto' whatever it said.
    //
    //   'auto'    — the context-aware auto-interject below may draw ONE agent in
    //               unprompted. One cheap Haiku call picks an agent or null, and
    //               fails CLOSED. Still the default; unchanged for every
    //               existing channel.
    //   'social'  — the same election, then paced by the reply-cadence gate
    //               further down (shared/replyCadence.cjs). The agent still
    //               answers; it just does not answer in 400ms, and it is not
    //               joined by every teammate at once.
    //   'mention' — nobody is dispatched. The message is posted and read like
    //               any other, and any agent can be pulled in later with an
    //               @mention or @channel. "They don't have to answer now, but
    //               they can whenever."
    //
    // Only the un-addressed case is governed. An @mention, a DM and a reply in
    // an agent's thread dispatch in EVERY mode — the mode decides whether
    // silence is allowed, never whether being asked directly is.
    //
    // Fires once per human message (agentTurns === 0, latest author is the
    // human). The candidate pool is every enabled agent that is a channel
    // participant UNION every agent that has recently posted here — so a human
    // replying right after an agent draws that agent back in to decide "is this
    // for me, or pass it on?".
    if (!nextAgent && agentTurns === 0 && latestAuthorAgentId === '' && unpromptedAllowed) {
     const candidateIds = new Set();
     for (const id of participantAgentIds) candidateIds.add(String(id));
     // Recent agent authors (newest first): the last one to speak is the
     // primary candidate — that's who the human is most likely replying to.
     let lastAgentAuthorId = '';
     for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.sender_kind === 'agent' && r.sender_id) {
       if (!lastAgentAuthorId) lastAgentAuthorId = String(r.sender_id);
       candidateIds.add(String(r.sender_id));
      }
     }
     const candidates = [...candidateIds]
      .map((id) => agents.find((agent) => String(agent.id) === id))
      .filter((agent) => agent && isAgentEnabled(agent));
     if (candidates.length > 0) {
      const humanMessage = textFromValue(burst[0]?.content).slice(0, 2000);
      const contextLines = rows
       .slice(Math.max(0, startIdx - 5), startIdx)
       .map((r) => `${r.sender_kind === 'agent' ? '@' + slugHandle(r.sender_name || 'agent') : 'human'}: ${textFromValue(r.content).slice(0, 300)}`)
       .join('\n');
      const lastAgent = candidates.find((agent) => String(agent.id) === lastAgentAuthorId);
      const lastSpeakerHandle = lastAgent ? slugHandle(lastAgent.handle || lastAgent.name) : '';
      const watcher = await pickAutoInterjectWatcher({ workspaceId, humanMessage, contextLines, candidates, lastSpeakerHandle });
      if (watcher) nextAgent = watcher;
     }
    }
   }
   if (!nextAgent) return { started, reason: 'no_agent' };
   if (await hasActiveBurstJob(sessionId, nextAgent.id)) return { started, reason: 'agent_busy' };

   // --- reply cadence -------------------------------------------------------
   // In a channel an operator set to 'social', this turn may be held for a few
   // seconds — or, if the room has already answered a message that named nobody,
   // skipped so the reply is a conversation rather than a chorus.
   //
   // WHY HERE. This is the last point before a turn goes in flight, and the only
   // point that knows all four things the decision needs: the mode, whether this
   // agent was named, how many voices have already answered, and how long ago the
   // message it answers landed. It is also AFTER the busy check, so a paced turn
   // is never booked for an agent that could not run anyway.
   //
   // The reference message is the one this reply answers — the human's seed for
   // the first reply, the previous message for a later one — because the wait is
   // "land N seconds after that", not "wait N more seconds from now". Measuring
   // it that way is what makes re-entry idempotent: on the wake, elapsed has
   // grown, the same target is already met, and the turn runs.
   //
   // Nothing here can slow a DM, a huddle or a channel on 'auto'/'mention':
   // replyCadencePlan answers delayMs 0 for all of them before it looks at
   // anything else, and cadenceWakes is only ever written from this one place.
   const cadenceRef = agentTurns === 0 ? burst[0] : latest;
   const cadence = replyCadencePlan({
    conversationMode: session.conversation_mode,
    isDirectMessage,
    folder: session.folder,
    agentTurnsSoFar: agentTurns,
    addressedIndividually,
    jitterKey: String(cadenceRef?.id || ''),
    elapsedMs: msSinceTimestamp(cadenceRef?.created_at),
   });
   if (cadence.standDown) {
    // Not a lost reply: the room answered, this agent did not have to, and it is
    // still reachable by name. That is the behaviour 'social' is chosen FOR.
    return { started, reason: 'cadence_stand_down' };
   }
   if (cadence.delayMs > 0) {
    scheduleCadenceWake(lockKey, cadence.delayMs, { workspaceId, sessionId, threadParentId: threadParentId || null });
    return { started, reason: 'cadence_deferred' };
   }

   const involved = new Map();
   for (const id of participantAgentIds) {
    const agent = agents.find((row) => String(row.id) === id);
    if (agent) involved.set(id, agent);
   }
   for (const row of burst) {
    if (row.sender_kind === 'agent' && row.sender_id) {
     const agent = agents.find((entry) => String(entry.id) === String(row.sender_id));
     if (agent) involved.set(String(agent.id), agent);
    }
    for (const handle of parseAgentMentions(row.content)) {
     const agent = byHandle.get(handle);
     if (agent) involved.set(String(agent.id), agent);
    }
   }
   const coParticipants = [...involved.values()]
    .filter((agent) => String(agent.id) !== String(nextAgent.id))
    .map((agent) => ({ handle: slugHandle(agent.handle || agent.name), name: agent.name }));

   const result = await runAgentTurn(nextAgent, { workspaceId, sessionId, threadParentId, coParticipants, isDirectMessage });
   if (result && result.ok) started = true;
   // `ok:false, pending:true` is the one that matters to the task queue: the
   // one-active-job unique index bounced the insert, so NO job exists and nothing
   // will ever answer this turn.
   if (!result || result.pending) return { started, reason: result && result.ok ? 'dispatched' : 'refused' };
   // builtin turn finished synchronously — loop to evaluate the next turn
  }
 } finally {
  conversationLocks.delete(lockKey);
 }
}

function agentLiveMessageContent(message) {
 const text = textFromValue(message?.content ?? message?.response ?? message?.text).trim();
 if (text) return text;
 return `Thinking ${formatElapsedMs(message?.elapsedMs)}`;
}

// Every shape the server itself writes into an activity placeholder: the daemon's
// own clock (`Thinking 0s`, `Thinking 1m 4s` — see agentLiveMessageContent /
// formatElapsedMs) and the built-in chat's `Thinking…`. Deliberately narrower than
// a bare `^Thinking`, so an agent reply that happens to OPEN with the word can
// never be mistaken for a placeholder and rewritten or swept away.
const PLACEHOLDER_CONTENT_RE = '^Thinking( [0-9]|…)';








// Scheduled agent runs. Every tick we atomically claim schedules whose next_run_at
// has passed (FOR UPDATE SKIP LOCKED so overlapping ticks / multiple machines never
// double-fire), post the schedule's prompt into its session addressed to its agent,
// let the orchestrator dispatch, then reschedule and record a run-history row.
let scheduleRunnerRunning = false;
async function runDueSchedules() {
 if (scheduleRunnerRunning) return;
 scheduleRunnerRunning = true;
 try {
  const db = getDb();
  // Atomic claim: flip due rows to running and bump next_run_at in one statement.
  const due = await db.unsafe(
   `update agent_schedules s
          set running = true, last_run_at = now(), updated_at = now(),
              next_run_at = now() + (interval_seconds || ' seconds')::interval
        where s.id in (
          select id from agent_schedules
           where enabled = true and running = false and next_run_at <= now()
           order by next_run_at asc
           limit 10
           for update skip locked
        )
        returning *`,
  );
  for (const schedule of due) {
   let status = 'ok';
   let detail = '';
   try {
    const agentRows = schedule.agent_id
     ? await db.unsafe('select * from workspace_agents where id = $1 and workspace_id = $2 limit 1', [schedule.agent_id, schedule.workspace_id])
     : [];
    const agent = agentRows[0];
    if (!agent) throw new Error('scheduled agent no longer exists');
    if (!isAgentEnabled(agent)) throw new Error('scheduled agent is deactivated');
    if (!schedule.session_id) throw new Error('schedule has no target session');
    const sessionRows = await db.unsafe('select id, workspace_id from chat_sessions where id = $1 limit 1', [schedule.session_id]);
    if (!sessionRows[0] || String(sessionRows[0].workspace_id) !== String(schedule.workspace_id)) {
     throw new Error('scheduled session no longer exists');
    }
    const handle = slugHandle(agent.handle || agent.name);
    const promptBody = String(schedule.prompt || '').trim() || 'Run your scheduled task.';
    // Address the agent explicitly so mention-mode channels still dispatch.
    const content = promptBody.includes(`@${handle}`) ? promptBody : `@${handle} ${promptBody}`;
    const messageRows = await db.unsafe(
     `insert into messages (session_id, role, content, sender_kind, sender_name)
           values ($1, 'user', $2, 'system', 'Schedule') returning *`,
     [schedule.session_id, content],
    );
    notifyDbSubscribers('messages', 'INSERT', messageRows);
    await continueConversation({ workspaceId: schedule.workspace_id, sessionId: schedule.session_id });
   } catch (error) {
    status = 'error';
    detail = String(error?.message || error).slice(0, 300);
   }
   const updated = await db.unsafe(
    `update agent_schedules
            set running = false, last_status = $2, updated_at = now(),
                run_count = run_count + 1,
                fail_count = fail_count + ($3::int)
          where id = $1 returning *`,
    [schedule.id, status, status === 'error' ? 1 : 0],
   );
   if (updated.length > 0) notifyDbSubscribers('agent_schedules', 'UPDATE', updated);
   const runRows = await db.unsafe(
    `insert into agent_schedule_runs (schedule_id, workspace_id, status, detail)
         values ($1, $2, $3, $4) returning *`,
    [schedule.id, schedule.workspace_id, status, detail],
   );
   notifyDbSubscribers('agent_schedule_runs', 'INSERT', runRows);
  }
 } catch (error) {
  console.warn('[backend] schedule runner error:', error?.message || error);
 } finally {
  scheduleRunnerRunning = false;
 }
}

// A schedule left running across a restart would never fire again; clear the flag.
async function reconcileSchedulesAtStartup() {
 try {
  await getDb().unsafe(`update agent_schedules set running = false where running = true`);
 } catch {
  // table may not exist yet on a brand-new DB
 }
}


// --- Cartesia ---------------------------------------------------------------
// Text-to-speech for agent voices. The key lives ONLY here: a Cartesia voice id
// is safe to hand the browser (it is a public identifier), the key is not.
//
// This file owns the catalogue and a one-shot render for the preview button.
// Streaming playback of agent replies into a huddle is a separate pipeline and
// is not built here.

const CARTESIA_API_BASE = 'https://api.cartesia.ai';
// Cartesia pins breaking changes behind a date header. Bumping it is a
// deliberate act, so it is a constant with an env escape hatch rather than
// "whatever is current".
const CARTESIA_VERSION = String(process.env.CARTESIA_VERSION || '2026-03-01');
// Every outbound Cartesia call is bounded. Without this, a hung provider held
// the panel's request open indefinitely — the catalogue fetch and the preview
// render both run inside a user-facing HTTP request.
const CARTESIA_TIMEOUT_MS = Number(process.env.CARTESIA_TIMEOUT_MS || 15_000);
const CARTESIA_VOICES_TTL_MS = 10 * 60 * 1000;
// `GET /voices` caps `limit` at 100 and pages by cursor. ~836 voices is nine
// round trips, which is why the result is cached rather than fetched per panel
// open. The bound stops a pagination bug turning into an infinite loop.
const CARTESIA_VOICES_PAGE = 100;
const CARTESIA_VOICES_MAX_PAGES = 30;

function cartesiaApiKey() {
 return String(process.env.CARTESIA_API_KEY || '').trim();
}

function cartesiaHeaders() {
 // X-API-Key, not Authorization: Bearer. The docs for this API version describe
 // Bearer, but both forms were verified live against api.cartesia.ai on
 // 2026-07-26 (200 on /voices and /tts/bytes with either header) — do not
 // "fix" this to match the docs without re-running that check.
 return {
  'X-API-Key': cartesiaApiKey(),
  'Cartesia-Version': CARTESIA_VERSION,
  'Content-Type': 'application/json',
 };
}

/**
 * fetch with the Cartesia timeout attached, and the resulting AbortError
 * translated into something a client can be told. Every outbound Cartesia call
 * in this file goes through here — a hung provider must become a 504 with a
 * sentence, not a request that never returns.
 */
async function cartesiaFetch(url, init = {}) {
 try {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(CARTESIA_TIMEOUT_MS) });
 } catch (error) {
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
   const timeout = new Error(`Cartesia did not respond within ${Math.round(CARTESIA_TIMEOUT_MS / 1000)}s`);
   timeout.status = 504;
   throw timeout;
  }
  throw error;
 }
}

/** The fields the picker and the resolver need — not the whole voice object. */
function publicCartesiaVoice(voice) {
 return {
  id: String(voice.id || ''),
  name: String(voice.name || '').slice(0, 200),
  description: String(voice.description || '').slice(0, 400),
  gender: voice.gender || null,
  language: voice.language || null,
  country: voice.country || null,
  is_pro: voice.is_pro === true,
 };
}

let cartesiaVoicesCache = { at: 0, voices: [], inflight: null };

async function fetchCartesiaVoices() {
 const out = [];
 let cursor = '';
 for (let page = 0; page < CARTESIA_VOICES_MAX_PAGES; page += 1) {
  const url = new URL('/voices', CARTESIA_API_BASE);
  url.searchParams.set('limit', String(CARTESIA_VOICES_PAGE));
  if (cursor) url.searchParams.set('starting_after', cursor);
  const response = await cartesiaFetch(url, { headers: cartesiaHeaders() });
  if (!response.ok) {
   const detail = await response.text().catch(() => '');
   const error = new Error(`Cartesia /voices failed (${response.status}) ${detail.slice(0, 200)}`);
   error.status = response.status === 401 || response.status === 403 ? 502 : 502;
   throw error;
  }
  const payload = await response.json();
  const batch = Array.isArray(payload?.data) ? payload.data : [];
  for (const voice of batch) if (voice && voice.id) out.push(publicCartesiaVoice(voice));
  if (!payload?.has_more || batch.length === 0) break;
  cursor = String(payload.next_page || batch[batch.length - 1].id || '');
  if (!cursor) break;
 }
 return out;
}

/**
 * The catalogue, cached. Concurrent callers share ONE in-flight fetch — the
 * Agents window and the resolver can both ask on the same tick, and nine
 * paginated round trips is not something to do twice.
 */
async function cartesiaVoices() {
 const now = Date.now();
 if (cartesiaVoicesCache.voices.length > 0 && now - cartesiaVoicesCache.at < CARTESIA_VOICES_TTL_MS) {
  return cartesiaVoicesCache.voices;
 }
 if (cartesiaVoicesCache.inflight) return cartesiaVoicesCache.inflight;
 const inflight = fetchCartesiaVoices()
  .then((voices) => {
   cartesiaVoicesCache = { at: Date.now(), voices, inflight: null };
   return voices;
  })
  .catch((error) => {
   cartesiaVoicesCache = { ...cartesiaVoicesCache, inflight: null };
   // Serve a stale catalogue rather than nothing: a voice list that is ten
   // minutes out of date is strictly better than an empty picker, and an empty
   // list would also make every agent's derived default resolve to ''.
   if (cartesiaVoicesCache.voices.length > 0) return cartesiaVoicesCache.voices;
   throw error;
  });
 cartesiaVoicesCache.inflight = inflight;
 return inflight;
}

/** English voice ids in a STABLE order — what a derived default indexes into. */
async function cartesiaEnglishVoiceIds() {
 const voices = await cartesiaVoices();
 return voices
  .filter((voice) => String(voice.language || '').toLowerCase().startsWith('en'))
  .map((voice) => voice.id)
  .sort((a, b) => a.localeCompare(b));
}

/**
 * WHAT THE TTS PIPELINE CALLS. Which voice speaks for this agent, and how.
 *
 * Returns `{ voiceId, speed, emotion, isDefault, modelId }`. `voiceId` is ''
 * only when the catalogue could not be loaded at all; the caller should skip
 * speaking rather than substitute an arbitrary voice.
 */
async function agentVoiceSettings(agent) {
 if (!agent) return null;
 let voiceIds = [];
 try {
  voiceIds = await cartesiaEnglishVoiceIds();
 } catch (error) {
  console.error('[cartesia] voice catalogue unavailable:', error.message || error);
 }
 return resolveAgentVoice(agent, voiceIds);
}

// The preview line is a server-side constant, never client input — see the
// route for why.
const CARTESIA_PREVIEW_TEXT = 'Hello. This is how I sound when I answer in a huddle.';

/** One-shot render to mp3 bytes. Not streaming; the preview is one short line. */
async function cartesiaSpeak({ voiceId, speed = 1, emotion = 'neutral', transcript = CARTESIA_PREVIEW_TEXT }) {
 if (!isCartesiaVoiceId(voiceId)) {
  const error = new Error('A Cartesia voice id is required');
  error.status = 400;
  throw error;
 }
 const response = await cartesiaFetch(new URL('/tts/bytes', CARTESIA_API_BASE), {
  method: 'POST',
  headers: cartesiaHeaders(),
  body: JSON.stringify({
   model_id: CARTESIA_MODEL_ID,
   transcript,
   voice: { mode: 'id', id: voiceId },
   // generation_config is the supported control surface on sonic-3 and newer.
   // The old top-level `speed: "slow"|"normal"|"fast"` is deprecated.
   generation_config: { speed, emotion },
   // Verified live 2026-07-26: this exact shape returns 200 audio/mpeg (a real
   // ID3-tagged MP3). The documented mp3 shape (bit_rate, no encoding, 44100)
   // is ALSO accepted — Cartesia tolerates both; this one is what our tests pin.
   output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 24000 },
  }),
 });
 if (!response.ok) {
  const detail = await response.text().catch(() => '');
  const error = new Error(`Cartesia /tts/bytes failed (${response.status}) ${detail.slice(0, 200)}`);
  error.status = 502;
  throw error;
 }
 return Buffer.from(await response.arrayBuffer());
}











// Sanitizes a daemon-reported reach advert before it's stored. Caps addrs to 4 and
// truncates host so a misbehaving daemon can't grow the capabilities row unbounded.
function reachFromMessage(raw) {
 if (!raw || typeof raw !== 'object') return undefined;
 return {
  transport: 'ws',
  listening: raw.listening === true,
  addrs: Array.isArray(raw.addrs)
   ? raw.addrs.slice(0, 4).map((a) => ({
    host: String(a?.host || '').slice(0, 63),
    port: Number(a?.port) || 0,
    scope: a?.scope === 'lan' ? 'lan' : 'other',
   }))
   : [],
  auth: 'hub-pairwise',
 };
}

// Whether a stored capabilities.reach block is usable as a direct-handoff target.
function reachIsDirect(caps) {
 const reach = caps && caps.reach;
 return Boolean(reach && reach.listening === true && Array.isArray(reach.addrs) && reach.addrs.length > 0);
}

// Shared model adverts are intentionally descriptive only. The daemon keeps
// endpoint URLs and credentials private and performs inference locally; the
// hub only needs enough information to authorize, display, and route a model.
function sharedModelsFromMessage(raw) {
 if (!Array.isArray(raw)) return [];
 const models = [];
 for (const candidate of raw.slice(0, 64)) {
  if (!candidate || typeof candidate !== 'object' || candidate.shared !== true) continue;
  const id = String(candidate.id || '').trim().slice(0, 160);
  if (!id || !/^[a-zA-Z0-9._:@/-]+$/.test(id)) continue;
  const capabilities = [...new Set(
   (Array.isArray(candidate.capabilities) ? candidate.capabilities : ['text'])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean),
  )].slice(0, 16);
  const contextWindow = Number.isFinite(Number(candidate.contextWindow))
   ? Math.max(1, Math.min(10_000_000, Math.trunc(Number(candidate.contextWindow))))
   : undefined;
  const maxConcurrency = Number.isFinite(Number(candidate.maxConcurrency))
   ? Math.max(1, Math.min(64, Math.trunc(Number(candidate.maxConcurrency))))
   : 1;
  models.push({
   id,
   name: String(candidate.name || id).trim().slice(0, 160) || id,
   provider: String(candidate.provider || 'local').trim().slice(0, 80) || 'local',
   protocol: candidate.protocol === 'openai-chat' ? 'openai-chat' : 'openai-chat',
   upstreamModel: String(candidate.upstreamModel || id).trim().slice(0, 200) || id,
   capabilities,
   ...(contextWindow ? { contextWindow } : {}),
   maxConcurrency,
   shared: true,
  });
  if (models.length === 32) break;
 }
 return models;
}

function canonicalSharedModelId(workspaceId, agentId, modelId) {
 return `agensis/${String(workspaceId)}/${String(agentId)}/${encodeURIComponent(String(modelId))}`;
}

function sharedModelRoutesFromConnections(workspaceId, connections) {
 const routes = [];
 for (const row of Array.isArray(connections) ? connections : []) {
  if (String(row?.workspace_id || '') !== String(workspaceId || '')) continue;
  if (!['online', 'busy'].includes(String(row?.status || ''))) continue;
  const capabilities = parseJsonObject(row.capabilities);
  const metadata = parseJsonObject(row.metadata);
  for (const model of sharedModelsFromMessage(capabilities.sharedModels)) {
   routes.push({
    id: canonicalSharedModelId(workspaceId, row.agent_id, model.id),
    workspaceId: String(workspaceId),
    agentId: String(row.agent_id),
    connectionId: String(row.id || ''),
    modelId: model.id,
    name: model.name,
    provider: model.provider,
    protocol: model.protocol,
    capabilities: model.capabilities,
    maxConcurrency: model.maxConcurrency,
    activeInference: Math.max(0, Number(metadata.activeInferenceByModel?.[model.id] ?? metadata.activeInference ?? 0) || 0),
    status: row.status,
    handle: String(row.handle || ''),
    host: String(row.name || row.host || ''),
   });
  }
 }
 return routes;
}

async function liveSharedModelRoutes(workspaceId) {
 const rows = await getDb().unsafe(
  `select * from agent_connections
     where workspace_id = $1 and status in ('online', 'busy')
       and last_seen_at > now() - interval '120 seconds'
     order by last_seen_at desc`,
  [workspaceId],
 );
 const reconciled = rows.map((row) => (
  isConnectionSocketOpen(row.id) ? row : { ...row, status: 'offline' }
 ));
 return sharedModelRoutesFromConnections(workspaceId, reconciled);
}

function publicInferenceModel(route) {
 return {
  id: route.id,
  object: 'model',
  created: 0,
  owned_by: `agensis:${route.agentId}`,
  farm: {
   workspaceId: route.workspaceId,
   agentId: route.agentId,
   modelId: route.modelId,
   handle: route.handle,
   host: route.host,
   provider: route.provider,
   protocol: route.protocol,
   capabilities: route.capabilities,
   maxConcurrency: route.maxConcurrency,
   activeInference: route.activeInference,
   status: route.status,
  },
 };
}

function createOpenAIInferenceStreamRelay(res, publicModel) {
 let usageForwarded = false;
 return {
  onEvent(event) {
   if (event.action !== 'agent_inference_delta' || !event.chunk) return;
   if (event.chunk.usage) usageForwarded = true;
   res.write(`data: ${JSON.stringify({ ...event.chunk, model: publicModel })}\n\n`);
  },
  appendUsage(result) {
   if (!usageForwarded && result?.usage) {
    res.write(`data: ${JSON.stringify({ choices: [], model: publicModel, usage: result.usage })}\n\n`);
   }
  },
 };
}

function bindInferenceAbort(req, res, controller, isComplete = () => false) {
 req.once('aborted', () => controller.abort());
 res.once('close', () => { if (!isComplete()) controller.abort(); });
}

// --- agent-mesh pairwise peer auth (F5). Peers can't verify each other's aga_ tokens
// directly (only the hub holds connect_token_hash). The hub is the trust root: it mints
// a short-lived, single-use ticket for a requested handoff and pushes the matching grant
// to the callee, so two daemons can open a direct channel with NO new crypto beyond the
// hub's existing token machinery (mirrors createAgentConnectToken's aga_ prefix pattern).
//
// Wire (new WS actions, alongside agent_capabilities_sync):
//   Daemon A -> hub:   { action:'peer_ticket_request', targetAgentId }
//   Hub -> Daemon A:   { type:'peer_ticket', ticket, exp, peer:{ agentId, addrs } }
//   Hub -> Daemon B:   { type:'peer_ticket_grant', ticket, exp, fromAgentId }
//   Daemon A -> B (FIRST frame on B's LAN listener): { type:'peer_auth', ticket, fromAgentId }
//   Daemon B validates the presented ticket against the grant it holds — hub-verified
//   indirectly, so B needs no server secret of its own.
const pendingPeerTickets = new Map(); // ticket -> { from, to, exp }
const PEER_TICKET_TTL_MS = 60_000;
function mintPeerTicket() {
 return `agp_${crypto.randomBytes(24).toString('base64url')}`;
}
function pruneExpiredPeerTickets() {
 const now = Date.now();
 for (const [ticket, entry] of pendingPeerTickets) {
  if (now > entry.exp) pendingPeerTickets.delete(ticket);
 }
}

async function handlePeerTicketRequest(ws, message) {
 const auth = ws.agentAuth;
 if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
 const targetAgentId = String(message.targetAgentId || '');
 if (!targetAgentId) throw badRequest('targetAgentId is required');
 const targetEntry = findConnectedAgent(ws.workspaceId, targetAgentId, '');
 if (!targetEntry) throw badRequest('Target agent is not connected');
 const rows = await getDb().unsafe(
  'select capabilities from agent_connections where id = $1',
  [targetEntry.connectionId],
 );
 const targetCaps = parseJsonObject(rows[0]?.capabilities);
 if (!reachIsDirect(targetCaps)) throw badRequest('Target agent is not direct-reachable');

 pruneExpiredPeerTickets();
 const ticket = mintPeerTicket();
 const exp = Date.now() + PEER_TICKET_TTL_MS;
 pendingPeerTickets.set(ticket, { from: ws.agentId, to: targetAgentId, exp });
 sendWs(targetEntry.ws, { type: 'peer_ticket_grant', ticket, exp, fromAgentId: ws.agentId });
 sendWs(ws, { type: 'peer_ticket', ticket, exp, peer: { agentId: targetAgentId, addrs: targetCaps.reach.addrs } });
}

// --- F7 hub-mediated discovery. Primary path; mDNS/LAN-broadcast deferred since the hub
// already stores each daemon's host and holds the live workspace-scoped connectedAgents
// map. New WS action:
//   Daemon -> hub:   { action:'peer_list_request' }
//   Hub -> daemon:   { type:'peer_list', peers:[{ agentId, handle, name, reach }] }
// `reach` here is the FULL block (LAN host/port) — this is a daemon-only channel and
// deliberately bypasses publicAgentConnection (which strips reach on the browser path).
async function handlePeerListRequest(ws) {
 const auth = ws.agentAuth;
 if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
 const candidates = [...connectedAgents.values()].filter(
  (entry) => entry.workspaceId === ws.workspaceId && entry.agentId !== ws.agentId && entry.ws?.readyState === 1,
 );
 if (!candidates.length) {
  sendWs(ws, { type: 'peer_list', peers: [] });
  return;
 }
 const rows = await getDb().unsafe(
  'select id, agent_id, name, handle, capabilities from agent_connections where id = any($1::uuid[])',
  [candidates.map((entry) => entry.connectionId)],
 );
 const byConnectionId = new Map(rows.map((row) => [row.id, row]));
 const peers = [];
 for (const entry of candidates) {
  const row = byConnectionId.get(entry.connectionId);
  const caps = parseJsonObject(row?.capabilities);
  if (!reachIsDirect(caps)) continue;
  peers.push({ agentId: entry.agentId, handle: row?.handle || entry.handle, name: row?.name || entry.name, reach: caps.reach });
 }
 sendWs(ws, { type: 'peer_list', peers });
}











// --- agent registration ("a client wants to register as an agent") ----------------
// An authenticated MCP client (workspace token / agensis login / invite link) calls
// register_agent to become an agent — a brand new one, or an existing one by handle.
// Pending registrations raise an approval popup; invite/auto-approve skip straight to
// approved. Approval is what flips an agent's mcp_approved flag so it can be worked as.

async function finalizeRegistrationApproval(reg) {
 let agentId = reg.agent_id;
 let handle = reg.requested_handle;
 let name = reg.requested_name;
 if (agentId) {
  const upd = await getDb().unsafe(
   'update workspace_agents set mcp_approved = true, enabled = true, updated_at = now() where id = $1 returning *',
   [agentId],
  );
  if (upd[0]) { notifyDbSubscribers('workspace_agents', 'UPDATE', upd); handle = slugHandle(upd[0].handle || upd[0].name); name = upd[0].name; }
 } else {
  const created = await getDb().unsafe(
   `insert into workspace_agents (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, avatar, accent_color, enabled, mcp_approved)
       values ($1, $2, $3, '', '', 'auto', 'external', 'default', 'AI', '#00a95c', true, true)
       returning *`,
   [reg.workspace_id, name || handle || 'Agent', slugHandle(handle || name || 'agent')],
  );
  agentId = created[0].id;
  handle = slugHandle(created[0].handle || created[0].name);
  notifyDbSubscribers('workspace_agents', 'INSERT', created);
 }
 // The identity the client asked for in register_agent, applied now that a row
 // exists. Approval is asynchronous, so this is the first moment it can land —
 // and `isNew` is only true for the branch that just created the row, which is
 // the one case where an agent is allowed to choose its own name.
 try {
  const declared = parseJsonObject(reg.requested_identity);
  if (Object.keys(declared).length > 0) {
   const rows = await getDb().unsafe(AGENT_IDENTITY_SELECT, [agentId, reg.workspace_id]);
   const applied = await applyAgentIdentity({
    workspaceId: reg.workspace_id,
    agentId,
    row: rows[0],
    declared,
    isNew: !reg.agent_id,
   });
   if (applied) name = applied.name;
  }
 } catch (error) {
  console.error('[agensis] register_agent identity declaration failed:', error.message || error);
 }
 const updReg = await getDb().unsafe(
  `update agent_registrations set status = 'approved', agent_id = $2, decided_at = now(), updated_at = now() where id = $1 returning *`,
  [reg.id, agentId],
 );
 notifyDbSubscribers('agent_registrations', 'UPDATE', updReg);
 return { agentId, handle, name };
}

async function registerAgentRequest({ workspaceId, asHandle = null, name = null, handle = null, clientLabel = '', autoApprove = false, identity = null }) {
 const declaredIdentity = normalizeIdentityDeclaration(identity);
 let agent = null;
 if (asHandle) {
  agent = await resolveWorkspaceAgentByHandle(workspaceId, asHandle);
  if (!agent) throw badRequest(`No agent "@${slugHandle(asHandle)}" in this workspace`);
  if (agent.mcp_approved) {
   // The already-approved reconnect — the common case, and the one that happens
   // several times a day. No registration row is written, so the declaration has
   // to be applied here or an MCP agent could never update its own identity.
   try {
    const rows = await getDb().unsafe(AGENT_IDENTITY_SELECT, [agent.id, workspaceId]);
    await applyAgentIdentity({ workspaceId, agentId: agent.id, row: rows[0], declared: declaredIdentity });
   } catch (error) {
    console.error('[agensis] register_agent identity declaration failed:', error.message || error);
   }
   return { status: 'approved', agentId: agent.id, handle: slugHandle(agent.handle || agent.name) };
  }
 }
 const reqHandle = agent ? slugHandle(agent.handle || agent.name) : slugHandle(handle || name || 'agent');
 // The one door an UNTRUSTED client chooses its own handle through. @channel is
 // reserved, so refuse it here rather than write a pending registration that
 // could only ever be approved into an unmentionable agent. `agent` (an
 // existing row, resolved by asHandle) cannot be reserved: nothing could have
 // created it.
 if (!agent && isReservedAgentHandle(reqHandle)) throw badRequest(reservedAgentHandleMessage(reqHandle));
 // The bare `name` argument is the same field as identity.name and gets the
 // same bound — otherwise this door would be the one way to smuggle an
 // unbounded string into workspace_agents.name.
 const reqName = agent ? agent.name : (String(name || reqHandle).trim().slice(0, IDENTITY_FIELD_LIMITS.name) || reqHandle);
 const rows = await getDb().unsafe(
  `insert into agent_registrations (workspace_id, agent_id, requested_handle, requested_name, client_label, status, requested_identity)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning *`,
  [
   workspaceId, agent ? agent.id : null, reqHandle, reqName,
   String(clientLabel || '').slice(0, 120), autoApprove ? 'approved' : 'pending',
   // The OBJECT, not JSON.stringify: postgres.js resolves the ::jsonb cast to a
   // jsonb parameter and serializes the value itself — a pre-stringified value
   // gets serialized AGAIN and lands as a jsonb string scalar. See
   // normalizeJsonParam for the full failure mode this caused live.
   declaredIdentity,
  ],
 );
 const reg = rows[0];
 notifyDbSubscribers('agent_registrations', 'INSERT', rows);
 if (autoApprove) {
  const out = await finalizeRegistrationApproval(reg);
  return { registrationId: reg.id, status: 'approved', agentId: out.agentId, handle: out.handle };
 }
 return { registrationId: reg.id, status: 'pending', handle: reqHandle };
}

// Poll target for the client between register_agent and approval.
async function getRegistrationStatus({ workspaceId, registrationId }) {
 const rows = await getDb().unsafe(
  'select id, status, agent_id, requested_handle from agent_registrations where id = $1 and workspace_id = $2 limit 1',
  [registrationId, workspaceId],
 );
 const reg = rows[0];
 if (!reg) throw badRequest('Registration not found');
 return { registrationId: reg.id, status: reg.status, agentId: reg.agent_id, handle: reg.requested_handle };
}

async function decideAgentRegistration({ registrationId, approve }) {
 const rows = await getDb().unsafe('select * from agent_registrations where id = $1 limit 1', [registrationId]);
 const reg = rows[0];
 if (!reg) return null;
 if (reg.status !== 'pending') return reg;
 if (approve) return finalizeRegistrationApproval(reg);
 const denied = await getDb().unsafe(
  `update agent_registrations set status = 'denied', decided_at = now(), updated_at = now() where id = $1 returning *`,
  [registrationId],
 );
 notifyDbSubscribers('agent_registrations', 'UPDATE', denied);
 return denied[0];
}








// Not a pure leaf (getDb + slugHandle), so it stayed behind when the rest of the
// project-fs allowlist moved to server/lib/project-fs.cjs. It goes with the
// project-files routes in Wave 2.
async function workspaceProjectFileSources(workspaceId, workspace, filters = {}) {
 const agentFilterKeys = new Set(
  (Array.isArray(filters.agents) ? filters.agents : [])
   .map(value => slugHandle(value || ''))
   .filter(Boolean),
 );
 const hasAgentFilter = agentFilterKeys.size > 0;
 const sources = [];
 const seen = new Set();
 const addSource = (source) => {
  const root = validFileSourceRoot(source.root);
  if (!root || seen.has(root)) return;
  seen.add(root);
  sources.push({ ...source, root });
 };

 addSource({
  id: 'workspace',
  kind: 'workspace',
  label: 'Workspace folder',
  root: workspaceProjectRoot(workspace),
 });

 const connections = await getDb().unsafe(
  `select id, agent_id, name, handle, host, cwd, status
     from agent_connections
     where workspace_id = $1
       and coalesce(cwd, '') <> ''
       and last_seen_at > now() - interval '24 hours'
     order by status = 'online' desc, status = 'busy' desc, last_seen_at desc`,
  [workspaceId],
 );

 connections.forEach(connection => {
  const handle = slugHandle(connection.handle || connection.name || 'agent');
  const connectionKeys = [
   connection.id,
   connection.agent_id,
   connection.handle,
   connection.name,
   handle,
   `agent:${connection.agent_id || ''}`,
   `agent:${handle}`,
  ].map(value => slugHandle(value || '')).filter(Boolean);
  if (hasAgentFilter && !connectionKeys.some(key => agentFilterKeys.has(key))) return;
  addSource({
   id: `agent:${connection.id}`,
   kind: 'agent',
   label: `${connection.name || handle} cwd`,
   root: connection.cwd,
   agent_id: connection.agent_id || null,
   connection_id: connection.id,
   handle,
   host: connection.host || '',
   status: connection.status || '',
  });
 });

 return sources;
}


function textFromValue(value) {
 if (typeof value === 'string') {
  return value === '[object Object]' ? '' : value;
 }
 if (value == null) return '';
 if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join('\n');
 if (typeof value === 'object') {
  const keys = ['text', 'content', 'message', 'response', 'output', 'stdout', 'stderr', 'error'];
  for (const key of keys) {
   const text = textFromValue(value[key]);
   if (text) return text;
  }
  try {
   return JSON.stringify(value);
  } catch {
   return '';
  }
 }
 return String(value);
}

async function inspectProjectPath(inputPath) {
 const resolved = path.resolve(String(inputPath || ''));
 // Multi-tenant hosts leave AGENSIS_ALLOW_PROJECT_FS unset — refuse host probes.
 if (!projectFsAllowed() || !isWithinAllowedProjectRoot(resolved)) {
  return {
   path: resolved,
   exists: false,
   isDirectory: false,
   gitRoot: '',
   gitBranch: '',
   gitRemote: '',
   projectKind: '',
   denied: true,
  };
 }
 const exists = fs.existsSync(resolved);
 const result = {
  path: resolved,
  exists,
  isDirectory: exists ? fs.statSync(resolved).isDirectory() : false,
  gitRoot: '',
  gitBranch: '',
  gitRemote: '',
  projectKind: exists ? 'folder' : '',
 };
 if (!exists) return result;

 try {
  const { stdout } = await execFileAsync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
  result.gitRoot = stdout.trim();
  result.projectKind = 'git';
 } catch {
  return result;
 }
 try {
  const { stdout } = await execFileAsync('git', ['-C', resolved, 'branch', '--show-current'], { timeout: 5000 });
  result.gitBranch = stdout.trim();
 } catch {
  // optional
 }
 try {
  const { stdout } = await execFileAsync('git', ['-C', resolved, 'remote', 'get-url', 'origin'], { timeout: 5000 });
  result.gitRemote = stdout.trim();
 } catch {
  // optional
 }
 return result;
}

function buildSystemPrompt(memory, documents, workspaceContext, agentContext) {
 const sections = [];
 if (agentContext && (agentContext.systemPrompt || agentContext.name)) {
  if (agentContext.name) {
   sections.push(`You are "${agentContext.name}", an AI agent collaborating in a shared agensis workspace.`);
  }
  if (agentContext.soul) {
   sections.push(`Agent soul: ${agentContext.soul}`);
  }
  if (agentContext.systemPrompt) {
   sections.push(agentContext.systemPrompt);
  }
  if (agentContext.instructions) {
   sections.push(`Instructions:\n${agentContext.instructions}`);
  }
  if (Array.isArray(agentContext.tools) && agentContext.tools.length > 0) {
   sections.push(`Available tool preferences: ${agentContext.tools.join(', ')}`);
  }
  if (Array.isArray(agentContext.skills) && agentContext.skills.length > 0) {
   sections.push(`Selected skill libraries: ${agentContext.skills.join(', ')}`);
  }
  if (Array.isArray(agentContext.coParticipants) && agentContext.coParticipants.length > 0) {
   const roster = agentContext.coParticipants.map((peer) => `@${peer.handle}${peer.name ? ` (${peer.name})` : ''}`).join(', ');
   sections.push(
    '',
    `This is a multi-agent channel. Other agents you can collaborate with: ${roster}.`,
    '- In the conversation history, each message is prefixed with the speaker, e.g. "[@handle]: ...". Messages without a prefix are your own.',
    '- To bring another agent into the conversation, address them by @handle in your reply. Only mention an agent when you genuinely need their help — do not @ them out of politeness, or the conversation will loop.',
    '- If the request is already fully handled, answer without mentioning anyone so the conversation can end.',
   );
  }
  sections.push('');
 } else {
  sections.push(
   'You are agensis AI, a collaborative workspace assistant. You help teams think, write, and get work done inside a shared workspace that contains documents, chats, memory, tasks, files, and a shared canvas.',
   '',
  );
 }
 sections.push(
  'Guidelines:',
  '- Be concise, warm, and thoughtful. Prefer markdown for structure.',
  '- When you reference workspace content, quote the title so teammates can find it.',
  '- When the user asks you to extract or create tasks, emit them on their own lines using this exact format so the app can parse them: `TASK: <title>` (one task per line).',
  '- If you do not know something from the provided context, say so rather than inventing.',
  '- You are one of potentially many people in this workspace; speak in a way that is useful to the whole team, not just a single user.',
 );

 if (workspaceContext) {
  const wsBlocks = [];
  if (workspaceContext.workspace) wsBlocks.push(`Workspace name: ${workspaceContext.workspace}`);
  if (workspaceContext.memory) wsBlocks.push(`# Team memory\n${workspaceContext.memory}`);
  if (workspaceContext.documents) wsBlocks.push(`# Key documents\n${workspaceContext.documents}`);
  if (workspaceContext.tasks) wsBlocks.push(`# Open tasks\n${workspaceContext.tasks}`);
  if (workspaceContext.canvas) wsBlocks.push(`# Canvas notes\n${workspaceContext.canvas}`);
  if (workspaceContext.agents) wsBlocks.push(`# Workspace agents\n${workspaceContext.agents}`);
  if (workspaceContext.skills) wsBlocks.push(`# Skill libraries\n${workspaceContext.skills}`);
  if (workspaceContext.commands) wsBlocks.push(`# Commands and CLIs\n${workspaceContext.commands}`);
  if (workspaceContext.tools) wsBlocks.push(`# Tools and SDKs\n${workspaceContext.tools}`);
  if (workspaceContext.webhooks) wsBlocks.push(`# Agent webhooks\n${workspaceContext.webhooks}`);
  if (wsBlocks.length > 0) {
   sections.push('', '<workspace_context>', 'The following is a snapshot of the shared workspace you are assisting in. Use it to answer grounded questions, but do not dump it verbatim unless asked.', '', wsBlocks.join('\n\n'), '</workspace_context>');
  }
 }

 if (memory) sections.push('', '<user_memory>', 'Persistent facts the user has saved. Use this to personalize responses.', memory, '</user_memory>');
 if (documents) sections.push('', '<linked_documents>', 'The user has explicitly linked these documents for this message. Treat them as high-priority context.', documents, '</linked_documents>');
 return sections.join('\n');
}

function normalizeAiChatMessages(messages) {
 const out = [];
 const system = [];
 if (!Array.isArray(messages)) return { messages: out, systemPrompt: '' };
 for (const message of messages) {
  const role = String(message?.role || '').trim().toLowerCase();
  const content = typeof message?.content === 'string' ? message.content : '';
  if (!content) continue;
  if (role === 'system') {
   system.push(content);
   continue;
  }
  out.push({
   role: role === 'assistant' ? 'assistant' : 'user',
   content,
  });
 }
 return { messages: out, systemPrompt: system.join('\n\n') };
}




const ACTIVITY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// LRU cache for session-to-workspace lookups. Capped to prevent unbounded
// memory growth on long-running servers.
const WORKSPACE_SESSION_CACHE_MAX = 2000;
const workspaceIdBySessionCache = new Map();

function workspaceSessionCacheGet(sessionId) {
 const value = workspaceIdBySessionCache.get(sessionId);
 if (value === undefined) return undefined;
 // Move to end (most recently used) by re-inserting.
 workspaceIdBySessionCache.delete(sessionId);
 workspaceIdBySessionCache.set(sessionId, value);
 return value;
}

function workspaceSessionCacheSet(sessionId, workspaceId) {
 if (workspaceIdBySessionCache.has(sessionId)) workspaceIdBySessionCache.delete(sessionId);
 workspaceIdBySessionCache.set(sessionId, workspaceId);
 // Evict oldest entries when the cache exceeds capacity.
 if (workspaceIdBySessionCache.size > WORKSPACE_SESSION_CACHE_MAX) {
  const excess = workspaceIdBySessionCache.size - WORKSPACE_SESSION_CACHE_MAX;
  let evicted = 0;
  for (const key of workspaceIdBySessionCache.keys()) {
   if (evicted >= excess) break;
   workspaceIdBySessionCache.delete(key);
   evicted++;
  }
 }
}

async function resolveWorkspaceIdForSession(sessionId) {
 if (!sessionId) return null;
 const cached = workspaceSessionCacheGet(sessionId);
 if (cached !== undefined) return cached;
 try {
  const rows = await getDb().unsafe(
   'select workspace_id from chat_sessions where id = $1 limit 1',
   [sessionId],
  );
  const workspaceId = rows[0]?.workspace_id || null;
  if (workspaceId) workspaceSessionCacheSet(sessionId, workspaceId);
  return workspaceId;
 } catch (error) {
  console.error('resolveWorkspaceIdForSession failed', error);
  return null;
 }
}

// Logs an `activity_events` row for each inserted/finalized chat message so it
// surfaces in the Activity feed. Fire-and-forget; never blocks message delivery.
async function logMessageActivity(rows) {
 for (const message of rows) {
  if (!message || typeof message !== 'object') continue;
  // Skip the "Thinking 0s" placeholder agent rows — the real reply is logged
  // when the message is finalized via UPDATE.
  if (isAgentPlaceholder(message)) continue;
  try {
   const sessionId = message.session_id;
   const workspaceId = await resolveWorkspaceIdForSession(sessionId);
   if (!workspaceId) continue;
   const role = message.role || '';
   const senderName = message.sender_name || (role === 'user' ? 'You' : 'Agent');
   const content = typeof message.content === 'string' ? message.content : '';
   const title = `${senderName}: ${content.slice(0, 80)}`.slice(0, 120);
   const senderId = typeof message.sender_id === 'string' ? message.sender_id : '';
   const userId = role === 'user' && ACTIVITY_UUID_RE.test(senderId) ? senderId : null;
   const metadata = {
    session_id: sessionId,
    role,
    sender_kind: message.sender_kind || '',
    sender_name: message.sender_name || '',
    content,
   };
   // C3: idempotent insert. ON CONFLICT DO NOTHING against the partial unique
   // index uq_activity_events_message_sent means a retried finalization for the
   // same message id is a no-op (returns 0 rows), so the feed row — and its
   // realtime notification below — fire exactly once. Target left off so it
   // degrades to a plain insert if the index hasn't been created yet.
   const inserted = await getDb().unsafe(
    `insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
         values ($1, $2, 'message_sent', 'message', $3, $4, $5::jsonb, now())
         on conflict do nothing
         returning *`,
    [workspaceId, userId, message.id != null ? String(message.id) : null, title, metadata],
   );
   if (inserted.length > 0) {
    // table is 'activity_events' here, so this cannot re-trigger message logging.
    notifyDbSubscribers('activity_events', 'INSERT', inserted);
   }
  } catch (error) {
   console.error('logMessageActivity failed', error);
  }
 }
}

// Logs an `activity_events` row when an agent daemon connects or disconnects, so
// the notifications bell can show a timestamped connection history (one row per
// event) instead of a single collapsing per-agent entry. Fire-and-forget — never
// blocks the connect/disconnect path. Only real connects and real socket-close
// disconnects are logged; the process-start mass-offline sweep is intentionally
// excluded so a daemon restart doesn't spam a disconnect storm into the bell.
async function logConnectionActivity(connection, eventType) {
 try {
  if (!connection || typeof connection !== 'object') return;
  const workspaceId = connection.workspace_id;
  if (!workspaceId) return;
  const handle = connection.handle || '';
  const name = connection.name || handle || 'Agent';
  const verb = eventType === 'agent_connected' ? 'connected' : 'disconnected';
  const title = `@${handle || name} ${verb}`.slice(0, 120);
  const metadata = {
   handle,
   name,
   agent_id: connection.agent_id || '',
   status: connection.status || (eventType === 'agent_connected' ? 'online' : 'offline'),
  };
  const inserted = await getDb().unsafe(
   `insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
       values ($1, null, $2, 'agent', $3, $4, $5::jsonb, now())
       returning *`,
   [workspaceId, eventType, connection.agent_id != null ? String(connection.agent_id) : null, title, metadata],
  );
  if (inserted.length > 0) {
   notifyDbSubscribers('activity_events', 'INSERT', inserted);
  }
 } catch (error) {
  console.error('logConnectionActivity failed', error);
 }
}


const FLOW_EVENT_BY_CHANGE = Object.freeze({
 'messages:INSERT': 'message.created',
 'messages:UPDATE': 'message.updated',
 'chat_sessions:INSERT': 'channel.created',
 'chat_sessions:UPDATE': 'channel.updated',
 'documents:INSERT': 'document.created',
 'documents:UPDATE': 'document.updated',
 'workspace_members:INSERT': 'member.created',
 'workspace_members:UPDATE': 'member.updated',
 'workspace_agents:INSERT': 'agent.created',
 'workspace_agents:UPDATE': 'agent.updated',
});

function publicFlowEventRecord(table, row) {
 if (!row || typeof row !== 'object') return {};
 if (table === 'messages') {
  return {
   id: row.id,
   channelId: row.session_id,
   role: row.role,
   content: textFromValue(row.content).slice(0, 20_000),
   threadParentId: row.thread_parent_id || null,
   senderKind: row.sender_kind || '',
   senderId: row.sender_id || null,
   senderName: row.sender_name || '',
   createdAt: row.created_at || null,
  };
 }
 if (table === 'chat_sessions') {
  return {
   id: row.id,
   title: row.title,
   folder: row.folder,
   conversationMode: row.conversation_mode,
   archivedAt: row.archived_at || null,
   updatedAt: row.updated_at || null,
  };
 }
 if (table === 'documents') {
  return { id: row.id, title: row.title, folder: row.folder, version: row.version, updatedAt: row.updated_at || null };
 }
 if (table === 'workspace_agents') {
  return { id: row.id, name: row.name, handle: row.handle, enabled: row.enabled !== false, model: row.model || null, metadata: parseJsonObject(row.metadata), updatedAt: row.updated_at || null };
 }
 if (table === 'workspace_members') {
  return { userId: row.user_id, role: row.role, updatedAt: row.updated_at || null };
 }
 return {};
}

async function flowEventLocation(table, row) {
 if (table === 'messages') {
  const sessions = await getDb().unsafe('select id, workspace_id from chat_sessions where id = $1 limit 1', [row.session_id]);
  return sessions[0] ? { workspaceId: sessions[0].workspace_id, channelId: row.session_id } : null;
 }
 return row.workspace_id ? { workspaceId: row.workspace_id, channelId: table === 'chat_sessions' ? row.id : null } : null;
}

async function enqueueFlowWebhookEvents(table, eventType, rows) {
 const flowEventType = FLOW_EVENT_BY_CHANGE[`${table}:${eventType}`];
 if (!flowEventType) return;
 for (const row of rows) {
  const location = await flowEventLocation(table, row);
  if (!location) continue;
  const connections = await getDb().unsafe(
   `select id, workspace_id, channel_id, events
         from flow_connections
        where workspace_id = $1 and revoked_at is null and webhook_url is not null`,
   [location.workspaceId],
  );
  const record = publicFlowEventRecord(table, row);
  const version = row.version || row.updated_at || row.created_at
   || crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16);
  const eventId = `${flowEventType}:${row.id || row.user_id}:${version}`;
  for (const connection of connections) {
   const subscribedEvents = parseJsonArray(connection.events);
   if (!subscribedEvents.includes(flowEventType)) continue;
   if (connection.channel_id && String(connection.channel_id) !== String(location.channelId || '')) continue;
   if (
    table === 'messages'
    && row.sender_kind === 'integration'
    && String(row.sender_id || '') === String(connection.id)
   ) continue;
   const payload = {
    id: eventId,
    type: flowEventType,
    occurredAt: new Date().toISOString(),
    workspaceId: location.workspaceId,
    channelId: location.channelId,
    data: record,
   };
   await getDb().unsafe(
    `insert into flow_webhook_deliveries
         (connection_id, workspace_id, event_id, event_type, payload)
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict (connection_id, event_id) do nothing`,
    [connection.id, location.workspaceId, eventId, flowEventType, payload],
   );
  }
 }
}

async function claimFlowWebhookDelivery() {
 const rows = await getDb().unsafe(
  `with candidate as (
       select d.id
         from flow_webhook_deliveries d
         join flow_connections c on c.id = d.connection_id
        where c.revoked_at is null
          and c.webhook_url is not null
          and (
            (d.status = 'pending' and d.next_attempt_at <= now())
            or (d.status = 'inflight' and d.lease_expires_at <= now())
          )
        order by d.next_attempt_at asc, d.created_at asc
        for update skip locked
        limit 1
     )
     update flow_webhook_deliveries d
        set status = 'inflight', claim_token = gen_random_uuid(),
            lease_expires_at = now() + interval '30 seconds',
            attempt_count = attempt_count + 1, updated_at = now()
       from candidate, flow_connections c
      where d.id = candidate.id and c.id = d.connection_id
      returning d.*, c.webhook_url, c.signing_secret_cipher`,
 );
 return rows[0] || null;
}

async function deliverNextFlowWebhook() {
 const delivery = await claimFlowWebhookDelivery();
 if (!delivery) return false;
 const body = JSON.stringify(delivery.payload);
 const timestamp = String(Math.floor(Date.now() / 1000));
 let httpStatus = null;
 let failure = '';
 try {
  const secret = await decryptFlowSecret(delivery.signing_secret_cipher);
  const response = await fetch(delivery.webhook_url, {
   method: 'POST',
   headers: {
    'content-type': 'application/json',
    'idempotency-key': delivery.event_id,
    'x-agensis-event-id': delivery.event_id,
    'x-agensis-timestamp': timestamp,
    'x-agensis-signature': signFlowWebhook({ secret, timestamp, body }),
   },
   body,
   signal: AbortSignal.timeout(10_000),
   redirect: 'error',
  });
  httpStatus = response.status;
  await response.body?.cancel().catch(() => undefined);
  if (response.ok) {
   await getDb().unsafe(
    `update flow_webhook_deliveries
            set status = 'delivered', delivered_at = now(), last_http_status = $3,
                last_error = null, lease_expires_at = null, updated_at = now()
          where id = $1 and claim_token = $2`,
    [delivery.id, delivery.claim_token, response.status],
   );
   return true;
  }
  failure = `HTTP ${response.status}`;
 } catch (error) {
  failure = String(error?.message || error || 'Webhook delivery failed').slice(0, 1000);
 }

 const attempts = Number(delivery.attempt_count || 1);
 const { dead, delaySeconds } = flowWebhookRetryDecision({ httpStatus, attempts });
 await getDb().unsafe(
  `update flow_webhook_deliveries
        set status = $3, next_attempt_at = now() + ($4 * interval '1 second'),
            last_http_status = $5, last_error = $6,
            lease_expires_at = null, updated_at = now()
      where id = $1 and claim_token = $2`,
  [delivery.id, delivery.claim_token, dead ? 'dead' : 'pending', delaySeconds, httpStatus, failure],
 );
 return true;
}



// Default agents seeded into every brand-new workspace. Kept in sync with the
// netlify backend (netlify/functions/backend.mjs).
const DEFAULT_AGENT_SEEDS = [
 {
  name: 'Scout',
  handle: 'scout',
  run_mode: 'builtin',
  avatar: 'SC',
  accent_color: '#38bdf8',
  description: 'Codebase navigator.',
  system_prompt:
   "You are Scout, the codebase navigator for this workspace. When asked where something lives or how a piece of code works, you locate the relevant files, trace the logic, and explain it with concrete file references. Collaborate with your teammates by @mentioning them when their expertise fits — @research for web lookups, @coder to make edits, @q for tooling, @mills for skills. Stay quiet when you have nothing useful to add.",
 },
 {
  name: 'Research',
  handle: 'research',
  run_mode: 'builtin',
  avatar: 'RE',
  accent_color: '#a78bfa',
  description: 'Web and information researcher.',
  system_prompt:
   "You are Research, the workspace's web and information specialist. You look things up, summarize what you find clearly, and always cite your sources so claims can be verified. Hand off to teammates by @mentioning them when relevant — @scout for this project's own code, @coder for implementation, @q for tools, @mills for skills. Stay quiet when you have nothing useful to add.",
 },
 {
  name: 'Coder',
  handle: 'coder',
  run_mode: 'daemon',
  avatar: 'CO',
  accent_color: '#00a95c',
  description: 'Coding agent (local daemon).',
  system_prompt:
   "You are Coder, the workspace's coding agent. You write and edit real code, running as a local daemon with actual execution, and you keep changes focused and verifiable. Work with your teammates by @mentioning them when relevant — @scout to find where code lives, @research to look things up, @q for the right tools, @mills for the right skills. Stay quiet when you have nothing useful to add.",
 },
 {
  name: 'Q',
  handle: 'q',
  run_mode: 'daemon',
  avatar: 'Q',
  accent_color: '#f59e0b',
  description: 'Tooling agent.',
  system_prompt:
   "You are Q, the workspace's tooling agent. You watch the conversation and recommend the right tools and CLIs for the task at hand, explaining briefly why each fits. Loop in teammates by @mentioning them when relevant — @coder to apply changes, @scout to locate code, @research for background, @mills for matching skills. Speak up only when a tool genuinely helps; stay quiet when you have nothing useful to add.",
 },
 {
  name: 'Mills',
  handle: 'mills',
  run_mode: 'daemon',
  avatar: 'MI',
  accent_color: '#f472b6',
  description: 'Skills agent.',
  system_prompt:
   "You are Mills, the workspace's skills agent. You watch the conversation and recommend the right skills and workflows for the task at hand, explaining how each applies. Bring in teammates by @mentioning them when relevant — @q for tools and CLIs, @coder to implement, @scout to navigate code, @research to investigate. Speak up only when a skill genuinely helps; stay quiet when you have nothing useful to add.",
 },
];

// Insert the default agents for a freshly created workspace. Idempotent: skips
// entirely when the workspace already has any agents, so existing workspaces and
// repeated calls never produce duplicates.
async function seedDefaultAgents(workspaceId, ownerUserId) {
 if (!workspaceId) return;
 const db = getDb();
 const existing = await db.unsafe(
  'select count(*)::int as count from workspace_agents where workspace_id = $1',
  [workspaceId],
 );
 if ((existing[0]?.count ?? 0) > 0) return;

 const columns = [
  'id', 'workspace_id', 'created_by', 'name', 'avatar', 'openpet_avatar_id',
  'accent_color', 'description', 'system_prompt', 'soul', 'instructions', 'tools', 'skills',
  'handle', 'model', 'run_mode', 'permission_mode',
 ];
 const params = [];
 const valueSql = DEFAULT_AGENT_SEEDS.map((seed) => {
  const row = {
   id: crypto.randomUUID(),
   workspace_id: workspaceId,
   created_by: ownerUserId ?? null,
   name: seed.name,
   avatar: seed.avatar,
   openpet_avatar_id: '',
   accent_color: seed.accent_color,
   description: seed.description ?? '',
   system_prompt: seed.system_prompt,
   soul: '',
   instructions: '',
   tools: [],
   skills: [],
   handle: seed.handle,
   model: 'auto',
   run_mode: seed.run_mode,
   permission_mode: 'default',
  };
  return `(${columns.map((column) => bindDbParam(params, 'workspace_agents', column, row[column])).join(', ')})`;
 }).join(', ');

 const inserted = await db.unsafe(
  `insert into workspace_agents (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning *`,
  params,
 );
 notifyDbSubscribers('workspace_agents', 'INSERT', inserted);
}







// The builtin turn: the tool-use loop and the Anthropic stream. Last of Wave 4.
const builtinTurn = createBuiltinTurn({
 VOICE_HUDDLE_NOTE,
 agentContextFromRow: (...a) => agentContextFromRow(...a),
 agentRuntimePayload,
 buildAgentActivityDigest: (...a) => buildAgentActivityDigest(...a),
 buildAgentConnectionCommand: (...a) => buildAgentConnectionCommand(...a),
 buildAgentTurnContext: (...a) => buildAgentTurnContext(...a),
 buildDaemonPrompt: (...a) => buildDaemonPrompt(...a),
 buildSystemPrompt: (...a) => buildSystemPrompt(...a),
 callProviderOperation: (...a) => callProviderOperation(...a),
 continueConversation: (...a) => continueConversation(...a),
 createAnthropicUsageAccumulator, createBuiltinToolset, dbQuery,
 enforceWorkspaceRole, fenceSkillContent, formatElapsedMs, getAnthropicApiKey,
 getDb,
 getRegistrationStatus: (...a) => getRegistrationStatus(...a),
 isAgentEnabled,
 listConfiguredSandboxCredentialKeys: (...a) => listConfiguredSandboxCredentialKeys(...a),
 listWorkspaceSkills,
 loadChannelIntentNote: (...a) => loadChannelIntentNote(...a),
 loadSandboxSkillNote: (...a) => loadSandboxSkillNote(...a),
 loadSkillContent,
 logMessageActivity: (...a) => logMessageActivity(...a),
 mirrorAgentReplyToTaskComment: (...a) => mirrorAgentReplyToTaskComment(...a),
 providerCallRateLimiter, recordAnthropicUsage,
 registerAgentRequest: (...a) => registerAgentRequest(...a),
 resolveAnthropicModel,
 resolveRunTarget: (...a) => resolveRunTarget(...a),
 resolveWorkThreadParent: (...a) => resolveWorkThreadParent(...a),
 resolveWorkspaceAgentByHandle: (...a) => resolveWorkspaceAgentByHandle(...a),
 roleHasWorkspaceCapability,
 sessionHasLiveHuddle: (...a) => sessionHasLiveHuddle(...a),
 slugHandle,
 notifyDbSubscribers: (...a) => realtime.notifyDbSubscribers(...a),
 sendWs: (...a) => realtime.sendWs(...a),
 insertActiveAgentJob: (...a) => agentJobs.insertActiveAgentJob(...a),
 claimMcpJob: (...a) => agentJobs.claimMcpJob(...a),
 submitMcpJobResult: (...a) => agentJobs.submitMcpJobResult(...a),
 agentStepParts: (...a) => agentJobs.agentStepParts(...a),
 agentStepContent: (...a) => agentJobs.agentStepContent(...a),
 dispatchTaskAssignment: (...a) => taskDispatch.dispatchTaskAssignment(...a),
 scheduleTaskQueueDrain: (...a) => taskDispatch.scheduleTaskQueueDrain(...a),
 hasMcpPresence: (...a) => agentConnections.hasMcpPresence(...a),
 findConnectedAgent: (...a) => agentConnections.findConnectedAgent(...a),
 updateAgentHeartbeat: (...a) => agentConnections.updateAgentHeartbeat(...a),
});
const {
 runToolUseLoop, toolResultText, mcpToolDeps, getBuiltinToolset,
 builtinToolIdentity, builtinStepDetail, runAgentTurn, streamAnthropicTurn,
 runAnthropicCompletion, streamFlushDue,
 connectionSupportsAmpRuntime, isAmpRuntimeAgent, loadAmpThreadBinding, validAmpThreadId,
 BUILTIN_FLUSH_INTERVAL_MS, BUILTIN_TOOL_LOOP_MAX_CALLS,
 BUILTIN_TOOL_LOOP_MAX_STEPS, BUILTIN_TOOL_NOTE, BUILTIN_TOOL_RESULT_MAX_CHARS,
} = builtinTurn;

// Mines this workspace's conversations for skills/memories/docs worth keeping —
// "Suggestions" in the product. Constructed here, after runAnthropicCompletion
// is bound, because that is the one-shot model call it analyses with.
const {
 queueThreadHarvest, runDueThreadHarvests, sweepIdleSessionHarvests,
 listThreadHarvests, decideHarvestFinding,
} = createThreadHarvest({
 getDb: () => getDb(),
 runAnthropicCompletion: (...a) => runAnthropicCompletion(...a),
 notifyDbSubscribers: (...a) => notifyDbSubscribers(...a),
 onWarn: (message) => console.warn('[thread-harvest]', message),
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
 badRequest,
});

// Workspace automations — the event-triggered/internal-action cell that
// agent_schedules, agent_webhooks and flow_connections between them leave
// uncovered. See server/automations.cjs for why it is not a fourth engine.
//
// The event vocabulary is INJECTED rather than extracted into a shared module.
// FLOW_EVENT_BY_CHANGE drives live outbound webhooks for anyone using the Flows
// integration, and a refactor that silently dropped an entry would stop their
// automation with nothing failing; passing the same objects in gives both
// consumers one map at no risk to the shipped path.
const {
 enqueueAutomationRuns, runDueAutomations, sweepAutomationRuns,
 listAutomations, listAutomationRuns,
 createAutomation, updateAutomation, deleteAutomation,
} = createAutomations({
 getDb: () => getDb(),
 notifyDbSubscribers: (...a) => notifyDbSubscribers(...a),
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
 flowEventByChange: FLOW_EVENT_BY_CHANGE,
 flowEvents: FLOW_EVENTS,
 publicFlowEventRecord: (...a) => publicFlowEventRecord(...a),
 flowEventLocation: (...a) => flowEventLocation(...a),
 recordAudit: (...a) => recordAudit(...a),
 onWarn: (message) => console.warn('[automations]', message),
});

// Agent templates ("persona packs"). The validator is shared/agentTemplates.cjs;
// the security property is that its output is REBUILT from a carried-field list,
// so no privilege-bearing column can ride into the template table.
const {
 listAgentTemplates, createAgentTemplate, saveAgentAsTemplate,
 updateAgentTemplate, deleteAgentTemplate,
} = createAgentTemplates({
 getDb: () => getDb(),
 notifyDbSubscribers: (...a) => notifyDbSubscribers(...a),
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
 normalizeAgentTemplate,
 agentToTemplateDraft,
});

// Agent jobs hold no in-process state — a job's liveness is a database fact, so
// a restart cannot lose it. See server/agent-jobs.cjs.
const agentJobs = createAgentJobs({
 PLACEHOLDER_CONTENT_RE,
 agentLiveMessageContent: (...a) => agentLiveMessageContent(...a),
 agentPermissionFlags, agentRuntimePayload, badRequest,
 continueConversation: (...a) => continueConversation(...a),
 forbidden, getDb, isAgentEnabled,
 logMessageActivity: (...a) => logMessageActivity(...a),
 mirrorAgentReplyToTaskComment: (...a) => mirrorAgentReplyToTaskComment(...a),
 normalizeAgentPermissionMode, parseJsonObject,
 slugHandle, textFromValue,
 verifyThreadParent: (...a) => verifyThreadParent(...a),
 notifyDbSubscribers: (...a) => realtime.notifyDbSubscribers(...a),
 sendWs: (...a) => realtime.sendWs(...a),
 findConnectedAgent: (...a) => agentConnections.findConnectedAgent(...a),
 hasMcpPresence: (...a) => agentConnections.hasMcpPresence(...a),
 touchMcpPresence: (...a) => agentConnections.touchMcpPresence(...a),
 isConnectionSocketOpen: (...a) => agentConnections.isConnectionSocketOpen(...a),
 updateAgentHeartbeat: (...a) => agentConnections.updateAgentHeartbeat(...a),
 getConnectedAgents: () => agentConnections.connectedAgents,
 scheduleTaskQueueDrain: (...a) => taskDispatch.scheduleTaskQueueDrain(...a),
});
const {
 insertActiveAgentJob, agentHasActiveJob, agentHasAnyActiveJob,
 hasActiveBurstJob, finalizeStuckJob, failConnectionJobs, rehomeRunningJobs, reapStuckAgentJobs,
 clearStrandedPlaceholders, handleAgentJobResult, handleAgentJobDelta,
 handleAgentJobStep, handleAgentJobSegment, agentStepParts, agentStepContent,
 finalizeAgentJobResult, ampResultMetadata, validateAmpJobResult, claimMcpJob, submitMcpJobResult, reapStuckMcpJobs,
 normalizeStopReason, stopResultMetadata, failureSentence,
 dispatchFarmAgentJob, getFarmAgentJob, cancelFarmAgentJob,
} = agentJobs;

// Interactive tool approvals. Stateless like agent jobs, and for the same
// reason: a pending approval must survive a server restart, because the daemon
// on the other side is still holding its turn open waiting for the answer.
const agentPermissions = createAgentPermissions({
 badRequest, forbidden, getDb, parseJsonObject, normalizeAgentPermissionMode,
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
 notifyDbSubscribers: (...a) => realtime.notifyDbSubscribers(...a),
 sendWs: (...a) => realtime.sendWs(...a),
 getConnectedAgents: () => agentConnections.connectedAgents,
 recordAudit: (...a) => recordAudit(...a),
});
const {
 decideAgentPermissionRequest, expireConnectionPermissionRequests,
 expireStalePermissionRequests, handleAgentPermissionRequest,
 publicPermissionRequest, rehomePendingPermissionRequests,
 revokeAgentPermissionRule, setAgentPermissionMode,
} = agentPermissions;

// Task dispatch owns four of the maps resetTestState() clears, and the cadence
// wakes own live timers — see server/task-dispatch.cjs.
const taskDispatch = createTaskDispatch({
 agentHasActiveJob: (...a) => agentHasActiveJob(...a),
 agentHasAnyActiveJob: (...a) => agentHasAnyActiveJob(...a),
 continueConversation: (...a) => continueConversation(...a),
 dispatchRateLimiter,
 findOrCreateDirectSession: (...a) => findOrCreateDirectSession(...a),
 getDb, getWorkspaceRole, isAgentEnabled, parseAgentMentions,
 postTaskSubthreadMention: (...a) => postTaskSubthreadMention(...a),
 roleHasWorkspaceCapability, slugHandle,
 notifyDbSubscribers: (...a) => realtime.notifyDbSubscribers(...a),
});
const {
 scheduleCadenceWake, clearCadenceWakes, msSinceTimestamp, agentNamedInBurst,
 claimTaskDispatch, releaseTaskDispatch, taskQueuePosition, undoTaskDispatch,
 dispatchTaskAssignment, drainAgentTaskQueue,
 taskStatusOnDispatch, cadenceWakes,
 TASK_QUEUE_BUSY_RUN_REASONS, TASK_ASSIGN_CLAIM_MS, TASK_QUEUE_MAX_STRIKES,
 TASK_QUEUE_SCAN_LIMIT, TASK_SOURCE_LINK_OVERWRITABLE,
} = taskDispatch;

// Agent daemon connections own their two maps (Wave 4); resetTestState()
// delegates to agentConnections.reset(). Realtime is constructed after this
// because its socket handlers call into these.
const agentConnections = createAgentConnections({
 agentRuntimePayload, applyIdentityDeclaration, bindDbParam, drainAgentTaskQueue,
 expireConnectionPermissionRequests,
 failConnectionJobs, finalizeStuckJob, forbidden, getDb, inferenceBroker,
 isAgentEnabled, logConnectionActivity, normalizeSkillDocuments, parseJsonObject,
 publicAgentConnection, publicFarmEnrolledAgent, quoteIdent, reachFromMessage,
 rehomePendingPermissionRequests, rehomeRunningJobs, repairStoredIdentity,
 sharedModelsFromMessage, slugHandle,
 // Forwarded lazily: channelBridges is constructed from agentConnections' own
 // exports, so it does not exist yet at this point in the file.
 resumeDaemonBridges: (...args) => channelBridges.resumeDaemonBridges(...args),
 // Realtime is created below, so these two are forwarded lazily rather than
 // captured — the module needs the live functions, not the bindings as they
 // stand at construction time.
 sendWs: (...args) => realtime.sendWs(...args),
 notifyDbSubscribers: (...args) => realtime.notifyDbSubscribers(...args),
});
const {
 registerAgentConnection, findConnectedAgent, takeAgentDaemonConnections,
 disconnectAgentDaemons, disableFarmIntegrationAgents,
 markAgentConnectionOffline, isConnectionSocketLive,
 isConnectionSocketOpen, updateAgentHeartbeat, handleAgentMemorySync,
 handleAgentSkillSync, handleAgentCapabilitiesSync, capabilitiesShapeValid,
 capabilitiesDriftNudges, ampRuntimeFromMessage, executionRuntimesFromMessage, refreshConnectedAgentConfigs, touchMcpPresence,
 hasMcpPresence, pruneOfflineConnections, reconcileAgentConnectionsAtStartup,
 applyAgentIdentity, repairCorruptedAgentIdentities, clearPendingJobFailures,
 AGENT_DISCONNECT_CLOSE_MESSAGES, AGENT_IDENTITY_SELECT, connectedAgents,
 registerTestConnectedAgent, listTestConnectedAgents, sendToConnection,
} = agentConnections;

// Channel bridges. Constructed after agentConnections because the daemon lane
// sends through it, and lazily forwarding continueConversation/notifyDbSubscribers
// for the same reason those are forwarded above: both are defined further down.
const channelBridges = createChannelBridges({
 getDb, isConnectionSocketOpen, sendToConnection,
 continueConversation: (...args) => continueConversation(...args),
 notifyDbSubscribers: (...args) => realtime.notifyDbSubscribers(...args),
});
// The hub lane's two providers. Registered here rather than inside the module so
// a test can construct channelBridges with no adapters and no network at all.
channelBridges.registerHubAdapter(telegramAdapter());
channelBridges.registerHubAdapter(slackAdapter());

// One relay for the process; per-socket state hangs off `ws.voiceStt`.
const voiceRelay = createVoiceRelay();

// Realtime lives in its own module now (Wave 4). It OWNS websocketClients, so
// resetTestState() delegates to realtime.reset() rather than reassigning a
// binding here — see server/realtime.cjs.
const realtime = createRealtime({
 enforceDbOperationAccess, enforceWorkspaceRole, enqueueFlowWebhookEvents,
 enqueueAutomationRuns,
 ensureTable, forbidden, agentTokenFromWsRequest, VAULT_SECRET_COLUMNS,
 handleAgentCapabilitiesSync,
 handleAgentJobDelta, handleAgentJobResult, handleAgentJobSegment,
 handleAgentJobStep, handleAgentMemorySync, handleAgentSkillSync,
 handleAgentPermissionRequest,
 handleBridgeMessage: (...args) => channelBridges.handleBridgeMessage(...args),
 handlePeerListRequest, handlePeerTicketRequest, inferenceBroker,
 isPrivateSessionRow, sessionMemberUserIds,
 logMessageActivity, markAgentConnectionOffline,
 refreshConnectedAgentConfigs, registerAgentConnection, updateAgentHeartbeat,
 // Lets the agent-status broadcast resolve a row's workspace. `messages` has no
 // workspace_id column, so without this the broadcast cannot fire at all.
 resolveWorkspaceIdForSession,
 verifyAgentConnectToken, verifyToken, voiceRelay, voiceStreamRateLimiter,
});
const {
 sendWs, notifyDbSubscribers, sanitizeRealtimeRow, relayBroadcast,
 broadcastGlobal, attachRealtime, authorizeRealtimeBinding,
 authorizeRealtimeBroadcast, revokeRealtimeAccessForMember,
 registerTestWebsocketClient, workspaceIdFromRealtimeChannel,
} = realtime;


// --- Link preview cache rows ------------------------------------------------
//
// Listed explicitly, never `select *`: a column added to the table and forgotten
// here would load blank rather than error, which is the failure mode this repo
// keeps re-learning (the bootstrap sessions select, the /agents metadata column).
const LINK_PREVIEW_COLUMNS = 'id, url_hash, url, final_url, status, title, '
 + 'description, site_name, image_url, detail, fetched_at, expires_at';

// `detail` is our own vocabulary ('timeout', 'http_404', 'too_many_redirects')
// with ONE exception: `content_type_<type>` carries a media type the remote
// server chose. Narrow charset, short cap — it is shown to a human as a reason.
function sanitizePreviewDetail(value) {
 return String(value == null ? '' : value)
  .replace(/[^a-zA-Z0-9._+/-]+/g, '_')
  .slice(0, 80);
}

/**
 * Write one unfurl result into the cache, or refresh the row that is there.
 *
 * The clamps are applied AGAIN here even though link-preview.cjs already applied
 * them. These columns are unbounded `text`, so the module being the only thing
 * standing between a hostile page and a 5MB row would make it load-bearing in a
 * place it is easy to edit without noticing.
 *
 * A refresh overwrites unconditionally, including a failure replacing a card
 * that previously worked. That is deliberate for now: the failure TTL is an hour,
 * so a site that blipped is re-tried soon, and "show the last thing we actually
 * saw" needs conditional SQL that is harder to be sure about than this is.
 */
async function upsertLinkPreview(result) {
 const status = LINK_PREVIEW_STATUSES.includes(result?.status) ? result.status : 'failed';
 const url = String(result?.url || '').slice(0, LINK_PREVIEW_MAX_URL_CHARS);
 if (!url) return null;
 const ttlSeconds = Math.max(60, Math.round(linkPreviewTtlMs(status) / 1000));
 const rows = await getDb().unsafe(
  `insert into link_previews
      (url_hash, url, final_url, status, title, description, site_name, image_url, detail, fetched_at, expires_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now() + make_interval(secs => $10::double precision))
    on conflict (url_hash) do update set
      url = excluded.url,
      final_url = excluded.final_url,
      status = excluded.status,
      title = excluded.title,
      description = excluded.description,
      site_name = excluded.site_name,
      image_url = excluded.image_url,
      detail = excluded.detail,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
    returning ${LINK_PREVIEW_COLUMNS}`,
  [
   linkPreviewCacheKey(url),
   url,
   String(result?.finalUrl || '').slice(0, LINK_PREVIEW_MAX_URL_CHARS),
   status,
   clampPreviewText(result?.title, LINK_PREVIEW_MAX_TITLE_CHARS),
   clampPreviewText(result?.description, LINK_PREVIEW_MAX_DESCRIPTION_CHARS),
   clampPreviewText(result?.siteName, LINK_PREVIEW_MAX_SITE_CHARS),
   String(result?.imageUrl || '').slice(0, LINK_PREVIEW_MAX_URL_CHARS),
   sanitizePreviewDetail(result?.detail),
   ttlSeconds,
  ],
 );
 return rows[0] || null;
}

/**
 * The client-facing shape of a cache row.
 *
 * `image_url` — the third-party host — is NEVER returned. The client receives
 * only `imagePath`, a path on our own origin, so there is no way for a card to
 * end up hotlinking a stranger's CDN even by accident.
 */
function publicLinkPreview(row) {
 return {
  url: String(row?.url || ''),
  finalUrl: String(row?.final_url || ''),
  status: String(row?.status || 'failed'),
  title: String(row?.title || ''),
  description: String(row?.description || ''),
  siteName: String(row?.site_name || ''),
  imagePath: row?.image_url ? `/backend/link-previews/${row.id}/image` : '',
  detail: String(row?.detail || ''),
  fetchedAt: row?.fetched_at ? new Date(row.fetched_at).toISOString() : null,
 };
}

/**
 * The injection contract for every extracted route module.
 *
 * `server/index.cjs` is being reduced by moving self-contained surfaces into
 * their own `mountXRoutes(app, deps)` modules — the pattern huddles.cjs and
 * voice.cjs already use. Ranked by call count inside this file, a dozen helpers
 * carry nearly all of the cross-cutting traffic (getDb 333, jsonError 306,
 * notifyDbSubscribers 121, enforceWorkspaceRole 77, …) and everything else is
 * local to its own block. That short list IS the contract, so it lives in one
 * place instead of being re-typed per mount call.
 *
 * INJECT `getDb`, THE FUNCTION — never `db`, the value. `setTestDb()` reassigns
 * the module-level `db` binding, so a module that captured the value at require
 * time would hold a stale handle and silently talk to the wrong database. Every
 * consumer must call `getDb()` per request, which is what these callers do.
 *
 * Modules destructure what they need, so passing keys a module ignores is free;
 * spread extras alongside it (`{ ...coreDeps(), webhookRateLimiter }`) rather
 * than growing this object with one-module dependencies.
 */
// One resolver, shared by the gateway CRUD routes and the per-turn ai-chat
// lookup. See server/lib/gateways.cjs for why it is not a nested helper of
// either module.
const resolveGatewayRoute = createGatewayResolver({
 getDb, decryptVaultSecret, parseJsonObject,
});

function coreDeps() {
 return {
  // Database handle + SQL error mapping
  getDb,
  // Responses
  jsonError, forbidden, badRequest,
  // Auth + RBAC. These stay single-sourced here and in shared/backend-core.cjs;
  // an extracted module must never reimplement one.
  requireAuth, requireUserOrFarm, enforceWorkspaceRole, enforceDbOperationAccess,
  // The read gate below the workspace. Injected next to enforceWorkspaceRole so
  // a route that does one and not the other is visible at the call site.
  enforceSessionRead, sessionReadableSql, addSessionParticipant,
  // Realtime fanout
  notifyDbSubscribers, sendWs,
  // The audit log's write surface. Never rejects; see recordAudit.
  recordAudit, auditEmailDomain,
  // Rate limiting (the limiter instances themselves stay per-module)
  rateLimitBlocked, dbRateLimitBlocked, clientIpFromReq,
  // Common value coercion
  parseJsonObject, parseJsonArray, slugHandle, textFromValue, isAgentEnabled,
 };
}

function createApp() {
 const app = express();
 app.use(cors());
 // Capture the raw request bytes alongside the parsed JSON. Netlify signs its
 // outgoing deploy webhooks with a JWS whose payload carries the SHA-256 of the
 // exact request body, so verifying that signature (see verifyNetlifyDeploySignature)
 // requires the untouched bytes — express.json otherwise discards them. Storing a
 // reference to the already-allocated buffer costs nothing.
 app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
 }));
 // Runtime schema fallback (ensureRuntimeSchema) runs by default so dev bootstrap
 // keeps working with zero config. Set AGENSIS_RUNTIME_SCHEMA=false in production
 // and run `npm run migrate` instead, once the supabase/migrations/*.sql files are
 // the source of truth. Unset/any-other-value preserves today's behavior.
 const ALLOW_RUNTIME_SCHEMA = process.env.AGENSIS_RUNTIME_SCHEMA !== 'false';
 const runtimeSchemaReady = ALLOW_RUNTIME_SCHEMA
  ? ensureRuntimeSchema().catch((error) => {
   console.warn('[backend] runtime schema migration failed:', error.message || error);
   throw error;
  })
  : Promise.resolve();
 // Terminal handler attached at creation, so a boot-time DDL failure is never an
 // unhandled rejection — Node's default mode terminates the process, which would
 // make the per-request 500 degradation below unreachable. The gate still awaits
 // the same promise, so requests keep surfacing the real error. Capturing it also
 // lets /backend/health — registered before the gate — report "not ready" instead
 // of a green light while every other /backend route is broken.
 let runtimeSchemaError = null;
 runtimeSchemaReady.catch((error) => { runtimeSchemaError = error; });

 // Identity rows corrupted by the double-encoded jsonb bind (see
 // normalizeJsonParam) are healed right after the schema gate — a corrupted
 // row errors out of jsonb_set, so until it is repaired no human edit to that
 // agent can save. Best-effort: a repair failure must not take the backend
 // down, and the next boot tries again.
 void runtimeSchemaReady
  .then(() => repairCorruptedAgentIdentities())
  .catch((error) => console.warn('[backend] identity repair skipped:', error.message || error));

 // Auth is enforced at the route boundary and again per workspace-scoped
 // operation. Keep this server-side; client filters are only UX hints.

 mountHealthRoutes(app, {
  ...coreDeps(), cspReportRateLimiter,
  getRuntimeSchemaError: () => runtimeSchemaError,
 });

 mountFarmRoutes(app, { ...coreDeps(), cancelFarmAgentJob, createAgentConnectToken, createPostgresFarmIntegrationStore, disableFarmIntegrationAgents, disconnectAgentDaemons, dispatchFarmAgentJob, farmDeviceRateLimiter, getFarmAgentJob, getFarmIntegrationCore, hashAgentToken, isConnectionSocketLive, normalizeAgentBackendBaseUrl, normalizeAgentPermissionMode, normalizeBaseUrl, publicAgentConnection, publicFarmEnrolledAgent, requestBaseUrl });

 mountPetsRoutes(app, { ...coreDeps(), CODEX_PETS_ROOT, OPENPETS_CATALOG_URL, contentTypeForImageAsset, isPathInside, mergeLocalCodexPets });

 mountSystemRoutes(app, { ...coreDeps(), detectCapabilities, inspectProjectPath, mergeSlashCommands, skillContentPayload, skillLibraryPayload, skillRateLimiter });

 mountFilesRoutes(app, { ...coreDeps(), FORCE_ATTACHMENT_CONTENT_TYPES, FORCE_ATTACHMENT_EXTENSIONS, getUploadExtension, lookupUploadContentType, resolveStoragePath, resolveStoragePathForWorkspace, safeFileName, storagePathFor });

 mountProjectGitRoutes(app, {
  ...coreDeps(),
  isWithinAllowedProjectRoot, listProjectFiles, workspaceProjectFileSources,
 });
 mountAgentWebhooksRoutes(app, {
  ...coreDeps(), broadcastGlobal, continueConversation, hashAgentToken,
  inviteTokenLookupParams, verifyNetlifyDeploySignature, webhookRateLimiter,
 });

 // Slack signs the RAW bytes. `req.rawBody` is already captured by the
 // express.json verify hook above (it exists for Netlify's JWS), so the Slack
 // HMAC reuses it rather than mounting a second parser for one path —
 // re-serializing the parsed object reorders keys and the signature stops
 // matching, which is the classic way this breaks.
 mountBridgeRoutes(app, {
  ...coreDeps(), bridges: channelBridges, bridgeRateLimiter,
 });
 mountBridgeAdminRoutes(app, {
  ...coreDeps(), bridges: channelBridges, findConnectedAgent, requestBaseUrl,
  resolveWorkspaceIdForSession, telegramSetWebhook,
  getWorkspaceRole, roleHasWorkspaceCapability,
 });

 mountWorkspacesRoutes(app, {
  ...coreDeps(),
  agentRuntimePayload, assertSafeOutboundUrl, encryptVaultSecret, publicWorkspace,
 });
 mountHuddleRoutes(app, { ...coreDeps(), webhookRateLimiter });

 // Voice engines for huddles. The Cartesia token exchange is plain HTTP and is
 // mirrored on Netlify; the Deepgram audio relay is not a route at all — it
 // rides the realtime websocket, which only exists here. See server/voice.cjs.
 mountVoiceRoutes(app, { ...coreDeps(), voiceTokenRateLimiter });

 // Per-workspace usage/storage stats in one round-trip. Read-role only. Bytes
 // come from stored upload sizes (uploaded_files.size) plus agent memory file
 // content (agent_memory_files.byte_size); counts are workspace-scoped. Messages
 // have no workspace_id column, so they are scoped via their chat_sessions.
 mountSessionsRoutes(app, { ...coreDeps(), buildAgentConnectionCommand, buildWorkspaceBootstrap, ensurePrimaryDaemonAgent, normalizeAgentBackendBaseUrl, requestBaseUrl, resolveSetupWorkspace, resolveWorkspaceIdForSession });

 mountCursorbuddyRoutes(app, { ...coreDeps(), agentRuntimePayload, buildAgentConnectionCommand, createCursorBuddyConnectionKey, ensureCursorBuddyAgentForKey, ensureCursorBuddyProviderAgent, hashAgentToken, normalizeAgentBackendBaseUrl, normalizeCursorBuddyDomain, normalizeCursorBuddyScope, normalizeCursorBuddySurface, publicCursorBuddyConnectionKey, requestBaseUrl, shellQuote });

 mountInferenceRoutes(app, { ...coreDeps(), authorizeUserOrFarmWorkspace, bindInferenceAbort, createOpenAIInferenceStreamRelay, inferenceBroker, liveSharedModelRoutes, publicInferenceModel });

 mountConnectionsRoutes(app, { ...coreDeps(), buildInboxSql, isConnectionSocketLive, publicAgentConnection });
 mountAgentPermissionRoutes(app, { ...coreDeps(), decideAgentPermissionRequest, publicPermissionRequest, revokeAgentPermissionRule, setAgentPermissionMode });
 // Reviewing what a discarded thread proposed. Accepting is a ROUTE, not a
 // client write, for the same reason thread_harvests is read-only to clients:
 // the request names which proposal, never what gets written into memory.
 mountThreadHarvestRoutes(app, { ...coreDeps(), listThreadHarvests, decideHarvestFinding });

 // Automations. Every write is 'manage' (a standing grant to act without a
 // human), list and history are 'read'. The routes are behind the same
 // AGENSIS_AUTOMATIONS flag as the worker, so the feature cannot be half-on.
 mountAutomationRoutes(app, {
  ...coreDeps(),
  listAutomations, listAutomationRuns, createAutomation, updateAutomation, deleteAutomation,
 });

 // Agent templates. Read at 'read', author/edit/delete at 'write' — authoring a
 // template is no more privileged than typing the prompt it holds, which
 // 'write' can already do on an agent directly. Note there is deliberately no
 // create-agent route here: a template prefills the existing form and the write
 // still goes through the generic insert, where the column guards apply.
 mountAgentTemplateRoutes(app, {
  ...coreDeps(),
  listAgentTemplates, createAgentTemplate, saveAgentAsTemplate,
  updateAgentTemplate, deleteAgentTemplate,
 });
 mountInboxRoutes(app, { ...coreDeps(), INBOX_DEFAULT_LIMIT, INBOX_FILTERS, INBOX_MAX_LIMIT, THREAD_INBOX_DEFAULT_LIMIT, buildInboxSql, buildThreadInboxSql, inboxMentionHandle, inboxMentionPattern, toInboxItem, toThreadInboxItem });
 mountSessionAccessRoutes(app, { ...coreDeps(), revokeRealtimeAccessForMember });
 mountLinkPreviewsRoutes(app, { ...coreDeps(), LINK_PREVIEW_COLUMNS, LINK_PREVIEW_MAX_PER_REQUEST, fetchLinkPreview, fetchPreviewImage, linkPreviewCacheKey, linkPreviewDbRateLimiter, linkPreviewImageDbRateLimiter, linkPreviewImageRateLimiter, linkPreviewRateLimiter, normalizeUnfurlUrl, publicLinkPreview, upsertLinkPreview });
 mountFeedbackRoutes(app, {
  ...coreDeps(), feedbackRateLimiter, feedbackDbRateLimiter, dbQuery,
  normalizeFeedbackSubmission, insertFeedbackReport,
 });

 mountTenantsRoutes(app, { ...coreDeps(), dbQuery, CAMPAIGN_CATEGORIES, assertSendable, assertSystemOwner, buildSegmentPreview, campaignMessageDbRateLimiter, campaignMessageRateLimiter, createCampaign, describeSegment, dismissCampaignMessage, getTenantAccount, listCampaigns, listTenantAccounts, listUserCampaignMessages, loadTenantFacts, normalizeCampaignInput, normalizeSegment, selectSegmentMatches, tenantsDbRateLimiter, tenantsRateLimiter });
 mountSchedulesRoutes(app, { ...coreDeps(), runDueSchedules });

 mountAgentsRoutes(app, {
  ...coreDeps(),
  allowsUnpromptedReply, buildAgentConnectionCommand, connectedAgents,
  continueConversation, directAgentParticipantFromSession, disconnectAgentDaemons,
  dispatchDbRateLimiter, dispatchRateLimiter, ensureMentionedParticipants,
  findConnectedAgent, inferThreadAgentTarget, mentionsChannel,
  normalizeAgentBackendBaseUrl, parseAgentMentions, publicAgentConnection,
  requestBaseUrl, resolveDispatchThreadParent, verifyThreadParent,
 });

 // Native MCP server endpoint. Any MCP-capable CLI (Qwen, Claude Code, Codex)
 // points its config at this URL with `Authorization: Bearer <agent connect
 // token>` and gets the full workspace toolset — no agensis-agent daemon needed.
 // Mirrors the hilos /api/mcp model. See server/mcp.cjs.
 const mcpHandler = createMcpHandler({
  // The tool-facing capabilities, shared verbatim with the builtin tool loop
  // (see mcpToolDeps / getBuiltinToolset). Only the transport concerns below are
  // specific to this door.
  ...mcpToolDeps(),
  verifyMcpToken,
  rateLimiter: mcpRateLimiter,
  rateLimitBlocked,
  runtimeSchemaReady,
  serverVersion: '1.0.0',
  // Measurement only, and a transport concern rather than a tool one, so it is
  // injected here rather than through mcpToolDeps(). Lets the door record that a
  // human's session token was used to authenticate — at most once per user per
  // 24h — while the decision to keep accepting them is still open.
  recordAudit,
 });

 mountMcpDoorsRoutes(app, { ...coreDeps(), mcpHandler, normalizeBaseUrl, renderSkillMd, requestBaseUrl, skillManifest, skillRateLimiter });

 mountAuthRoutes(app, {
  ...coreDeps(),
  createPasswordHash, emailLookupRateLimiter, evaluatePasswordServerSide,
  isReservedSignupEmail, issueToken, setCachedTokenVersion,
  signinIpFailureLimiter, signinRateLimiter, signupRateLimiter, verifyPassword,
 });

 mountMembersInvitesRoutes(app, { ...coreDeps(), hashAgentToken, inviteTokenLookupParams });

 // The origin a human is expected to see. The app origin, not the backend host:
 // /join/* is proxied there (netlify.toml) so one URL works for both audiences
 // and for both hosts.
 function joinPublicBaseUrl(req) {
  return normalizeBaseUrl(process.env.AGENSIS_APP_URL || '') || requestBaseUrl(req);
 }

 // The origin that actually serves /backend/*. On the deployed split this is
 // Fly, and it is NOT the same host as the app: https://agensis.io/backend/... is
 // a 404 (netlify.toml routes only /join/* through). So the redeem endpoint and
 // the MCP endpoint are built from here, and only the human-facing page and
 // accept links are built from joinPublicBaseUrl.
 function joinApiBaseUrl(req) {
  return normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL) || requestBaseUrl(req);
 }

 // The single refusal. Every failure mode routes through here, so there is one
 // status code and one message and no way to tell them apart. 410 rather than
 // 404 for all of them, including "never existed": a 404/410 split would be the
 // oracle.
 const JOIN_REFUSAL_MESSAGE =
  'This join link is no longer valid. It may have expired, been used, or been revoked.';

 function joinLinkRefused(res) {
  return res.status(410).json({
   data: null,
   error: { message: JOIN_REFUSAL_MESSAGE, code: 'join_link_invalid' },
  });
 }

 // Headers every join response carries.
 //
 // Referrer-Policy is load-bearing, not boilerplate: the token is IN THE URL, so
 // without `no-referrer` a click on "Sign in and join" would send the whole
 // secret URL to the next origin in a Referer header. no-store keeps it out of
 // shared caches for the same reason. The CSP is achievable only because the
 // page has no script, no image and no external asset of any kind.
 function setJoinPageHeaders(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
   'Content-Security-Policy',
   "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
 }

 function setJoinJsonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
 }

 // Content negotiation, and nothing else. `?format=json` is the explicit escape
 // hatch for a client that cannot set headers. An Accept of `*/*` (curl's
 // default, and most HTTP libraries') deliberately gets HTML: the HTML carries
 // the same instructions in readable text, so the fallback is never a dead end.
 function joinWantsJson(req) {
  if (String(req.query?.format || '').toLowerCase() === 'json') return true;
  const accept = String(req.headers?.accept || '');
  return /application\/json/i.test(accept) && !/text\/html/i.test(accept);
 }

 mountJoinPagesRoutes(app, {
  ...coreDeps(),
  agentNextSteps, bearerToken, configBlock, createAgentConnectToken,
  hashAgentToken, invalidDescriptor, isJoinLinkToken, joinApiBaseUrl,
  joinDescriptor, joinLinkRateLimiter, joinLinkRefused, joinPublicBaseUrl,
  joinRedeemDbRateLimiter, joinRedeemRateLimiter, joinWantsJson,
  loadJoinLinkForDisplay, logJoinLinkActivity, machinePayload, mcpEndpoint,
  previewDescriptor, publicFarmEnrolledAgent, renderJoinHtml,
  setJoinJsonHeaders, setJoinPageHeaders, uniqueAgentHandle, verifyToken,
 });

 mountJoinLinksRoutes(app, { ...coreDeps(), createJoinLinkToken, hashAgentToken, joinLinkTtlMs, joinPublicBaseUrl, joinUrlFor, logJoinLinkActivity });

 mountFlowRoutes(app, { ...coreDeps(), createPostgresFlowConnectionStore, getFlowConnectionCore, mcpEndpoint, normalizeBaseUrl, normalizeFlowWebhookUrl, requestBaseUrl });
 mountWorkspaceMcpRoutes(app, { ...coreDeps(), claudeMcpAddCommand, configBlock, createWorkspaceMcpToken, decideAgentRegistration, hashAgentToken, mcpEndpoint, normalizeBaseUrl, requestBaseUrl });

 app.post('/backend/db/select', requireAuth, async (req, res) => {
  try {
   const { table, columns = '*', filters = [], orderBy = null, limit = null, single = false } = req.body || {};
   const tableSql = ensureTable(table);
   await enforceDbOperationAccess(req.userId, table, 'select', { filters });
   const where = table === 'workspaces'
    ? appendWorkspaceAccessClause(buildWhereClause(filters, []), req.userId)
    // enforceDbOperationAccess can only answer "may you"; it cannot drop rows.
    // A chat_sessions select filtered by workspace_id would otherwise hand back
    // every DM's title and roster.
    : appendSessionAccessClause(buildWhereClause(filters, []), req.userId, table);
   const { clause, params } = where;
   const rows = await getDb().unsafe(`select ${normalizeColumns(safeSelectColumns(table, columns))} from ${tableSql}${clause}${buildOrderClause(orderBy)}${Number.isInteger(limit) ? ` LIMIT ${Number(limit)}` : ''}`, params);
   res.json({ data: single ? (rows[0] ?? null) : rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/db/insert', requireAuth, async (req, res) => {
  try {
   const { table, values, returning = '*', single = false } = req.body || {};
   const tableSql = ensureTable(table);
   await enforceDbOperationAccess(req.userId, table, 'insert', { values });
   // Resolve inherited privacy BEFORE the insert, never as a fixup after it. A
   // sub-thread or split of a DM is created by the client through this generic
   // route with no visibility of its own; correcting it afterwards would leave a
   // window — and a realtime INSERT fanout — in which a private conversation's
   // offshoot was world-readable.
   const inheritedVisibility = table === 'chat_sessions'
    ? await resolveInheritedSessionVisibility(Array.isArray(values) ? values : [values])
    : null;
   const rows = (Array.isArray(values) ? values : [values]).map(row => {
    if (!row || typeof row !== 'object') return row;
    let next = stripPrivilegedDbValues(table, row);
    if (table === 'workspaces') next = { ...next, user_id: req.userId };
    // `visibility` is server-decided. A client may not declare a session public
    // when its parent is private — that would be a one-line way to publish any
    // DM by splitting a thread out of it.
    if (table === 'chat_sessions' && inheritedVisibility) next = { ...next, visibility: inheritedVisibility };
    // Strip agent-invented outline prefixes ("Ship UI work / 1. …") from task
    // titles. Title only on this route: inferring parent_id from a title string
    // is the right call for the MCP tool (server/mcp.cjs, where agents create
    // tasks) but would silently re-nest a human's task from what they typed.
    if (table === 'tasks' && typeof next.title === 'string') {
     const normalized = normalizeTaskTitle(next.title);
     if (normalized.changed) next = { ...next, title: normalized.title };
    }
    // @channel addresses every agent in a channel, so no agent may answer to
    // `channel`. Refused rather than mangled: a silently-renamed handle is an
    // agent nobody can @mention. Mirrored in netlify/functions/backend.mjs and
    // in registerAgentRequest (the MCP door).
    if (table === 'workspace_agents' && isReservedAgentHandle(next.handle)) {
     throw badRequest(reservedAgentHandleMessage(next.handle));
    }
    // Creation-time identity choices are HUMAN choices: synthesize the
    // human_set locks server-side (discarding any client-supplied ones) so an
    // agent's first connect cannot replace the avatar or profile the human
    // just picked. Empty fields stay unlocked — locking '' pins emptiness.
    next = synthesizeHumanIdentityInsert(table, next);
    return next;
   });
   if (!rows[0] || typeof rows[0] !== 'object') return jsonError(res, 400, new Error('Insert values are required'));

   const columns = Object.keys(rows[0]);
   if (columns.length === 0) return jsonError(res, 400, new Error('Insert values are required'));
   const params = [];
   const valueSql = rows.map((row) => `(${columns.map((column) => {
    return bindDbParam(params, table, column, row[column]);
   }).join(', ')})`).join(', ');

   const result = await getDb().unsafe(
    `insert into ${tableSql} (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning ${normalizeColumns(returning)}`,
    params,
   );

   notifyDbSubscribers(table, 'INSERT', result);

   // A message posted into a bridged channel goes out to the outside network it
   // mirrors. Fire-and-forget AFTER the row is written and broadcast: a Telegram
   // outage must never cost somebody the message they just sent in the app.
   // emitBridgeOutbound itself refuses anything that came IN over the bridge, so
   // this cannot echo.
   if (table === 'messages') {
    for (const row of result) {
     void channelBridges.emitBridgeOutbound(row).catch((error) =>
      console.error('emitBridgeOutbound failed', error),
     );
    }
   }

   // A DM opened from the client arrives here (createSession -> POST /db/insert).
   // The person who opened it is its first member — do this in the SAME request,
   // not lazily, because a private session with no members is one its own creator
   // cannot read.
   //
   // This is the ONLY place a user is added to a session by their own action.
   // Dispatching an agent into a DM deliberately does NOT add the dispatcher:
   // `run_agents` is an editor-level capability, so auto-adding would make
   // "assign a task" a self-service way into anyone's DM — a self-grant
   // primitive, which is exactly what this feature exists to remove. Access for
   // someone else goes through the manage-gated grant route and leaves an audit
   // row.
   if (table === 'chat_sessions') {
    for (const row of result) {
     if (!row?.id) continue;
     if (!isPrivateSessionRow(row)) continue;
     await addSessionParticipant({ sessionId: row.id, userId: req.userId, db: sharedDbAdapter });
     // A sub-thread or fork of a private session inherits its member list, not
     // just its privacy. Otherwise splitting a thread out of a DM would quietly
     // cut off everyone in that DM except whoever clicked — including someone
     // holding a deliberate grant.
     await copyInheritedSessionMembers(row);
    }
   }

   // A human comment that @mentions an agent wakes that agent in its DM. Fire-and-
   // forget so the insert responds immediately; each mention is guarded internally.
   if (COMMENT_MENTION_TABLES[table]) {
    for (const row of result) {
     void dispatchCommentMentions({ table, row, authorUserId: req.userId }).catch((error) =>
      console.error('dispatchCommentMentions failed', error),
     );
    }
   }

   // A task CREATED already assigned to an agent dispatches it too — otherwise
   // "add task, assign @coder" would sit there while the same choice made a
   // second later (via update) runs. An insert is always a change, so there is
   // nothing to diff; dispatchTaskAssignment still vets agent-vs-human, disabled
   // agents, terminal status and duplicates.
   if (table === 'tasks') {
    for (const row of result) {
     const assigneeId = typeof row?.assignee_id === 'string' ? row.assignee_id.trim() : '';
     if (!assigneeId || !row.id) continue;
     void dispatchTaskAssignment({
      workspaceId: row.workspace_id,
      taskId: row.id,
      agentId: assigneeId,
      actorUserId: req.userId,
     }).catch((error) => console.error('dispatchTaskAssignment failed', error));
    }
   }

   if (table === 'workspaces') {
    for (const row of result) {
     try {
      await seedDefaultAgents(row.id, row.user_id || req.userId);
     } catch (seedError) {
      console.error('seedDefaultAgents failed:', seedError);
     }
    }
   }

   res.json({ data: single ? (result[0] ?? null) : result, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/db/update', requireAuth, async (req, res) => {
  try {
   const { table, values, filters = [], returning = '*', single = false } = req.body || {};
   const tableSql = ensureTable(table);
   if (!values || typeof values !== 'object') return jsonError(res, 400, new Error('Update values are required'));
   await enforceDbOperationAccess(req.userId, table, 'update', { filters, values });
   // Renaming an agent INTO the reserved handle is the same door as creating one
   // there. See the insert route above.
   if (table === 'workspace_agents' && isReservedAgentHandle(values.handle)) {
    return jsonError(res, 400, new Error(reservedAgentHandleMessage(values.handle)));
   }
   const safeValues = stripPrivilegedDbValues(table, values);

   // A human editing an agent is the OTHER half of the identity precedence rule
   // (shared/agentIdentity.cjs): whatever they touch here is recorded in
   // identity.human_set so the agent's next self-declaration leaves it alone.
   // This route is the one chokepoint every human agent edit goes through, which
   // is why the marking lives here and not in whichever dialog made the edit.
   // The identity jsonb itself is NEVER written from the client's object — only
   // a validated `voice` is grafted onto the STORED column in SQL — so a
   // payload like {"identity":{"human_set":{...}}} (or {"identity":{}}) can
   // neither forge a lock nor erase one.
   const { values: markedValues, voice, lockPatch } = markHumanIdentityWrite(table, safeValues);
   const keys = Object.keys(markedValues);
   if (keys.length === 0 && !lockPatch && !(VERSIONED_TABLES.has(table) && values.version == null)) {
    return jsonError(res, 400, new Error('No updatable fields provided'));
   }

   const params = [];
   const setParts = keys.map((column) => `${quoteIdent(column)} = ${bindDbParam(params, table, column, markedValues[column])}`);
   if (lockPatch) {
    // Base is the stored column (a rename must not clobber the voice); locks
    // merge INTO the stored ones, so a client cannot forge a lock for a field
    // it did not write and a stale echo cannot un-protect a chosen field.
    const voiceBound = voice !== undefined ? bindDbParam(params, table, 'identity', voice) : null;
    setParts.push(`"identity" = ${identityWriteSql(voiceBound, bindDbParam(params, table, 'identity', lockPatch))}`);
   }
   if (VERSIONED_TABLES.has(table) && values.version == null) {
    setParts.push('"version" = COALESCE("version", 0) + 1');
   }
   if (setParts.length === 0) {
    return jsonError(res, 400, new Error('No updatable fields provided'));
   }
   const setClause = setParts.join(', ');

   // Dispatch-on-assign needs the PREVIOUS assignee: an update that re-writes the
   // assignee it already had is not a change and must not re-run the agent. Read
   // it with the same filters, before the write, and only for the rare update
   // that actually sets assignee_id (an unassign — null/'' — never dispatches).
   const nextAssigneeId = table === 'tasks' && typeof safeValues.assignee_id === 'string'
    ? safeValues.assignee_id.trim()
    : '';
   let priorTaskRows = [];
   if (nextAssigneeId) {
    const priorWhere = buildWhereClause(filters, []);
    priorTaskRows = await getDb().unsafe(
     `select id, workspace_id, assignee_id from ${tableSql}${priorWhere.clause}`,
     priorWhere.params,
    ).catch(() => []);
   }

   // Same shape, same reason as the assignee read above: a reaction event is the
   // DIFFERENCE between the stored map and the one being written, and the write
   // replaces the whole column, so the before-image has to be read first. Only
   // for the writes that actually touch `reactions` — an ordinary message edit
   // must not pay for a second query. `.catch(() => [])` because a reaction that
   // saves without an event is a missing signal; a reaction that fails to save
   // because the event machinery could not read is a lost user action.
   // Same shape and same reason again: "was this thread ALREADY discarded?" is a
   // before-image question, and the write replaces the column. Only for writes
   // that actually touch deleted_at, so an ordinary rename pays nothing.
   let priorSessionRows = [];
   if (table === 'chat_sessions' && Object.prototype.hasOwnProperty.call(safeValues, 'deleted_at')) {
    const priorWhere = buildWhereClause(filters, []);
    priorSessionRows = await getDb().unsafe(
     `select id, workspace_id, deleted_at from ${tableSql}${priorWhere.clause}`,
     priorWhere.params,
    ).catch(() => []);
   }

   let priorReactionRows = [];
   if (table === 'messages' && Object.prototype.hasOwnProperty.call(safeValues, 'reactions')) {
    const priorWhere = buildWhereClause(filters, []);
    priorReactionRows = await getDb().unsafe(
     `select id, session_id, reactions, sender_kind, sender_id, sender_name, thread_parent_id, created_at
        from ${tableSql}${priorWhere.clause}`,
     priorWhere.params,
    ).catch(() => []);
   }

   const where = buildWhereClause(filters, params);
   const result = await getDb().unsafe(
    `update ${tableSql} set ${setClause}${where.clause} returning ${normalizeColumns(returning)}`,
    where.params,
   );

   notifyDbSubscribers(table, 'UPDATE', result);

   // Fire-and-forget, AFTER the row is written and broadcast: an integration
   // that cannot be told about a reaction must never cost somebody the
   // reaction. Fails open, exactly like the enqueue inside notifyDbSubscribers.
   if (priorReactionRows.length > 0) {
    void emitReactionFlowEventsForUpdate({
     db: (sql, sqlParams) => getDb().unsafe(sql, sqlParams),
     // porsager: bind the OBJECT. A JSON.stringify here becomes a jsonb string
     // scalar (tests/jsonb-bind-hygiene.test.cjs).
     encodeJsonb: (payload) => payload,
     priorRows: priorReactionRows,
     updatedRows: result,
     nextReactions: safeValues.reactions,
     actorUserId: req.userId,
     onWarn: (message) => console.warn('[flows] reaction events:', message),
    }).catch((error) => {
     console.error('[flows] failed to queue reaction event:', error.message || error);
    });
   }

   // Assigning a task to an agent runs it — the same flow a task-comment @mention
   // runs. Fire-and-forget AFTER the row is written and broadcast, so a failed
   // dispatch can never lose the user's edit. dispatchTaskAssignment re-checks
   // everything that matters (agent vs human, disabled, done/cancelled, duplicate).
   // Discarding a thread is the moment its lessons are most likely to be lost, so
   // queue a background analysis of what could be gleaned from it. Fire-and-forget
   // AFTER the row is written and broadcast, and fails open inside: a harvest that
   // cannot be queued must never cost somebody their delete. Only on the
   // null -> timestamp EDGE, so a repeat delete or an undelete queues nothing.
   for (const before of priorSessionRows) {
    const after = result.find((row) => String(row.id) === String(before.id));
    if (!after || !isDiscardTransition(before, after)) continue;
    void queueThreadHarvest({
     workspaceId: before.workspace_id,
     sessionId: before.id,
     reason: 'deleted',
     requestedBy: req.userId,
    }).catch((error) => console.error('queueThreadHarvest failed', error));
   }

   for (const before of priorTaskRows) {
    if (String(before.assignee_id || '') === nextAssigneeId) continue;
    void dispatchTaskAssignment({
     workspaceId: before.workspace_id,
     taskId: before.id,
     agentId: nextAssigneeId,
     actorUserId: req.userId,
    }).catch((error) => console.error('dispatchTaskAssignment failed', error));
   }

   res.json({ data: single ? (result[0] ?? null) : result, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/db/delete', requireAuth, async (req, res) => {
  try {
   const { table, filters = [], single = false } = req.body || {};
   const tableSql = ensureTable(table);
   // Refuse an unfiltered delete — it would wipe the entire table.
   if (!Array.isArray(filters) || filters.length === 0) {
    return jsonError(res, 400, new Error('Delete requires at least one filter'));
   }
   const where = buildWhereClause(filters, []);
   if (!where.clause) {
    return jsonError(res, 400, new Error('Delete requires a non-empty where clause'));
   }
   await enforceDbOperationAccess(req.userId, table, 'delete', { filters });
   const result = await getDb().unsafe(`delete from ${tableSql}${where.clause} returning *`, where.params);
   notifyDbSubscribers(table, 'DELETE', result);
   res.json({ data: single ? (result[0] ?? null) : null, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 mountVaultRoutes(app, {
  ...coreDeps(), dbUnsafe,
  MANAGED_SECRET_KEYS, SANDBOX_VAULT_PREFIX, VAULT_KEY_RE, classifyVaultKey,
  credentialLabel, listManagedSecrets, listWorkspaceVaultEntries,
  parseSandboxCredentialKey, providerCredentialSlots, sandboxCredentialKey,
  setWorkspaceSecretValue, settingsWorkspaceIdFromRequest,
  workspaceAuthoredProviderSkills,
 });

 // The audit log's only read route. Mounted next to the vault because it is the
 // same sensitivity and the same gate: manage, user session, Fly only.
 mountAuditRoutes(app, { ...coreDeps(), auditReadRateLimiter });

 // --- Cartesia voices -------------------------------------------------------
 // Two routes, both thin. The browser must never see CARTESIA_API_KEY, so the
 // catalogue is proxied and the preview is rendered here.
 //
 // NOT the huddle playback pipeline — that is a separate piece of work. This is
 // only "which voices exist" and "let me hear this one".

 mountTtsRoutes(app, { ...coreDeps(), cartesiaApiKey, cartesiaSpeak, cartesiaVoices, normalizeVoicePreference, ttsPreviewRateLimiter });

 // Web-only egress for the browser panel; the desktop shell uses <webview> and
 // never calls this. Auth + rate limit are both mandatory — see the module header.
 installBrowserProxy(app, {
  requireAuth, rateLimiter: browserProxyRateLimiter, rateLimitBlocked, clientIpFromReq,
 });

 mountAiChatRoutes(app, {
  ...coreDeps(),
  aiChatRateLimiter, aiChatDbRateLimiter, dbQuery, inferenceBroker,
  liveSharedModelRoutes, bindInferenceAbort, getAnthropicApiKey,
  resolveAnthropicModel, buildSystemPrompt, normalizeAiChatMessages,
  assertSafeOutboundUrl, resolveGatewayRoute,
  recordAnthropicUsage, createAnthropicUsageAccumulator,
 });

 return app;
}

function startBackendServer(port = DEFAULT_PORT) {
 // Last-resort process guards. A single malformed frame, a rejected background
 // promise, or a throw from a detached callback must not take the whole backend
 // down — every request path already reports its own errors, so log and stay up.
 process.on('uncaughtException', (error) => {
  console.error('[backend] uncaught exception:', error?.stack || error?.message || error);
 });
 process.on('unhandledRejection', (reason) => {
  console.error('[backend] unhandled rejection:', reason?.stack || reason?.message || reason);
 });
 const app = createApp();
 const server = http.createServer(app);
 const wss = attachRealtime(server);
 // Bind to 127.0.0.1 locally (Electron/dev safety) but to 0.0.0.0 in a container
 // so Fly's proxy can reach it. Fly sets HOST=0.0.0.0 via fly.toml [env].
 const host = process.env.HOST || '127.0.0.1';
 server.listen(port, host, () => {
  console.log(`[backend] listening on http://${host}:${port}`);
 });
 void reconcileAgentConnectionsAtStartup();
 void reconcileSchedulesAtStartup();
 // sweepAutomationRuns stays on the 30s tick: reclaiming a lease that expired
 // because a process died is housekeeping, and running it every second would be
 // 30x the query for no benefit. The DRAIN moved to its own 1s worker below.
 const jobReaper = setInterval(() => { void reapStuckAgentJobs(); void reapStuckMcpJobs(); void expireStalePermissionRequests(); void pruneOfflineConnections(); pruneExpiredPeerTickets(); void runDueSchedules(); void runDueThreadHarvests(); void sweepAutomationRuns(); }, 30_000);
 if (jobReaper.unref) jobReaper.unref();
 let flowDeliveryRunning = false;
 const flowDeliveryWorker = setInterval(() => {
  if (flowDeliveryRunning) return;
  flowDeliveryRunning = true;
  void deliverNextFlowWebhook()
   .catch(error => console.error('[flows] webhook worker failed:', error.message || error))
   .finally(() => { flowDeliveryRunning = false; });
 }, 1_000);
 flowDeliveryWorker.unref?.();

 // Automations drain on their OWN 1s worker, a sibling of the flow delivery
 // worker above rather than a passenger on the 30s reaper tick.
 //
 // WHY 1s: "when X happens, do Y" arriving up to 30 seconds later reads as
 // broken. This is the cadence the shipped flowDeliveryWorker already runs at
 // against the same database, with the same in-flight boolean, so it is a known
 // quantity rather than a new risk.
 //
 // WHY A SIBLING AND NOT MERGED INTO IT: a slow automation must not delay a
 // webhook delivery, and a slow webhook must not delay an automation.
 //
 // A FASTER TICK IS NOT A BIGGER TICK. runDueAutomations keeps its per-tick
 // bound exactly as it was — the interval got 30x shorter and the batch did not
 // grow, so peak work per tick is strictly lower than before. The in-flight
 // boolean means a drain that outlives its interval simply skips the next one
 // instead of stacking, and every other guard (compare-and-set lease, idempotent
 // enqueue, fan-out cap, the rate limit that disables rather than throttles) is
 // untouched and lives in server/automations.cjs, not here.
 let automationRunning = false;
 const automationWorker = setInterval(() => {
  if (automationRunning) return;
  automationRunning = true;
  void runDueAutomations()
   .catch(error => console.error('[automations] worker failed:', error.message || error))
   .finally(() => { automationRunning = false; });
 }, 1_000);
 automationWorker.unref?.();

 // Suggestions: notice the conversations that have gone quiet and queue them.
 //
 // Its own timer at five minutes rather than a passenger on the 30s reaper.
 // The selector is a join over `messages` and the per-session cooldown means it
 // has nothing to do on almost every pass, so running it 10x more often would
 // be 10x the query for the same result — and five minutes of latency against a
 // three-hour idle threshold is not latency.
 //
 // ENQUEUEING IS NOT SPENDING. This only writes 'pending' rows, capped at
 // SUGGEST_SWEEP_LIMIT per pass; the model calls stay behind
 // runDueThreadHarvests on the 30s tick, at its unchanged 3 per tick. The
 // in-flight boolean is the same pattern as the two workers above: a slow sweep
 // skips the next pass rather than stacking on top of itself.
 let suggestionSweepRunning = false;
 const suggestionSweeper = setInterval(() => {
  if (suggestionSweepRunning) return;
  suggestionSweepRunning = true;
  void sweepIdleSessionHarvests()
   .catch(error => console.error('[thread-harvest] idle sweep failed:', error.message || error))
   .finally(() => { suggestionSweepRunning = false; });
 }, SUGGEST_SWEEP_INTERVAL_MS);
 suggestionSweeper.unref?.();

 server.on('close', () => {
  clearInterval(jobReaper);
  clearInterval(flowDeliveryWorker);
  clearInterval(automationWorker);
  clearInterval(suggestionSweeper);
  wss.close();
  realtime.reset();
 });
 return server;
}

if (require.main === module) {
 startBackendServer();
}

function setTestDb(nextDb) {
 db = nextDb;
 cachedAuthSecret = null;
 cachedAuthSecretSource = '';
 tokenVersionCache.clear();
}

function resetTestState() {
 db = undefined;
 cachedAuthSecret = null;
 cachedAuthSecretSource = '';
 realtime.reset();
 envLoaded = false;
 tokenVersionCache.clear();
 farmIntegrationCoreInstance = undefined;
 flowConnectionCoreInstance = undefined;
 agentConnections.reset();
 clearPendingJobFailures();
 taskDispatch.reset();
 conversationLocks.clear();
}




module.exports = {
 startBackendServer,
 createApp,
 __test: {
  allowLoopbackAgentDevFallback,
  appendWorkspaceAccessClause,
  assertSafeOutboundUrl,
  isBlockedAddress,
  // The credential-injecting provider proxy, exercised against a fake DB and a
  // stubbed fetch in tests/provider-proxy.test.cjs.
  callProviderOperation,
  readCappedResponseText,
  providerCallRateLimiter,
  // Join links. The limiters are exported so tests can reset them between
  // cases — a redeem budget of 10/min is deliberately low, and a suite that
  // redeems more than that would otherwise start measuring the limiter instead
  // of the thing under test.
  joinLinkRateLimiter,
  joinRedeemRateLimiter,
  isJoinLinkToken,
  createJoinLinkToken,
  joinLinkTtlMs,
  JOIN_LINK_DEFAULT_TTL_MS,
  authorizeRealtimeBinding,
  authorizeRealtimeBroadcast,
  revokeRealtimeAccessForMember,
  registerTestWebsocketClient,
  notifyDbSubscribers,
  relayBroadcast,
  registerTestConnectedAgent,
  listTestConnectedAgents,
  // One live daemon per agent: registration supersedes an older live connection.
  registerAgentConnection,
  // A dropped socket is not proof the turn stopped — see daemon-drop-survives.
  markAgentConnectionOffline,
  disconnectAgentDaemons,
  takeAgentDaemonConnections,
  findConnectedAgent,
  AGENT_DISCONNECT_CLOSE_MESSAGES,
  insertActiveAgentJob,
  buildWhereClause,
  buildDaemonPrompt,
  agentConnectionCommand,
  // Reply cadence — the pending-wake bookkeeping. The DECISION is pure and lives
  // in shared/replyCadence.cjs; these are only the seams a test needs to prove
  // that a held turn is booked (and never double-booked) rather than dropped.
  // continueConversation itself is already exported further down.
  cadenceWakes,
  clearCadenceWakes,
  scheduleCadenceWake,
  agentNamedInBurst,
  msSinceTimestamp,
  TASK_QUEUE_BUSY_RUN_REASONS,
  VOICE_HUDDLE_NOTE,
  streamFlushDue,
  BUILTIN_FLUSH_INTERVAL_MS,
  // The builtin tool-use loop: the cap, the pure orchestrator (model + tools
  // injected), and the identity/projection helpers that decide what a builtin
  // turn may reach.
  runToolUseLoop,
  toolResultText,
  builtinToolIdentity,
  builtinStepDetail,
  getBuiltinToolset,
  mcpToolDeps,
  streamAnthropicTurn,
  BUILTIN_TOOL_LOOP_MAX_STEPS,
  BUILTIN_TOOL_LOOP_MAX_CALLS,
  BUILTIN_TOOL_RESULT_MAX_CHARS,
  BUILTIN_TOOL_NOTE,
  loadChannelIntentNote,
  agentVoiceSettings,
  cartesiaEnglishVoiceIds,
  cartesiaSpeak,
  fetchCartesiaVoices,
  publicCartesiaVoice,
  capabilityForDbOperation,
  canManageWorkspace,
  canMutateWorkspace,
  enforceDbOperationAccess,
  enforceWorkspaceRole,
  evaluatePasswordServerSide,
  getWorkspaceRole,
  issueToken,
  resetTestState,
  roleHasWorkspaceCapability,
  setTestDb,
  stripPrivilegedDbValues,
  storagePathBelongsToWorkspace,
  resolveStoragePathForWorkspace,
  inspectProjectPath,
  validFileSourceRoot,
  projectFsAllowed,
  isWithinAllowedProjectRoot,
  WORKSPACE_SCOPED_TABLES,
  getTokenTtlSec,
  DEFAULT_TOKEN_TTL_SEC,
  verifyToken,
  // Token revocation cache — exposed so tests can assert the cache is real
  // (not a no-op) without hardcoding its TTL.
  TOKEN_VERSION_CACHE_TTL_MS,
  getCachedTokenVersion,
  workspaceIdFromRealtimeChannel,
  // Socket liveness — a daemon must survive a single missed pong.
  sweepLiveness: (...args) => realtime.sweepLiveness(...args),
  LIVENESS_MAX_MISSED_PONGS: realtime.LIVENESS_MAX_MISSED_PONGS,
  LIVENESS_PING_INTERVAL_MS: realtime.LIVENESS_PING_INTERVAL_MS,
  clearPendingJobFailures,
  // MCP connect-a-client model — exercised against a fake DB.
  verifyInviteToken,
  verifyWorkspaceMcpToken,
  verifyUserAuthMcpToken,
  verifyMcpToken,
  createWorkspaceMcpToken,
  createCursorBuddyConnectionKey,
  normalizeCursorBuddySurface,
  normalizeCursorBuddyScope,
  publicCursorBuddyConnectionKey,
  publicWorkspace,
  buildWorkspaceBootstrap,
  BOOTSTRAP_LIMITS,
  ensureCursorBuddyAgentForKey,
  runAgentTurn,
  resolveWorkThreadParent,
  loadChannelMessages,
  sanitizeRealtimeRow,
  // The vault: encryption at rest, the legacy-plaintext backfill, and the
  // managed-key state shape (which must never carry a preview again).
  encryptVaultSecret,
  decryptVaultSecret,
  // Exposed for tests/env-isolation.test.cjs only: it is the one call that
  // reports whether a test process could open a real database connection.
  getDatabaseUrl,
  getWorkspaceSecretValue,
  setWorkspaceSecretValue,
  reencryptLegacyPlaintextSecrets,
  listManagedSecrets,
  MANAGED_SECRET_KEYS,
  CHANNEL_CONTEXT_MAX_BYTES,
  agentContextBytes,
  boundAgentContextMessages,
  agentRuntimePayload,
  resolveRunTarget,
  connectionSupportsAmpRuntime,
  isAmpRuntimeAgent,
  loadAmpThreadBinding,
  validAmpThreadId,
  taskStatusOnDispatch,
  resolveDispatchThreadParent,
  shouldMirrorAgentMessage,
  postTaskSubthreadMention,
  mirrorAgentReplyToTaskComment,
  dispatchCommentMentions,
  dispatchTaskAssignment,
  drainAgentTaskQueue,
  agentHasActiveJob,
  agentHasAnyActiveJob,
  claimTaskDispatch,
  releaseTaskDispatch,
  taskQueuePosition,
  TASK_ASSIGN_CLAIM_MS,
  TASK_QUEUE_MAX_STRIKES,
  TASK_QUEUE_SCAN_LIMIT,
  createTtlPromiseCache,
  hasActiveBurstJob,
  capabilitiesShapeValid,
  ampRuntimeFromMessage,
  executionRuntimesFromMessage,
  refreshConnectedAgentConfigs,
  capabilitiesDriftNudges,
  reachFromMessage,
  reachIsDirect,
  sharedModelsFromMessage,
  canonicalSharedModelId,
  sharedModelRoutesFromConnections,
  publicAgentConnection,
  publicFarmEnrolledAgent,
  createOpenAIInferenceStreamRelay,
  bindInferenceAbort,
  mintPeerTicket,
  mergeSlashCommands,
  finalizeStuckJob,
  clearStrandedPlaceholders,
  PLACEHOLDER_CONTENT_RE,
  reapStuckAgentJobs,
  claimMcpJob,
  submitMcpJobResult,
  reapStuckMcpJobs,
  finalizeAgentJobResult,
  ampResultMetadata,
  normalizeStopReason,
  stopResultMetadata,
  failureSentence,
  validateAmpJobResult,
  dispatchFarmAgentJob,
  disableFarmIntegrationAgents,
  getFarmAgentJob,
  cancelFarmAgentJob,
  handleAgentJobDelta,
  handleAgentJobStep,
  handleAgentPermissionRequest,
  decideAgentPermissionRequest,
  expireStalePermissionRequests,
  expireConnectionPermissionRequests,
  rehomePendingPermissionRequests,
  revokeAgentPermissionRule,
  setAgentPermissionMode,
  publicPermissionRequest,
  handleAgentJobSegment,
  agentStepContent,
  agentStepParts,
  handleAgentCapabilitiesSync,
  resolveWorkspaceAgentByHandle,
  applyAgentIdentity,
  repairCorruptedAgentIdentities,
  registerAgentRequest,
  finalizeRegistrationApproval,
  decideAgentRegistration,
  getRegistrationStatus,
  touchMcpPresence,
  hasMcpPresence,
  ensureMentionedParticipants,
  parseAgentMentions,
  parseAllMentions,
  pickMentionNextAgent,
  agentsAddressedByRow,
  slugHandle,
  continueConversation,
  verifyNetlifyDeploySignature,
  buildSystemPrompt,
  normalizeAiChatMessages,
 },
};
