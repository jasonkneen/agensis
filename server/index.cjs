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
const { createMarketplace, mountMarketplaceRoutes } = require('./marketplace-routes.cjs');
const { createWorkspaceSkills, mountWorkspaceSkillRoutes } = require('./workspace-skills-routes.cjs');
const {
 normalizeAgentTemplate, normalizeAgentIntent, normalizeAgentRunMode, agentToTemplateDraft, readTemplateExport, templateFingerprint, buildTemplateExport,
} = require('../shared/agentTemplates.cjs');
const {
 normalizeMarketplaceListing, publicMarketplaceListing, hiredAgentDraft,
} = require('../shared/marketplace.cjs');
// Reactions are written through the generic /backend/db/update route as a whole
// jsonb map, so their flow events come from diffing that map — see the module
// header. Shared with netlify/functions/backend.mjs; the two lanes differ only
// in the `encodeJsonb` bind (porsager wants the object, @netlify/database the
// string).
const { emitReactionFlowEventsForUpdate } = require('../shared/reaction-events.cjs');
const { ensureSessionReadStateShape, SHARE_READ_RECEIPTS_DDL } = require('../shared/read-receipts.cjs');
const { renderSkillMd, skillManifest, configBlock, claudeMcpAddCommand, mcpEndpoint } = require('./skills.cjs');
const {
 agentNextSteps,
 controllerNextSteps,
 joinDescriptor,
 previewDescriptor,
 invalidDescriptor,
 machinePayload,
 renderJoinHtml,
 joinUrlFor,
} = require('./join-page.cjs');
const {
 createControllerCredential,
 verifyControllerToken: verifyScopedControllerToken,
} = require('./controller-credentials.cjs');
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
const { mountHuddleRoutes, ensureHuddlesSchema, deleteLivekitRoom } = require('./huddles.cjs');
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
 installCreatedSessionMemberships,
 lockPrivateSessionRoster,
 prepareSessionCreateRows,
 projectSessionCreateRows,
 sessionLineageKind,
} = require('../shared/session-lineage.cjs');
const {
 createThreadHarvest, mountThreadHarvestRoutes,
 SUGGEST_SWEEP_INTERVAL_MS,
} = require('./thread-harvest.cjs');

const TASK_MENTION_CLAIM_MS = 5_000;
const { mountFeedbackRoutes } = require('./feedback-routes.cjs');
const { mountAiChatRoutes } = require('./ai-chat-routes.cjs');
const {
 normalizeAndBoundAiChatMessages,
} = require('../shared/ai-chat-context.cjs');
const { installBrowserProxy } = require('./browser-proxy.cjs');
const { mountVaultRoutes } = require('./vault-routes.cjs');
const { mountAuditRoutes } = require('./audit-routes.cjs');
const { mountTenantsRoutes } = require('./tenants-routes.cjs');
const { mountSchedulesRoutes } = require('./schedules-routes.cjs');
const { lockScheduleExecutionScope } = require('./schedule-scope.cjs');
const { mountCursorbuddyRoutes } = require('./cursorbuddy-routes.cjs');
const { mountInferenceRoutes } = require('./inference-routes.cjs');
const { mountFarmRoutes } = require('./farm-routes.cjs');
const { mountFilesRoutes } = require('./files-routes.cjs');
const { mountProjectGitRoutes } = require('./project-git-routes.cjs');
const { mountAuthRoutes } = require('./auth-routes.cjs');
const { mountMembersInvitesRoutes } = require('./members-invites-routes.cjs');
const { mountJoinLinksRoutes } = require('./join-links-routes.cjs');
const { mountControllerRoutes } = require('./controller-routes.cjs');
const { createWorkspaceResourceService } = require('./workspace-resources.cjs');
const { mountWorkspaceResourceRoutes } = require('./workspace-resource-routes.cjs');
const { mountFlowRoutes } = require('./flow-routes.cjs');
const { mountSystemRoutes } = require('./system-routes.cjs');
const { mountWorkspacesRoutes } = require('./workspaces-routes.cjs');
const { mountWorkspaceMcpRoutes } = require('./workspace-mcp-routes.cjs');
const { mountInboxRoutes } = require('./inbox-routes.cjs');
const { mountAgentJobCancelRoutes } = require('./agent-job-cancel-routes.cjs');
const { mountReactionsRoutes } = require('./reactions-routes.cjs');
const { mountReadReceiptsRoutes } = require('./read-receipts-routes.cjs');
const { mountSessionAccessRoutes } = require('./session-access-routes.cjs');
const { runDmScopeBackfill } = require('./dm-scope-backfill.cjs');
const { mountLinkPreviewsRoutes } = require('./link-previews-routes.cjs');
const { mountAgentsRoutes } = require('./agents-routes.cjs');
const { mountJoinPagesRoutes } = require('./join-pages-routes.cjs');
const { mountTtsRoutes } = require('./tts-routes.cjs');
const { mountMcpDoorsRoutes } = require('./mcp-doors-routes.cjs');
const { mountMcpOauthRoutes } = require('./mcp-oauth-routes.cjs');
const { createMcpOauthStore } = require('./mcp-oauth.cjs');
const mcpOauthShared = require('../shared/mcp-oauth.cjs');
const { mountConnectionsRoutes } = require('./connections-routes.cjs');
const { mountSessionsRoutes } = require('./sessions-routes.cjs');
const { SESSION_RETURNING, settleSessionClosure } = require('../shared/session-close.cjs');
const { applySessionClosureRuntimeEffects } = require('./session-close-runtime.cjs');
const { mountAgentWebhooksRoutes } = require('./agent-webhooks-routes.cjs');
const { createChannelBridges } = require('./channel-bridges.cjs');
const {
 telegramAdapter, telegramSetWebhook, slackAdapter, mountBridgeRoutes,
} = require('./bridge-routes.cjs');
const { mountBridgeAdminRoutes } = require('./bridge-admin-routes.cjs');
const { createNostrCommunityManager } = require('./nostr-community-manager.cjs');
const { mountNostrCommunityRoutes } = require('./nostr-community-routes.cjs');
const { mountPetsRoutes } = require('./pets-routes.cjs');
const { mountHealthRoutes } = require('./health-routes.cjs');
const { mountStaticSite } = require('./static-site.cjs');
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
 buildGenericInsertSource,
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
 // ALLOWED_TABLES / JSON_COLUMNS_BY_TABLE / arrayColumnElemType moved with the
 // SQL builders — see server/lib/db-sql.cjs,
 // which imports them from this same shared core.
 VERSIONED_TABLES,
 WORKSPACE_SCOPED_TABLES: SHARED_WORKSPACE_SCOPED_TABLES,
 WORKSPACE_ROLE_CAPABILITIES: SHARED_WORKSPACE_ROLE_CAPABILITIES,
 DB_TABLE_ACCESS: SHARED_DB_TABLE_ACCESS,
 stripPrivilegedDbValues,
 validateUniformInsertRows,
 applyAgentPurposeInsertDefaults,
 stampTaskWriteIdentity,
 taskDispatchRequesterSql,
 stripImmutableDbUpdateValues,
 appendMessageAuthorshipFilters,
 appendMessageMutationAccessClause,
 loadBrowserMessageAuthor,
 stampBrowserMessageInsert,
 safeSelectColumns,
 assertGenericSelectAllowed,
 toPgArrayLiteral,
 aiStreamErrorText,
 redactDeletedMessageRows,
 scrubEditedMessageActivityByMessageId,
 scrubMessageActivityByMessageId,
 scrubMessageActivityBySession,
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
 assertWorkspaceRoleLocked: sharedAssertWorkspaceRoleLocked,
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
const cursorBuddyGuides = require('../shared/cursorbuddy-guides.cjs');
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
const {
 ambientRepliesEnabled,
 createAmbientElectionBudget,
 isHumanAuthored,
 isStructurallyTrivial,
 openInterlocutor,
} = require('../shared/ambientAddressing.cjs');

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = Number(process.env.API_PORT || 3142);
const DEFAULT_AI_MODEL = process.env.AGENSIS_DEFAULT_AI_MODEL || 'claude-opus-5';
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
async function _resolveInheritedSessionVisibility(
 rows,
 userId,
 db = sharedDbAdapter,
 { lockParent = false } = {},
) {
 let inheritedPrivate = false;
 for (const row of rows) {
  if (!row || typeof row !== 'object') continue;
  const parentSessionId = String(row.split_parent_id || '').trim() || null;
  const parentMessageId = String(row.parent_message_id || '').trim() || null;
  if (!parentSessionId && !parentMessageId) continue;
  try {
   const found = await db(
    `select parent_session.id, parent_session.visibility, parent_session.folder
       from chat_sessions parent_session
      where parent_session.id = coalesce(
              $1::uuid,
              (select parent_message.session_id
                 from messages parent_message
                where parent_message.id = $2::uuid
                  and parent_message.deleted_at is null)
            )
        and parent_session.workspace_id = $3::uuid
        and ${sessionReadableSql('parent_session', '$4', { lockMembership: lockParent })}
      limit 1
      ${lockParent ? 'for share of parent_session' : ''}`,
    [parentSessionId, parentMessageId, String(row.workspace_id || ''), String(userId || '')],
   );
   if (found.length !== 1) {
    throw forbidden('The parent conversation is unavailable');
   }
   if (isPrivateSessionRow(found[0])) inheritedPrivate = true;
  } catch (error) {
   if (error?.status) throw error;
   // This lookup proves authority as well as classification. Marking a child
   // private is not enough when its parent itself was never proven readable and
   // same-workspace: the member-copy step would still cross that boundary.
   console.warn('[backend] inherited session visibility lookup failed:', error?.message || error);
   const unavailable = new Error('Unable to verify the parent conversation');
   unavailable.status = 503;
   throw unavailable;
  }
 }
 return inheritedPrivate ? 'private' : null;
}

/**
 * Copy a newly created derived session's member list down from its parent.
 *
 * Returns false instead of throwing so callers can choose their integrity
 * boundary. The generic browser insert treats false as fatal inside the same
 * transaction: a derived private session must never commit with only a partial
 * inherited audience.
 */
async function _copyInheritedSessionMembers(row, db = sharedDbAdapter) {
 const parentSessionId = row?.split_parent_id ? String(row.split_parent_id) : '';
 const parentMessageId = row?.parent_message_id ? String(row.parent_message_id) : '';
 if (!parentSessionId && !parentMessageId) return true;
 try {
  await db(
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
  return true;
 } catch (error) {
  console.warn('[backend] inherited session member copy failed:', error?.message || error);
  return false;
 }
}
// The read gate BELOW the workspace: a private session (a DM, or a sub-thread /
// huddle transcript derived from one) is readable only by its members. Always
// called AFTER enforceWorkspaceRole, never instead of it — it narrows, it does
// not grant. Same wrapper shape as enforceWorkspaceRole so route modules keep
// taking one injected function and cannot duplicate the rule.
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

/**
 * Resolve the audience for a session-derived workspace-wide realtime row.
 *
 * A null result means the source session could not be proven and the row must
 * be withheld. `memberUserIds: null` means the session is workspace-visible;
 * a Set means only those current private-session members may receive it.
 */
async function sessionRealtimeAudience(sessionId) {
 if (!sessionId) return null;
 const audiences = await sessionRealtimeAudiences([sessionId]);
 return audiences.get(String(sessionId)) || null;
}

async function sessionRealtimeAudiences(sessionIds) {
 const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
  .map(String)
  .filter(Boolean))];
 if (ids.length === 0) return new Map();
 const rows = await sharedDbAdapter(
  `select id, visibility, folder
     from chat_sessions
    where id = any($1::uuid[]) and deleted_at is null`,
  [toPgArrayLiteral(ids)],
 );
 const result = new Map();
 const privateIds = rows.filter(isPrivateSessionRow).map(row => String(row.id));
 const membersBySession = new Map(privateIds.map(id => [id, new Set()]));
 if (privateIds.length > 0) {
  const memberships = await sharedDbAdapter(
   `select session_id, user_id
      from chat_session_members
     where session_id = any($1::uuid[])
       and (expires_at is null or expires_at > now())`,
   [toPgArrayLiteral(privateIds)],
  );
  for (const membership of memberships) {
   membersBySession.get(String(membership.session_id))?.add(String(membership.user_id));
  }
 }
 for (const session of rows) {
  const id = String(session.id);
  result.set(id, isPrivateSessionRow(session)
   ? { memberUserIds: membersBySession.get(id) || new Set() }
   : { memberUserIds: null });
 }
 return result;
}

async function readReceiptOptedInUserIds(userIds) {
 const ids = [...new Set(
  (Array.isArray(userIds) ? userIds : []).map(String).filter(Boolean),
 )];
 if (ids.length === 0) return new Set();
 const rows = await sharedDbAdapter(
  `select id from app_users
    where id = any($1::uuid[])
      and coalesce(share_read_receipts, true)`,
  [toPgArrayLiteral(ids)],
 );
 return new Set(rows.map((row) => String(row.id)));
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
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_baseline_message_id uuid;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_source_boundary_message_id uuid;
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
    -- No suggestion may EXIST for a private conversation.
    --
    -- Not a filter — a delete. queueThreadHarvest and the idle sweep both refuse
    -- to mine a private session, but that only stops NEW rows: deleting a DM
    -- queued a workspace-visible analysis before that rule existed, and those
    -- rows are in production. Two read paths reach a row without going through
    -- listThreadHarvests' privacy clause — the generic /backend/db/select
    -- (thread_harvests is in ALLOWED_TABLES so its realtime subscription can be
    -- authorized at all, and a select of all columns hands back the findings
    -- verbatim), and decideHarvestFinding by id. Column-level allow-lists
    -- cannot express "not this ROW", so the only way to make those paths safe
    -- is for the row not to be there.
    --
    -- Runs every boot rather than once, which is what makes it an invariant
    -- instead of a migration: a channel that is turned private LATER has the
    -- suggestions mined from it removed on the next start. Idempotent by
    -- construction — the second run matches nothing.
    DELETE FROM thread_harvests h
     USING chat_sessions s
     WHERE s.id = h.session_id
       AND (COALESCE(s.visibility, 'workspace') = 'private'
            OR COALESCE(s.folder, '') = 'Direct messages');

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
      -- Frozen at enqueue so a reclaimed run cannot resume against edited
      -- steps. Nullable for runs created before the forward migration.
      definition jsonb,
      steps jsonb NOT NULL DEFAULT '[]'::jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS definition jsonb;
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
    -- Descriptive intent only. Neither column grants tools, permissions, host
    -- folders, runtime placement or other authority.
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'collaborator'
      CHECK (purpose IN ('collaborator', 'resource'));
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (
        jsonb_typeof(resource_facets) = 'array'
        AND resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
      );
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'workspace_agents_resource_facets_match_purpose'
           AND conrelid = 'workspace_agents'::regclass
      ) THEN
        ALTER TABLE workspace_agents
          ADD CONSTRAINT workspace_agents_resource_facets_match_purpose CHECK (
            (purpose = 'collaborator' AND resource_facets = '[]'::jsonb)
            OR (purpose = 'resource' AND jsonb_array_length(resource_facets) > 0)
          );
      END IF;
    END
    $$;
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
    -- May this agent be drawn into a channel post that named nobody?
    --
    -- DEFAULT true on purpose: unprompted replies have been live for every
    -- 'auto' channel since the conversation_mode work, and defaulting to false
    -- would silently switch that off for everyone. Explicit addressing — an
    -- @mention, @channel, a DM, a reply in the agent's own thread — is NEVER
    -- affected by this column; an off switch that made an agent unreachable by
    -- name would be a bug, not a setting. Read fail-open in
    -- shared/ambientAddressing.cjs so a row predating this column stays audible.
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS ambient_replies boolean NOT NULL DEFAULT true;
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

    -- Connection rows must exist before channel_bridges adds its optional
    -- connection_id foreign key. Keep this ordering compatible with a genuinely
    -- fresh database rather than relying on a previous runtime bootstrap.
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

    -- One hosted Nostr identity + relay connection per imported Nostr community.
    -- The private key is NOT in this table; it lives encrypted in
    -- workspace_secrets under bridge:nostr:<id>:nsec.
    CREATE TABLE IF NOT EXISTS nostr_community_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      relay_http_url text NOT NULL,
      relay_ws_url text NOT NULL,
      community_id text NOT NULL DEFAULT '',
      host text NOT NULL DEFAULT '',
      name text NOT NULL DEFAULT 'Nostr community',
      description text NOT NULL DEFAULT '',
      relay_pubkey text NOT NULL DEFAULT '',
      member_pubkey text NOT NULL DEFAULT '',
      policy_version text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending',
      last_error text,
      last_event_at bigint NOT NULL DEFAULT 0,
      last_inbound_at timestamptz,
      last_outbound_at timestamptz,
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (workspace_id, relay_ws_url)
    );
    CREATE INDEX IF NOT EXISTS idx_nostr_community_connections_workspace
      ON nostr_community_connections(workspace_id);

    CREATE TABLE IF NOT EXISTS nostr_community_members (
      connection_id uuid NOT NULL REFERENCES nostr_community_connections(id) ON DELETE CASCADE,
      channel_id text NOT NULL,
      pubkey text NOT NULL,
      name text NOT NULL DEFAULT '',
      handle text NOT NULL DEFAULT '',
      picture text NOT NULL DEFAULT '',
      is_agent boolean NOT NULL DEFAULT false,
      aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (connection_id, channel_id, pubkey)
    );
    CREATE INDEX IF NOT EXISTS idx_nostr_community_members_lookup
      ON nostr_community_members(connection_id, channel_id, lower(handle));

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
      nostr_connection_id uuid REFERENCES nostr_community_connections(id) ON DELETE CASCADE,
      nostr_last_event_at bigint NOT NULL DEFAULT 0,
      nostr_initial_sync_completed boolean NOT NULL DEFAULT false,
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
      CHECK (provider IN ('telegram', 'slack', 'whatsapp', 'signal', 'openclaw', 'nostr'));
    ALTER TABLE channel_bridges ADD COLUMN IF NOT EXISTS nostr_connection_id uuid
      REFERENCES nostr_community_connections(id) ON DELETE CASCADE;
    ALTER TABLE channel_bridges ADD COLUMN IF NOT EXISTS nostr_last_event_at bigint NOT NULL DEFAULT 0;
    ALTER TABLE channel_bridges ADD COLUMN IF NOT EXISTS nostr_initial_sync_completed boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_channel_bridges_nostr_connection
      ON channel_bridges(nostr_connection_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_bridges_nostr_channel
      ON channel_bridges(nostr_connection_id, external_id)
      WHERE nostr_connection_id IS NOT NULL;
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
    CREATE INDEX IF NOT EXISTS idx_cursorbuddy_guides_owner ON cursorbuddy_guides(owner_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cursorbuddy_guides_public_match ON cursorbuddy_guides(host, review_status, published_at DESC);

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
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
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
    DELETE FROM agent_schedules WHERE session_id IS NULL;
    ALTER TABLE agent_schedules ALTER COLUMN session_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_schedules_workspace_id ON agent_schedules(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(next_run_at) WHERE enabled;

    CREATE TABLE IF NOT EXISTS agent_schedule_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      schedule_id uuid NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'ok',
      detail text DEFAULT '',
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_schedule ON agent_schedule_runs(schedule_id, created_at desc);
    ALTER TABLE agent_schedule_runs ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE;
    UPDATE agent_schedule_runs run
       SET session_id = schedule.session_id
      FROM agent_schedules schedule
     WHERE schedule.id = run.schedule_id
       AND run.session_id IS NULL;
    DELETE FROM agent_schedule_runs WHERE session_id IS NULL;
    ALTER TABLE agent_schedule_runs ALTER COLUMN session_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_session ON agent_schedule_runs(session_id, created_at desc);
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
    -- A closed conversation is a storage boundary, not a convention every
    -- producer must remember. Messages are written by browser routes, built-in
    -- turns, daemon turns, MCP, huddles, bridges, permissions and automations;
    -- one omitted deleted_at-is-null guard in any of them could otherwise resurrect
    -- a transcript after it was deleted.
    --
    -- INSERT takes a SHARE lock on the live session so it serializes with the
    -- clear route's FOR UPDATE lock. UPDATE already owns the message tuple
    -- before a BEFORE ROW trigger runs; refusing an existing tombstone makes
    -- that tuple lock the serialization point without introducing the inverse
    -- message-row -> session-row lock order on every streaming delta.
    CREATE OR REPLACE FUNCTION messages_require_live_session()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.session_id IS DISTINCT FROM OLD.session_id THEN
          RAISE EXCEPTION 'A message cannot move between conversations'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'messages_live_session_write_guard';
        END IF;
        IF OLD.deleted_at IS NOT NULL THEN
          RAISE EXCEPTION 'A deleted message is immutable'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'messages_live_session_write_guard';
        END IF;
        PERFORM 1
          FROM chat_sessions
         WHERE id = NEW.session_id
           AND deleted_at IS NULL;
      ELSE
        PERFORM 1
          FROM chat_sessions
         WHERE id = NEW.session_id
           AND deleted_at IS NULL
         FOR SHARE;
        IF FOUND THEN
          NEW.created_at = clock_timestamp();
        END IF;
      END IF;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Messages require a live conversation'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'messages_live_session_write_guard';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_messages_require_live_session ON messages;
    CREATE TRIGGER trg_messages_require_live_session
      BEFORE INSERT OR UPDATE ON messages
      FOR EACH ROW EXECUTE FUNCTION messages_require_live_session();
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
    -- Durable per-human queue routing. A task may be created by A and assigned
    -- by B; delayed work must return to B's agent DM, never infer from created_by.
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispatch_requested_by uuid;
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
      -- Safe template intent, not authority. Instantiation still uses the
      -- existing generic agent creation path and its permission guards.
      purpose text NOT NULL DEFAULT 'collaborator'
        CHECK (purpose IN ('collaborator', 'resource')),
      resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (
          jsonb_typeof(resource_facets) = 'array'
          AND resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
        ),
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
      CONSTRAINT workspace_agent_templates_resource_facets_match_purpose CHECK (
        (purpose = 'collaborator' AND resource_facets = '[]'::jsonb)
        OR (purpose = 'resource' AND jsonb_array_length(resource_facets) > 0)
      ),
      UNIQUE (workspace_id, slug)
    );
    ALTER TABLE workspace_agent_templates ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'collaborator'
      CHECK (purpose IN ('collaborator', 'resource'));
    ALTER TABLE workspace_agent_templates ADD COLUMN IF NOT EXISTS resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (
        jsonb_typeof(resource_facets) = 'array'
        AND resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
      );
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'workspace_agent_templates_resource_facets_match_purpose'
           AND conrelid = 'workspace_agent_templates'::regclass
      ) THEN
        ALTER TABLE workspace_agent_templates
          ADD CONSTRAINT workspace_agent_templates_resource_facets_match_purpose CHECK (
            (purpose = 'collaborator' AND resource_facets = '[]'::jsonb)
            OR (purpose = 'resource' AND jsonb_array_length(resource_facets) > 0)
          );
      END IF;
    END
    $$;
    CREATE INDEX IF NOT EXISTS idx_workspace_agent_templates_workspace_id
      ON workspace_agent_templates(workspace_id);

    -- THE AGENT MARKETPLACE. Cross-workspace listings of agents, in two
    -- shapes: 'template' (the persona body travels and is copied through the
    -- existing review-before-instantiate Agents-window form) and 'hire' (the
    -- body stays with the publisher; the hirer gets a Connector roster entry
    -- served by the host's own runtime). Validator: shared/marketplace.cjs.
    -- Routes: server/marketplace-routes.cjs. Deliberately ABSENT from
    -- ALLOWED_TABLES — the dedicated routes are the only doors, so the
    -- validator always runs.
    --
    -- THE ABSENT COLUMNS ARE THE SECURITY CONTROL, same rule as
    -- workspace_agent_templates: no permission_mode ('yolo' is unrestricted
    -- shell on the daemon host), no metadata (host_folders becomes an
    -- --add-dir argument on somebody's actual machine; sandbox_skills names a
    -- baseUrl the server fetches plus a vault credential), no sandbox config,
    -- no connect token, no identity. A listing carries prose and requests; it
    -- never carries authority — and here the artifact crosses TENANT
    -- boundaries, so adding one of those columns later is a security decision,
    -- not a schema tidy-up.
    --
    -- A 'hire' listing additionally carries NO PERSONA BODY AT ALL: the CHECK
    -- below refuses a hire row with non-empty prose columns, so "the hirer
    -- never sees the prompt or skills" is a property of the schema rather
    -- than of a projection some future call site forgets.
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      publisher_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      slug text NOT NULL,
      listing_type text NOT NULL CHECK (listing_type IN ('template', 'hire')),
      name text NOT NULL,
      category text NOT NULL DEFAULT 'Community',
      description text DEFAULT '',
      -- The publisher's own words for what the agent can do — the ONLY detail
      -- a hire listing shows. string[].
      capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
      -- Template body ('template' listings only). Same carried fields as
      -- workspace_agent_templates; tools and skills MUST stay string[] — the
      -- Agents window round-trips skills through a comma-separated input.
      handle_hint text DEFAULT '',
      system_prompt text DEFAULT '',
      soul text DEFAULT '',
      instructions text DEFAULT '',
      tools jsonb NOT NULL DEFAULT '[]'::jsonb,
      skills jsonb NOT NULL DEFAULT '[]'::jsonb,
      purpose text NOT NULL DEFAULT 'collaborator'
        CHECK (purpose IN ('collaborator', 'resource')),
      resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (
          jsonb_typeof(resource_facets) = 'array'
          AND resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
        ),
      model text NOT NULL DEFAULT 'auto',
      run_mode text NOT NULL DEFAULT 'builtin',
      runtime text DEFAULT '',
      avatar text DEFAULT '',
      accent_color text DEFAULT '',
      -- 'hire' only: which host agent serves hires. Never projected to
      -- marketplace browsers; the listing dies with the host agent.
      source_agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE,
      fingerprint text DEFAULT '',
      status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'unlisted')),
      install_count integer NOT NULL DEFAULT 0,
      hire_count integer NOT NULL DEFAULT 0,
      created_by uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      CONSTRAINT marketplace_listings_hire_carries_no_body CHECK (
        listing_type = 'template' OR (
          system_prompt = '' AND soul = '' AND instructions = ''
          AND tools = '[]'::jsonb AND skills = '[]'::jsonb
        )
      ),
      CONSTRAINT marketplace_listings_type_matches_source CHECK (
        (listing_type = 'hire') = (source_agent_id IS NOT NULL)
      ),
      CONSTRAINT marketplace_listings_resource_facets_match_purpose CHECK (
        (purpose = 'collaborator' AND resource_facets = '[]'::jsonb)
        OR (purpose = 'resource' AND jsonb_array_length(resource_facets) > 0)
      ),
      UNIQUE (publisher_workspace_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_marketplace_listings_publisher
      ON marketplace_listings(publisher_workspace_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_listings_type_status
      ON marketplace_listings(listing_type, status);

    -- One workspace hiring one listing. The hired roster row is a Connector
    -- shell (run_mode 'external', no prose, permission_mode 'default')
    -- created by the manage-gated hire route from hiredAgentDraft — never
    -- from caller fields. listing_id survives an unpublish as NULL; the host
    -- ids are a snapshot so the hirer's bookkeeping outlives the host side.
    CREATE TABLE IF NOT EXISTS marketplace_hires (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id uuid REFERENCES marketplace_listings(id) ON DELETE SET NULL,
      hirer_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      hired_agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
      host_workspace_id uuid,
      host_agent_id uuid,
      listing_name text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
      created_by uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (hirer_workspace_id, hired_agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_marketplace_hires_hirer
      ON marketplace_hires(hirer_workspace_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_hires_listing
      ON marketplace_hires(listing_id);

    -- WORKSPACE-AUTHORED SKILLS. The app-side skill store.
    --
    -- Before this table, agent_skill_documents (above) was the only place a
    -- skill BODY could live, and it is daemon-owned: written by an
    -- agent_skill_sync push, keyed per agent, read-only in-app, and absent from
    -- ALLOWED_TABLES entirely. Nothing in the browser could write a skill, so
    -- two shipped features were bent around the hole — Suggestions accepted a
    -- proposed skill as a Document in a "Skills" folder, and an agent
    -- template's skills list exported NAMES that resolved to nothing.
    --
    -- SYNC DIRECTION IS UNCHANGED, DELIBERATELY. Skills still flow UP from
    -- daemons into agent_skill_documents. Nothing here flows DOWN onto anyone's
    -- disk: an app-side row that wrote a file onto a user's machine would be a
    -- strictly larger authority than any daemon has today, and the same
    -- category as host_folders -> --add-dir, which is MANAGE_ONLY. Agents
    -- reach these bodies at turn time through the read_skill MCP tool, which
    -- already existed, already fences a body as untrusted data, and already
    -- reads STORED content — so a skill stays readable when no daemon is up.
    --
    -- THE ABSENT COLUMNS ARE THE SECURITY CONTROL, and adding one later is a
    -- security decision rather than a schema tidy-up. There is deliberately no
    -- base_url, no credential, no endpoints, no mcp, no code, no path, no
    -- agent_id, no tools and no permission_mode. A workspace skill carries
    -- PROSE; it never carries AUTHORITY. The privilege-bearing skill shape
    -- already has a home — workspace_agents.metadata.sandbox_skills, which is
    -- MANAGE_ONLY for precisely the reason those fields are absent here: a
    -- base_url is a host THE SERVER FETCHES with a stored credential attached.
    -- See shared/workspaceSkills.cjs for the validator and the role argument.
    CREATE TABLE IF NOT EXISTS workspace_skills (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      -- agentskills.io's name rule (lowercase, digits, single hyphens, <= 64):
      -- this value is the lookup key for read_skill, the folder name if the
      -- skill is ever exported, and an element of a template's skills array.
      name text NOT NULL,
      title text NOT NULL,
      summary text DEFAULT '',
      -- Capped at 64 KiB by the validator, matching SKILL_CONTENT_MAX_BYTES in
      -- server/skill-content.cjs: the body is read back through the same loader
      -- that caps a daemon document, so a bigger one would only be truncated.
      body text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      -- 'authored' (typed here), 'suggested' (accepted from a thread harvest),
      -- 'imported' (crossed a workspace boundary). Provenance, so "where did
      -- this procedure come from" has an answer when an agent follows it.
      source text NOT NULL DEFAULT 'authored',
      origin jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (workspace_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_skills_workspace_id
      ON workspace_skills(workspace_id);

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
 // Read receipts: one MONOTONIC high-water mark per (session, user) — "I had
 // this conversation on screen up to this point" — plus the reciprocal per-user
 // opt-out that gates both writing one and reading anyone else's.
 //
 // NOT a row per message per user: that model grows with message volume times
 // workspace size and is written on every scroll, where this one is bounded by
 // (members x sessions) and coalesces a page of scrolling into a single write.
 // It is also the more private of the two — it cannot record which SPECIFIC
 // message was read, only how far.
 //
 // There is deliberately NO workspace_id column; see shared/read-receipts.cjs
 // for why that absence is what makes a DM's read state unsubscribable by a
 // non-member. The DDL itself is single-sourced there so the three schema
 // places (this file, database/neon-schema.sql, supabase/migrations/) cannot
 // drift in shape, only in whether they have run.
 //
 // Comments stay OUT of the SQL string, same reason as the block below: several
 // tests mock the DB and classify a bootstrap statement by its first keyword.
 // Table + the in-place upgrade to agent-capable read state, one statement per
 // db.unsafe() (see ensureSessionReadStateShape — a multi-statement string throws
 // on the extended protocol and would kill boot before the server listens).
 await ensureSessionReadStateShape(db);
 await db.unsafe(SHARE_READ_RECEIPTS_DDL);
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

    -- The ONE join link: a single URL a human, Connector agent, or named
    -- workspace controller can redeem. It provisions the real credential
    -- server-side and returns a machine credential exactly once.
    -- (Deliberately kept inside THIS statement block rather than opening a new
    -- db.unsafe: a block whose text begins with a comment breaks every strict
    -- mock database in tests/, all of which dispatch on the leading keyword.)
    --
    -- Deliberately a separate table from workspace_invites rather than more
    -- columns on it, because the two have opposite security properties and
    -- merging them would have meant one row type with two lifetimes:
    --   * workspace_invites is the legacy human-accept record and may live for
    --     14 DAYS. It is NOT an MCP credential.
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
      grant_kind text NOT NULL DEFAULT 'individual' CHECK (grant_kind IN ('individual', 'workspace_control')),
      audience text NOT NULL DEFAULT 'both' CHECK (audience IN ('both', 'human', 'agent', 'controller')),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed', 'revoked')),
      redeemed_as text NOT NULL DEFAULT '' CHECK (redeemed_as IN ('', 'human', 'agent', 'controller')),
      redeemed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      redeemed_agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      redeemed_controller_id uuid,
      controller_name text NOT NULL DEFAULT '',
      controller_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      controller_expires_at timestamptz,
      redeemed_at timestamptz,
      expires_at timestamptz NOT NULL,
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      CONSTRAINT workspace_join_links_controller_shape_check CHECK (
        (
          grant_kind = 'individual'
          AND audience IN ('both', 'human', 'agent')
          AND controller_name = ''
          AND controller_scopes = '[]'::jsonb
          AND controller_expires_at IS NULL
        )
        OR
        (
          grant_kind = 'workspace_control'
          AND audience = 'controller'
          AND btrim(controller_name) <> ''
          AND jsonb_typeof(controller_scopes) = 'array'
          AND jsonb_array_length(controller_scopes) > 0
          AND controller_scopes <@ '["agents:register", "agents:manage_own", "resources:create", "resources:manage_own"]'::jsonb
          AND controller_expires_at IS NOT NULL
        )
      )
    );
    ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS grant_kind text NOT NULL DEFAULT 'individual';
    ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS controller_name text NOT NULL DEFAULT '';
    ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS controller_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS controller_expires_at timestamptz;
    ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS redeemed_controller_id uuid;
    ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_grant_kind_check;
    ALTER TABLE workspace_join_links
      ADD CONSTRAINT workspace_join_links_grant_kind_check
      CHECK (grant_kind IN ('individual', 'workspace_control'));
    ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_audience_check;
    ALTER TABLE workspace_join_links
      ADD CONSTRAINT workspace_join_links_audience_check
      CHECK (audience IN ('both', 'human', 'agent', 'controller'));
    ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_redeemed_as_check;
    ALTER TABLE workspace_join_links
      ADD CONSTRAINT workspace_join_links_redeemed_as_check
      CHECK (redeemed_as IN ('', 'human', 'agent', 'controller'));
    ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_controller_shape_check;
    ALTER TABLE workspace_join_links
      ADD CONSTRAINT workspace_join_links_controller_shape_check CHECK (
        (
          grant_kind = 'individual'
          AND audience IN ('both', 'human', 'agent')
          AND controller_name = ''
          AND controller_scopes = '[]'::jsonb
          AND controller_expires_at IS NULL
        )
        OR
        (
          grant_kind = 'workspace_control'
          AND audience = 'controller'
          AND btrim(controller_name) <> ''
          AND jsonb_typeof(controller_scopes) = 'array'
          AND jsonb_array_length(controller_scopes) > 0
          AND controller_scopes <@ '["agents:register", "agents:manage_own", "resources:create", "resources:manage_own"]'::jsonb
          AND controller_expires_at IS NOT NULL
        )
      );
    CREATE INDEX IF NOT EXISTS idx_workspace_join_links_workspace_id ON workspace_join_links(workspace_id, created_at DESC);

    -- Named workspace-control credentials. Unlike the legacy agw_ bearer, an
    -- agc_ credential is individually attributable, expiring, revocable, and
    -- limited to this closed scope set.
    CREATE TABLE IF NOT EXISTS workspace_controllers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        jsonb_typeof(scopes) = 'array'
        AND jsonb_array_length(scopes) > 0
        AND scopes <@ '["agents:register", "agents:manage_own", "resources:create", "resources:manage_own"]'::jsonb
      ),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      parent_controller_id uuid REFERENCES workspace_controllers(id) ON DELETE SET NULL,
      expires_at timestamptz NOT NULL,
      last_used_at timestamptz,
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_controllers_workspace
      ON workspace_controllers(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workspace_controllers_parent
      ON workspace_controllers(parent_controller_id);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_join_links_redeemed_controller_id_fkey'
      ) THEN
        ALTER TABLE workspace_join_links
          ADD CONSTRAINT workspace_join_links_redeemed_controller_id_fkey
          FOREIGN KEY (redeemed_controller_id) REFERENCES workspace_controllers(id) ON DELETE SET NULL;
      END IF;
    END $$;

    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS controller_id uuid;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_agents_controller_id_fkey'
      ) THEN
        ALTER TABLE workspace_agents
          ADD CONSTRAINT workspace_agents_controller_id_fkey
          FOREIGN KEY (controller_id) REFERENCES workspace_controllers(id) ON DELETE SET NULL;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_workspace_agents_controller_id ON workspace_agents(controller_id);

    -- Agent-stewarded resources and retry-safe, fenced operations. Both tables
    -- stay outside generic DB/realtime allowlists; callers receive explicit
    -- projections only from dedicated routes and MCP tools.
    CREATE TABLE IF NOT EXISTS workspace_resources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      steward_agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE RESTRICT,
      controller_id uuid REFERENCES workspace_controllers(id) ON DELETE SET NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      facet text NOT NULL CHECK (facet IN ('context', 'knowledge', 'tooling', 'code')),
      descriptor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(descriptor) = 'object'),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'restricted')),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      deleted_at timestamptz,
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE workspace_resources ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    CREATE INDEX IF NOT EXISTS idx_workspace_resources_deleted
      ON workspace_resources(workspace_id, deleted_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workspace_resources_workspace
      ON workspace_resources(workspace_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workspace_resources_steward
      ON workspace_resources(steward_agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_workspace_resources_controller
      ON workspace_resources(controller_id);

    CREATE TABLE IF NOT EXISTS resource_operations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      resource_id uuid NOT NULL REFERENCES workspace_resources(id) ON DELETE CASCADE,
      steward_agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE RESTRICT,
      requested_by_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
      requested_by_agent_id uuid REFERENCES workspace_agents(id) ON DELETE RESTRICT,
      requested_by_controller_id uuid REFERENCES workspace_controllers(id) ON DELETE RESTRICT,
      requested_by_workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
      requester_key text NOT NULL,
      claimed_by_agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      operation text NOT NULL CHECK (operation IN ('read', 'propose', 'apply', 'publish')),
      input_artifact jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_artifact) = 'object'),
      output_artifact jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output_artifact) = 'object'),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed', 'completed', 'rejected', 'failed', 'cancelled')),
      resource_version integer NOT NULL CHECK (resource_version > 0),
      idempotency_key text NOT NULL,
      attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
      lease_expires_at timestamptz,
      error text NOT NULL DEFAULT '',
      progress jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object'),
      progress_seq bigint NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
      progress_updated_at timestamptz,
      audit_reference uuid REFERENCES audit_log(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT resource_operations_one_requester_check CHECK (
        num_nonnulls(requested_by_user_id, requested_by_agent_id, requested_by_controller_id, requested_by_workspace_id) = 1
      ),
      UNIQUE (workspace_id, requester_key, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_resource_operations_resource
      ON resource_operations(resource_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_resource_operations_claim
      ON resource_operations(steward_agent_id, status, created_at);

ALTER TABLE resource_operations ADD COLUMN IF NOT EXISTS requested_by_workspace_id uuid;
ALTER TABLE resource_operations ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE resource_operations ADD COLUMN IF NOT EXISTS progress_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE resource_operations ADD COLUMN IF NOT EXISTS progress_updated_at timestamptz;
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_progress_object_check;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_progress_object_check CHECK (jsonb_typeof(progress) = 'object');
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_progress_seq_check;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_progress_seq_check CHECK (progress_seq >= 0);
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_one_requester_check;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_one_requester_check CHECK (
  num_nonnulls(requested_by_user_id, requested_by_agent_id, requested_by_controller_id, requested_by_workspace_id) = 1
);
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_requested_by_user_id_fkey;
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_requested_by_agent_id_fkey;
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_requested_by_controller_id_fkey;
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_requested_by_workspace_id_fkey;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_requested_by_user_id_fkey
  FOREIGN KEY (requested_by_user_id) REFERENCES app_users(id) ON DELETE RESTRICT;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_requested_by_agent_id_fkey
  FOREIGN KEY (requested_by_agent_id) REFERENCES workspace_agents(id) ON DELETE RESTRICT;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_requested_by_controller_id_fkey
  FOREIGN KEY (requested_by_controller_id) REFERENCES workspace_controllers(id) ON DELETE RESTRICT;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_requested_by_workspace_id_fkey
  FOREIGN KEY (requested_by_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;

    -- MCP workspace control-plane bearer. The singleton workspace token (or a
    -- separately verified login/OAuth identity) may call register_agent to become
    -- an agent, new or existing. Legacy invite and join-link URLs authenticate only
    -- at their dedicated redemption routes, never at the MCP door.
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_token_hash text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_auto_approve boolean NOT NULL DEFAULT false;
    -- MCP OAuth 2.1 (authorization-code + PKCE). Additive to the existing
    -- agent, Flow, controller, workspace, and login-token bearer paths.
    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id text NOT NULL UNIQUE,
      client_secret_hash text NOT NULL DEFAULT '',
      workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT '',
      token_endpoint_auth_method text NOT NULL DEFAULT 'none',
      redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
      scopes jsonb NOT NULL DEFAULT '["mcp:tools"]'::jsonb,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_workspace
      ON mcp_oauth_clients(workspace_id) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS mcp_oauth_client_grants (
      client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      granted_by uuid,
      granted_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      PRIMARY KEY (client_id, workspace_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_client_grants_workspace
      ON mcp_oauth_client_grants(workspace_id) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      code_hash text PRIMARY KEY,
      client_id text NOT NULL,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      redirect_uri text NOT NULL,
      code_challenge text NOT NULL,
      code_challenge_method text NOT NULL DEFAULT 'S256',
      scopes jsonb NOT NULL DEFAULT '["mcp:tools"]'::jsonb,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_client ON mcp_oauth_codes(client_id);
    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      token_hash text PRIMARY KEY,
      client_id text NOT NULL,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id uuid,
      scopes jsonb NOT NULL DEFAULT '["mcp:tools"]'::jsonb,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_workspace
      ON mcp_oauth_tokens(workspace_id) WHERE revoked_at IS NULL;
    INSERT INTO mcp_oauth_client_grants (client_id, workspace_id, granted_by)
      SELECT client_id, workspace_id, created_by
        FROM mcp_oauth_clients
       WHERE workspace_id IS NOT NULL
      UNION
      SELECT client_id, workspace_id, user_id FROM mcp_oauth_codes
      UNION
      SELECT client_id, workspace_id, user_id FROM mcp_oauth_tokens
      ON CONFLICT (client_id, workspace_id) DO NOTHING;
    -- An agent becomes claimable over MCP once its registration is approved.
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS mcp_approved boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS agent_registrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      controller_id uuid REFERENCES workspace_controllers(id) ON DELETE SET NULL,
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
    ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS controller_id uuid;
    ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_purpose text NOT NULL DEFAULT 'collaborator';
    ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE agent_registrations DROP CONSTRAINT IF EXISTS agent_registrations_requested_purpose_check;
    ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_requested_purpose_check
      CHECK (requested_purpose IN ('collaborator', 'resource'));
    ALTER TABLE agent_registrations DROP CONSTRAINT IF EXISTS agent_registrations_requested_resource_facets_check;
    ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_requested_resource_facets_check CHECK (
      jsonb_typeof(requested_resource_facets) = 'array'
      AND requested_resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
    );
    ALTER TABLE agent_registrations DROP CONSTRAINT IF EXISTS agent_registrations_resource_facets_match_purpose;
    ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_resource_facets_match_purpose CHECK (
      (requested_purpose = 'collaborator' AND requested_resource_facets = '[]'::jsonb)
      OR (requested_purpose = 'resource' AND jsonb_array_length(requested_resource_facets) > 0)
    );
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_registrations_controller_id_fkey'
      ) THEN
        ALTER TABLE agent_registrations
          ADD CONSTRAINT agent_registrations_controller_id_fkey
          FOREIGN KEY (controller_id) REFERENCES workspace_controllers(id) ON DELETE SET NULL;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_agent_registrations_workspace ON agent_registrations(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_registrations_controller ON agent_registrations(controller_id, status);
    -- Controller ids are attribution, not authority, but they must never point
    -- across tenants. The single-column FKs above cannot express that.
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_controllers_id_workspace_key') THEN
        ALTER TABLE workspace_controllers ADD CONSTRAINT workspace_controllers_id_workspace_key UNIQUE (id, workspace_id);
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_controllers_parent_workspace_fkey'
          AND confdeltype = 'n' AND confdelsetcols IS NULL
      ) THEN
        ALTER TABLE workspace_controllers DROP CONSTRAINT workspace_controllers_parent_workspace_fkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_controllers_parent_workspace_fkey') THEN
        ALTER TABLE workspace_controllers ADD CONSTRAINT workspace_controllers_parent_workspace_fkey
          FOREIGN KEY (parent_controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (parent_controller_id);
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_agents_controller_workspace_fkey'
          AND confdeltype = 'n' AND confdelsetcols IS NULL
      ) THEN
        ALTER TABLE workspace_agents DROP CONSTRAINT workspace_agents_controller_workspace_fkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_agents_controller_workspace_fkey') THEN
        ALTER TABLE workspace_agents ADD CONSTRAINT workspace_agents_controller_workspace_fkey
          FOREIGN KEY (controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (controller_id);
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_resources_controller_workspace_fkey'
          AND confdeltype = 'n' AND confdelsetcols IS NULL
      ) THEN
        ALTER TABLE workspace_resources DROP CONSTRAINT workspace_resources_controller_workspace_fkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_resources_controller_workspace_fkey') THEN
        ALTER TABLE workspace_resources ADD CONSTRAINT workspace_resources_controller_workspace_fkey
          FOREIGN KEY (controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (controller_id);
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_registrations_controller_workspace_fkey'
          AND confdeltype = 'n' AND confdelsetcols IS NULL
      ) THEN
        ALTER TABLE agent_registrations DROP CONSTRAINT agent_registrations_controller_workspace_fkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_registrations_controller_workspace_fkey') THEN
        ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_controller_workspace_fkey
          FOREIGN KEY (controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (controller_id);
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_join_links_redeemed_controller_workspace_fkey'
          AND confdeltype = 'n' AND confdelsetcols IS NULL
      ) THEN
        ALTER TABLE workspace_join_links DROP CONSTRAINT workspace_join_links_redeemed_controller_workspace_fkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_join_links_redeemed_controller_workspace_fkey') THEN
        ALTER TABLE workspace_join_links ADD CONSTRAINT workspace_join_links_redeemed_controller_workspace_fkey
          FOREIGN KEY (redeemed_controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (redeemed_controller_id);
      END IF;
    END $$;
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
 //
 // 'automation' joined it for the automations `create_task` action. Widening a
 // CHECK is safe on a populated table BECAUSE IT ONLY ADDS a permitted value —
 // every existing row already satisfies the wider predicate, so the validation
 // scan Postgres runs on ADD CONSTRAINT cannot fail. Narrowing this list later
 // is the dangerous direction and would need a data migration first.
 await db.unsafe(`
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_system ON workspaces (is_system) WHERE is_system;

    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_source_type_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_source_type_check
      CHECK (source_type IN ('manual', 'chat', 'document', 'canvas', 'ai', 'feedback', 'automation'));

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
 // A workspace is the ACCOUNT and its channels are the projects. Grouping is
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
// Keyed per (user, message), not per user: toggling one reaction on and off
// repeatedly is the abusive shape, and each accepted write rebroadcasts the
// whole message row to every socket in the session. 30/min leaves a decisive
// human far more headroom than they will ever use on ONE message while bounding
// a stuck button.
const reactionRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
// Keyed per (user, session). RECEIPT_REARM_MS in src/lib/readReceipts.ts already
// holds a well-behaved client to ~20 writes/minute per conversation; this is the
// floor under one that does not.
const readReceiptRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
// Keyed per (user, job). Stopping is idempotent and cheap, so this only has to
// bound a stuck button — a person legitimately halting several runaway agents
// at once is the exact moment the feature exists for and must not be throttled.
const agentJobCancelRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
// Bridge deliveries are machine traffic and legitimately bursty — a busy Slack
// channel or a Telegram group mid-argument outruns a human webhook by a lot.
const bridgeRateLimiter = createRateLimiter({ windowMs: 60_000, max: 600 });
const mcpRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
// Dynamic OAuth client registration is unauthenticated and creates durable
// rows, so it has its own smaller per-IP budget rather than sharing MCP calls.
const mcpOauthDcrRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
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
// Resource requests can enqueue durable work for a steward agent. Bound the
// authenticated human surface independently from generic DB traffic so a stuck
// UI cannot produce an unbounded operation queue.
const resourceOperationRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
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
// Guide resolution is public because the extension has no Agensis session on
// arbitrary sites. Keep one shared budget for public reads and authenticated
// library writes; 120/minute is comfortably above normal navigation.
const cursorBuddyGuidesRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
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
const cursorBuddyGuidesDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 120, db: dbQuery, namespace: 'cursorbuddy-guides' });
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
// 14-day legacy human invite pasted into one remains redeemable by a human for
// that window. The same paste of a join link is, fifteen minutes later, a dead
// string, and neither link authenticates at the MCP endpoint.
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
  `select l.id, l.workspace_id, l.role, l.label, l.grant_kind, l.audience,
            l.controller_name, l.controller_scopes, l.controller_expires_at,
            l.expires_at,
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
async function uniqueAgentHandle(workspaceId, desired, database = getDb()) {
 const base = slugHandle(desired) || 'agent';
 const rows = await database.unsafe(
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
  // Server-computed role for the authenticated caller (`owner` when
  // workspaces.user_id matches). Settings → Connections gates the MCP
  // credential on this — not on a client-side user_id compare against a
  // field this projection used to omit, which made the tab look blank for
  // the actual owner.
  role: row.role || 'viewer',
  // Present when the SELECT includes it (generic /backend/db path). The list
  // route may omit it and rely on `role` alone.
  user_id: row.user_id || null,
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

// An ACP harness runs its OWN model. A Claude or Codex id means nothing to it,
// and forcing one is how a Grok agent ended up launched with
// `--model claude-opus-5` and then describing itself as Claude and listing
// Claude models as its own.
//
// The harness is pinned on the agent's metadata as `acp_harness`, which is a
// SEPARATE axis from the claude|codex|amp execution runtime — the agents that
// hit this had acp_harness set and runtime unset, so normalizeExecutionRuntime
// returned '' and every one of them fell through to resolveAnthropicModel.
//
// A harness absent from this table still works: it simply takes no --model and
// lets the local harness choose, which is the honest default (the same choice
// Amp already makes) rather than inventing a model id we cannot verify.
//
// Grok default is intentionally EMPTY. Forcing `grok-4.5` looked right on paper
// (it is the public id and Grok Build's default) but broke real hosts when the
// plan/tier or local CLI config did not accept that exact id. Empty means
// "omit --model" so the local Grok CLI uses its own config.
const ACP_HARNESS_MODELS = {
 grok: {
  default: '',
  owns: /^grok([.-]|$)|^grok-build/i,
 },
};

function acpHarnessOf(metadata) {
 const harness = String(metadata?.acp_harness || metadata?.acpHarness || '').trim().toLowerCase();
 // claude/codex/amp are execution runtimes with their own model handling.
 return harness && harness !== 'claude' && harness !== 'codex' && harness !== 'amp' ? harness : '';
}

/** The model a harness-pinned agent should actually run. '' means "send no --model". */
function resolveAcpHarnessModel(harness, model) {
 const spec = ACP_HARNESS_MODELS[String(harness || '').trim().toLowerCase()] || null;
 const value = String(model || '').trim();
 if (!value || value === 'auto') return spec ? (spec.default || '') : '';
 // An id the harness plainly does not own is a leftover default, not a choice a
 // human made — every one of these agents was carrying claude-opus-5. Drop it
 // rather than inventing a different inaccessible id (the old bug was forcing
 // grok-4.5 onto accounts that could not use it).
 if (spec) return spec.owns.test(value) ? value : (spec.default || '');
 return /^(claude|gpt)[-.]/i.test(value) ? '' : value;
}

function agentConnectionCommand({ baseUrl, token, workspaceId, agentId, handle, name, model, permissionMode, runtime = null, acpHarness = null, profile = null }) {
 const resolvedRuntime = normalizeExecutionRuntime(runtime);
 const harness = String(acpHarness || '').trim().toLowerCase();
 const resolvedModel = harness
  ? resolveAcpHarnessModel(harness, model)
  : resolveExecutionModel(model, resolvedRuntime);
 const resolvedPermissionMode = normalizeAgentPermissionMode(permissionMode);
 const commandPermissionArgs = ['--permission-mode', shellQuote(resolvedPermissionMode)];
 // No model at all when the harness owns that choice and we have no id we can
 // stand behind — better than shipping a Claude id to something that is not Claude.
 const commandModelArgs = !resolvedModel
  || resolvedRuntime === 'amp'
  || (resolvedRuntime === 'codex' && resolvedModel === 'auto')
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

// Mint a Relay connect token for an agent and return the full connect payload
// (command + one-time token + resolved settings). Shared by the HTTP
// connection-command route and the MCP `get_connect_command` tool so the two can
// never drift. Side effects: ROTATES the agent's connect token (any running Relay
// host must be restarted with the new one) and flips run_mode to 'daemon' (Relay)
// so a linked host takes over from Direct (builtin). Authorization is the caller's
// responsibility (HTTP route enforces manage role; MCP scopes by workspace token).
// `actorUserId` is threaded in by every caller that has a verified session, for
// the audit row at the end. It is recorded HERE rather than at the four call
// sites so a new way to mint a token cannot ship without an audit row — an
// unattributed mint ('' actor) is still a recorded mint, which is the property
// that matters. Note the connect token itself is minted in this function and is
// never, anywhere below, put in the audit row.
function publicAgentConnectionCommandAgent(row) {
 if (!row || typeof row !== 'object') return null;
 return {
  id: row.id || null,
  workspace_id: row.workspace_id || null,
  name: row.name || '',
  handle: row.handle || '',
  model: row.model || null,
  run_mode: row.run_mode || null,
  permission_mode: row.permission_mode || 'default',
  enabled: row.enabled !== false,
  mcp_approved: row.mcp_approved === true,
  purpose: row.purpose === 'resource' ? 'resource' : 'collaborator',
  resource_facets: parseJsonArray(row.resource_facets),
  controller_id: row.controller_id || null,
 };
}

async function buildAgentConnectionCommand({
 agentId,
 workspaceId = null,
 handle = null,
 model = null,
 permissionMode = null,
 baseUrl = null,
 profile = null,
 actorUserId = null,
 actorControllerId = null,
 // True only when the caller already proved manage (HTTP connection-command,
 // MCP user/workspace after role check). Without this, an explicit
 // permissionMode is IGNORED and the stored agent mode is kept — so a
 // compromised agent connect token cannot escalate itself to yolo by re-minting.
 allowPermissionModeChange = false,
} = {}) {
 const id = String(agentId || '').trim();
 if (!id) throw new Error('agentId is required');
 const rows = await getDb().unsafe('select * from workspace_agents where id = $1 limit 1', [id]);
 const agent = rows[0];
 if (!agent) throw new Error('Agent not found');
 if (workspaceId && agent.workspace_id !== workspaceId) throw new Error('Agent is not in this workspace');
 if (!isAgentEnabled(agent)) throw new Error('Agent is deactivated');
 const token = createAgentConnectToken();
 const resolvedHandle = slugHandle(handle || agent.handle || agent.name);
 const agentMetadata = parseJsonObject(agent.metadata);
 const resolvedRuntime = normalizeExecutionRuntime(agentMetadata.runtime);
 // A harness-pinned agent (acp_harness) resolves its model from the harness, not
 // from the Anthropic catalog — otherwise the minted command, and the model
 // written back to the row below, both say claude-opus-5 for a Grok agent.
 const resolvedAcpHarness = acpHarnessOf(agentMetadata);
 const resolvedModel = resolvedAcpHarness
  ? resolveAcpHarnessModel(resolvedAcpHarness, model || agent.model)
  : resolveExecutionModel(model || agent.model, resolvedRuntime);
 // Mode changes are manage-gated. Minting a connect token is NOT by itself a
 // mode grant: only an explicit override when allowPermissionModeChange is true
 // (caller already proved manage) may change permission_mode. actorUserId is for
 // audit attribution only — it must NEVER open the mode gate by itself (a
 // cursorbuddy key minter id or setup session is not a mode grant).
 const modeOverrideAllowed = allowPermissionModeChange === true;
 const wantsMode = typeof permissionMode === 'string' && permissionMode.trim();
 const resolvedPermissionMode = (modeOverrideAllowed && wantsMode)
  ? normalizeAgentPermissionMode(permissionMode)
  : normalizeAgentPermissionMode(agent.permission_mode);
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
 const updatedAgent = updateRows[0];
 if (!updatedAgent) throw new Error('Agent could not be updated for connection');
 notifyDbSubscribers('workspace_agents', 'UPDATE', updateRows);
 // A connect token is a real credential: it is the daemon's whole identity.
 // permission_mode is rewritten to the resolved mode (stored, or manage-proven
 // override). Recorded: the agent, its handle, and the RESULTING mode.
 // Never recorded: the token, and never its hash either.
 await recordAudit({
  workspaceId: agent.workspace_id ? String(agent.workspace_id) : null,
  actor: {
   userId: actorUserId ? String(actorUserId) : '',
   label: actorControllerId ? 'controller:' + String(actorControllerId) : '',
  },
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
  acpHarness: resolvedAcpHarness,
  profile: profile === null ? resolvedHandle : profile,
 });
 return {
  // This response is copied into MCP transcripts and browser state. Never
  // return the raw workspace_agents row: it contains connect_token_hash,
  // metadata (host folders/skills), sandbox configuration, identity, and
  // memory paths that are server-only even when the caller is a controller.
  agent: publicAgentConnectionCommandAgent(updatedAgent),
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
  `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, identity, metadata, model, handle, run_mode, sandbox_provider, sandbox_config, memory_dir, permission_mode, version, enabled, created_by
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
    `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, identity, metadata, model, handle, run_mode, sandbox_provider, sandbox_config, memory_dir, permission_mode, version, enabled, created_by
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

// The one workspace MCP token (issued in settings). Authenticates any client into the
// workspace; the client then registers as an agent (popup approval unless auto-approve).
async function verifyWorkspaceMcpToken(token) {
 if (!token || typeof token !== 'string') return null;
 const rows = await getDb().unsafe(
  `select id, mcp_auto_approve from workspaces where mcp_token_hash = $1 and mcp_token_hash <> '' limit 1`,
  [hashAgentToken(token)],
 );
 const ws = rows[0];
 if (!ws) return null;
 return {
  kind: 'workspace',
  workspaceId: ws.id,
  name: 'MCP client',
  autoApprove: Boolean(ws.mcp_auto_approve),
 };
}

async function verifyControllerToken(token) {
 return verifyScopedControllerToken({ db: getDb(), token });
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

// The MCP endpoint accepts, in priority order: a per-agent connect token (acts AS
// that agent), a Flow token, a scoped controller token, the singleton workspace
// token, an OAuth access token, or the user's agensis login. Workspace/user OAuth
// identities retain their existing kinds and pass through the same tool
// authorization chokepoint. Legacy workspace_invites and workspace_join_links
// deliberately do not authenticate here.
let _mcpOauthStore = null;
function getMcpOauthStore() {
 if (!_mcpOauthStore) {
  _mcpOauthStore = createMcpOauthStore({ getDb, hashAgentToken });
 }
 return _mcpOauthStore;
}

async function verifyOauthAccessToken(token) {
 if (!mcpOauthShared.isOauthAccessToken(token)) return null;
 try {
  return await getMcpOauthStore().verifyAccessToken(token);
 } catch {
  return null;
 }
}

async function verifyMcpToken(token, req = null) {
 return (await verifyAgentConnectToken(token, req))
  || (await verifyFlowConnectionToken(token))
  || (await verifyControllerToken(token))
  || (await verifyWorkspaceMcpToken(token))
  || (await verifyOauthAccessToken(token))
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
 const metadata = parseJsonObject(agent.metadata);
 const runtime = normalizeExecutionRuntime(metadata.runtime);
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
  purpose: agent.purpose === 'resource' ? 'resource' : 'collaborator',
  resource_facets: agent.purpose === 'resource'
   ? parseJsonArray(agent.resource_facets).filter((facet) => ['context', 'knowledge', 'tooling', 'code'].includes(facet))
   : [],
  metadata: parseJsonObject(agent.metadata),
  // { voice, human_set } — see shared/agentIdentity.cjs. Every explicit
  // workspace_agents select above lists `identity` too; a column left out of
  // one of them reads blank in exactly one screen, which is how host_folders
  // and canvas_id each got shipped broken.
  identity: parseJsonObject(agent.identity),
  model: resolveExecutionModel(agent.model, runtime),
  run_mode: normalizeAgentRunMode(agent.run_mode),
  sandbox_provider: agent.sandbox_provider || null,
  sandbox_config: parseJsonObject(agent.sandbox_config),
  permissionMode,
  permission_mode: permissionMode,
  permissionFlags: agentPermissionFlags(permissionMode),
  version: Number(agent.version || 0),
  enabled: isAgentEnabled(agent),
  // Fail-open, like the reader in shared/ambientAddressing.cjs: a row from
  // before the column existed must not read as "opted out of ambient replies".
  ambient_replies: ambientRepliesEnabled(agent),
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
   `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, purpose, resource_facets, identity, model, handle, run_mode, sandbox_provider, sandbox_config, memory_dir, permission_mode, metadata, version, enabled, ambient_replies, created_by
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
   `select id, workspace_id, title, model, folder, description, icon, intent, is_favorite, participants, conversation_mode, max_agent_turns, auto_rounds, parent_message_id, split_parent_id, split_at, split_baseline_message_id, split_source_boundary_message_id, archived_at, deleted_at, canvas_id, visibility, version, created_at, updated_at
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

 // Same live-socket reconcile as GET /backend/agents/connections. The DB column
 // alone lies after a process restart or when the daemon is registered on a
 // different backend instance than the one serving this bootstrap: status stays
 // 'online' in Neon while no socket exists here. Painting that as green, then
 // flipping offline when the connections poll reconciles, is the "refresh → green
 // for ~10s → offline" flash. Fail closed: no live socket ⇒ offline in the
 // snapshot too.
 const connections = connectionRows.map((row) => {
  const connection = publicAgentConnection(row);
  if (
   (connection.status === 'online' || connection.status === 'busy')
   && !isConnectionSocketLive(connection.id)
  ) {
   return { ...connection, status: 'offline' };
  }
  return connection;
 });

 return {
  workspace: workspaceRows[0] ? publicWorkspace(workspaceRows[0]) : null,
  agents: agentRows.map(agentRuntimePayload),
  sessions: sessionRows,
  documents: documentRows,
  tasks: taskRows,
  files: fileRows,
  connections,
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
 // none of these branches selects from `messages`. Activity events predate
 // session attribution and deliberately retain their legacy workspace-visible
 // rows. An agent job is different: it is conversation work when it reaches
 // this human inbox, so no provable session means no row.
 //
 // Joined on ::text rather than casting the metadata value to uuid: that column
 // is free-form jsonb and a non-uuid string in it would turn a bad row into a
 // query-wide 500 instead of one hidden item.
 const sessionVisible = (expr, alias) =>
  `(${expr} is not null and ${expr} <> '' and exists (
      select 1 from chat_sessions ${alias}
       where ${alias}.id::text = ${expr} and ${sessionReadableSql(alias, '$2')}
    ))`;
 const sessionVisibleOrUnscoped = (expr, alias) =>
  `(${expr} is null or ${expr} = '' or ${sessionVisible(expr, alias)})`;
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
           and ${sessionVisibleOrUnscoped(`nullif(ae.metadata->>'session_id', '')`, 'cs_ae')}
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
// A human message that arrives while the agent it is addressed to is mid-turn
// used to be DROPPED: continueConversation returned { reason: 'agent_busy' } and
// nothing ever retried it. In a channel that is survivable — someone else
// answers. In a DM it is silent data loss, because every thread of one DM shares
// ONE chat_session and therefore ONE active-job slot
// (uq_agent_jobs_active_per_session_agent, index.cjs ~2769). Ask a question in a
// second thread while the agent works in the first and it was never answered at
// all. Observed live 2026-08-03 in three sessions; in the worst case a human
// waited 32 minutes and re-asked before learning the work was already done.
//
// So the turn is PARKED here instead of dropped, and replayed the instant that
// agent's job reaches a terminal state (every such path already calls
// scheduleTaskQueueDrain; the replay hooks the same sites). Keyed by
// (session, agent) because that is exactly the scope of the slot blocking it.
//
// In-process, like conversationLocks: a parked turn is a best-effort retry, not
// a durable promise. Losing one on restart is the pre-fix behaviour, so the
// existing single-machine assumption (reconcileAgentConnectionsAtStartup) is not
// made any weaker by this.
const pendingChatTurns = new Map();
// Long enough to outlive the 30-minute hard ceiling would be wrong: replaying a
// turn a human has given up on is its own bug. 15 minutes covers an idle_timeout
// (10) plus slack, and anything staler is dropped on read.
const PENDING_CHAT_TURN_MAX_AGE_MS = 15 * 60_000;
// A replay that is itself refused re-parks. The cap stops a permanently-busy
// agent from turning one message into an unbounded retry loop.
const PENDING_CHAT_TURN_MAX_ATTEMPTS = 3;
// Cost damper on the PAID ambient tier only (shared/ambientAddressing.cjs).
// In-process like conversationLocks and cadenceWakes, so on N Fly machines the
// real cap is N x the constant. That is fine for a spend limiter and would NOT
// be fine for anything correctness-bearing — the one-active-job unique index
// holds that, not this.
const ambientElectionBudget = createAmbientElectionBudget();
// Kill switch for the paid tier, gating EXECUTION rather than a button: with it
// off the free continuity tier still runs, because there is nothing to kill
// about a decision that costs nothing.
function ambientElectionEnabled() {
 return String(process.env.AGENSIS_AMBIENT_ELECTION || '').trim().toLowerCase() !== 'off';
}






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

function boundAgentContextSnapshot(messages, maxBytes = CHANNEL_CONTEXT_MAX_BYTES) {
 const source = Array.isArray(messages) ? messages : [];
 const budget = Math.max(256, Number(maxBytes) || CHANNEL_CONTEXT_MAX_BYTES);
 const selected = [];
 let used = 0;
 for (let index = source.length - 1; index >= 0; index -= 1) {
  const message = source[index];
  const normalized = {
   role: message?.role === 'assistant' ? 'assistant' : 'user',
   content: String(message?.content || ''),
   lastSeenMessageId: message?.lastSeenMessageId ? String(message.lastSeenMessageId) : null,
  };
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
 const lastSeen = [...selected].reverse().find(message => message.lastSeenMessageId);
 return {
  messages: selected.map(({ role, content }) => ({ role, content })),
  lastSeenMessageId: lastSeen?.lastSeenMessageId || null,
 };
}

function boundAgentContextMessages(messages, maxBytes = CHANNEL_CONTEXT_MAX_BYTES) {
 return boundAgentContextSnapshot(messages, maxBytes).messages;
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

function explicitConversationAgent(agents, participantAgentIds, targetAgentId) {
 if (!targetAgentId) return null;
 const participants = participantAgentIds instanceof Set
  ? participantAgentIds
  : new Set(Array.isArray(participantAgentIds) ? participantAgentIds.map(String) : []);
 return (Array.isArray(agents) ? agents : []).find(agent => (
  isAgentEnabled(agent)
  && String(agent.id) === String(targetAgentId)
  && participants.has(String(agent.id))
 )) || null;
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

// Resolve (or lazily create) one human↔agent Direct message session.
//
// This is a COMMAND, not a read followed by two unrelated writes. Task dispatch
// and comment mentions can race each other, so a transaction-scoped advisory
// lock serializes this exact workspace/human/agent key. The private session and
// its human membership then commit together; fanout happens only after commit.
// Truly actorless background work falls back to the workspace owner.
async function findOrCreateDirectSession(workspaceId, agent, humanUserId = null) {
 const wantedId = String(agent.id || '');
 const wantedHandle = slugHandle(agent.handle || agent.name || '');
 if (!wantedId && !wantedHandle) throw badRequest('Agent identity is required');

 const settled = await getDb().begin(async (transaction) => {
  const tx = (sql, params = []) => transaction.unsafe(sql, params);

  // Lock workspace ownership before resolving an actorless fallback. An owner
  // transfer cannot commit between attribution and membership installation.
  const owners = await tx(
   'select user_id from workspaces where id = $1::uuid for share',
   [workspaceId],
  );
  const ownerId = owners[0]?.user_id;
  if (!ownerId) throw new Error('Workspace owner is unavailable');
  const participantUserId = String(humanUserId || ownerId);
  const lockKey = `direct-session:${String(workspaceId)}:${participantUserId}:${wantedId || wantedHandle}`;
  await tx('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [lockKey]);

  const candidates = await tx(
   `select * from chat_sessions where workspace_id = $1::uuid and folder = 'Direct messages' and archived_at is null and deleted_at is null order by created_at, id`,
   [workspaceId],
  );
  const matchingCandidates = candidates.filter((session) => {
   const participant = directAgentParticipantFromSession(session);
   if (!participant) return false;
   const participantId = String(participant.agent_id || '');
   const participantHandle = slugHandle(participant.handle || participant.name || '');
   // IDs are authoritative. Handle matching is only a compatibility fallback
   // for a legacy participant/agent that lacks one; handles are non-unique.
   if (wantedId && participantId) return participantId === wantedId;
   return Boolean(wantedHandle && participantHandle === wantedHandle);
  });
  for (const match of matchingCandidates) {
   const members = await tx(
    `select user_id, source, (user_id = $2::uuid) as requested_user
       from chat_session_members
      where session_id = $1::uuid
        and (expires_at is null or expires_at > now())
      order by user_id
      for share`,
    [match.id, participantUserId],
   );
   // A grant is oversight, not conversation identity. Reusing a candidate for
   // any active membership would route a grantee's future work into the
   // original participant's private DM.
   if (members.some((member) =>
    String(member.user_id) === participantUserId
    && String(member.source || 'participant') === 'participant')) {
    return { row: match, created: false };
   }
   if (members.length === 0 && participantUserId === String(ownerId)) {
    // Repair only a completely orphaned legacy owner DM. Never attach another
    // human to somebody else's private conversation just because the agent is
    // the same.
    await tx(
     `insert into chat_session_members
             (session_id, user_id, source, granted_by, expires_at)
      values ($1::uuid, $2::uuid, 'participant', null, null)
      on conflict (session_id, user_id) do nothing`,
     [match.id, participantUserId],
    );
    return { row: match, created: false };
   }
  }

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
  const prepared = await prepareSessionCreateRows({
   db: tx,
   userId: participantUserId,
   rows: [{
    workspace_id: workspaceId,
    title,
    model: resolveAnthropicModel(agent.model),
    folder: 'Direct messages',
    conversation_mode: 'auto',
    participants: [participant],
    visibility: 'private',
   }],
  });
  const row = prepared.rows[0];
  const inserted = await tx(
   `insert into chat_sessions
           (workspace_id, title, model, folder, conversation_mode,
            participants, visibility)
    values ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
    returning *`,
   [
    row.workspace_id, row.title, row.model, row.folder,
    row.conversation_mode, JSON.stringify(row.participants), row.visibility,
   ],
  );
  await installCreatedSessionMemberships({
   db: tx,
   userId: participantUserId,
   createdRows: inserted,
   lineage: prepared.lineage,
  });
  return { row: inserted[0] || null, created: Boolean(inserted[0]) };
 });

 if (settled.created && settled.row) {
  notifyDbSubscribers('chat_sessions', 'INSERT', [settled.row]);
 }
 return settled.row;
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
   'select id from messages where id = $1 and session_id = $2 and deleted_at is null limit 1',
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
   const session = await findOrCreateDirectSession(workspaceId, agent, authorUserId);
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
      'update tasks set assignee_id = $1, dispatch_requested_by = $2, updated_at = now() where id = $3 returning *',
      [String(agent.id), authorUserId || null, String(taskId)],
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
      "update tasks set assignee_id = $1, dispatch_requested_by = $2, status = $3, source_type = 'chat', source_id = $4, updated_at = now() where id = $5 returning *",
      [String(agent.id), authorUserId || null, nextStatus, String(session.id), String(taskId)],
     )
     : await getDb().unsafe(
      'update tasks set assignee_id = $1, dispatch_requested_by = $2, status = $3, updated_at = now() where id = $4 returning *',
      [String(agent.id), authorUserId || null, nextStatus, String(taskId)],
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
     // Same as task dispatch: this opens a thread on the agent's behalf after a
     // comment @mention, so the reply must surface in the conversation rather
     // than only inside a thread nobody has opened.
     outcome = await run({ workspaceId, sessionId: session.id, threadParentId, broadcastToChannel: true });
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

// How a non-human requester is described in the steward's DM. A resource
// operation can be requested by an agent, a controller, or the workspace itself,
// none of which have a display name to look up.
const RESOURCE_REQUESTER_LABELS = {
 agent: 'Another agent',
 controller: 'A workspace controller',
 workspace: 'The workspace',
};

// Enqueueing a resource operation wakes its steward in a DM.
//
// claim_resource_operation is pull-only: before this, an enqueued operation sat
// 'pending' with nothing telling the steward it existed, so it waited for a human
// to @mention the daemon into life — measured at 85s of dead air on a 91s demo
// operation, with RESOURCE_OPERATION_LEASE_MS (60s, workspace-resources.cjs:23)
// already counting down against a steward that had not been asked yet.
//
// Deliberately mirrors the plain-DM branch of dispatchCommentMentions rather
// than the task branch: an operation is not a task, so there is no assignee,
// status or provenance to write — and therefore nothing to roll back if the turn
// is refused. The row stays 'pending' and remains claimable by the old pull path
// on every non-dispatched path below, so this is strictly an accelerator.
// `run` is a test seam; production always uses continueConversation.
async function dispatchResourceOperation({
 workspaceId, operationId, resourceId, stewardAgentId, operation,
 resourceName = '', requesterKind = '', requesterUserId = null,
 run = continueConversation,
} = {}) {
 // Released on every path that does NOT end in a running turn.
 let claim = null;
 try {
  if (!workspaceId || !operationId || !stewardAgentId) return { dispatched: false, reason: 'missing_input' };

  const agentRows = await getDb().unsafe(
   'select * from workspace_agents where id = $1 and workspace_id = $2 limit 1',
   [String(stewardAgentId), String(workspaceId)],
  );
  const steward = agentRows[0];
  if (!steward) return { dispatched: false, reason: 'not_an_agent' };
  // Mirrors the @mention path, which resolves through enabled agents only.
  if (!isAgentEnabled(steward)) return { dispatched: false, reason: 'agent_disabled' };

  // Running an agent is an agent-dispatch action, so a human-requested operation
  // carries the same capability + throttle as every other dispatch path: a
  // commenter/viewer who may request an operation still cannot spend tokens
  // running an agent with it. Non-human requesters were already authorized
  // against the resource itself inside requestOperation.
  if (requesterUserId) {
   const role = await getWorkspaceRole(requesterUserId, workspaceId);
   if (!roleHasWorkspaceCapability(role, 'run_agents')) return { dispatched: false, reason: 'not_permitted' };
   if (!dispatchRateLimiter.check(String(requesterUserId)).allowed) return { dispatched: false, reason: 'rate_limited' };
  }

  // Keyed on the operation, not the resource: two different operations on the
  // same resource are two real pieces of work and must both wake the steward.
  if (!claimTaskDispatch(String(operationId), String(steward.id), TASK_MENTION_CLAIM_MS)) {
   return { dispatched: false, reason: 'duplicate' };
  }
  claim = [String(operationId), String(steward.id)];

  const session = await findOrCreateDirectSession(workspaceId, steward, requesterUserId);
  if (!session) return { dispatched: false, reason: 'no_session' };

  // agent_jobs carries a partial unique index (one active job per session+agent),
  // so a turn started while the steward is mid-turn cannot create a job. Find
  // that out BEFORE posting, so a busy steward does not collect a pile of seed
  // messages it will never answer individually.
  //
  // NOTE: unlike tasks, resource operations have no queue drain — nothing
  // re-dispatches this operation when the steward frees up. It stays 'pending'
  // and claimable, which is exactly the pre-change behaviour, so this is not a
  // regression; it is the remaining gap, and it is logged rather than hidden.
  if (await agentHasActiveJob(session.id, steward.id)) {
   console.log(`[resource-op] not dispatched operation=${operationId}: steward @${slugHandle(steward.handle || steward.name)} is mid-turn; operation stays pending and claimable`);
   return { dispatched: false, reason: 'busy' };
  }

  let requesterName = RESOURCE_REQUESTER_LABELS[requesterKind] || 'A teammate';
  if (requesterUserId) {
   const u = await getDb()
    .unsafe('select display_name, email from app_users where id = $1 limit 1', [String(requesterUserId)])
    .catch(() => []);
   requesterName = u[0]?.display_name || u[0]?.email || 'A teammate';
  }

  const label = resourceName ? `"${resourceName}"` : `resource ${resourceId}`;
  const content =
   `@${slugHandle(steward.handle || steward.name)} — ${requesterName} requested a \`${operation}\` operation on ${label}, and you are its steward.\n\n` +
   `Use your normal connected tool surface (your built-in tools or the agent CLI) to do the work; there are no resource-specific tool names to call.\n\n` +
   `Claim it with \`claim_resource_operation\`, then read \`${operationId}\` with \`get_resource_operation\` (including its bounded artifacts). If the request contains steps, execute them in dependency order. Report plain-language checkpoints with \`report_resource_operation_progress\` before and after meaningful work, then finish with \`settle_resource_operation\`.\n\n` +
   `Source: agensis://resource/${resourceId}`;

  const messageRows = await getDb().unsafe(
   `insert into messages (session_id, role, content, sender_kind, sender_id, sender_name)
         values ($1, 'user', $2, 'user', $3, $4)
         returning *`,
   [session.id, content, String(requesterUserId || ''), requesterName],
  );
  notifyDbSubscribers('messages', 'INSERT', messageRows);

  // AWAITED so the caller's log line reports what actually happened; every
  // call site is `void`-ed, so this costs no request latency.
  let outcome = null;
  try {
   outcome = await run({ workspaceId, sessionId: session.id });
  } catch (error) {
   console.error('continueConversation (resource operation) failed', error);
   outcome = { started: false, reason: 'error' };
  }
  if (outcome && outcome.started === false) {
   console.log(`[resource-op] could not start operation=${operationId} for steward: run=${outcome.reason || 'unknown'}; operation stays pending and claimable`);
   return { dispatched: false, reason: 'not_started', runReason: String(outcome.reason || '') };
  }

  claim = null; // a real turn is running; keep the claim so a retry cannot double-run it
  console.log(`[resource-op] dispatched operation=${operationId} (${operation}) to steward @${slugHandle(steward.handle || steward.name)} (session=${session.id})`);
  return { dispatched: true, reason: 'dispatched', sessionId: session.id };
 } catch (error) {
  console.error('dispatchResourceOperation failed', error);
  return { dispatched: false, reason: 'error' };
 } finally {
  if (claim) releaseTaskDispatch(claim[0], claim[1]);
 }
}










async function loadChannelMessages(sessionId, threadParentId = null, limit = CHANNEL_CONTEXT_LIMIT) {
 const rows = threadParentId
  ? await getDb().unsafe(
   `select id, role, content, sender_kind, sender_id, sender_name, message_kind, tool_name, tool_detail, broadcast_to_channel, created_at
         from messages
         where session_id = $1 and (id = $2 or thread_parent_id = $2) and deleted_at is null
         order by created_at desc, id desc
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
         order by created_at desc, id desc
         limit $2`,
   [sessionId, limit],
  );
 return rows.filter((row) => !isAgentPlaceholder(row)).reverse();
}

// Rebuild conversation context from the running agent's point of view: its own
// messages are 'assistant', everyone else (humans and other agents) is 'user'
// with a "[@handle]:" / "[name]:" prefix so the agent can tell who said what.
async function buildAgentTurnContextSnapshot(sessionId, runningAgent, threadParentId = null) {
 const rows = await loadChannelMessages(sessionId, threadParentId);
 const runningId = String(runningAgent?.id || '');
 const mapped = [];
 for (const row of rows) {
  const text = textFromValue(row.content).trim();
  if (!text) continue;
  const isOwn = row.sender_kind === 'agent' && String(row.sender_id || '') === runningId;
  if (isOwn) {
   mapped.push({ role: 'assistant', content: text, lastSeenMessageId: null });
   continue;
  }
  const label = row.sender_kind === 'agent'
   ? `@${slugHandle(row.sender_name || 'agent')}`
   : (row.sender_name ? String(row.sender_name) : 'User');
  mapped.push({
   role: 'user',
   content: `[${label}]: ${text}`,
   lastSeenMessageId: row.id ? String(row.id) : null,
  });
 }
 const merged = [];
 for (const message of mapped) {
  const last = merged[merged.length - 1];
  if (last && last.role === message.role) {
   last.content = `${last.content}\n\n${message.content}`;
   if (message.lastSeenMessageId) last.lastSeenMessageId = message.lastSeenMessageId;
  }
  else merged.push({
   role: message.role,
   content: message.content,
   lastSeenMessageId: message.lastSeenMessageId,
  });
 }
 while (merged.length > 0 && merged[0].role !== 'user') merged.shift();
 return boundAgentContextSnapshot(merged);
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
function pendingChatTurnKey(sessionId, agentId) {
 return `${String(sessionId || '')}::${String(agentId || '')}`;
}

// Remember a turn that was refused only because the agent was already working.
// Last write wins per (session, agent): if a human sends three messages while an
// agent is busy, one replay answers all three — continueConversation re-reads the
// conversation from the database, so the parked entry is a WAKE-UP, not a copy of
// the message. Storing the newest keeps the thread/broadcast context current.
function parkChatTurn({ workspaceId, sessionId, threadParentId, broadcastToChannel, targetAgentId, agentId }) {
 if (!workspaceId || !sessionId || !agentId) return;
 const key = pendingChatTurnKey(sessionId, agentId);
 const attempts = pendingChatTurns.get(key)?.attempts || 0;
 pendingChatTurns.set(key, {
  workspaceId: String(workspaceId),
  sessionId: String(sessionId),
  threadParentId: threadParentId || null,
  broadcastToChannel: broadcastToChannel ?? null,
  targetAgentId: targetAgentId || null,
  attempts,
  parkedAt: Date.now(),
 });
}

/**
 * Replay the turn parked for (session, agent), if any.
 *
 * Called from every path that puts an agent job into a terminal state — the same
 * sites that already schedule a task-queue drain, so the coverage (result,
 * reap, cancel, connection loss, startup reconcile) is the coverage that has
 * already been proven for tasks.
 *
 * Fire-and-forget and defensive: a replay must never be able to fail, or slow,
 * the job-completion write that triggered it.
 *
 * `run` is a test seam; production always uses continueConversation.
 */
function drainPendingChatTurn(sessionId, agentId, cause = 'job_finished', run = continueConversation) {
 const key = pendingChatTurnKey(sessionId, agentId);
 const parked = pendingChatTurns.get(key);
 if (!parked) return;
 pendingChatTurns.delete(key);
 // A human who has been waiting a quarter of an hour has moved on; answering now
 // is noise, not service.
 if (Date.now() - parked.parkedAt > PENDING_CHAT_TURN_MAX_AGE_MS) {
  console.log(`[chat-retry] dropping stale parked turn session=${sessionId} agent=${agentId} (cause=${cause})`);
  return;
 }
 if (parked.attempts >= PENDING_CHAT_TURN_MAX_ATTEMPTS) {
  console.log(`[chat-retry] giving up on parked turn session=${sessionId} agent=${agentId} after ${parked.attempts} attempts`);
  return;
 }
 const attempts = parked.attempts + 1;
 return (async () => {
  try {
   const out = await run({
    workspaceId: parked.workspaceId,
    sessionId: parked.sessionId,
    threadParentId: parked.threadParentId,
    broadcastToChannel: parked.broadcastToChannel,
    targetAgentId: parked.targetAgentId,
   });
   if (out && out.started) {
    console.log(`[chat-retry] replayed parked turn session=${sessionId} agent=${agentId} (cause=${cause}, attempt ${attempts})`);
    return;
   }
   // Still refused. 'agent_busy' means continueConversation has already re-parked
   // it with the attempt count it read before this call, so only the counter needs
   // carrying forward. 'locked' is a transient overlap with another turn on the
   // same thread and deserves the same treatment.
   if (out && (out.reason === 'agent_busy' || out.reason === 'locked')) {
    const reparked = pendingChatTurns.get(key) || { ...parked, parkedAt: parked.parkedAt };
    pendingChatTurns.set(key, { ...reparked, attempts, parkedAt: parked.parkedAt });
   }
  } catch (error) {
   console.error('drainPendingChatTurn failed', error);
  }
 })();
}

async function continueConversation({
 workspaceId,
 sessionId,
 threadParentId = null,
 broadcastToChannel = null,
 targetAgentId = null,
}) {
 if (!workspaceId || !sessionId) return { started: false, reason: 'missing_input' };
 const lockKey = `${sessionId}::${threadParentId || ''}`;
 if (conversationLocks.has(lockKey)) return { started: false, reason: 'locked' };
 conversationLocks.add(lockKey);
 let started = false;
 try {
  // eslint-disable-next-line no-constant-condition
  while (true) {
   const sessionRows = await getDb().unsafe(
    'select id, workspace_id, title, participants, conversation_mode, max_agent_turns, folder from chat_sessions where id = $1 and deleted_at is null limit 1',
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
   // A TURN, not a row. Tool chips carry sender_kind 'agent' too, so counting
   // rows meant one reply that used ten tools spent ten turns of the budget and
   // returned budget_exhausted before any election branch ran — in a threaded
   // conversation the agent would simply stop answering, with no visible cause.
   //
   // The direction was always safe (over-tight, never looser, so the loop bound
   // was never weakened), which is why this survived: it fails silently rather
   // than badly. `message_kind` is already in the projection.
   const agentTurns = burst.filter(
    (row) => row.sender_kind === 'agent' && row.message_kind !== 'tool_step',
   ).length;
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
   if (targetAgentId) {
    nextAgent = explicitConversationAgent(agents, participantAgentIds, targetAgentId);
    if (!nextAgent) return { started, reason: 'target_unavailable' };
    addressedIndividually = true;
   } else if (isDirectMessage) {
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
    // Fires once per human message (agentTurns === 0, the newest row is the
    // human's). The candidate pool is every enabled agent that is a channel
    // participant UNION every agent that has recently posted here — so a human
    // replying right after an agent draws that agent back in to decide "is this
    // for me, or pass it on?".
    //
    // `isHumanAuthored(latest)` is deliberately NARROWER than the
    // "latest author is not an agent" test it replaces. That test was satisfied
    // by a schedule row (sender_kind='system') and an automation post
    // (sender_kind='automation') as well as by a person. Neither can reach here
    // today — schedules always prefix @handle so they route through mentions
    // (see runScheduleNow), and automations never call continueConversation —
    // but AGENTS.md anticipates a dispatch_agent automation action landing, and
    // on that day "not an agent" would let a machine open a paid turn budget
    // that only a human is supposed to open. Narrower can only ever dispatch
    // less, never more.
    //
    // THREE TIERS, in order, and none of them can turn a "no" into a "yes":
    //
    //   Tier 1  openInterlocutor — FREE and deterministic. The agent you are
    //           demonstrably mid-conversation with, read off the transcript.
    //           This is the common case (a follow-up to the agent that just
    //           spoke) and it used to cost a paid, non-deterministic call to
    //           decide something the messages already state.
    //   Tier 2  cheap suppressors — a cold post with no letters or digits, and
    //           a per-session budget. Both only ever REFUSE the paid call.
    //   Tier 3  pickAutoInterjectWatcher — the existing single Haiku call,
    //           unchanged, still one agent or null, still failing closed.
    //
    // Tier 1 elects from the SAME pool Tier 3 would have, so it can never elect
    // where Tier 3 could not. Tier 1 and Tier 3 are mutually exclusive: a
    // continuity hit makes NO model call.
    if (!nextAgent && agentTurns === 0 && isHumanAuthored(latest) && unpromptedAllowed) {
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
     // The per-agent off switch is applied to the POOL, so an opted-out agent
     // is invisible to both tiers at once — and a channel where every candidate
     // has opted out makes no model call at all.
     const candidates = [...candidateIds]
      .map((id) => agents.find((agent) => String(agent.id) === id))
      .filter((agent) => agent && isAgentEnabled(agent) && ambientRepliesEnabled(agent));
     if (candidates.length > 0) {
      const inPool = (agentId) => candidates.some((agent) => String(agent.id) === String(agentId));
      // --- Tier 1: free, deterministic continuity ---------------------------
      const open = openInterlocutor({
       rows,
       startIdx,
       nowMs: Date.now(),
       isEligible: inPool,
       textOf: textFromValue,
      });
      if (open) nextAgent = candidates.find((agent) => String(agent.id) === open.agentId) || null;

      if (!nextAgent) {
       const humanMessage = textFromValue(burst[0]?.content).slice(0, 2000);
       // --- Tier 2: suppressors, guarding only the paid call ----------------
       // Structural, never semantic: a message with zero letters and zero
       // digits is a bare reaction. It runs AFTER Tier 1 on purpose, so a `👍`
       // typed mid-conversation still reaches the agent you were talking to —
       // only the COLD trivial message is dropped.
       const paidTierAllowed = ambientElectionEnabled()
        && !isStructurallyTrivial(humanMessage)
        && ambientElectionBudget.take(sessionId);
       if (paidTierAllowed) {
        const contextLines = rows
         .slice(Math.max(0, startIdx - 5), startIdx)
         .map((r) => `${r.sender_kind === 'agent' ? '@' + slugHandle(r.sender_name || 'agent') : 'human'}: ${textFromValue(r.content).slice(0, 300)}`)
         .join('\n');
        const lastAgent = candidates.find((agent) => String(agent.id) === lastAgentAuthorId);
        const lastSpeakerHandle = lastAgent ? slugHandle(lastAgent.handle || lastAgent.name) : '';
        // --- Tier 3: the existing single cheap call -------------------------
        const watcher = await pickAutoInterjectWatcher({ workspaceId, humanMessage, contextLines, candidates, lastSpeakerHandle });
        if (watcher) nextAgent = watcher;
       }
      }
     }
    }
   }
   if (!nextAgent) return { started, reason: 'no_agent' };
   if (await hasActiveBurstJob(sessionId, nextAgent.id)) {
    // Park, don't drop. Pinned to the agent that was busy via targetAgentId, so
    // the replay answers as the same agent instead of paying for a second
    // election — explicitConversationAgent still degrades to a fresh election if
    // that agent has since left the session.
    parkChatTurn({
     workspaceId,
     sessionId,
     threadParentId,
     broadcastToChannel,
     targetAgentId: nextAgent.id,
     agentId: nextAgent.id,
    });
    return { started, reason: 'agent_busy' };
   }

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

   const result = await runAgentTurn(nextAgent, { workspaceId, sessionId, threadParentId, coParticipants, isDirectMessage, broadcastToChannel });
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
const SCHEDULE_CLAIM_STALE_MINUTES = 35;
async function runDueSchedules() {
 if (scheduleRunnerRunning) return;
 scheduleRunnerRunning = true;
 try {
  const db = getDb();
  // Legacy targetless rows and schedules whose conversation was soft-deleted
  // cannot ever run. Disable them before applying the batch LIMIT so ten broken
  // rows cannot starve every valid schedule behind them.
  const invalidTargets = await db.unsafe(
   `update agent_schedules schedule
       set enabled = false,
           running = false,
           last_status = 'Target conversation unavailable',
           updated_at = now()
     where (schedule.enabled is true or schedule.running is true)
       and (
         schedule.session_id is null
         or not exists (
           select 1
             from chat_sessions target_session
            where target_session.id = schedule.session_id
              and target_session.workspace_id = schedule.workspace_id
              and target_session.deleted_at is null
         )
       )
   returning *`,
  );
  if (invalidTargets.length > 0) {
   notifyDbSubscribers('agent_schedules', 'UPDATE', invalidTargets);
  }

  // A process can die after claim and before finalization. Startup recovery is
  // not enough on a multi-machine deployment, so reclaim rows older than the
  // agent hard ceiling plus five minutes on every live worker.
  const staleClaims = await db.unsafe(
   `update agent_schedules
       set running = false,
           last_status = 'Recovered interrupted schedule run',
           fail_count = fail_count + 1,
           updated_at = now()
     where running is true
       and coalesce(last_run_at, updated_at, created_at)
           < now() - ($1 || ' minutes')::interval
   returning *`,
   [String(SCHEDULE_CLAIM_STALE_MINUTES)],
  );
  if (staleClaims.length > 0) {
   notifyDbSubscribers('agent_schedules', 'UPDATE', staleClaims);
  }

  // Atomic claim: flip due rows to running and bump next_run_at in one statement.
  const due = await db.unsafe(
   `with due_candidates as materialized (
      select candidate.id, candidate.session_id
        from agent_schedules candidate
        join chat_sessions candidate_session
          on candidate_session.id = candidate.session_id
         and candidate_session.workspace_id = candidate.workspace_id
         and candidate_session.deleted_at is null
       where candidate.enabled = true
         and candidate.running = false
         and candidate.next_run_at <= now()
       order by candidate.next_run_at asc, candidate.id asc
       limit 10
    ),
    locked_sessions as materialized (
      select live_session.id
        from chat_sessions live_session
        join due_candidates candidate on candidate.session_id = live_session.id
       where live_session.deleted_at is null
       order by live_session.id
       for share of live_session skip locked
    ),
    claimable as materialized (
      select schedule.id
        from agent_schedules schedule
        join due_candidates candidate on candidate.id = schedule.id
        join locked_sessions live_session on live_session.id = schedule.session_id
       where schedule.enabled = true
         and schedule.running = false
         and schedule.next_run_at <= now()
       order by schedule.next_run_at asc, schedule.id asc
       for update of schedule skip locked
    )
    update agent_schedules s
          set running = true, last_run_at = now(), updated_at = now(),
              next_run_at = now() + (interval_seconds || ' seconds')::interval
        where s.id in (select id from claimable)
        returning *`,
  );
  for (const schedule of due) {
   let status = 'ok';
   let detail = '';
   let disableSchedule = false;
   try {
    if (!schedule.session_id) {
     disableSchedule = true;
     throw new Error('schedule has no target session');
    }
    if (!schedule.created_by) {
     disableSchedule = true;
     throw new Error('schedule has no author to re-authorize');
    }
    const launch = await db.begin(async (tx) => {
     let current;
     let agent;
     try {
      ({ schedule: current, agent } = await lockScheduleExecutionScope({
       tx,
       userId: schedule.created_by,
       workspaceId: schedule.workspace_id,
       sessionId: schedule.session_id,
       scheduleId: schedule.id,
       agentId: schedule.agent_id,
       capability: 'run_agents',
       roleHasWorkspaceCapability,
       sessionReadableSql,
      }));
     } catch (error) {
      if (error?.code === 'SCHEDULE_SCOPE_CHANGED') {
       disableSchedule = true;
       throw new Error('schedule author no longer has access to run this conversation');
      }
      if (error?.code === 'SCHEDULE_TARGET_UNAVAILABLE') {
       disableSchedule = true;
       throw new Error(error.message);
      }
      throw error;
     }
     if (!current.running || !current.enabled) {
      throw new Error('schedule was disabled before its run could start');
     }
     const handle = slugHandle(agent.handle || agent.name);
     const promptBody = String(current.prompt || '').trim() || 'Run your scheduled task.';
     // Address the agent explicitly so mention-mode channels still dispatch.
     const content = promptBody.includes(`@${handle}`) ? promptBody : `@${handle} ${promptBody}`;
     const messageRows = await tx.unsafe(
      `insert into messages (session_id, role, content, sender_kind, sender_name)
            values ($1, 'user', $2, 'system', 'Schedule') returning *`,
      [current.session_id, content],
     );
     if (messageRows.length !== 1) {
      throw new Error('scheduled message could not be created');
     }
     return {
      messageRows,
      workspaceId: current.workspace_id,
      sessionId: current.session_id,
      agentId: current.agent_id,
     };
    });
    notifyDbSubscribers('messages', 'INSERT', launch.messageRows);
    const dispatch = await continueConversation({
     workspaceId: launch.workspaceId,
     sessionId: launch.sessionId,
     targetAgentId: launch.agentId,
    });
    if (!dispatch?.started) {
     throw new Error(`scheduled agent did not start (${dispatch?.reason || 'refused'})`);
    }
   } catch (error) {
    status = 'error';
    detail = String(error?.message || error).slice(0, 300);
   }
   let finalized;
   try {
    finalized = await db.begin(async (tx) => {
     const updated = await tx.unsafe(
      `update agent_schedules
              set running = false, last_status = $2, updated_at = now(),
                  enabled = case when $4::boolean then false else enabled end,
                  run_count = run_count + 1,
                  fail_count = fail_count + ($3::int)
            where id = $1 and running = true
            returning *`,
      [schedule.id, status, status === 'error' ? 1 : 0, disableSchedule],
     );
     if (updated.length !== 1) return { updated: [], runRows: [] };
     const current = updated[0];
     const runRows = await tx.unsafe(
      `insert into agent_schedule_runs (schedule_id, workspace_id, session_id, status, detail)
           values ($1, $2, $3, $4, $5) returning *`,
      [current.id, current.workspace_id, current.session_id, status, detail],
     );
     return { updated, runRows };
    });
   } catch (error) {
    console.warn(
     `[backend] schedule ${schedule.id} finalization failed:`,
     error?.message || error,
    );
    // The history insert and ordinary final update share a transaction, so a
    // history failure rolls both back. Release the claim separately and keep
    // draining the batch. If even this cleanup fails, the live stale-claim
    // recovery above clears it after the hard ceiling instead of waiting for a
    // process restart.
    try {
     const recovered = await db.unsafe(
      `update agent_schedules
          set running = false,
              last_status = 'Schedule finalization failed',
              fail_count = fail_count + 1,
              updated_at = now()
        where id = $1 and running = true
        returning *`,
      [schedule.id],
     );
     if (recovered.length > 0) {
      notifyDbSubscribers('agent_schedules', 'UPDATE', recovered);
     }
    } catch (cleanupError) {
     console.warn(
      `[backend] schedule ${schedule.id} claim cleanup failed:`,
      cleanupError?.message || cleanupError,
     );
    }
    continue;
   }
   if (finalized.updated.length > 0) {
    notifyDbSubscribers('agent_schedules', 'UPDATE', finalized.updated);
   }
   if (finalized.runRows.length > 0) {
    notifyDbSubscribers('agent_schedule_runs', 'INSERT', finalized.runRows);
   }
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
 const database = getDb();
 if (!database || typeof database.begin !== 'function') {
  throw new Error('Agent registration approval requires transaction support');
 }
 const result = await database.begin(async (transaction) => {
  const lockedRows = await transaction.unsafe(
   'select * from agent_registrations where id = $1 for update',
   [reg.id],
  );
  const current = lockedRows[0] || reg;
  if (current.status && current.status !== 'pending') {
   return {
    alreadySettled: true,
    agentId: current.agent_id,
    handle: current.requested_handle,
    name: current.requested_name,
    agentRows: [],
    registrationRows: [],
    isNew: false,
   };
  }

  let agentId = current.agent_id;
  let handle = current.requested_handle;
  let name = current.requested_name;
  let agentRows = [];
  const isNew = !agentId;
  if (agentId) {
   agentRows = await transaction.unsafe(
    `update workspace_agents
        set mcp_approved = true, enabled = true, updated_at = now()
      where id = $1
        and ($2::uuid is null or controller_id = $2)
      returning *`,
    [agentId, current.controller_id || null],
   );
   if (!agentRows[0]) throw forbidden('The registered agent is no longer owned by this controller');
   handle = slugHandle(agentRows[0].handle || agentRows[0].name);
   name = agentRows[0].name;
  } else {
   const intent = normalizeAgentIntent(
    current.requested_purpose,
    parseJsonArray(current.requested_resource_facets),
   );
   if (!intent.ok) throw badRequest(intent.errors.join('; '));
   agentRows = await transaction.unsafe(
    `insert into workspace_agents
        (workspace_id, name, handle, description, system_prompt, model, run_mode,
         permission_mode, avatar, accent_color, enabled, mcp_approved,
         ambient_replies, purpose, resource_facets, controller_id)
       values ($1, $2, $3, '', '', 'auto', 'external', 'default', 'AI', '#00a95c',
         true, true, $4, $5, $6::jsonb, $7)
       returning *`,
    [
     current.workspace_id,
     name || handle || 'Agent',
     slugHandle(handle || name || 'agent'),
     intent.purpose === 'resource' ? false : true,
     intent.purpose,
     intent.resourceFacets,
     current.controller_id || null,
    ],
   );
   if (!agentRows[0]) throw new Error('Agent could not be created');
   agentId = agentRows[0].id;
   handle = slugHandle(agentRows[0].handle || agentRows[0].name);
   name = agentRows[0].name;
  }
  const registrationRows = await transaction.unsafe(
   `update agent_registrations
       set status = 'approved', agent_id = $2, decided_at = now(), updated_at = now()
     where id = $1 and status = 'pending'
     returning *`,
   [current.id, agentId],
  );
  if (!registrationRows[0]) throw new Error('Agent registration was settled concurrently');
  return { alreadySettled: false, agentId, handle, name, agentRows, registrationRows, isNew };
 });

 if (result.alreadySettled) return result;
 if (result.agentRows.length > 0) {
  notifyDbSubscribers('workspace_agents', result.isNew ? 'INSERT' : 'UPDATE', result.agentRows);
 }
 notifyDbSubscribers('agent_registrations', 'UPDATE', result.registrationRows);

 // Identity is descriptive and best-effort; the authority-bearing agent row and
 // its registration are already committed atomically above.
 try {
  const declared = parseJsonObject(reg.requested_identity);
  if (Object.keys(declared).length > 0) {
   const rows = await getDb().unsafe(AGENT_IDENTITY_SELECT, [result.agentId, reg.workspace_id]);
   const applied = await applyAgentIdentity({
    workspaceId: reg.workspace_id,
    agentId: result.agentId,
    row: rows[0],
    declared,
    isNew: result.isNew,
   });
   if (applied) result.name = applied.name;
  }
 } catch (error) {
  console.error('[agensis] register_agent identity declaration failed:', error.message || error);
 }
 return result;
}

async function registerAgentRequest({
 workspaceId,
 asHandle = null,
 name = null,
 handle = null,
 clientLabel = '',
 autoApprove = false,
 identity = null,
 controllerId = null,
 purpose = 'collaborator',
 resourceFacets = [],
}) {
 const declaredIdentity = normalizeIdentityDeclaration(identity);
 let agent = null;
 if (asHandle) {
  if (controllerId && (purpose !== 'collaborator' || (Array.isArray(resourceFacets) && resourceFacets.length > 0))) {
   throw badRequest('purpose and resourceFacets are only valid when creating a new agent');
  }
  agent = await resolveWorkspaceAgentByHandle(workspaceId, asHandle);
  if (!agent) throw badRequest(`No agent "@${slugHandle(asHandle)}" in this workspace`);
  if (
   controllerId
   && (!agent.controller_id || String(agent.controller_id) !== String(controllerId))
  ) {
   throw forbidden(`@${slugHandle(asHandle)} is not owned by this controller`);
  }
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
 const intent = normalizeAgentIntent(purpose, resourceFacets);
 if (!intent.ok) throw badRequest(intent.errors.join('; '));
 if (!controllerId && (purpose !== 'collaborator' || (Array.isArray(resourceFacets) && resourceFacets.length > 0))) {
  throw forbidden('Only a workspace controller may choose resource-agent intent during registration');
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
 const common = {
  agentId: agent ? agent.id : null,
  clientLabel: String(clientLabel || '').slice(0, 120),
  status: 'pending',
};
 const rows = controllerId
  ? await getDb().unsafe(
   `insert into agent_registrations
       (workspace_id, agent_id, controller_id, requested_handle, requested_name,
        client_label, status, requested_identity, requested_purpose, requested_resource_facets)
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb) returning *`,
   [
    workspaceId, common.agentId, controllerId, reqHandle, reqName,
    common.clientLabel, common.status, declaredIdentity, intent.purpose, intent.resourceFacets,
   ],
  )
  : await getDb().unsafe(
   `insert into agent_registrations (workspace_id, agent_id, requested_handle, requested_name, client_label, status, requested_identity, requested_purpose, requested_resource_facets)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb) returning *`,
   [
    workspaceId, common.agentId, reqHandle, reqName,
    common.clientLabel, common.status,
    // The OBJECT, not JSON.stringify: postgres.js resolves the ::jsonb cast to a
    // jsonb parameter and serializes the value itself — a pre-stringified value
    // gets serialized AGAIN and lands as a jsonb string scalar.
    declaredIdentity, intent.purpose, intent.resourceFacets,
   ],
  );
 const reg = rows[0];
 notifyDbSubscribers('agent_registrations', 'INSERT', rows);
 if (autoApprove) {
  const out = await finalizeRegistrationApproval({ ...reg, status: 'pending' });
  return { registrationId: reg.id, status: 'approved', agentId: out.agentId, handle: out.handle };
 }
 return { registrationId: reg.id, status: 'pending', handle: reqHandle };
}

// Poll target for the client between register_agent and approval.
async function getRegistrationStatus({ workspaceId, registrationId, controllerId = null }) {
 const params = [registrationId, workspaceId];
 const controllerClause = controllerId ? ' and controller_id = $3' : '';
 if (controllerId) params.push(controllerId);
 const rows = await getDb().unsafe(
  `select id, status, agent_id, requested_handle
     from agent_registrations
    where id = $1 and workspace_id = $2${controllerClause}
    limit 1`,
  params,
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
 return normalizeAndBoundAiChatMessages(messages);
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

/**
 * Resolve a session's workspace AND whether only its members may read it.
 *
 * Both travel together because `activity_events` is a WORKSPACE-scoped feed:
 * `appendSessionAccessClause` returns untouched for any table that is not
 * `chat_sessions`/`messages`, and the realtime private lane at
 * server/realtime.cjs only splits `chat_sessions` rows. So nothing downstream
 * of this function can re-derive "that came out of a DM" — if the privacy of
 * the source session does not ride along with the row at WRITE time, it is
 * gone, and a members-only conversation ends up in a feed every `read` member
 * can select.
 *
 * One query and one cache entry for both, so the privacy check is free.
 */
async function resolveSessionActivityContext(sessionId, { fresh = false } = {}) {
 if (!sessionId) return null;
 if (!fresh) {
  const cached = workspaceSessionCacheGet(sessionId);
  if (cached !== undefined) return cached;
 }
 try {
  const rows = await getDb().unsafe(
   'select workspace_id, visibility, folder, deleted_at from chat_sessions where id = $1 limit 1',
   [sessionId],
  );
  const row = rows[0];
  const workspaceId = row?.workspace_id || null;
  if (!workspaceId || row.deleted_at) return null;
  // Fail closed: an unreadable/absent row is treated as private by
  // isPrivateSessionRow's own folder backstop rather than assumed open.
  const context = {
   workspaceId,
   isPrivate: isPrivateSessionRow(row),
   visibility: row.visibility ?? null,
   folder: row.folder ?? null,
  };
  if (!fresh) workspaceSessionCacheSet(sessionId, context);
  return context;
 } catch (error) {
  console.error('resolveSessionActivityContext failed', error);
  return null;
 }
}

async function resolveWorkspaceIdForSession(sessionId) {
 const context = await resolveSessionActivityContext(sessionId);
 return context ? context.workspaceId : null;
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
   const sessionContext = await resolveSessionActivityContext(sessionId);
   if (!sessionContext) continue;
   const { workspaceId, isPrivate, visibility, folder } = sessionContext;
   const role = message.role || '';
   const senderName = message.sender_name || (role === 'user' ? 'You' : 'Agent');
   const content = typeof message.content === 'string' ? message.content : '';
   const senderId = typeof message.sender_id === 'string' ? message.sender_id : '';
   const userId = role === 'user' && ACTIVITY_UUID_RE.test(senderId) ? senderId : null;
   // A members-only session contributes the FACT of a message, never its words.
   // Both carriers have to be cut, not just one: `metadata.content` is the whole
   // body, and `title` was the first 80 characters of that same body — which is
   // still the message, just shorter. What survives is enough for the feed to
   // say something happened and to link to it; a reader who is not a member
   // follows that link and gets nothing, because the session gate does hold on
   // the transcript route.
   const title = isPrivate
    ? `${senderName}: (private conversation)`.slice(0, 120)
    : `${senderName}: ${content.slice(0, 80)}`.slice(0, 120);
   const metadata = {
    session_id: sessionId,
    role,
    sender_kind: message.sender_kind || '',
    sender_name: message.sender_name || '',
    ...(isPrivate ? {} : { content }),
   };
   // C3: idempotent insert. ON CONFLICT DO NOTHING against the partial unique
   // index uq_activity_events_message_sent means a retried finalization for the
   // same message id is a no-op (returns 0 rows), so the feed row — and its
   // realtime notification below — fire exactly once. Target left off so it
   // degrades to a plain insert if the index hasn't been created yet.
   const inserted = await getDb().unsafe(
    `with live_activity_message as materialized (
       select activity_message.id
         from messages activity_message
         join chat_sessions activity_session
           on activity_session.id = activity_message.session_id
        where activity_message.id = $3::uuid
          and activity_message.session_id = $6::uuid
          and activity_message.deleted_at is null
          and activity_session.deleted_at is null
          and activity_session.workspace_id = $1::uuid
          and activity_session.visibility is not distinct from $7
          and activity_session.folder is not distinct from $8
        for share of activity_message, activity_session
     )
     insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
       select $1, $2, 'message_sent', 'message', $3, $4, $5::jsonb, now()
         from live_activity_message
     on conflict do nothing
     returning *`,
    [
     workspaceId,
     userId,
     message.id != null ? String(message.id) : null,
     title,
     metadata,
     String(sessionId),
     visibility,
     folder,
    ],
   );
   if (inserted.length > 0) {
    // table is 'activity_events' here, so this cannot re-trigger message logging.
    notifyDbSubscribers('activity_events', 'INSERT', inserted);

    // Bump the session's updated_at so the Threads panel sorts correctly.
    // This is the single chokepoint for all message INSERTs (via realtime.cjs),
    // so every conversation — including sub-threads — stays fresh in the list.
    getDb().unsafe(
     'update chat_sessions set updated_at = now() where id = $1 and deleted_at is null',
     [String(sessionId)],
    ).catch(() => {});
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







// Resource-operation progress is delivered through an operation-scoped
// broadcast channel. The service is constructed before realtime, so keep the
// relay as a late-bound function rather than giving the service a socket set or
// weakening the dedicated resource authorization boundary.
let resourceProgressRelay = () => {};
const workspaceResources = createWorkspaceResourceService({
 getDb: () => getDb(),
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
 assertWorkspaceRoleLocked: sharedAssertWorkspaceRoleLocked,
 recordAudit: (...a) => recordAudit(...a),
 // Enqueueing an operation wakes its steward, instead of leaving the row for
 // whenever someone next pulls. Thunked, like every other dep here.
 dispatchResourceOperation: (...a) => dispatchResourceOperation(...a),
 notifyResourceOperationProgress: (...a) => resourceProgressRelay(...a),
});

// The builtin turn: the tool-use loop and the Anthropic stream. Last of Wave 4.
const builtinTurn = createBuiltinTurn({
 VOICE_HUDDLE_NOTE,
 agentContextFromRow: (...a) => agentContextFromRow(...a),
 agentRuntimePayload,
 buildAgentActivityDigest: (...a) => buildAgentActivityDigest(...a),
 buildAgentConnectionCommand: (...a) => buildAgentConnectionCommand(...a),
 buildAgentTurnContextSnapshot: (...a) => buildAgentTurnContextSnapshot(...a),
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
 workspaceResources,
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
 grantAgentPermissionRule: (...a) => grantAgentPermissionRule(...a),
 listAgentPermissionRules: (...a) => listAgentPermissionRules(...a),
 revokeAgentPermissionRule: (...a) => revokeAgentPermissionRule(...a),
});
const {
 runToolUseLoop, toolResultText, mcpToolDeps, getBuiltinToolset,
 builtinToolIdentity, builtinStepDetail, runAgentTurn, streamAnthropicTurn,
 runAnthropicCompletion, streamFlushDue,
 connectionSupportsAmpRuntime, isAmpRuntimeAgent, loadAmpThreadBinding, validAmpThreadId,
 cancelBuiltinJob,
 BUILTIN_FLUSH_INTERVAL_MS, BUILTIN_TOOL_LOOP_MAX_CALLS,
 BUILTIN_TOOL_LOOP_MAX_STEPS, BUILTIN_TOOL_NOTE, BUILTIN_TOOL_RESULT_MAX_CHARS,
} = builtinTurn;

// Mines this workspace's conversations for skills/memories/docs worth keeping —
// "Suggestions" in the product. Constructed here, after runAnthropicCompletion
// is bound, because that is the one-shot model call it analyses with.
const {
 runDueThreadHarvests, sweepIdleSessionHarvests,
 listThreadHarvests, decideHarvestFinding,
} = createThreadHarvest({
 getDb: () => getDb(),
 runAnthropicCompletion: (...a) => runAnthropicCompletion(...a),
 notifyDbSubscribers: (...a) => notifyDbSubscribers(...a),
 onWarn: (message) => console.warn('[thread-harvest]', message),
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
 badRequest,
 // Wrapped in an arrow rather than passed by value because the skill store is
 // constructed further down this file. Same lazy-binding pattern as `getDb`
 // above; by the time a human accepts a suggestion, every binding is settled.
 writeWorkspaceSkill: (...a) => writeWorkspaceSkill(...a),
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
 listAgentTemplates, createAgentTemplate, saveAgentAsTemplate, importAgentTemplate,
 updateAgentTemplate, deleteAgentTemplate,
} = createAgentTemplates({
 getDb: () => getDb(),
 notifyDbSubscribers: (...a) => notifyDbSubscribers(...a),
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
 normalizeAgentTemplate,
 agentToTemplateDraft,
 readTemplateExport,
 templateFingerprint,
 // Import alone is audited, because import alone crosses a workspace boundary.
 // Authoring is not: a template cannot carry privilege, so writing one is a
 // non-event and logging it would bury the rows that matter.
 recordAudit: (...a) => recordAudit(...a),
});

// The agent marketplace. Same validator discipline as templates, applied
// across the tenant boundary: a 'template' listing shares the persona body,
// a 'hire' listing structurally cannot carry one, and the copy lane routes
// through importAgentTemplate so a marketplace copy gets the same manage
// gate, refusals and audit row as any other cross-workspace import.
const {
 listMarketplaceListings, listWorkspaceMarketplaceListings,
 publishMarketplaceListing, unpublishMarketplaceListing,
 copyMarketplaceListing, hireMarketplaceListing,
 listMarketplaceHires, endMarketplaceHire,
} = createMarketplace({
 getDb: () => getDb(),
 notifyDbSubscribers: (...a) => notifyDbSubscribers(...a),
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
 normalizeMarketplaceListing,
 publicMarketplaceListing,
 hiredAgentDraft,
 agentToTemplateDraft,
 buildTemplateExport,
 importAgentTemplate: (...a) => importAgentTemplate(...a),
 recordAudit: (...a) => recordAudit(...a),
});

// The app-side skill store. Same shape and same reasoning as agent templates:
// the validator is shared/workspaceSkills.cjs, its output is REBUILT from a
// carried-field list, and the table has no column a privilege-bearing field
// could land in. `writeSkill` is destructured too because the thread-harvest
// accept path uses it — accepting a proposed skill must go through the SAME
// validator and the SAME insert as authoring one by hand, or the store grows a
// second door with different rules.
const {
 listSkills: listWorkspaceSkillRows,
 createSkill: createWorkspaceSkill,
 updateSkill: updateWorkspaceSkill,
 deleteSkill: deleteWorkspaceSkill,
 writeSkill: writeWorkspaceSkill,
} = createWorkspaceSkills({
 getDb: () => getDb(),
 notifyDbSubscribers: (...a) => notifyDbSubscribers(...a),
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
});

// Agent jobs hold no in-process state — a job's liveness is a database fact, so
// a restart cannot lose it. See server/agent-jobs.cjs.
const agentJobs = createAgentJobs({
 PLACEHOLDER_CONTENT_RE,
 agentLiveMessageContent: (...a) => agentLiveMessageContent(...a),
 agentPermissionFlags, agentRuntimePayload, badRequest,
 continueConversation: (...a) => continueConversation(...a),
 drainPendingChatTurn: (...a) => drainPendingChatTurn(...a),
 forbidden, ensureTable, getDb, isAgentEnabled,
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
 recordAnthropicUsage: (...a) => recordAnthropicUsage(...a),
});
const {
 insertActiveAgentJob, agentHasActiveJob, agentHasAnyActiveJob,
 hasActiveBurstJob, finalizeStuckJob, failConnectionJobs, rehomeRunningJobs, reapStuckAgentJobs,
 clearStrandedPlaceholders, handleAgentJobResult, handleAgentJobDelta,
 handleAgentJobStep, handleAgentJobSegment, agentStepParts, agentStepContent,
 finalizeAgentJobResult, ampResultMetadata, validateAmpJobResult, claimMcpJob, submitMcpJobResult, reapStuckMcpJobs,
 normalizeStopReason, stopResultMetadata, failureSentence, daemonStopUsage,
 dispatchFarmAgentJob, getFarmAgentJob, cancelFarmAgentJob,
} = agentJobs;

// Interactive tool approvals. Stateless like agent jobs, and for the same
// reason: a pending approval must survive a server restart, because the daemon
// on the other side is still holding its turn open waiting for the answer.
const agentPermissions = createAgentPermissions({
 appendSessionAccessClause, badRequest, forbidden, getDb, parseJsonObject,
 normalizeAgentPermissionMode,
 enforceSessionRead: (...a) => enforceSessionRead(...a),
 enforceWorkspaceRole: (...a) => enforceWorkspaceRole(...a),
 notifyDbSubscribers: (...a) => realtime.notifyDbSubscribers(...a),
 sendWs: (...a) => realtime.sendWs(...a),
 getConnectedAgents: () => agentConnections.connectedAgents,
 recordAudit: (...a) => recordAudit(...a),
});
const {
 decideAgentPermissionRequest, expireConnectionPermissionRequests,
 expireStalePermissionRequests, handleAgentPermissionPrepared, handleAgentPermissionRequest,
 grantAgentPermissionRule, listAgentPermissionRequests, listAgentPermissionRules,
 publicPermissionRequest, rehomePendingPermissionRequests, replayPermissionDecisions,
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
 rehomePendingPermissionRequests, rehomeRunningJobs, replayPermissionDecisions, repairStoredIdentity,
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
const nostrCommunities = createNostrCommunityManager({
 getDb,
 getWorkspaceSecretValue,
 setWorkspaceSecretValue,
 assertSafeOutboundUrl,
 bridges: channelBridges,
 notifyDbSubscribers: (...args) => realtime.notifyDbSubscribers(...args),
});
channelBridges.registerHubAdapter(nostrCommunities.hubAdapter);

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
 handleAgentPermissionPrepared, handleAgentPermissionRequest,
 handleBridgeMessage: (...args) => channelBridges.handleBridgeMessage(...args),
 handlePeerListRequest, handlePeerTicketRequest, inferenceBroker,
 authorizeResourceOperationRealtime: async (userId, workspaceId, operationId) => {
  await workspaceResources.getOperation({
   workspaceId,
   operationId,
   actor: { kind: 'user', userId, workspaceId },
   includeArtifacts: false,
  });
 },
 isPrivateSessionRow, sessionMemberUserIds, sessionRealtimeAudience,
 sessionRealtimeAudiences,
 readReceiptOptedInUserIds,
 redactDeletedMessageRows,
 logMessageActivity, markAgentConnectionOffline,
 refreshConnectedAgentConfigs, registerAgentConnection, updateAgentHeartbeat,
 // Lets the agent-status broadcast resolve both workspace and canonical
 // private/open classification. `messages` carries neither.
 resolveSessionActivityContext: (sessionId) => resolveSessionActivityContext(sessionId, { fresh: true }),
 verifyAgentConnectToken, verifyToken, voiceRelay, voiceStreamRateLimiter,
});
const {
 sendWs, notifyDbSubscribers, sanitizeRealtimeRow, relayBroadcast,
 broadcastGlobal, attachRealtime, authorizeRealtimeBinding,
 authorizeRealtimeBroadcast, revokeRealtimeAccessForMember,
 notifyReadReceiptPreference,
 registerTestWebsocketClient, workspaceIdFromRealtimeChannel, resourceOperationFromRealtimeChannel,
 truncateAgentStatusContent, AGENT_STATUS_CONTENT_MAX, REALTIME_HEAVY_FIELDS,
} = realtime;

resourceProgressRelay = ({ workspaceId, operationId, status, progress, progressSeq, updatedAt } = {}) => {
 if (!workspaceId || !operationId) return;
 relayBroadcast(
  `resource-operation:${String(workspaceId)}:${String(operationId)}`,
  'progress',
  {
   operationId: String(operationId),
   status: String(status || ''),
   progress: progress && typeof progress === 'object' ? progress : {},
   progressSeq: String(progressSeq ?? '0'),
   updatedAt: updatedAt || null,
  },
 );
};


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
  // an extracted module must never duplicate one.
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
  redactDeletedMessageRows, aiStreamErrorText,
  scrubMessageActivityByMessageId, scrubMessageActivityBySession,
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
 // OAuth token/register endpoints use form-encoded bodies (RFC 6749).
 app.use(express.urlencoded({ extended: false }));
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
 app.locals.runtimeSchemaReady = runtimeSchemaReady;
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
 mountNostrCommunityRoutes(app, {
  ...coreDeps(), nostrCommunities,
 });

 mountWorkspacesRoutes(app, {
  ...coreDeps(),
  agentRuntimePayload, assertSafeOutboundUrl, encryptVaultSecret, publicWorkspace,
 });
 mountHuddleRoutes(app, {
  ...coreDeps(),
  assertWorkspaceRoleLocked: sharedAssertWorkspaceRoleLocked,
  installCreatedSessionMemberships,
  lockPrivateSessionRoster,
  webhookRateLimiter,
 });

 // Voice engines for huddles. The Cartesia token exchange is plain HTTP and is
 // mirrored on Netlify; the Deepgram audio relay is not a route at all — it
 // rides the realtime websocket, which only exists here. See server/voice.cjs.
 mountVoiceRoutes(app, { ...coreDeps(), voiceTokenRateLimiter });

 // Per-workspace usage/storage stats in one round-trip. Read-role only. Bytes
 // come from stored upload sizes (uploaded_files.size) plus agent memory file
 // content (agent_memory_files.byte_size); counts are workspace-scoped. Messages
 // have no workspace_id column, so they are scoped via their chat_sessions.
 mountSessionsRoutes(app, {
  ...coreDeps(),
  buildAgentConnectionCommand,
  buildWorkspaceBootstrap,
  cancelBuiltinJob,
  endHuddleRoom: deleteLivekitRoom,
  ensurePrimaryDaemonAgent,
  isPrivateSessionRow,
  normalizeAgentBackendBaseUrl,
  requestBaseUrl,
  resolveSetupWorkspace,
  resolveWorkspaceIdForSession,
  scheduleTaskQueueDrain: (...a) => taskDispatch.scheduleTaskQueueDrain(...a),
  sendToConnection,
 });

 mountCursorbuddyRoutes(app, { ...coreDeps(), ...cursorBuddyGuides, dbQuery, cursorBuddyGuidesDbRateLimiter, cursorBuddyGuidesRateLimiter, agentRuntimePayload, buildAgentConnectionCommand, createCursorBuddyConnectionKey, ensureCursorBuddyAgentForKey, ensureCursorBuddyProviderAgent, hashAgentToken, normalizeAgentBackendBaseUrl, normalizeCursorBuddyDomain, normalizeCursorBuddyScope, normalizeCursorBuddySurface, publicCursorBuddyConnectionKey, requestBaseUrl, shellQuote });

 mountInferenceRoutes(app, { ...coreDeps(), authorizeUserOrFarmWorkspace, bindInferenceAbort, createOpenAIInferenceStreamRelay, inferenceBroker, liveSharedModelRoutes, publicInferenceModel });

 mountConnectionsRoutes(app, { ...coreDeps(), buildInboxSql, isConnectionSocketLive, publicAgentConnection });
 mountAgentPermissionRoutes(app, {
  ...coreDeps(),
  decideAgentPermissionRequest,
  grantAgentPermissionRule,
  listAgentPermissionRequests,
  revokeAgentPermissionRule,
  setAgentPermissionMode,
 });
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
  listAgentTemplates, createAgentTemplate, saveAgentAsTemplate, importAgentTemplate,
  updateAgentTemplate, deleteAgentTemplate,
 });
 // The agent marketplace. Browse is any signed-in user (listings are published
 // on purpose); publish, unpublish, copy and hire are 'manage' — each one
 // either pushes prose across the tenant boundary or stands up an arrangement
 // with another tenant's agent, and each is audited.
 mountMarketplaceRoutes(app, {
  ...coreDeps(),
  listMarketplaceListings, listWorkspaceMarketplaceListings,
  publishMarketplaceListing, unpublishMarketplaceListing,
  copyMarketplaceListing, hireMarketplaceListing,
  listMarketplaceHires, endMarketplaceHire,
 });
 // The app-side skill store. Authoring is 'write' for the same reason as a
 // template — a 'write' member can already type prose into an agent's
 // system_prompt, which the agent obeys as TRUSTED text every turn, while a
 // skill body reaches an agent FENCED as untrusted reference data. Generic
 // /backend/db writes on the table are gated to 'manage', so this is the only
 // door where the validator runs.
 mountWorkspaceSkillRoutes(app, {
  ...coreDeps(),
  listSkills: listWorkspaceSkillRows,
  createSkill: createWorkspaceSkill,
  updateSkill: updateWorkspaceSkill,
  deleteSkill: deleteWorkspaceSkill,
 });
 mountInboxRoutes(app, { ...coreDeps(), INBOX_DEFAULT_LIMIT, INBOX_FILTERS, INBOX_MAX_LIMIT, THREAD_INBOX_DEFAULT_LIMIT, buildInboxSql, buildThreadInboxSql, inboxMentionHandle, inboxMentionPattern, toInboxItem, toThreadInboxItem });
 // Stop one running turn. Deliberately NOT part of sessions-routes: clearing or
 // closing a conversation also deletes its messages, and "stop what you are
 // doing" must not be reachable only through a destructive door.
 mountAgentJobCancelRoutes(app, {
  ...coreDeps(),
  agentJobCancelRateLimiter,
  cancelBuiltinJob,
  scheduleTaskQueueDrain: (...a) => taskDispatch.scheduleTaskQueueDrain(...a),
  drainPendingChatTurn: (...a) => drainPendingChatTurn(...a),
  sendToConnection,
  onWarn: message => console.warn(`[agent-job-cancel] ${message}`),
 });
 mountReactionsRoutes(app, { ...coreDeps(), reactionRateLimiter });
 mountReadReceiptsRoutes(app, { ...coreDeps(), readReceiptRateLimiter });
 mountSessionAccessRoutes(app, { ...coreDeps(), revokeRealtimeAccessForMember });
 mountLinkPreviewsRoutes(app, { ...coreDeps(), LINK_PREVIEW_COLUMNS, LINK_PREVIEW_MAX_PER_REQUEST, fetchLinkPreview, fetchPreviewImage, linkPreviewCacheKey, linkPreviewDbRateLimiter, linkPreviewImageDbRateLimiter, linkPreviewImageRateLimiter, linkPreviewRateLimiter, normalizeUnfurlUrl, publicLinkPreview, upsertLinkPreview });
 mountFeedbackRoutes(app, {
  ...coreDeps(), feedbackRateLimiter, feedbackDbRateLimiter, dbQuery,
  normalizeFeedbackSubmission, insertFeedbackReport,
 });

 mountTenantsRoutes(app, { ...coreDeps(), ...cursorBuddyGuides, dbQuery, CAMPAIGN_CATEGORIES, assertSendable, assertSystemOwner, buildSegmentPreview, campaignMessageDbRateLimiter, campaignMessageRateLimiter, createCampaign, describeSegment, dismissCampaignMessage, getTenantAccount, listCampaigns, listTenantAccounts, listUserCampaignMessages, loadTenantFacts, normalizeCampaignInput, normalizeSegment, selectSegmentMatches, tenantsDbRateLimiter, tenantsRateLimiter });
 mountSchedulesRoutes(app, {
  ...coreDeps(),
  runDueSchedules,
  roleHasWorkspaceCapability,
 });

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
 // Transport, auth and the tool surface all live in server/mcp.cjs.
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

 mountMcpDoorsRoutes(app, {
  ...coreDeps(),
  mcpHandler,
  normalizeBaseUrl,
  renderSkillMd,
  requestBaseUrl,
  skillManifest,
  skillRateLimiter,
  oauthWwwAuthenticate: (req) => {
   const base = normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
    || normalizeBaseUrl(process.env.AGENSIS_PUBLIC_URL)
    || requestBaseUrl(req);
   return mcpOauthShared.wwwAuthenticateHeader(base);
  },
 });
 mountMcpOauthRoutes(app, {
  ...coreDeps(),
  dcrRateLimiter: mcpOauthDcrRateLimiter,
  hashAgentToken,
  normalizeBaseUrl,
  requestBaseUrl,
  verifyToken,
 });

 mountAuthRoutes(app, {
  ...coreDeps(),
  createPasswordHash, emailLookupRateLimiter, evaluatePasswordServerSide,
 isReservedSignupEmail, issueToken, setCachedTokenVersion,
  revokeRealtimeAccessForMember,
  notifyReadReceiptPreference,
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
  agentNextSteps, controllerNextSteps, bearerToken, configBlock,
  createAgentConnectToken, createControllerCredential,
  hashAgentToken, invalidDescriptor, isJoinLinkToken, joinApiBaseUrl,
  joinDescriptor, joinLinkRateLimiter, joinLinkRefused, joinPublicBaseUrl,
  joinRedeemDbRateLimiter, joinRedeemRateLimiter, joinWantsJson,
  loadJoinLinkForDisplay, logJoinLinkActivity, machinePayload, mcpEndpoint,
  previewDescriptor, publicFarmEnrolledAgent, renderJoinHtml,
  setJoinJsonHeaders, setJoinPageHeaders, uniqueAgentHandle, verifyToken,
 });

 mountJoinLinksRoutes(app, { ...coreDeps(), createJoinLinkToken, hashAgentToken, joinLinkTtlMs, joinPublicBaseUrl, joinUrlFor, logJoinLinkActivity });
 mountControllerRoutes(app, { ...coreDeps() });
 mountWorkspaceResourceRoutes(app, {
  ...coreDeps(),
  workspaceResources,
  resourceOperationRateLimiter,
 });

 mountFlowRoutes(app, { ...coreDeps(), createPostgresFlowConnectionStore, getFlowConnectionCore, mcpEndpoint, normalizeBaseUrl, normalizeFlowWebhookUrl, requestBaseUrl });
 mountWorkspaceMcpRoutes(app, { ...coreDeps(), claudeMcpAddCommand, configBlock, createWorkspaceMcpToken, decideAgentRegistration, hashAgentToken, mcpEndpoint, normalizeBaseUrl, requestBaseUrl });

 app.post('/backend/db/select', requireAuth, async (req, res) => {
  try {
   const { table, columns = '*', filters = [], orderBy = null, limit = null, single = false } = req.body || {};
   const tableSql = ensureTable(table);
   assertGenericSelectAllowed(table);
   await enforceDbOperationAccess(req.userId, table, 'select', { filters });
   const where = table === 'workspaces'
    ? appendWorkspaceAccessClause(buildWhereClause(filters, []), req.userId)
    // enforceDbOperationAccess can only answer "may you"; it cannot drop rows.
    // A chat_sessions select filtered by workspace_id would otherwise hand back
    // every DM's title and roster.
    : appendSessionAccessClause(buildWhereClause(filters, []), req.userId, table);
   const { clause, params } = where;
   const safeColumns = safeSelectColumns(table, columns);
   const normalizedColumns = normalizeColumns(safeColumns);
   const requestedColumns = String(safeColumns || '*').split(',').map((column) => column.trim());
   const appendedDeletedAt = table === 'messages'
    && normalizedColumns !== '*'
    && !requestedColumns.includes('deleted_at');
   const queryColumns = appendedDeletedAt
    ? `${normalizedColumns}, "deleted_at"`
    : normalizedColumns;
   const rows = await getDb().unsafe(`select ${queryColumns} from ${tableSql}${clause}${buildOrderClause(orderBy)}${Number.isInteger(limit) ? ` LIMIT ${Number(limit)}` : ''}`, params);
   const publicRows = table === 'messages'
    ? redactDeletedMessageRows(rows).map((row) => {
     if (!appendedDeletedAt) return row;
     const { deleted_at: _projectionOnly, ...projected } = row;
     return projected;
    })
    : rows;
   res.json({ data: single ? (publicRows[0] ?? null) : publicRows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/db/insert', requireAuth, async (req, res) => {
  try {
   const { table, values, returning = '*', single = false } = req.body || {};
   const tableSql = ensureTable(table);
   await enforceDbOperationAccess(req.userId, table, 'insert', { values });
   const messageAuthor = table === 'messages'
    ? await loadBrowserMessageAuthor({ userId: req.userId, db: sharedDbAdapter })
    : null;
   const rows = (Array.isArray(values) ? values : [values]).map(row => {
    // Validate before any object spread can turn an array or other non-record
    // value into a record that appears safe only after server normalization.
    validateUniformInsertRows([row]);
    let next = stripPrivilegedDbValues(table, row);
    next = stampTaskWriteIdentity(table, next, req.userId, { insert: true });
    next = applyAgentPurposeInsertDefaults(table, next);
    if (table === 'workspaces') next = { ...next, user_id: req.userId };
    if (table === 'messages') next = stampBrowserMessageInsert(next, messageAuthor);
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
   // Validate the caller-visible projection before opening a transaction or
   // writing anything. A forbidden/invalid RETURNING shape must not create a
   // conversation and then fail while formatting the response.
   if (table === 'chat_sessions') {
    projectSessionCreateRows([], returning);
    // Pure lineage shape validation belongs before the transaction. A malformed
    // child with two parent edges must not open a write transaction first.
    rows.forEach(sessionLineageKind);
   }
   const insertRows = async (db) => {
    let effectiveRows = rows;
    let lineage = null;
    if (table === 'chat_sessions') {
     const prepared = await prepareSessionCreateRows({
      db,
      userId: req.userId,
      rows,
     });
     effectiveRows = prepared.rows;
     lineage = prepared.lineage;
    }
    const columns = validateUniformInsertRows(effectiveRows);
    const params = [];
    const valueBindings = effectiveRows.map((row) => columns.map((column) => {
     return bindDbParam(params, table, column, row[column]);
    }));
    const insertSource = buildGenericInsertSource({
     table,
     columns,
     valueBindings,
     rows: effectiveRows,
     params,
    });
    // Session membership settlement needs the authoritative id/visibility
    // before commit. The internal return uses the complete reviewed public
    // session shape; the caller's narrower projection is applied after commit.
    const returningColumns = table === 'chat_sessions' ? '*' : returning;
    const inserted = await db(
     `insert into ${tableSql} (${columns.map(quoteIdent).join(', ')}) ${insertSource} returning ${normalizeColumns(safeSelectColumns(table, returningColumns))}`,
     params,
    );
    if (table === 'messages' && inserted.length !== effectiveRows.length) {
     throw forbidden('Message parent must belong to the target conversation');
    }
    if (table === 'chat_sessions') {
     await installCreatedSessionMemberships({
      db,
      userId: req.userId,
      createdRows: inserted,
      lineage,
     });
    }
    return inserted;
   };
   const result = table === 'chat_sessions'
    ? await getDb().begin((transaction) => insertRows(
     (sql, params) => transaction.unsafe(sql, params),
    ))
    : await insertRows(sharedDbAdapter);

   // The transaction above has committed before any session row can fan out.
   // No socket can observe a private child before its inherited member graph.
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

   const responseRows = table === 'chat_sessions'
    ? projectSessionCreateRows(result, returning)
    : table === 'messages' ? redactDeletedMessageRows(result) : result;
   res.json({ data: single ? (responseRows[0] ?? null) : responseRows, error: null });
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
   const safeValues = stampTaskWriteIdentity(
    table,
    stripImmutableDbUpdateValues(table, stripPrivilegedDbValues(table, values)),
    req.userId,
   );

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
   if (keys.length === 0 && !lockPatch) {
    return jsonError(res, 400, new Error('No updatable fields provided'));
   }
   // workspace_agents.version is server-owned: stripPrivilegedDbValues removed
   // any caller value, so an agent edit can only advance the stored counter.
   // Other legacy versioned tables retain their explicit-version behaviour.
   const shouldBumpVersion = VERSIONED_TABLES.has(table) && safeValues.version == null;

   const params = [];
   const setParts = keys.map((column) => `${quoteIdent(column)} = ${bindDbParam(params, table, column, markedValues[column])}`);
   if (table === 'tasks' && Object.prototype.hasOwnProperty.call(markedValues, 'assignee_id')) {
    // SQL expressions in one UPDATE read the OLD row. This preserves requester
    // A when B merely re-saves the same assignee, while an actual transition
    // atomically records B (or clears on unassign) before any async dispatch.
    const assigneeBind = bindDbParam(params, table, 'assignee_id', markedValues.assignee_id);
    const assigned = typeof markedValues.assignee_id === 'string'
     ? markedValues.assignee_id.trim()
     : markedValues.assignee_id;
    const requesterBind = bindDbParam(
     params,
     table,
     'dispatch_requested_by',
     assigned ? req.userId : null,
    );
    setParts.push(taskDispatchRequesterSql(assigneeBind, requesterBind));
   }
   if (lockPatch) {
    // Base is the stored column (a rename must not clobber the voice); locks
    // merge INTO the stored ones, so a client cannot forge a lock for a field
    // it did not write and a stale echo cannot un-protect a chosen field.
    const voiceBound = voice !== undefined ? bindDbParam(params, table, 'identity', voice) : null;
    setParts.push(`"identity" = ${identityWriteSql(voiceBound, bindDbParam(params, table, 'identity', lockPatch))}`);
   }
   if (shouldBumpVersion) {
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
     `select id, workspace_id, visibility, folder, deleted_at from ${tableSql}${priorWhere.clause}`,
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

   const mutationFilters = appendMessageAuthorshipFilters({
    userId: req.userId,
    table,
    op: 'update',
    filters,
    values,
   });
   const where = appendMessageMutationAccessClause(
    buildWhereClause(mutationFilters, params),
    req.userId,
    table,
   );
   const editsMessageContent = table === 'messages'
    && Object.prototype.hasOwnProperty.call(safeValues, 'content');
   const closesSessions = table === 'chat_sessions'
    && Object.prototype.hasOwnProperty.call(safeValues, 'deleted_at')
    && safeValues.deleted_at != null;
   if (
    table === 'chat_sessions'
    && Object.prototype.hasOwnProperty.call(safeValues, 'deleted_at')
    && safeValues.deleted_at == null
   ) {
    throw badRequest('A closed conversation cannot be reopened through the generic database route');
   }
   const changesSessionPrivacy = table === 'chat_sessions'
    && (
     Object.prototype.hasOwnProperty.call(safeValues, 'visibility')
     || Object.prototype.hasOwnProperty.call(safeValues, 'folder')
    );
   let scrubbedActivity = [];
   let sessionClosureEffects = null;
   let canonicalClosedSessionRows = [];
   const projectedReturning = normalizeColumns(safeSelectColumns(table, returning));
   const integrityReturning = editsMessageContent
    ? `${projectedReturning}, id as "__integrity_id", session_id as "__integrity_session_id"`
    : closesSessions
     ? `${projectedReturning}, id as "__integrity_id"`
     : changesSessionPrivacy
      ? `${projectedReturning}, id as "__integrity_id", visibility as "__integrity_visibility", folder as "__integrity_folder"`
      : projectedReturning;
   const rawResult = editsMessageContent || changesSessionPrivacy || closesSessions
    ? await getDb().begin(async (transaction) => {
     let lockedSessionIds = [];
     if (closesSessions) {
      const lockWhere = buildWhereClause(filters, []);
      lockWhere.params.push(req.userId);
      const userParam = `$${lockWhere.params.length}`;
      const accessJoin = lockWhere.clause ? ' and ' : ' where ';
      const locked = await transaction.unsafe(
       `select close_session_scope.id
          from chat_sessions close_session_scope
          ${lockWhere.clause}${accessJoin}${sessionReadableSql(
            'close_session_scope',
            userParam,
            { lockMembership: true },
           )}
          for update of close_session_scope`,
       lockWhere.params,
      );
      lockedSessionIds = locked.map(row => String(row.id));
      if (lockedSessionIds.length === 0) {
       throw forbidden('Conversation access changed before the close completed');
      }
      if (lockedSessionIds.length !== 1) {
       throw badRequest('Conversations must be closed one at a time');
      }
      sessionClosureEffects = await settleSessionClosure({
       query: (sql, sqlParams) => transaction.unsafe(sql, sqlParams),
       hostSessionIds: lockedSessionIds,
       // The generic UPDATE below owns the host row so its requested returning
       // projection and version semantics remain intact. Linked transcript
       // sessions still close inside the same transaction.
       closeHostSessions: false,
      });
     }
     const updated = await transaction.unsafe(
      `update ${tableSql} set ${setClause}${where.clause} returning ${integrityReturning}`,
      where.params,
     );
     if (closesSessions && updated.length !== lockedSessionIds.length) {
      throw forbidden('Conversation access changed before the close completed');
     }
     if (closesSessions) {
      // Re-read the complete current rows while their UPDATE locks are still
      // held. Client-controlled RETURNING remains the HTTP projection only; it
      // must never become the shape of a realtime lifecycle event.
      canonicalClosedSessionRows = await transaction.unsafe(
       `select ${SESSION_RETURNING}
          from chat_sessions
         where id = any($1::uuid[])
         order by id`,
       [toPgArrayLiteral(lockedSessionIds)],
      );
      if (canonicalClosedSessionRows.length !== lockedSessionIds.length) {
       throw forbidden('Conversation closure could not be canonicalized');
      }
     }
     if (editsMessageContent) {
      for (const row of updated) {
       const activityRows = await scrubEditedMessageActivityByMessageId({
        db: (sql, sqlParams) => transaction.unsafe(sql, sqlParams),
        messageId: row.__integrity_id,
        sessionId: row.__integrity_session_id,
       });
       scrubbedActivity.push(...activityRows);
      }
     } else if (!closesSessions) {
      for (const row of updated) {
       if (!closesSessions && !isPrivateSessionRow({
        visibility: row.__integrity_visibility,
        folder: row.__integrity_folder,
       })) continue;
       await scrubMessageActivityBySession({
        db: (sql, sqlParams) => transaction.unsafe(sql, sqlParams),
        sessionId: row.__integrity_id,
       });
      }
     }
     return updated;
    })
    : await getDb().unsafe(
     `update ${tableSql} set ${setClause}${where.clause} returning ${integrityReturning}`,
     where.params,
    );
   const result = rawResult.map((row) => {
    const next = { ...row };
    delete next.__integrity_id;
    delete next.__integrity_session_id;
    delete next.__integrity_visibility;
    delete next.__integrity_folder;
    return next;
   });
   if (table === 'messages' && result.length === 0) {
    throw forbidden('Message access changed before the edit completed');
   }

   // `returning` is client-controlled, but realtime is a server protocol. A
   // narrow response such as `returning: 'id'` must not turn a close event into
   // an id-only frame. The canonical rows above carry every session field from
   // the committed write while `result` preserves the requested HTTP shape.
   const realtimeResult = closesSessions ? canonicalClosedSessionRows : result;
   notifyDbSubscribers(table, 'UPDATE', realtimeResult);
   if (sessionClosureEffects) {
    await applySessionClosureRuntimeEffects(sessionClosureEffects, {
     notifyDbSubscribers,
     cancelBuiltinJob,
     sendToConnection,
     scheduleTaskQueueDrain: (...a) => taskDispatch.scheduleTaskQueueDrain(...a),
     endHuddleRoom: deleteLivekitRoom,
     onWarn: (message) => console.warn('[session-close]', message),
    });
    const closedHost = result[0];
    void recordAudit({
     workspaceId: closedHost?.workspace_id || priorSessionRows[0]?.workspace_id || null,
     actor: { userId: req.userId },
     action: 'chat_session.cleared',
     target: { type: 'chat_session', id: closedHost?.id || priorSessionRows[0]?.id || '' },
     detail: {
      sessionIds: sessionClosureEffects.allSessionIds.join(','),
      clearedMessages: sessionClosureEffects.clearedMessages,
      cancelledJobs: sessionClosureEffects.jobs.length,
      expiredPermissionRequests: sessionClosureEffects.permissionRequests.length,
      endedHuddles: sessionClosureEffects.huddles.length,
     },
    });
   }
   if (scrubbedActivity.length > 0) {
    notifyDbSubscribers('activity_events', 'UPDATE', scrubbedActivity);
   }

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
   for (const before of priorTaskRows) {
    if (String(before.assignee_id || '') === nextAssigneeId) continue;
    void dispatchTaskAssignment({
     workspaceId: before.workspace_id,
     taskId: before.id,
     agentId: nextAssigneeId,
     actorUserId: req.userId,
    }).catch((error) => console.error('dispatchTaskAssignment failed', error));
   }

   const publicResult = table === 'messages' ? redactDeletedMessageRows(result) : result;
   res.json({ data: single ? (publicResult[0] ?? null) : publicResult, error: null });
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
   const mutationFilters = appendMessageAuthorshipFilters({
    userId: req.userId,
    table,
    op: 'delete',
    filters,
   });
   const where = appendMessageMutationAccessClause(
    buildWhereClause(mutationFilters, []),
    req.userId,
    table,
   );
   if (!where.clause) {
    return jsonError(res, 400, new Error('Delete requires a non-empty where clause'));
   }
   await enforceDbOperationAccess(req.userId, table, 'delete', { filters });
   const deleteReturning = normalizeColumns(safeSelectColumns(table, '*'));
   // Physical message deletion is not author-local: FK cascades would also
   // erase other people's replies and whole subthread sessions. A user's
   // delete therefore retains the row and only hides it from normal reads.
   let scrubbedActivity = [];
   const result = table === 'messages'
    ? await getDb().begin(async (transaction) => {
     // The logger takes a SHARE lock before mirroring a live message. Updating
     // first makes any in-flight logger finish; the second statement then gets
     // a fresh READ COMMITTED snapshot and cannot miss its just-committed row.
     const deleted = await transaction.unsafe(
      `update ${tableSql}
          set deleted_at = coalesce(deleted_at, now())
          ${where.clause} and deleted_at is null
        returning ${deleteReturning}`,
      where.params,
     );
     if (deleted.length === 0) {
      throw forbidden('Message access changed before the delete completed');
     }
     scrubbedActivity = await scrubMessageActivityByMessageId({
      db: (sql, params) => transaction.unsafe(sql, params),
      messageId: deleted[0].id,
      sessionId: deleted[0].session_id,
     });
     return deleted;
    })
    : await getDb().unsafe(
     `delete from ${tableSql}${where.clause} returning ${deleteReturning}`,
     where.params,
    );
   if (table === 'messages' && result.length === 0) {
    throw forbidden('Message access changed before the delete completed');
   }
   notifyDbSubscribers(table, table === 'messages' ? 'UPDATE' : 'DELETE', result);
   if (scrubbedActivity.length > 0) {
    notifyDbSubscribers('activity_events', 'UPDATE', scrubbedActivity);
   }
   const publicResult = table === 'messages' ? redactDeletedMessageRows(result) : result;
   res.json({ data: single ? (publicResult[0] ?? null) : null, error: null });
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
  emitBridgeOutbound: (...args) => channelBridges.emitBridgeOutbound(...args),
  logMessageActivity,
  recordAnthropicUsage, createAnthropicUsageAccumulator,
 });

 // LAST, deliberately — see server/static-site.cjs. The self-hosted container
 // sets AGENSIS_STATIC_ROOT to the built frontend so one origin serves the app,
 // the API and the websocket; fly.toml does not set it, so the split deploy
 // (Netlify frontend + this backend) behaves exactly as before.
 if (process.env.AGENSIS_STATIC_ROOT) {
  mountStaticSite(app, { root: process.env.AGENSIS_STATIC_ROOT });
 }

 return app;
}

// `handleSignals` is OFF by default and turned on only by the standalone entry
// point at the bottom of this file. electron/main.cjs also calls this function,
// in the Electron MAIN process, where it already owns shutdown through
// app.on('before-quit') -> backendServer.close(). Installing our own SIGINT/
// SIGTERM handlers there would hijack that: Ctrl-C would exit(0) out of the
// drain below and skip Electron's own quit path entirely. The desktop app is
// not the deploy that needed this.
function startBackendServer(port = DEFAULT_PORT, { handleSignals = false } = {}) {
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
 void Promise.resolve(app.locals.runtimeSchemaReady)
  .then(() => nostrCommunities.startAll())
  .catch(error => console.error('[nostr] connection startup failed:', error?.message || error));
 // sweepAutomationRuns stays on the 30s tick: reclaiming a lease that expired
 // because a process died is housekeeping, and running it every second would be
 // 30x the query for no benefit. The DRAIN moved to its own 1s worker below.
 // Every sweep on this tick is independently re-entrancy guarded.
 //
 // The three workers below each carry their own in-flight boolean; this tick
 // carried none, and it is the tick with the slow passengers on it —
 // runDueThreadHarvests makes model calls (3 per tick) and runDueSchedules and
 // sweepAutomationRuns are DB scans that grow with the workspace. A sweep that
 // outlives its 30s interval used to simply start again on top of itself, so the
 // slower the database got the more concurrent copies of the same scan it was
 // asked to serve — the failure mode that turns a slow database into a dead one.
 //
 // PER-SWEEP and not one boolean for the whole tick: a slow harvest must not be
 // able to stop stuck jobs from being reaped. That is the same reasoning that
 // put the automation drain on its own worker rather than merging it into this
 // one.
 //
 // The .catch is not decoration. These were bare `void fn()` calls, so a
 // rejection became an unhandledRejection — survivable only because of the
 // last-resort process guard installed above, and invisible as to which sweep
 // failed.
 const sweepsInFlight = new Set();
 const guardedSweep = (name, fn) => {
  if (sweepsInFlight.has(name)) return;
  sweepsInFlight.add(name);
  void Promise.resolve()
   .then(fn)
   .catch((error) => console.error(`[reaper] ${name} failed:`, error?.message || error))
   .finally(() => { sweepsInFlight.delete(name); });
 };
 const jobReaper = setInterval(() => {
  guardedSweep('reapStuckAgentJobs', reapStuckAgentJobs);
  guardedSweep('reapStuckMcpJobs', reapStuckMcpJobs);
  guardedSweep('expireStalePermissionRequests', expireStalePermissionRequests);
  guardedSweep('pruneOfflineConnections', pruneOfflineConnections);
  guardedSweep('runDueSchedules', runDueSchedules);
  guardedSweep('runDueThreadHarvests', runDueThreadHarvests);
  guardedSweep('sweepAutomationRuns', sweepAutomationRuns);
  // Synchronous and in-memory — no guard needed, and no reason to pay for one.
  try { pruneExpiredPeerTickets(); } catch (error) { console.error('[reaper] pruneExpiredPeerTickets failed:', error?.message || error); }
 }, 30_000);
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
  nostrCommunities.stopAll();
  realtime.reset();
 });

 // Graceful shutdown.
 //
 // Fly sends SIGTERM on every deploy, restart and machine move. Node's DEFAULT
 // SIGTERM action is to exit immediately, and until now that is exactly what
 // happened: no handler existed anywhere in this process. Every WebSocket died
 // as a 1006 abnormal close, which is the one close code that carries no reason
 // and no intent — so every daemon and every browser learned about the deploy by
 // having its socket vanish mid-frame, and every in-flight agent turn sat as
 // 'running' until the 30s reaper failed it. A deploy cost users their work.
 //
 // What this does instead, in the order that matters:
 //  1. Stop accepting new connections, so the load balancer drains us.
 //  2. Tell every open socket WHY, with a close code that means "come back".
 //     1012 (Service Restart) is chosen deliberately: the daemon treats only
 //     `1008 + /agent deactivated|authentication failed/` as terminal, so 1012
 //     lands in its normal reconnect path, and the browser client's 'close'
 //     handler drives its usual backoff. Neither is told to give up.
 //  3. Give the close frames a moment to actually leave, then exit.
 //
 // SHUTDOWN_GRACE_MS must stay under fly.toml's kill_timeout or Fly SIGKILLs us
 // mid-drain and we are back to 1006.
 const SHUTDOWN_GRACE_MS = Number(process.env.AGENSIS_SHUTDOWN_GRACE_MS || 3_000);
 let shuttingDown = false;
 const shutdown = (signal) => {
  // A second signal during the drain means someone is impatient (or Fly is
  // escalating). Go now rather than restarting the timer.
  if (shuttingDown) {
   console.log(`[backend] ${signal} during shutdown — exiting now`);
   process.exit(0);
   return;
  }
  shuttingDown = true;
  console.log(`[backend] ${signal} received — draining ${wss.clients.size} websocket client(s)`);
  // Stops new connections and fires the 'close' handler above, which clears
  // every interval so nothing new is started while we drain.
  server.close();
  if (wss.clients.size === 0) {
   console.log('[backend] shutdown complete');
   process.exit(0);
   return;
  }
  for (const client of wss.clients) {
   try { client.close(1012, 'Server restarting'); } catch { /* already closing */ }
  }
  // Deliberately NOT unref'd: this timer is the thing keeping us alive long
  // enough for those close frames to leave the box. Unref'ing it would let the
  // process exit the instant the last other handle drops, which is the 1006 we
  // are here to stop sending.
  setTimeout(() => {
   // Anything still holding a socket open past the grace window gets cut; we
   // have already said why, and Fly's kill_timeout is not negotiable.
   for (const client of wss.clients) {
    try { client.terminate(); } catch { /* already gone */ }
   }
   console.log('[backend] shutdown complete');
   process.exit(0);
  }, SHUTDOWN_GRACE_MS);
 };
 if (handleSignals) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
 }

 return server;
}

if (require.main === module) {
 // The standalone deploy (Fly, Docker, `npm run backend`) — the only caller that
 // owns the whole process, and therefore the only one allowed to install signal
 // handlers. See startBackendServer's `handleSignals`.
 startBackendServer(DEFAULT_PORT, { handleSignals: true });
}

function setTestDb(nextDb) {
 // Older recording fakes predate transactional commands. Keep the production
 // code honest (it always requires begin/row locks) while adapting only the
 // explicit test seam. Dedicated transaction tests use their own `begin` and
 // therefore bypass this compatibility layer entirely.
 if (
  process.env.AGENSIS_TEST === '1'
  && nextDb
  && typeof nextDb.unsafe === 'function'
  && typeof nextDb.begin !== 'function'
 ) {
  const unsafe = nextDb.unsafe.bind(nextDb);
  nextDb.begin = async (callback) => {
   const testOwnerId = '00000000-0000-4000-8000-000000000099';
   const transaction = {
    async unsafe(sql, params = []) {
     const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
     if (normalized.startsWith('select user_id from workspaces where id = $1')) {
      return [{ user_id: testOwnerId }];
     }
     if (normalized.startsWith('select id, parent_id, user_id from workspaces')) {
      const userId = params[1];
      if (String(userId) === testOwnerId) {
       return [{ id: params[0], parent_id: null, user_id: testOwnerId }];
      }
      const owner = await unsafe(
       'select 1 from workspaces where id = $1 and user_id = $2 limit 1',
       [params[0], userId],
      );
      return [{
       id: params[0],
       parent_id: null,
       user_id: owner.length > 0 ? userId : null,
      }];
     }
     if (normalized.startsWith('select user_id, source, (user_id = $2::uuid) as requested_user')) {
      const rows = await unsafe(sql, params);
      return rows.length > 0 ? rows : [{ user_id: params[1], source: 'participant' }];
     }
     return unsafe(sql, params);
    },
    async savepoint(callback) {
     // Compatibility only for legacy recording fakes. Dedicated huddle tests
     // provide a real snapshot/rollback savepoint; this adapter's purpose is to
     // ensure old fakes execute the transcript/member path instead of throwing
     // before the first statement and silently exercising only the fallback.
     return callback(transaction);
    },
   };
   return callback(transaction);
  };
 }
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
 nostrCommunities.stopAll();
 clearPendingJobFailures();
 taskDispatch.reset();
 conversationLocks.clear();
 pendingChatTurns.clear();
 ambientElectionBudget.reset();
 workspaceIdBySessionCache.clear();
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
  notifyReadReceiptPreference,
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
  buildAgentConnectionCommand,
  publicAgentConnectionCommandAgent,
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
  verifyAgentConnectToken,
  verifyToken,
  // Token revocation cache — exposed so tests can assert the cache is real
  // (not a no-op) without hardcoding its TTL.
  TOKEN_VERSION_CACHE_TTL_MS,
  getCachedTokenVersion,
  workspaceIdFromRealtimeChannel,
  resourceOperationFromRealtimeChannel,
  // Socket liveness — a daemon must survive a single missed pong.
  sweepLiveness: (...args) => realtime.sweepLiveness(...args),
  LIVENESS_MAX_MISSED_PONGS: realtime.LIVENESS_MAX_MISSED_PONGS,
  LIVENESS_PING_INTERVAL_MS: realtime.LIVENESS_PING_INTERVAL_MS,
  clearPendingJobFailures,
  // MCP connect-a-client model — exercised against a fake DB.
  verifyWorkspaceMcpToken,
  verifyControllerToken,
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
  runDueSchedules,
  explicitConversationAgent,
  resolveWorkThreadParent,
  loadChannelMessages,
  sanitizeRealtimeRow,
  truncateAgentStatusContent,
  AGENT_STATUS_CONTENT_MAX,
  REALTIME_HEAVY_FIELDS,
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
  dispatchResourceOperation,
  dispatchTaskAssignment,
  findOrCreateDirectSession,
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
  daemonStopUsage,
  failureSentence,
  validateAmpJobResult,
  dispatchFarmAgentJob,
  disableFarmIntegrationAgents,
  getFarmAgentJob,
  cancelFarmAgentJob,
  handleAgentJobDelta,
  handleAgentJobStep,
  handleAgentPermissionPrepared,
  handleAgentPermissionRequest,
  decideAgentPermissionRequest,
  listAgentPermissionRequests,
  expireStalePermissionRequests,
  expireConnectionPermissionRequests,
  rehomePendingPermissionRequests,
  replayPermissionDecisions,
  grantAgentPermissionRule,
  listAgentPermissionRules,
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
  parkChatTurn,
  drainPendingChatTurn,
  pendingChatTurns,
  verifyNetlifyDeploySignature,
  buildSystemPrompt,
  normalizeAiChatMessages,
 },
};
