import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getDatabase } from '@netlify/database';
import { getUser } from '@netlify/identity';
import {
 verifyAuthToken,
 issueAuthToken,
 enforceDbOperationAccess,
 assertWorkspaceRole,
 appendWorkspaceAccessClause,
 appendSessionAccessClause,
 logMessageActivityIdempotent,
 createRateLimiter,
 createDbRateLimiter,
 evaluatePasswordServerSide,
 createTokenVersionCache,
 ALLOWED_TABLES,
 VERSIONED_TABLES,
 JSON_COLUMNS_BY_TABLE,
 arrayColumnElemType,
 toPgArrayLiteral,
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
 aiStreamErrorText,
 redactDeletedMessageRows,
 scrubEditedMessageActivityByMessageId,
 scrubMessageActivityByMessageId,
 scrubMessageActivityBySession,
 getWorkspaceSecretValue as coreGetWorkspaceSecretValue,
 setWorkspaceSecretValue as coreSetWorkspaceSecretValue,
 VAULT_KEY_RE,
 listWorkspaceSecretMeta,
 listWorkspaceVaultEntries,
 normalizeFeedbackSubmission,
 insertFeedbackReport,
 badRequest,
 forbidden,
 enforceSessionReadAccess,
 assertWorkspaceRoleLocked,
 recordAuditEntry,
 isPrivateSessionRow,
 sessionReadableSql,
} from '../../shared/backend-core.cjs';
import { createWorkspaceResourceService } from '../../server/workspace-resources.cjs';
import {
 REACTION_CURRENT_SQL,
 explainReactionNoop,
 normalizeReactionOp,
 normalizeReactionValue,
 priorReactionMap,
 reactionToggleSql,
} from '../../shared/reaction-toggle.cjs';
import {
 ADVANCE_READ_MARKER_SQL,
 DELETE_HUMAN_READ_MARKERS_SQL,
 SESSION_READ_STATE_SQL,
 toReadMarker,
} from '../../shared/read-receipts.cjs';
import { SESSION_RETURNING, settleSessionClosure } from '../../shared/session-close.cjs';
import { createSessionSplit } from '../../shared/session-split.cjs';
import {
 AI_CHAT_SYSTEM_MAX_BYTES,
 loadStoredAiChatContext,
 lockAiChatRunScope,
 normalizeAndBoundAiChatMessages,
 truncateUtf8Middle,
} from '../../shared/ai-chat-context.cjs';
import {
 assertSystemOwner,
 isReservedSignupEmail,
 listTenantAccounts,
 getTenantAccount,
} from '../../shared/tenant-admin.cjs';
import {
 createOwnedGuide,
 deleteOwnedGuide,
 listCommunityGuides,
 listGuideSubmissions,
 listOwnedGuides,
 resolveCommunityGuide,
 reviewGuideSubmission,
 submitOwnedGuide,
 updateOwnedGuide,
} from '../../shared/cursorbuddy-guides.cjs';
// Cost metering, shared with the Fly lane so both backends write identically
// shaped rows into one table. FAIL-OPEN by contract — never wrap in try/catch.
import { recordAnthropicUsage, createAnthropicUsageAccumulator } from '../../shared/usage-metering.cjs';
import {
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
} from '../../shared/tenant-campaigns.cjs';
import { normalizeTaskTitle } from '../../shared/taskTitle.cjs';
import { markHumanIdentityWrite, identityWriteSql, synthesizeHumanIdentityInsert } from '../../shared/agentIdentity.cjs';
import {
 isReservedAgentHandle,
 reservedAgentHandleMessage,
 slugMentionHandle,
} from '../../shared/channelMentions.cjs';
import { voiceCapabilities, unavailableReason, mintCartesiaToken, scrubError } from '../../shared/voice-core.cjs';
// Reaction flow events. This lane can write `messages.reactions` through the
// same generic /backend/db/update route the Fly lane serves, so it queues the
// same deliveries into the same `flow_webhook_deliveries` table — the Fly
// delivery worker drains it. Wired into one lane and silently missing from the
// other is this repo's most repeated bug. Shared implementation; the ONLY
// difference is the jsonb bind (see encodeJsonb at the call site).
import { emitReactionFlowEventsForUpdate } from '../../shared/reaction-events.cjs';
import {
 installCreatedSessionMemberships,
 prepareSessionCreateRows,
 projectSessionCreateRows,
 sessionLineageKind,
} from '../../shared/session-lineage.cjs';

// Nostr invite preview is intentionally shared with the Fly protocol adapter.
// The preview performs the remote metadata fetch, so this mirror must carry the
// same HTTPS/SSRF guard and must strip the opaque invite code before responding.
// Without this route the UI's Check button falls through to the Netlify 404
// even though the long-running backend has the route.
const requireCjs = createRequire(import.meta.url);
const { createNostrProtocol } = requireCjs('../../server/nostr-community.cjs');
const { assertSafeOutboundUrl } = requireCjs('../../server/lib/net-guard.cjs');
const netlifyNostrProtocol = createNostrProtocol({ assertSafeOutboundUrl });

const READ_RECEIPT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalReadReceiptThreadParent(value) {
 const normalized = String(value || '').trim();
 if (!normalized) return null;
 if (!READ_RECEIPT_UUID_RE.test(normalized)) throw badRequest('threadParentId must be a UUID');
 return normalized;
}

// Plan 005 — token revocation. See shared/backend-core.mjs's verifyAuthToken/
// createTokenVersionCache doc comments for the full rationale.
//
// requireUserId (-> verifyAuthToken -> getTokenVersion) runs before every
// protected route. Schema provisioning is deliberately not part of that request:
// Netlify shares the primary database, so canonical schema + migrations must
// establish app_users.token_version before this function is deployed.
const tokenVersionCache = createTokenVersionCache();
async function getTokenVersion(userId) {
 return tokenVersionCache.get(userId, query);
}

// H4 — Rate limiting. Module-scoped, in-memory fixed-window limiters.
// NOTE: in-memory state lives in a single warm serverless instance; a
// multi-instance / scaled deploy needs a SHARED store (Redis, etc.) to be
// globally accurate. This is a first abuse-protection layer, not a hard quota.
const aiChatRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const dispatchRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
// Plan 004 — auth hardening: signin is keyed per-email (matches the client's
// documented "5 attempts" lockout intent); signup is keyed per-IP and looser,
// to slow down bulk account creation without punishing normal signup retries.
const signinRateLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
// Per-IP FAILED-attempt limiter (L3): bounds credential-stuffing across emails.
const signinIpFailureLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const signupRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
// Voice: a Cartesia token is a credential at a metered provider, so minting is
// bounded per user+workspace. Mirrors the Fly limiter's budget exactly.
const voiceTokenRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
// F9: curb email-enumeration via lookup_user_by_email — per-caller budget, on
// top of the 'manage' capability gate below (mirrors server/index.cjs).
const emailLookupRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
// Feedback: any signed-in user may submit, so this is the only thing standing
// between one account and an unbounded write into the System workspace's task
// list. Tight on purpose — nobody files five genuine bug reports a minute.
const feedbackRateLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
// Tenants (the system-owner admin surface). Mirrors server/index.cjs: every
// request costs a DB lookup of the caller's own email before it can be refused,
// so this is what stops an authenticated non-owner turning the 403 into a free
// query loop.
const tenantsRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const cursorBuddyGuidesRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
// Delivery side of owner broadcasts: read by every signed-in session, not by
// the operator, so it gets its own budget rather than sharing the admin one.
const campaignMessageRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
// Reactions and receipts. Budgets mirror server/index.cjs exactly — a client
// that hits one lane's limit and not the other's would be a difference nobody
// could explain from the UI.
const reactionRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const readReceiptRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const resourceOperationRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

function clientIpFromRequest(req) {
 // Prefer Netlify's trusted x-nf-client-connection-ip (set at the edge); never
 // trust the client-supplied leftmost x-forwarded-for for rate-limit keys (H2).
 const trusted = String(req.headers.get('x-nf-client-connection-ip') || '').trim();
 if (trusted) return trusted;
 return String(req.headers.get('x-forwarded-for') || '').split(',').pop().trim() || 'unknown';
}

// Returns a 429 Response (with Retry-After) when the key is over budget, else null.
function rateLimitBlock(limiter, key) {
 const result = limiter.check(key);
 if (result.allowed) return null;
 const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
 return new Response(
  JSON.stringify({ data: null, error: { message: 'Rate limit exceeded. Please retry shortly.', code: 'rate_limited' } }),
  { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) } },
 );
}

// Cross-instance layer (H4 follow-up). Netlify runs MANY concurrent lambdas, so
// the in-memory limiters above only bound one warm instance — the case this DB
// layer actually fixes. Layered: in-memory first (cheap), then the shared DB
// counter. `query` is hoisted (function declaration below), so referencing it
// here at module load is safe. DB errors fail open (see createDbRateLimiter).
const aiChatDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 30, db: query, namespace: 'ai-chat' });
const dispatchDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 60, db: query, namespace: 'dispatch' });
const feedbackDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 5, db: query, namespace: 'feedback' });
const tenantsDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 30, db: query, namespace: 'tenants' });
const cursorBuddyGuidesDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 120, db: query, namespace: 'cursorbuddy-guides' });
const campaignMessageDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 60, db: query, namespace: 'campaign-messages' });
const resourceOperationDbRateLimiter = createDbRateLimiter({ windowMs: 60_000, max: 120, db: query, namespace: 'resource-operations' });

// Async layered gate: returns a 429 Response when EITHER layer blocks, else null.
// Callers MUST await it.
async function dbRateLimitBlock(memLimiter, dbLimiter, key) {
 const k = String(key || 'unknown');
 const mem = memLimiter.check(k);
 const result = mem.allowed ? await dbLimiter.check(k) : mem;
 if (result.allowed) return null;
 const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
 return new Response(
  JSON.stringify({ data: null, error: { message: 'Rate limit exceeded. Please retry shortly.', code: 'rate_limited' } }),
  { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) } },
 );
}

const MANAGED_SECRET_KEYS = ['ANTHROPIC_API_KEY'];
const OPENPETS_CATALOG_URL = 'https://openpets.dev/pets/catalog.v3/page-000.json';
const CODEX_PETS_ROOT = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'pets');
let database;

// The whole architecture is TWO BACKENDS OVER ONE DATABASE (see AGENTS.md), so
// which connection string wins here is load-bearing, not a detail.
//
// This used to read NETLIFY_DB_URL || NETLIFY_DATABASE_URL || DATABASE_URL, which
// let a Netlify-provisioned database silently outrank the one an operator had
// explicitly configured. In production it did exactly that, and the two backends
// ended up on DIFFERENT databases:
//
//   - Google sign-in is the ONE route that must run on the Netlify origin (it
//     needs the edge-injected identity context), so it created the account here,
//     in the auto-provisioned database, and minted a token for it.
//   - Every other call goes to the Fly backend, which uses the real shared
//     database, could not find that user, and returned 401.
//
// The result was a user who signed in successfully and then got 401 on every
// single request, forever. No OAuth account ever reached the real database.
//
// Explicit configuration therefore wins, and the auto-provisioned vars are only
// a fallback for an environment where nobody set DATABASE_URL (matching how
// server/index.cjs resolves AUTH_SECRET: env first, generated fallback second).
export const DB_URL_VARS = ['DATABASE_URL', 'NETLIFY_DB_URL', 'NETLIFY_DATABASE_URL'];

/** Exported so the precedence can be tested without a live database. */
/**
 * A connection string only counts if it could actually connect.
 *
 * Precedence without validation is a loaded gun: production had DATABASE_URL set
 * to `=postgresql://…` — one stray leading `=` — and promoting it to first place
 * handed neon() a string it rejects, taking the whole function down while a
 * perfectly good fallback sat right behind it. A value that cannot be parsed is
 * not configuration, it is a typo, and it must not outrank something that works.
 */
function isUsableDbUrl(value) {
 if (!value) return false;
 try {
  const { protocol } = new URL(value);
  return protocol === 'postgres:' || protocol === 'postgresql:';
 } catch {
  return false;
 }
}

export function resolveDbUrl(env = process.env) {
 const rejected = [];
 for (const name of DB_URL_VARS) {
  const value = String(env[name] || '').trim();
  if (!value) continue;
  if (!isUsableDbUrl(value)) {
   rejected.push(name);
   continue;
  }
  return { connectionString: value, source: name, rejected };
 }
 return { connectionString: '', source: null, rejected };
}

function dbPool() {
 if (!database) {
  const { connectionString, source, rejected } = resolveDbUrl();
  if (rejected.length > 0) {
   console.error(`[db] ignoring malformed connection string in ${rejected.join(', ')}`);
  }
  // Loud, once, at cold start: a backend quietly talking to the wrong database
  // is the most expensive failure this file can have, and it is invisible from
  // the outside — every response looks healthy.
  const shadowed = DB_URL_VARS.filter(name => name !== source && String(process.env[name] || '').trim());
  if (source && shadowed.length > 0) {
   console.warn(`[db] using ${source}; ignoring also-set ${shadowed.join(', ')}`);
  }
  database = connectionString ? getDatabase({ connectionString }) : getDatabase();
  // A `pg` Pool emits 'error' for a client that fails while IDLE in the pool —
  // which against Neon is routine, not exceptional: it closes idle connections,
  // and a serverless container is idle between invocations almost by definition.
  // An 'error' event with no listener throws, and this one is emitted from a
  // socket callback with no request on the stack to catch it, so it takes the
  // whole function container down: the in-flight request 502s and the next
  // caller pays a cold start. The pool discards the bad client on its own — the
  // only thing missing was somebody willing to hear about it.
  database.pool?.on?.('error', (error) => {
   console.error('[db] idle client error:', error?.message || error);
  });
 }
 return database.pool;
}

function mapDbError(error) {
 // Never return Postgres `detail` to clients — it can leak stored values and
 // schema internals. Log it server-side, expose only message + code (L2).
 if (error?.detail) {
  console.error('[db-error]', { code: error.code, detail: error.detail, message: error.message });
 }
 return {
  message: error?.message || 'Database error',
  code: error?.code || null,
 };
}

const CORS_HEADERS = {
 'Access-Control-Allow-Origin': '*',
 'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key',
 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function json(data, status = 200) {
 return Response.json(data, { status, headers: CORS_HEADERS });
}

function jsonError(status, error) {
 return json({ data: null, error: mapDbError(error) }, status);
}

async function readBody(req) {
 return req.json().catch(() => ({}));
}

function createPasswordHash(password) {
 const salt = crypto.randomBytes(16).toString('hex');
 const hash = crypto.scryptSync(password, salt, 64).toString('hex');
 return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
 if (!passwordHash || !passwordHash.includes(':')) return false;
 const [salt, storedHash] = passwordHash.split(':');
 const hash = crypto.scryptSync(password, salt, 64).toString('hex');
 const computed = Buffer.from(hash, 'hex');
 const stored = Buffer.from(storedHash, 'hex');
 // timingSafeEqual throws on a length mismatch; treat as a failed verification.
 if (computed.length !== stored.length) return false;
 return crypto.timingSafeEqual(computed, stored);
}

// The canonical implementation lives in shared/channelMentions.cjs, beside the
// mention parser that has to produce the same string from an @mention of a
// handle this mints. Fly delegates to the same function.
function slugHandle(value) {
 return slugMentionHandle(value);
}

function hashAgentToken(token) {
 return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createAgentConnectToken() {
 return `aga_${crypto.randomBytes(32).toString('base64url')}`;
}

function normalizeAgentPermissionMode(value) {
 return value === 'accept_edits' || value === 'yolo' ? value : 'default';
}

function resolveAnthropicModel(model) {
 if (model === 'claude-sonnet-4-6') return 'claude-sonnet-4-5';
 if (model === 'claude-opus-4-6') return 'claude-opus-4-5';
 if (model === 'claude-haiku-4-5') return 'claude-haiku-4-5';
 if (model && model !== 'auto') return model;
 return 'claude-opus-4-5';
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

function daemonBaseUrl() {
 return normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL || process.env.AGENSIS_WS_BASE_URL || '');
}

function isDeployedNetlifyRuntime() {
 return process.env.NETLIFY === 'true'
  || Boolean(process.env.CONTEXT)
  || Boolean(process.env.DEPLOY_PRIME_URL);
}

/**
 * Destructive conversation control belongs to the long-running backend: only
 * that process can abort an in-process built-in stream or address the exact
 * daemon websocket. Netlify authenticates first, then forwards the same bearer
 * and payload. If deployment forgot the control-plane URL, fail closed rather
 * than committing a database-only "cancellation" while tools keep running.
 *
 * Returns null only in local unit/dev execution with no daemon base configured.
 */
async function forwardLongRunningControl(req, pathname, body, {
 requiredMessage,
 unavailableMessage,
 logTag,
}) {
 const baseUrl = daemonBaseUrl();
 if (!baseUrl) {
  if (!isDeployedNetlifyRuntime()) return null;
  return jsonErrorWithData(
   503,
   new Error(requiredMessage),
   { requiredEnv: 'AGENSIS_DAEMON_BASE_URL' },
  );
 }
 const requestOrigin = new URL(req.url).origin.replace(/\/+$/, '');
 if (baseUrl === requestOrigin) {
  if (!isDeployedNetlifyRuntime()) return null;
  return jsonErrorWithData(
   503,
   new Error(`${requiredMessage}: the daemon URL must not point back to Netlify`),
   { requiredEnv: 'AGENSIS_DAEMON_BASE_URL' },
  );
 }
 try {
  const requestHeaders = {
   authorization: req.headers.get('authorization') || '',
   'content-type': req.headers.get('content-type') || 'application/json',
  };
  // Join pages use content negotiation rather than User-Agent sniffing. Keep
  // the caller's Accept header on the forwarding hop or a machine requesting
  // JSON through Netlify would silently receive the HTML renderer instead.
  const accept = req.headers.get('accept');
  if (accept) requestHeaders.accept = accept;
  const idempotencyKey = req.headers.get('idempotency-key');
  if (idempotencyKey) requestHeaders['idempotency-key'] = idempotencyKey;
  const response = await fetch(`${baseUrl}${pathname}`, {
   method: req.method,
   headers: requestHeaders,
   ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseHeaders = { ...CORS_HEADERS };
  for (const name of [
   'content-type',
   'cache-control',
   'referrer-policy',
   'x-robots-tag',
   'x-content-type-options',
   'content-security-policy',
   'retry-after',
  ]) {
   const value = response.headers.get(name);
   if (value) responseHeaders[name] = value;
  }
  return new Response(await response.arrayBuffer(), {
   status: response.status,
   headers: responseHeaders,
  });
 } catch (error) {
  console.error(`[${logTag}] forward failed:`, error?.message || error);
  return jsonError(502, new Error(unavailableMessage));
 }
}

function isJoinBackendPath(pathname) {
 return /^\/backend\/join(?:\/|$)/.test(pathname)
  || /^\/backend\/workspaces\/[^/]+\/(?:join-links|controllers)(?:\/|$)/.test(pathname);
}

// Legacy human membership/invite callers still exist in access dialogs and in
// the `?invite=` compatibility flow.  Keep those paths on the same canonical
// Fly implementation too: it owns the audit writes, one-use acceptance
// transaction and realtime fanout.  Without this matcher an explicit Netlify
// backend base sends the collection/accept paths to the partial serverless
// mirror (or a 404), so the UI appears selectively broken depending on which
// invite surface opened it.
function isLegacyMembershipInvitePath(pathname) {
 return /^\/backend\/workspaces\/[^/]+\/(?:members|invites)(?:\/|$)/.test(pathname)
  || /^\/backend\/invites\/[^/]+(?:\/accept)?$/.test(pathname);
}

// These operations depend on the Fly process rather than just Postgres: they
// touch live daemon sockets, the automation worker, the append-only audit
// reader, or server-owned template validation/realtime.  Keep the serverless
// mirror from exposing a second, incomplete implementation.  The forwarding
// helper fails closed in a deployed Netlify runtime when the control-plane URL
// is missing, which is preferable to a successful-looking database write that
// never reaches the live worker.
function isFlyOwnedControlPath(pathname) {
 return /^\/backend\/agents\/connections\/[^/]+$/.test(pathname)
  || /^\/backend\/agents\/[^/]+\/(?:disconnect|memory-refresh|capabilities-refresh)$/.test(pathname)
  || /^\/backend\/workspaces\/[^/]+\/audit$/.test(pathname)
  || /^\/backend\/workspaces\/[^/]+\/(?:automations|automation-runs)(?:\/[^/]+)?$/.test(pathname)
  || /^\/backend\/workspaces\/[^/]+\/agent-templates(?:\/|$)/.test(pathname)
  || /^\/backend\/webhooks\/[^/]+$/.test(pathname)
  // HTTP mirrors for features whose canonical implementation needs the Fly
  // process (or whose Netlify lane intentionally has no route).  Keep the
  // list explicit: generic DB and ordinary stateless routes must continue to
  // use the local serverless implementation and its own access policy.
  || /^\/backend\/workspaces\/[^/]+\/(?:bootstrap|gateways|skills|schedules|my-threads|huddles|project-files|git|nostr-communities)(?:\/|$)/.test(pathname)
  || /^\/backend\/workspaces\/[^/]+\/sessions\/[^/]+\/huddle(?:\/|$)/.test(pathname)
  || /^\/backend\/workspaces\/[^/]+\/permission-requests(?:\/|$)/.test(pathname)
  || /^\/backend\/sessions\/[^/]+\/(?:messages|access|nostr-members)(?:\/|$)/.test(pathname)
  || /^\/backend\/schedules\/[^/]+(?:\/|$)/.test(pathname)
  || /^\/backend\/files\/(?:upload|[^/]+(?:\/content)?)$/.test(pathname)
  || /^\/backend\/workspaces\/[^/]+\/git\/(?:status|diff|stage|unstage|commit)$/.test(pathname)
  || /^\/backend\/tts\/(?:voices|preview)$/.test(pathname)
  || /^\/backend\/bridges(?:\/|$)/.test(pathname)
  || /^\/backend\/integrations\/farm(?:\/|$)/.test(pathname)
  || /^\/backend\/link-previews(?:\/|$)/.test(pathname)
  || /^\/backend\/system\/skill-content(?:\/|$)/.test(pathname)
  || /^(?:\/backend\/skill(?:\/|$)|\/api\/skill(?:\/|$)|\/skill(?:\/|$)|\/.well-known\/agent-skill(?:\/|$))/.test(pathname);
}

async function forwardCanonicalRoute(req, requestUrl) {
 const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
 return forwardLongRunningControl(
  req,
  `${requestUrl.pathname}${requestUrl.search}`,
  body,
  {
   requiredMessage: 'Unified join links require the long-running backend',
   unavailableMessage: 'The unified join service is unavailable',
   logTag: 'join-route',
  },
 );
}

async function forwardConversationControl(req, pathname, body = undefined) {
 return forwardLongRunningControl(req, pathname, body, {
  requiredMessage: 'Conversation control requires the long-running backend',
  unavailableMessage: 'The conversation control service is unavailable',
  logTag: 'conversation-control',
 });
}

async function forwardReadReceiptControl(req, pathname, body) {
 return forwardLongRunningControl(req, pathname, body, {
  requiredMessage: 'Read receipt privacy changes require the long-running backend',
  unavailableMessage: 'The read receipt privacy service is unavailable',
  logTag: 'read-receipts-control',
 });
}

function requestBaseUrl(req) {
 const publicUrl = normalizeBaseUrl(process.env.AGENSIS_PUBLIC_URL || process.env.PUBLIC_URL || '');
 if (publicUrl) return publicUrl;
 const url = new URL(req.url);
 const forwardedProto = String(req.headers.get('x-forwarded-proto') || '').split(',')[0].trim();
 const forwardedHost = String(req.headers.get('x-forwarded-host') || '').split(',')[0].trim();
 const proto = forwardedProto || url.protocol.replace(':', '') || 'https';
 const host = forwardedHost || req.headers.get('host') || url.host;
 if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0):8888$/.test(host)) {
  return 'http://127.0.0.1:3142';
 }
 return `${proto}://${host}`;
}

function shellQuote(value) {
 const text = String(value || '');
 if (/^[A-Za-z0-9_/:.,=@%+-]+$/.test(text)) return text;
 return `'${text.replace(/'/g, `'\\''`)}'`;
}

function isPathInside(parent, candidate) {
 const relative = path.relative(parent, candidate);
 return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function codexPetAssetUrl(petDirName, assetName) {
 return `/backend/codex-pets/${encodeURIComponent(petDirName)}/${encodeURIComponent(assetName)}`;
}

function contentTypeForImageAsset(filePath) {
 const ext = path.extname(filePath).toLowerCase();
 if (ext === '.webp') return 'image/webp';
 if (ext === '.png') return 'image/png';
 if (ext === '.gif') return 'image/gif';
 if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
 return 'application/octet-stream';
}

function listCodexPets() {
 if (!fs.existsSync(CODEX_PETS_ROOT)) return [];
 return fs.readdirSync(CODEX_PETS_ROOT, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .flatMap(entry => {
   try {
    const petDir = path.resolve(CODEX_PETS_ROOT, entry.name);
    if (!isPathInside(CODEX_PETS_ROOT, petDir)) return [];
    const manifestPath = path.join(petDir, 'pet.json');
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const spriteName = path.basename(String(manifest.spritesheetPath || 'spritesheet.webp'));
    if (!/\.(webp|png|gif|jpe?g)$/i.test(spriteName)) return [];
    const spritePath = path.resolve(petDir, spriteName);
    if (!isPathInside(petDir, spritePath) || !fs.existsSync(spritePath)) return [];
    const id = String(manifest.id || entry.name).trim() || entry.name;
    const assetUrl = codexPetAssetUrl(entry.name, spriteName);
    return [{
     id: `codex:${id}`,
     displayName: String(manifest.displayName || id),
     description: typeof manifest.description === 'string' ? manifest.description : 'Local Codex pet.',
     thumbnail: assetUrl,
     spritesheet: assetUrl,
     category: typeof manifest.category === 'string' ? manifest.category : 'codex',
     featured: false,
     original: false,
     source: 'codex',
    }];
   } catch {
    return [];
   }
  });
}

function mergeLocalCodexPets(openPetsPayload) {
 const remotePets = Array.isArray(openPetsPayload?.pets) ? openPetsPayload.pets : [];
 const codexPets = listCodexPets();
 return {
  ...(openPetsPayload && typeof openPetsPayload === 'object' ? openPetsPayload : {}),
  pets: [...codexPets, ...remotePets],
  pageSize: codexPets.length + remotePets.length,
 };
}

function agentPermissionFlags(permissionMode) {
 return normalizeAgentPermissionMode(permissionMode) === 'yolo' ? ['--no-sandbox', '--yolo'] : [];
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

function agentConnectionCommand({ baseUrl, token, workspaceId, agentId, handle, name, model, permissionMode, runtime = null }) {
 const resolvedRuntime = normalizeExecutionRuntime(runtime);
 const resolvedModel = resolveExecutionModel(model, resolvedRuntime);
 const resolvedPermissionMode = normalizeAgentPermissionMode(permissionMode);
 const commandPermissionArgs = ['--permission-mode', shellQuote(resolvedPermissionMode)];
 const commandModelArgs = resolvedRuntime === 'amp' || (resolvedRuntime === 'codex' && resolvedModel === 'auto')
  ? []
  : ['--model', shellQuote(resolvedModel)];
 const displayName = String(name || handle || 'Agensis Agent').trim() || 'Agensis Agent';
 if (resolvedPermissionMode === 'yolo') commandPermissionArgs.push('--no-sandbox');
 const portableCommand = [
  'agensis',
  'connect',
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

function jsonErrorWithData(status, error, data = null) {
 return json({ data, error: mapDbError(error) }, status);
}

function getAuthSecret() {
 // H9: accept the AGENSIS_AUTH_SECRET alias, in the same precedence order as
 // server/index.cjs (AGENSIS_ first). AGENTS.md documents the var as "AUTH_SECRET
 // (a.k.a. AGENSIS_AUTH_SECRET)" and Fly honours both, so an operator who set only
 // the alias on Netlify used to get the hardcoded placeholder below — and if both
 // are set to different values, matching Fly's order keeps the two backends on ONE
 // secret instead of minting tokens the daemon then rejects.
 const secret = process.env.AGENSIS_AUTH_SECRET || process.env.AUTH_SECRET;
 if (secret) return secret;
 // F2: NEVER fall back to the DB URL or a hardcoded constant — either makes the
 // HMAC session secret guessable/forgeable. Fail closed unless the insecure
 // placeholder is explicitly opted into: NODE_ENV is not guaranteed to be
 // 'production' in the Netlify Functions runtime, so gating on it left a real
 // deploy signing sessions with a public constant (H9).
 if (process.env.AGENSIS_ALLOW_INSECURE_AUTH !== 'true') {
  const err = new Error('Server auth is not configured (set AUTH_SECRET)');
  err.status = 500;
  throw err;
 }
 return 'netlify-preview-auth-secret';
}

function issueToken(userId, tokenVersion, options = {}) {
 return issueAuthToken(userId, tokenVersion, getAuthSecret(), options);
}

// Resolve the authed user id from a request's Authorization header. Throws 401
// when no valid Bearer token is present. The thrown error's `.status` is mapped
// to the existing `{ data: null, error }` JSON shape by the top-level handler.
async function requireUserId(req) {
 const userId = await verifyAuthToken(req.headers.get('authorization'), getAuthSecret(), getTokenVersion);
 if (!userId) {
  const err = new Error('Authentication required');
  err.status = 401;
  throw err;
 }
 return userId;
}

function quoteIdent(value) {
 if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
  throw new Error(`Invalid identifier: ${value}`);
 }
 return `"${value}"`;
}

function ensureTable(table) {
 if (!ALLOWED_TABLES.has(table)) {
  throw new Error(`Table not allowed: ${table}`);
 }
 return quoteIdent(table);
}

function normalizeColumns(columns) {
 if (!columns || columns === '*') return '*';
 const list = String(columns).split(',').map((column) => column.trim()).filter(Boolean);
 if (list.length === 0) return '*';
 return list.map(quoteIdent).join(', ');
}

function isJsonColumn(table, column) {
 return Boolean(JSON_COLUMNS_BY_TABLE[table]?.has(column));
}

function invalidJsonValue(table, column) {
 const err = new Error(`${table}.${column} must be valid JSON`);
 err.status = 400;
 return err;
}

function normalizeJsonParam(table, column, value) {
 if (value == null) return null;
 if (typeof value === 'string') {
  try {
   JSON.parse(value);
   return value;
  } catch {
   throw invalidJsonValue(table, column);
  }
 }
 return JSON.stringify(value);
}

function bindDbParam(params, table, column, value) {
 const jsonColumn = isJsonColumn(table, column);
 if (jsonColumn) {
  params.push(normalizeJsonParam(table, column, value));
  return `$${params.length}::jsonb`;
 }
 const elemType = arrayColumnElemType(table, column);
 if (elemType) {
  params.push(toPgArrayLiteral(value));
  return `$${params.length}::${elemType}[]`;
 }
 params.push(value ?? null);
 return `$${params.length}`;
}

function buildWhereClause(filters = [], params = []) {
 if (!Array.isArray(filters) || filters.length === 0) {
  return { clause: '', params };
 }

 const clauses = [];
 for (const filter of filters) {
  if (!filter || typeof filter !== 'object') continue;
  const operator = filter.operator || 'eq';
  if (operator === 'eq') {
   params.push(filter.value ?? null);
   clauses.push(`${quoteIdent(filter.column)} = $${params.length}`);
   continue;
  }
  // F5: mirror server/index.cjs — the only supported `not` is `.not(col,'is',null)`
  // → IS NOT NULL (sub-threads query). Anything else is rejected, not silently run.
  if (operator === 'not') {
   if (filter.subOperator !== 'is' || filter.value !== null) {
    throw new Error(`Unsupported not filter: ${filter.subOperator} ${filter.value}`);
   }
   clauses.push(`${quoteIdent(filter.column)} IS NOT NULL`);
   continue;
  }
  throw new Error(`Unsupported filter operator: ${operator}`);
 }

 return {
  clause: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
  params,
 };
}

function buildOrderClause(orderBy) {
 if (!orderBy || !orderBy.column) return '';
 const direction = orderBy.ascending === false ? 'DESC' : 'ASC';
 return ` ORDER BY ${quoteIdent(orderBy.column)} ${direction}`;
}

function buildSystemPrompt(memory, documents, workspaceContext, agentContext) {
 const sections = [];
 if (agentContext && (agentContext.systemPrompt || agentContext.name)) {
  if (agentContext.name) {
   sections.push(`You are "${agentContext.name}", an AI agent collaborating in a shared agensis workspace.`);
  }
  if (agentContext.soul) sections.push(`Agent soul: ${agentContext.soul}`);
  if (agentContext.systemPrompt) sections.push(agentContext.systemPrompt);
  if (agentContext.instructions) sections.push(`Instructions:\n${agentContext.instructions}`);
  if (Array.isArray(agentContext.tools) && agentContext.tools.length > 0) {
   sections.push(`Available tool preferences: ${agentContext.tools.join(', ')}`);
  }
  if (Array.isArray(agentContext.skills) && agentContext.skills.length > 0) {
   sections.push(`Selected skill libraries: ${agentContext.skills.join(', ')}`);
  }
  if (Array.isArray(agentContext.coParticipants) && agentContext.coParticipants.length > 0) {
   const roster = agentContext.coParticipants
    .map(peer => `@${peer.handle}${peer.name ? ` (${peer.name})` : ''}`)
    .join(', ');
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

async function query(text, params = []) {
 const result = await dbPool().query(text, params);
 return result.rows;
}

async function withDbTransaction(callback) {
 const client = await dbPool().connect();
 try {
  await client.query('BEGIN');
  const transactionQuery = async (text, params = []) => {
   const result = await client.query(text, params);
   return result.rows;
  };
  const value = await callback(transactionQuery);
  await client.query('COMMIT');
  return value;
 } catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
 } finally {
  client.release?.();
 }
}

// Dedicated resource-service adapter for the serverless pg driver. The service
// itself owns every tenant, steward, controller, idempotency and lease check;
// this adapter only gives it the same `unsafe`/`begin` shape postgres.js exposes
// on Fly. Netlify performs no DDL — both lanes use the canonical schema.
const netlifyWorkspaceResourceDb = {
 unsafe: query,
 begin: callback => withDbTransaction(transactionQuery => callback({ unsafe: transactionQuery })),
};

const workspaceResources = createWorkspaceResourceService({
 getDb: () => netlifyWorkspaceResourceDb,
 enforceWorkspaceRole: (userId, workspaceId, capability) => assertWorkspaceRole({
  userId,
  workspaceId,
  capability,
  db: query,
 }),
 assertWorkspaceRoleLocked,
 recordAudit: entry => recordAuditEntry({
  ...entry,
  db: query,
  jsonParam: JSON.stringify,
 }),
});

function queryBoolean(value, fallback = false) {
 if (value === null || value === undefined || value === '') return fallback;
 if (value === true || value === 'true') return true;
 if (value === false || value === 'false') return false;
 const error = new Error('includeArtifacts must be true or false');
 error.status = 400;
 throw error;
}

function resourceDefinition(body) {
 if (body?.definition !== undefined) return body.definition;
 const {
  stewardAgentId: _stewardAgentId,
  steward_agent_id: _stewardAgentIdSnake,
  ...definition
 } = body ?? {};
 return definition;
}
// ----------------------------------------------------------------------------
// VAULT WRITES ON THIS LANE.
//
// Both hosts read and write the same `workspace_secrets` rows in the same Neon
// DB, and both derive the AES-256-GCM key the same way (shared/backend-core.cjs):
// a dedicated SECRETS_ENCRYPTION_KEY if it is set, else the HMAC AUTH_SECRET. Fly
// HAS SECRETS_ENCRYPTION_KEY; this function historically did not — so a secret
// written here was encrypted under the auth fallback, and the Fly server, deriving
// from the dedicated key, could not decrypt it. AES-GCM fails closed, so the
// symptom was not garbage: the key silently read back as NOT CONFIGURED, and the
// provider call it was entered for kept refusing.
//
// So this lane refuses to WRITE a vault secret unless SECRETS_ENCRYPTION_KEY is
// set here too — which is the operator saying "I have synced it with the primary".
// Reads are always served: a metadata list holds no secret material.
//
// This is a fail-closed guard, not a capability check: `assertWorkspaceRole(...,
// 'manage')` still runs on every write. Both must pass.
function vaultWritesEnabled() {
 return String(process.env.SECRETS_ENCRYPTION_KEY || '').trim().length > 0;
}

function vaultWriteUnavailable() {
 return jsonError(503, new Error(
  'Vault writes are served by the primary backend. This host has no SECRETS_ENCRYPTION_KEY, '
  + 'so a secret written here would be encrypted with different key material and would read back '
  + 'as not configured on the server that uses it. Set the same SECRETS_ENCRYPTION_KEY on both hosts to enable this route.',
 ));
}

async function getSettingValue(key) {
 const rows = await query('select value from app_settings where key = $1 limit 1', [key]);
 return rows[0]?.value || '';
}

// M5: both vault helpers delegate to the shared implementation so this mirror
// stores AES-256-GCM ciphertext in secret_cipher (value stays '') and prefers it
// on read — exactly like server/index.cjs. Writing plaintext into `value` here
// left the Fly server's cipher-first read serving the OLD key after a rotation
// through Netlify.
async function getWorkspaceSecretValue(workspaceId, key) {
 if (!workspaceId) return '';
 return coreGetWorkspaceSecretValue(workspaceId, key, { db: query, getAuthSecret });
}

async function setWorkspaceSecretValue(workspaceId, key, value, userId = null) {
 await coreSetWorkspaceSecretValue(workspaceId, key, value, { db: query, getAuthSecret, userId });
}

async function resolveSecret(key, workspaceId = null) {
 const workspaceValue = await getWorkspaceSecretValue(workspaceId, key).catch(() => '');
 if (workspaceValue) return workspaceValue;
 const appValue = await getSettingValue(key).catch(() => '');
 return appValue || process.env[key] || '';
}

// Managed-key STATE, never any part of a value — mirrors the Fly shape. The
// masked preview both lanes used to return was of the PLATFORM key whenever the
// workspace had none of its own, which showed every workspace owner four
// characters of the app-level ANTHROPIC_API_KEY. `scope` already says which key is
// in play.
async function listManagedSecrets(workspaceId = null) {
 const meta = new Map();
 if (workspaceId) {
  const rows = await listWorkspaceSecretMeta(workspaceId, { db: query }).catch(() => []);
  for (const row of rows) meta.set(row.key, row);
 }
 return Promise.all(MANAGED_SECRET_KEYS.map(async (key) => {
  const workspaceValue = await getWorkspaceSecretValue(workspaceId, key).catch(() => '');
  const fallbackValue = workspaceValue ? '' : await resolveSecret(key, null);
  const value = workspaceValue || fallbackValue;
  return {
   key,
   configured: Boolean(value),
   scope: workspaceValue ? 'workspace' : fallbackValue ? 'app' : 'unset',
   updated_at: meta.get(key)?.updated_at || null,
  };
 }));
}

function parseJsonObject(value) {
 if (!value) return {};
 if (typeof value === 'object' && !Array.isArray(value)) return value;
 if (typeof value !== 'string') return {};
 try {
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
 } catch {
  return {};
 }
}

function parseJsonArray(value) {
 if (Array.isArray(value)) return value;
 if (typeof value !== 'string' || !value.trim()) return [];
 try {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
 } catch {
  return [];
 }
}

function publicAgentConnection(row) {
 if (!row) return row;
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
  connected_at: row.connected_at,
  last_seen_at: row.last_seen_at,
  updated_at: row.updated_at,
 };
}

function publicWorkspace(row) {
 if (!row) return row;
 return {
  id: row.id,
  name: row.name,
  description: row.description || '',
  // Mirrors server/index.cjs — the workspace rail paints `icon` and groups
  // `is_system` apart, and it reads whichever backend answered.
  icon: row.icon || '',
  is_system: row.is_system === true,
  // Groupable workspaces: null = top level, otherwise the group this workspace
  // sits inside. Must match server/index.cjs — the client reads whichever
  // backend answered, and a column present on one and missing on the other is
  // exactly how `icon` and `is_system` went missing here before.
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

// The serverless mirror of the Fly server's agentRuntimePayload. The KEY SET
// must match it exactly — tests/agents-projection-parity.test.cjs diffs the two
// — because any field present on one backend and absent on the other blanks in
// the UI whenever a reload happens to be served by the other one. That is how
// soul, accent_color and openpet_avatar_id each shipped broken here.
function publicWorkspaceAgent(row) {
 if (!row) return row;
 const permissionMode = normalizeAgentPermissionMode(row.permission_mode || row.permissionMode);
 return {
  id: row.id,
  workspace_id: row.workspace_id,
  name: row.name,
  avatar: row.avatar || 'AI',
  openpet_avatar_id: row.openpet_avatar_id || '',
  accent_color: row.accent_color || '',
  handle: row.handle || slugHandle(row.name),
  description: row.description || '',
  system_prompt: row.system_prompt || '',
  soul: row.soul || '',
  instructions: row.instructions || '',
  tools: parseJsonArray(row.tools),
  skills: parseJsonArray(row.skills),
  purpose: row.purpose === 'resource' ? 'resource' : 'collaborator',
  resource_facets: row.purpose === 'resource'
   ? parseJsonArray(row.resource_facets).filter((facet) => ['context', 'knowledge', 'tooling', 'code'].includes(facet))
   : [],
  metadata: parseJsonObject(row.metadata),
  identity: parseJsonObject(row.identity),
  model: resolveAnthropicModel(row.model),
  run_mode: row.run_mode === 'daemon' ? 'daemon'
   : row.run_mode === 'sandbox' ? 'sandbox'
    : 'builtin',
  sandbox_provider: row.sandbox_provider || null,
  sandbox_config: parseJsonObject(row.sandbox_config),
  permissionMode,
  permission_mode: permissionMode,
  permissionFlags: agentPermissionFlags(permissionMode),
  version: Number(row.version || 0),
  enabled: row.enabled !== false,
  // Fail-open: an absent column (a row predating the migration) reads as ON.
  // Mirrors ambientRepliesEnabled in shared/ambientAddressing.cjs — the two
  // backends must agree or the toggle flips itself on reload.
  ambient_replies: row.ambient_replies !== false,
 };
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

async function handleWorkspaces(userId) {
 const rows = await query(
  `select w.id, w.name, w.description, w.icon, w.is_system, w.parent_id,
            w.local_path, w.project_kind, w.git_root, w.git_remote,
            w.created_at, w.updated_at,
            case when w.user_id = $1 then 'owner' else coalesce(wm.role, 'viewer') end as role
     from workspaces w
     left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = $1
     where w.user_id = $1 or wm.user_id = $1
     order by w.updated_at desc nulls last, w.created_at desc nulls last, w.name asc`,
  [userId],
 );
 return json({ data: rows.map(publicWorkspace), error: null });
}

async function handleUpdateWorkspaceMember(workspaceId, memberId, req, userId) {
 if (!workspaceId) return jsonError(400, new Error('workspace id is required'));
 if (!memberId) return jsonError(400, new Error('member id is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
 if (memberId === 'null' || memberId === 'undefined') return jsonError(404, new Error('Workspace member not found'));
 const allowedRoles = ['admin', 'editor', 'commenter', 'viewer'];
 const body = await readBody(req);
 const role = String(body?.role || '').trim();
 if (!allowedRoles.includes(role)) return jsonError(400, new Error('Invalid workspace member role'));
 const rows = await query(
  `update workspace_members set role = $3
      where id = $1 and workspace_id = $2
      returning *`,
  [memberId, workspaceId, role],
 );
 if (!rows[0]) return jsonError(404, new Error('Workspace member not found'));
 return json({ data: rows[0], error: null });
}

async function handleDeleteWorkspaceMember(workspaceId, memberId, userId) {
 if (!workspaceId) return jsonError(400, new Error('workspace id is required'));
 if (!memberId) return jsonError(400, new Error('member id is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
 if (memberId === 'null' || memberId === 'undefined') return json({ data: null, error: null });
 const rows = await query(
  `delete from workspace_members
      where id = $1 and workspace_id = $2
      returning *`,
  [memberId, workspaceId],
 );
 return json({ data: rows[0] ?? null, error: null });
}

async function handleWorkspaceAgents(workspaceId, userId) {
 if (!workspaceId) return jsonError(400, new Error('workspaceId is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'read', db: query });
 // Same column list as the Fly server's /agents route — the parity test
 // extracts and diffs both, so a column added on one side fails until it is
 // added here too.
 const rows = await query(
  `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, purpose, resource_facets, identity, model, handle, run_mode, sandbox_provider, sandbox_config, memory_dir, permission_mode, metadata, version, enabled, ambient_replies, created_by
     from workspace_agents
     where workspace_id = $1
     order by created_at asc, name asc`,
  [workspaceId],
 );
 return json({ data: rows.map(publicWorkspaceAgent), error: null });
}

async function handleWorkspaceUsage(workspaceId, userId) {
 if (!workspaceId) return jsonError(400, new Error('workspace id is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'read', db: query });
 const rows = await query(
  `select
      (select coalesce(sum(size), 0)::bigint from uploaded_files where workspace_id = $1) as upload_bytes,
      (select count(*)::bigint from uploaded_files where workspace_id = $1) as file_count,
      (select coalesce(sum(byte_size), 0)::bigint from agent_memory_files where workspace_id = $1) as memory_bytes,
      (select count(*)::bigint from agent_memory_files where workspace_id = $1) as memory_file_count,
      (select count(*)::bigint from documents where workspace_id = $1) as document_count,
      (select count(*)::bigint from tasks where workspace_id = $1) as task_count,
      (select count(*)::bigint from workspace_agents where workspace_id = $1) as agent_count,
      (select count(*)::bigint
         from messages m
         join chat_sessions s on s.id = m.session_id
        where s.workspace_id = $1 and s.deleted_at is null and m.deleted_at is null) as message_count`,
  [workspaceId],
 );
 const row = rows[0] || {};
 const uploadBytes = Number(row.upload_bytes || 0);
 const memoryBytes = Number(row.memory_bytes || 0);
 return json({
  data: {
   workspaceId,
   uploadBytes,
   memoryBytes,
   totalBytes: uploadBytes + memoryBytes,
   counts: {
    files: Number(row.file_count || 0),
    memoryFiles: Number(row.memory_file_count || 0),
    documents: Number(row.document_count || 0),
    tasks: Number(row.task_count || 0),
    agents: Number(row.agent_count || 0),
    messages: Number(row.message_count || 0),
   },
  },
  error: null,
 });
}

// Huddle voice. Only the Cartesia half is mirrored here, and that is not an
// omission: the Deepgram side is an audio RELAY over the realtime websocket
// (server/voice.cjs), and this runtime has no websockets. Huddles themselves
// are Fly-only for the same reason, so nothing that can reach these routes is
// missing its transcription. The token exchange is mirrored anyway because it
// is plain HTTP and a workspace-scoped 404 here would be a silent dead speaker
// on any deployment that does route /backend through Netlify.
async function handleVoiceCapabilities(workspaceId, userId) {
 if (!workspaceId) return jsonError(400, new Error('workspace id is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'read', db: query });
 return json({ data: voiceCapabilities(process.env), error: null });
}

async function handleVoiceTtsToken(workspaceId, userId) {
 if (!workspaceId) return jsonError(400, new Error('workspace id is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'read', db: query });
 const limit = voiceTokenRateLimiter.check(`${userId}:${workspaceId}`);
 if (!limit.allowed) {
  return json({ data: null, error: { message: 'Rate limit exceeded. Please retry shortly.', code: 'rate_limited' } }, 429);
 }
 const reason = unavailableReason('tts', process.env);
 if (reason) return jsonError(503, new Error(reason));
 try {
  const { token, expiresInSeconds } = await mintCartesiaToken({ apiKey: String(process.env.CARTESIA_API_KEY || '').trim() });
  const capabilities = voiceCapabilities(process.env);
  return json({ data: { token, expiresInSeconds, ...(capabilities.tts || {}) }, error: null });
 } catch (error) {
  // scrubError, not the raw error: jsonError forwards `message` verbatim, and
  // this is the one route whose upstream is authenticated with a raw secret.
  return jsonError(error.status || 502, scrubError(error, process.env));
 }
}

async function handleSystemCapabilities(req) {
 const url = new URL(req.url);
 const workspacePath = url.searchParams.get('workspacePath') || '';
 const configuredDaemonBaseUrl = daemonBaseUrl();
 return json({
  data: {
   checkedAt: new Date().toISOString(),
   workspacePath,
   clis: [],
   packages: [],
   skills: [],
   codexAppServer: {
    available: Boolean(configuredDaemonBaseUrl),
    command: '',
    transports: configuredDaemonBaseUrl ? ['websocket'] : [],
    daemonBaseUrl: configuredDaemonBaseUrl,
   },
  },
  error: null,
 });
}

async function handleAgentConnections(req, userId) {
 const url = new URL(req.url);
 const workspaceId = String(url.searchParams.get('workspaceId') || '').trim();
 if (!workspaceId) return jsonError(400, new Error('workspaceId is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'read', db: query });
 const rows = await query(
  `select *
     from agent_connections
     where workspace_id = $1
       and last_seen_at > now() - interval '24 hours'
     order by status = 'online' desc, status = 'busy' desc, last_seen_at desc`,
  [workspaceId],
 );
 return json({ data: rows.map(publicAgentConnection), error: null });
}

async function handleCursorBuddyConnectionKeys(req, userId) {
 const url = new URL(req.url);
 const workspaceId = String(url.searchParams.get('workspaceId') || '').trim();
 if (!workspaceId) return jsonError(400, new Error('workspaceId is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
 const rows = await query(
  `select *
     from cursorbuddy_connection_keys
     where workspace_id = $1
     order by created_at desc
     limit 100`,
  [workspaceId],
 );
 return json({ data: rows.map(publicCursorBuddyConnectionKey), error: null });
}

async function handleCreateCursorBuddyConnectionKey(req, userId) {
 const body = await readBody(req);
 const workspaceId = String(body?.workspaceId || body?.workspace_id || '').trim();
 if (!workspaceId) return jsonError(400, new Error('workspaceId is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });

 const agentId = String(body?.agentId || body?.agent_id || '').trim() || null;
 if (agentId) {
  const agentRows = await query('select id from workspace_agents where id = $1 and workspace_id = $2 limit 1', [agentId, workspaceId]);
  if (!agentRows[0]) return jsonError(404, new Error('Agent not found in this workspace'));
 }

 const surface = normalizeCursorBuddySurface(body?.surface);
 const scope = normalizeCursorBuddyScope(body?.scope);
 const domain = normalizeCursorBuddyDomain(body?.domain);
 const name = String(body?.name || 'CursorBuddy runtime').trim().slice(0, 80) || 'CursorBuddy runtime';
 const requestMetadata = parseJsonObject(body?.metadata);
 const metadata = {
  ...requestMetadata,
  requestedBy: userId,
  setup: 'cursorbuddy',
  runtimeKind: String(body?.runtimeKind || '').trim().slice(0, 80),
 };
 const key = createCursorBuddyConnectionKey(surface);
 const rows = await query(
  `insert into cursorbuddy_connection_keys
       (workspace_id, agent_id, created_by, key_hash, name, surface, scope, domain, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     returning *`,
  [workspaceId, agentId, userId, hashAgentToken(key), name, surface, scope, domain, JSON.stringify(metadata)],
 );
 return json({
  data: {
   ...publicCursorBuddyConnectionKey(rows[0]),
   key,
   command: `agensis buddy connect --key ${shellQuote(key)}`,
  },
  error: null,
 });
}

async function ensureCursorBuddyAgentForKey(connectionKey, claim = {}) {
 if (connectionKey?.agent_id) {
  const rows = await query(
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
 const metadata = {
  runtime: 'cursorbuddy',
  surface,
  scope,
  domain: connectionKey?.domain || '',
  host: String(claim.host || '').trim().slice(0, 160),
  cwd: String(claim.cwd || '').trim().slice(0, 500),
 };
 const rows = await query(
  `insert into workspace_agents
       (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, avatar, accent_color, enabled, created_by, tools, skills, metadata)
     values
       ($1, $2, $3, $4, $5, 'auto', 'daemon', $6, 'AI', '#ffe04a', true, $7, $8::jsonb, $9::jsonb, $10::jsonb)
     returning *`,
  [
   connectionKey.workspace_id,
   label,
   slugHandle(handleBase),
   `CursorBuddy ${surface.replace(/_/g, ' ')} runtime connected through Agensis.`,
   'You are CursorBuddy, a local-machine agent connected through Agensis. Route browser, desktop, and embedded-site context through the hub, use local source paths when authorized, and keep all actions logged.',
   normalizeAgentPermissionMode(claim.permissionMode || claim.permission_mode || 'default'),
   connectionKey.created_by || null,
   JSON.stringify(['cursorbuddy']),
   JSON.stringify(['cursorbuddy', 'local-source-edit', 'surface-routing', 'agent-mesh']),
   JSON.stringify({ cursorbuddyRuntime: metadata }),
  ],
 );
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
 const existingRows = await query(
  'select * from workspace_agents where workspace_id = $1 and handle = $2 limit 1',
  [workspaceId, handle],
 );
 if (existingRows[0]) {
  const mergedMetadata = mergeCursorBuddyProviderMetadata(existingRows[0], metadata);
  const rows = await query(
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
    JSON.stringify(['cursorbuddy']),
    JSON.stringify(['cursorbuddy', 'surface-routing', 'agent-mesh']),
    JSON.stringify({ ...parseJsonObject(existingRows[0].metadata), cursorbuddyProvider: mergedMetadata }),
   ],
  );
  return rows[0];
 }

 const rows = await query(
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
   JSON.stringify(['cursorbuddy']),
   JSON.stringify(['cursorbuddy', 'surface-routing', 'agent-mesh']),
   JSON.stringify({ cursorbuddyProvider: metadata }),
  ],
 );
 return rows[0];
}

async function buildCursorBuddyAgentConnectionCommand({ agentId, workspaceId = null, handle = null, model = null, permissionMode = null, baseUrl = null } = {}) {
 const id = String(agentId || '').trim();
 if (!id) throw new Error('agentId is required');
 const rows = await query('select * from workspace_agents where id = $1 limit 1', [id]);
 const agent = rows[0];
 if (!agent) throw new Error('Agent not found');
 if (workspaceId && agent.workspace_id !== workspaceId) throw new Error('Agent is not in this workspace');
 if (agent.enabled === false) throw new Error('Agent is deactivated');
 const token = createAgentConnectToken();
 const resolvedHandle = slugHandle(handle || agent.handle || agent.name);
 const resolvedRuntime = normalizeExecutionRuntime(parseJsonObject(agent.metadata).runtime);
 const resolvedModel = resolveExecutionModel(model || agent.model, resolvedRuntime);
 const resolvedPermissionMode = normalizeAgentPermissionMode(permissionMode || agent.permission_mode);
 const updateRows = await query(
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
 const resolvedBaseUrl = normalizeBaseUrl(baseUrl) || daemonBaseUrl() || '';
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

async function handleClaimCursorBuddyConnectionKey(req) {
 const body = await readBody(req);
 const key = String(body?.key || '').trim();
 if (!/^cbk_[a-z0-9_]+_[A-Z2-9]{18}$/.test(key)) return jsonError(400, new Error('A valid CursorBuddy connection key is required'));
 const rows = await query('select * from cursorbuddy_connection_keys where key_hash = $1 limit 1', [hashAgentToken(key)]);
 const record = rows[0];
 if (!record) return jsonError(404, new Error('CursorBuddy connection key not found'));
 if (record.status === 'claimed') return jsonError(409, new Error('CursorBuddy connection key has already been claimed'));
 if (record.status === 'revoked') return jsonError(410, new Error('CursorBuddy connection key was revoked'));
 if (record.status === 'expired' || (record.expires_at && new Date(record.expires_at) < new Date())) {
  await query(
   `update cursorbuddy_connection_keys
       set status = 'expired', updated_at = now()
       where id = $1 and status = 'created'`,
   [record.id],
  );
  return jsonError(410, new Error('CursorBuddy connection key has expired'));
 }

 const claim = {
  host: body?.host,
  cwd: body?.cwd,
  name: body?.name,
  surface: body?.surface,
  scope: body?.scope,
  permissionMode: body?.permissionMode || body?.permission_mode,
 };
 const agent = await ensureCursorBuddyAgentForKey(record, claim);
 const payload = await buildCursorBuddyAgentConnectionCommand({
  agentId: agent.id,
  workspaceId: record.workspace_id,
  handle: agent.handle || agent.name,
  model: body?.model || agent.model,
  permissionMode: claim.permissionMode || agent.permission_mode,
  baseUrl: body?.baseUrl || requestBaseUrl(req),
 });
 const metadata = {
  ...parseJsonObject(record.metadata),
  claimedBy: {
   host: String(body?.host || '').trim().slice(0, 160),
   cwd: String(body?.cwd || '').trim().slice(0, 500),
   runtimeKind: String(body?.runtimeKind || 'machine').trim().slice(0, 80),
   version: String(body?.version || '').trim().slice(0, 80),
  },
  cursorBuddy: {
   websiteSource: String(body?.websiteSource || '').trim().slice(0, 2048),
   page: parseJsonObject(body?.page),
   client: parseJsonObject(body?.client),
   manifest: parseJsonObject(body?.manifest),
   metadata: parseJsonObject(body?.metadata),
  },
 };
 const updateRows = await query(
  `update cursorbuddy_connection_keys
     set status = 'claimed',
         agent_id = $2,
         claimed_at = now(),
         metadata = $3::jsonb,
         updated_at = now()
     where id = $1
     returning *`,
  [record.id, agent.id, JSON.stringify(metadata)],
 );
 return json({
  data: {
   ...payload,
   workspaceId: record.workspace_id,
   agentId: agent.id,
   connectionKey: publicCursorBuddyConnectionKey(updateRows[0]),
   command: payload.command,
  },
  error: null,
 });
}

async function handleAgentDispatch(req, userId) {
 const body = await readBody(req);
 const { workspaceId, sessionId, content } = body || {};
 if (!workspaceId || !sessionId || !content) {
  return jsonError(400, new Error('workspaceId, sessionId, and content are required'));
 }
 await assertWorkspaceRole({ userId, workspaceId, capability: 'run_agents', db: query });
 const baseUrl = daemonBaseUrl();
 if (baseUrl && req.headers.get('x-agensis-dispatch-proxy') !== '1') {
  return proxyAgentDispatchToDaemon(req, baseUrl, body);
 }
 // Serverless deployments cannot hold the local daemon orchestration loop open.
 // Without a websocket-capable daemon backend there is nowhere to deliver the
 // job, so keep the explicit fallback contract.
 return json({
  data: {
   dispatched: false,
   reason: baseUrl ? 'daemon_dispatch_proxy_loop' : 'serverless_dispatch_unavailable',
   requiredEnv: baseUrl ? null : 'AGENSIS_DAEMON_BASE_URL',
  },
  error: null,
 });
}

async function proxyAgentDispatchToDaemon(req, baseUrl, body) {
 let upstream;
 try {
  upstream = await fetch(`${baseUrl}/backend/agents/dispatch`, {
   method: 'POST',
   headers: {
    'Content-Type': 'application/json',
    Authorization: req.headers.get('authorization') || '',
    'X-Agensis-Dispatch-Proxy': '1',
   },
   body: JSON.stringify(body || {}),
  });
 } catch (error) {
  return jsonErrorWithData(
   502,
   new Error(`Daemon dispatch backend is unreachable: ${error?.message || error}`),
   { dispatched: false, daemonBaseUrl: baseUrl },
  );
 }

 const text = await upstream.text();
 const contentType = upstream.headers.get('content-type') || 'application/json';
 return new Response(text, {
  status: upstream.status,
  headers: { 'Content-Type': contentType },
 });
}

async function handleCreateAgentWebhook(req, userId) {
 const body = await readBody(req);
 const workspaceId = String(body?.workspace_id || '').trim();
 const agentId = body?.agent_id ? String(body.agent_id).trim() : null;
 const name = String(body?.name || '').trim();
 if (!workspaceId || !name) return jsonError(400, new Error('workspace_id and name are required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
 if (agentId) {
  const agentRows = await query('select id from workspace_agents where id = $1 and workspace_id = $2 limit 1', [agentId, workspaceId]);
  if (!agentRows[0]) return jsonError(404, new Error('Agent not found in this workspace'));
 }
 // F10: store only the hash (mirrors server/index.cjs) — same agent_webhooks
 // table/trigger route, so both writers must hash or the trigger's dual-path
 // lookup would never match a netlify-created row.
 const token = crypto.randomBytes(32).toString('base64url');
 const rows = await query(
  `insert into agent_webhooks (workspace_id, agent_id, name, token)
     values ($1, $2, $3, $4)
     returning *`,
  [workspaceId, agentId || null, name, hashAgentToken(token)],
 );
 return json({ data: { ...rows[0], token }, error: null });
}

async function handleAgentConnectionCommand(req, agentId, userId) {
 const body = await readBody(req);
 const rows = await query('select * from workspace_agents where id = $1 limit 1', [agentId]);
 const agent = rows[0];
 if (!agent) return jsonError(404, new Error('Agent not found'));
 if (agent.enabled === false) return jsonError(403, new Error('Agent is deactivated'));
 await assertWorkspaceRole({ userId, workspaceId: agent.workspace_id, capability: 'manage', db: query });
 const handle = slugHandle(body?.handle || agent.handle || agent.name);
 const runtime = normalizeExecutionRuntime(parseJsonObject(agent.metadata).runtime);
 const model = resolveExecutionModel(body?.model || agent.model, runtime);
 const permissionMode = normalizeAgentPermissionMode(body?.permissionMode || body?.permission_mode || agent.permission_mode);
 const baseUrl = daemonBaseUrl();
 if (!baseUrl) {
  return jsonErrorWithData(
   503,
   new Error('Daemon websocket backend is not configured. Set AGENSIS_DAEMON_BASE_URL to a long-running Node backend that serves /backend/ws; Netlify Functions cannot host websocket upgrades.'),
   {
    websocketAvailable: false,
    requiredEnv: 'AGENSIS_DAEMON_BASE_URL',
   },
  );
 }
 const token = createAgentConnectToken();
 const updateRows = await query(
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
  [agentId, handle, hashAgentToken(token), model, permissionMode],
 );
 const commands = agentConnectionCommand({
  baseUrl,
  token,
  workspaceId: agent.workspace_id,
  agentId,
  handle,
  name: updateRows[0]?.name || agent.name,
  model: updateRows[0]?.model || agent.model,
  permissionMode,
  runtime,
 });
 return json({
  data: {
   agent: updateRows[0],
   handle,
   token,
   command: commands.portableCommand,
   localCommand: commands.localCommand,
   portableCommand: commands.portableCommand,
   baseUrl,
   model,
   permissionMode,
   permission_mode: permissionMode,
   runtime: runtime || null,
   permissionFlags: agentPermissionFlags(permissionMode),
  },
  error: null,
 });
}

async function handleAuth(pathname, req) {
 const body = await readBody(req);
 const email = String(body?.email || '').trim().toLowerCase();
 const password = String(body?.password || '');
 if (!email || !password) return jsonError(400, new Error('Email and password are required'));

 if (pathname === '/backend/auth/signup') {
  const signupBlocked = rateLimitBlock(signupRateLimiter, clientIpFromRequest(req));
  if (signupBlocked) return signupBlocked;

  const policy = evaluatePasswordServerSide(password);
  if (!policy.valid) return jsonError(400, new Error(policy.message || 'Password must be at least 10 characters and include 3 of: lowercase, uppercase, number, symbol.'));

  // The configured system owner's address cannot be claimed through public
  // signup: Tenants-surface authority derives from the stored email, and
  // signup never verifies mailbox ownership (shared/tenant-admin.cjs has the
  // full story). Same status and message as the duplicate-account refusal
  // below, on purpose — this response must not mark the address as special.
  if (isReservedSignupEmail(email)) return jsonError(409, new Error('An account with that email already exists'));

  const existing = await query('select id from app_users where email = $1 limit 1', [email]);
  if (existing.length > 0) return jsonError(409, new Error('An account with that email already exists'));

  const rows = await query(
   'insert into app_users (email, password_hash) values ($1, $2) returning id, email, display_name, accent_color, created_at, token_version',
   [email, createPasswordHash(password)],
  );
  const row = rows[0];
  const user = { id: row.id, email: row.email, display_name: row.display_name, accent_color: row.accent_color, created_at: row.created_at };
  return json({ data: { user, token: issueToken(user.id, row.token_version) }, error: null });
 }

 // signin — no complexity check (existing users must be able to log in with
 // whatever password they already have).
 const rows = await query('select id, email, password_hash, display_name, accent_color, created_at, token_version from app_users where email = $1 limit 1', [email]);
 const user = rows[0];
 const passwordOk = user && verifyPassword(password, user.password_hash);

 // L3 (2026-07 review): only FAILED attempts count, and a correct password is
 // never blocked, so a guesser can't lock a victim out. Mirrors the daemon.
 if (!passwordOk) {
  const emailAllowed = signinRateLimiter.check(`signin:${email}`).allowed;
  const ipAllowed = signinIpFailureLimiter.check(`signin-ip:${clientIpFromRequest(req)}`).allowed;
  if (!emailAllowed || !ipAllowed) {
   return new Response(JSON.stringify({ data: null, error: { message: 'Too many failed sign-in attempts. Please wait a minute and try again.', code: 'rate_limited' } }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
   });
  }
  return jsonError(401, new Error('Invalid email or password'));
 }
 const sessionUser = { id: user.id, email: user.email, display_name: user.display_name, accent_color: user.accent_color, created_at: user.created_at };
 return json({ data: { user: sessionUser, token: issueToken(sessionUser.id, user.token_version) }, error: null });
}

async function handleOAuthAuth() {
 const identityUser = await getUser();
 const email = String(identityUser?.email || '').trim().toLowerCase();
 if (!email) return jsonError(401, new Error('Social login was not completed'));

 const existing = await query('select id, email, display_name, accent_color, created_at, token_version from app_users where email = $1 limit 1', [email]);
 // This door CREATES accounts too, so the owner-address reservation applies
 // here as well: the email is whatever the identity provider asserted, and
 // providers differ on whether the mailbox was ever actually verified. Only
 // creation is refused — an owner account that already exists signs in
 // through OAuth exactly as before.
 if (!existing[0] && isReservedSignupEmail(email)) {
  return jsonError(409, new Error('An account with that email already exists'));
 }
 const row = existing[0] || (await query(
  'insert into app_users (email, password_hash) values ($1, $2) returning id, email, display_name, accent_color, created_at, token_version',
  [email, `oauth:netlify:${identityUser.id}`],
 ))[0];
 const user = { id: row.id, email: row.email, display_name: row.display_name, accent_color: row.accent_color, created_at: row.created_at };

 return json({ data: { user, token: issueToken(user.id, row.token_version) }, error: null });
}

async function handleGetMyProfile(userId) {
 const rows = await query('select id, email, display_name, accent_color, share_read_receipts, created_at from app_users where id = $1 limit 1', [userId]);
 if (!rows[0]) return jsonError(404, new Error('User not found'));
 return json({ data: rows[0], error: null });
}

async function handleUpdateMyProfile(req, userId, suppliedBody = null) {
 const body = suppliedBody ?? await readBody(req);
 const updates = {};
 if (body?.display_name !== undefined) {
  updates.display_name = String(body.display_name || '').trim().slice(0, 80);
 }
 if (body?.accent_color !== undefined) {
  const color = String(body.accent_color || '').trim();
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
   return jsonError(400, new Error('accent_color must be a #rrggbb hex value'));
  }
  updates.accent_color = color;
 }
 if (body?.share_read_receipts !== undefined) {
  // Coerced to a real boolean, mirroring server/auth-routes.cjs: the column is
  // NOT NULL and a string 'false' is truthy in every language that reads it.
  updates.share_read_receipts = body.share_read_receipts === true
   || String(body.share_read_receipts).toLowerCase() === 'true';
 }
 const fields = Object.keys(updates);
 if (fields.length === 0) return jsonError(400, new Error('No fields to update'));

 const setClause = fields.map((field, i) => `${field} = $${i + 2}`).join(', ');
 const updateSql =
  `update app_users set ${setClause} where id = $1 returning id, email, display_name, accent_color, share_read_receipts, created_at`;
 const params = [userId, ...fields.map(field => updates[field])];
 const rows = updates.share_read_receipts === false
  ? await withDbTransaction(async (transactionQuery) => {
    const updated = await transactionQuery(updateSql, params);
    if (updated[0]) {
     await transactionQuery(DELETE_HUMAN_READ_MARKERS_SQL, [userId]);
    }
    return updated;
   })
  : await query(updateSql, params);
 if (!rows[0]) return jsonError(404, new Error('User not found'));
 return json({ data: rows[0], error: null });
}

async function handleChangeMyPassword(req, userId) {
 const body = await readBody(req);
 const currentPassword = String(body?.currentPassword || '');
 const newPassword = String(body?.newPassword || '');
 if (!currentPassword || !newPassword) return jsonError(400, new Error('Current and new password are required'));
 const newPasswordPolicy = evaluatePasswordServerSide(newPassword);
 if (!newPasswordPolicy.valid) return jsonError(400, new Error(newPasswordPolicy.message || 'Password must be at least 10 characters and include 3 of: lowercase, uppercase, number, symbol.'));

 const rows = await query('select id, password_hash from app_users where id = $1 limit 1', [userId]);
 const user = rows[0];
 if (!user || !verifyPassword(currentPassword, user.password_hash)) {
  return jsonError(401, new Error('Current password is incorrect'));
 }

 // Bumping token_version invalidates EVERY outstanding token for this user,
 // including the one used to make this very request — issue a fresh one below
 // so the caller's own session survives without a forced re-login.
 const updated = await query(
  'update app_users set password_hash = $2, token_version = token_version + 1 where id = $1 returning token_version',
  [userId, createPasswordHash(newPassword)],
 );
 const newVersion = updated[0]?.token_version;
 tokenVersionCache.set(userId, newVersion);
 return json({ data: { ok: true, token: issueToken(userId, newVersion) }, error: null });
}

// Real server-side sign-out: bumps token_version so the calling token (and
// every other outstanding token for this user) is rejected on its next use.
async function handleSignOut(userId) {
 const updated = await query(
  'update app_users set token_version = token_version + 1 where id = $1 returning token_version',
  [userId],
 );
 if (updated[0]) tokenVersionCache.set(userId, updated[0].token_version);
 return json({ data: { ok: true }, error: null });
}

// Logs an `activity_events` row for each inserted chat message so it surfaces in
// the Activity feed. The canonical schema and migration own the partial unique
// index that makes this idempotent; request handling only writes data.
async function logMessageActivity(rows) {
 await logMessageActivityIdempotent(rows, { db: query });
}

// Default agents seeded into every brand-new workspace. Kept in sync with the
// local backend (server/index.cjs).
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
 const existing = await query(
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

 await query(
  `insert into workspace_agents (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning *`,
  params,
 );
}

// ---------------------------------------------------------------------------
// Reactions and read receipts — the Netlify half of the two dedicated routes.
//
// Every decision is in the shared modules (shared/reaction-toggle.cjs,
// shared/read-receipts.cjs) and every guard is the same shared function the Fly
// lane calls. What is NOT shared, and must not be: the jsonb bind. Nothing here
// binds jsonb directly — the reaction statements build the map with jsonb
// operators server-side, so there is no map parameter to get wrong on either
// lane, which is a small side benefit of moving the mutation into SQL.
//
// There is no realtime fanout on this lane (serverless has no socket to fan to);
// clients on the Fly lane get the live update, and a client on this one sees the
// change on its next read. That asymmetry predates this feature.
// ---------------------------------------------------------------------------

// Resolve a session and run BOTH gates: workspace membership, then the DM gate
// under it. Returns the row so callers never re-read it.
async function authorizeSessionForUser(
 sessionId,
 userId,
 capability,
 { concealUnavailable = false } = {},
) {
 const unavailable = () => jsonError(
  404,
  new Error(concealUnavailable
   ? 'Conversation not found or unavailable'
   : 'Conversation not found'),
 );
 const rows = await query(
  `select id, workspace_id, visibility, folder, parent_message_id, split_parent_id, deleted_at
     from chat_sessions
    where id = $1::uuid
    limit 1`,
  [sessionId],
 );
 const session = rows[0];
 if (!session) return { error: unavailable() };
 try {
  await assertWorkspaceRole({ userId, workspaceId: session.workspace_id, capability, db: query });
  await enforceSessionReadAccess({ userId, sessionId, sessionRow: session, db: query });
 } catch (error) {
  if (concealUnavailable && (error?.status === 403 || error?.status === 404)) {
   return { error: unavailable() };
  }
  throw error;
 }
 return { session };
}

/**
 * Resolve the private-session classification inherited by a client-created
 * sub-thread or split. This is the Netlify mirror of the Fly generic insert
 * rule: a derived session must be private before its INSERT becomes visible,
 * never corrected after the fact. Folder-only legacy DMs are private too.
 */
async function _resolveInheritedSessionVisibility(
 rows,
 userId,
 db = query,
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
   console.warn('[backend] inherited session visibility lookup failed:', error?.message || error);
   // This query proves both classification AND authority. Merely forcing the
   // child private would still accept an unverified cross-workspace parent and
   // could copy that parent's members after the INSERT. On an infrastructure
   // fault the only fail-closed answer is therefore no derived session at all.
   const unavailable = new Error('Unable to verify the parent conversation');
   unavailable.status = 503;
   throw unavailable;
  }
 }
 return inheritedPrivate ? 'private' : null;
}

async function _copyInheritedSessionMembers(row, db = query) {
 const parentSessionId = row?.split_parent_id ? String(row.split_parent_id) : '';
 const parentMessageId = row?.parent_message_id ? String(row.parent_message_id) : '';
 if (!row?.id || (!parentSessionId && !parentMessageId)) return true;
 try {
  await db(
   `insert into chat_session_members (session_id, user_id, source, granted_by, expires_at)
      select $1::uuid, member.user_id, member.source, member.granted_by, member.expires_at
        from chat_session_members member
       where member.session_id = coalesce(
               $2::uuid,
               (select parent_message.session_id
                  from messages parent_message
                 where parent_message.id = $3::uuid
                   and parent_message.deleted_at is null)
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

async function handleToggleReaction(req, messageId, userId) {
 const body = await readBody(req);
 const op = normalizeReactionOp(body?.op);
 if (!op) return jsonError(400, badRequest("op must be 'add' or 'remove'"));
 const reaction = normalizeReactionValue(body?.reaction ?? body?.emoji);
 if (!reaction) return jsonError(400, badRequest('A reaction is required'));

 const blocked = rateLimitBlock(reactionRateLimiter, `${userId}:${messageId}`);
 if (blocked) return blocked;

 const rows = await query(
  `select m.id, m.session_id from messages m
    where m.id = $1::uuid and m.deleted_at is null
    limit 1`,
  [messageId],
 );
 if (!rows[0]) return jsonError(404, new Error('Message not found'));
 const sessionId = String(rows[0].session_id);
 // 'write', not 'read': a reaction changes a stored row and publishes your name
 // against someone else's message. A viewer may read the channel, not annotate it.
 const gate = await authorizeSessionForUser(sessionId, userId, 'write');
 if (gate.error) return gate.error;

 const updated = await query(reactionToggleSql(op), [messageId, sessionId, reaction, String(userId)]);

 if (updated.length === 0) {
  const current = await query(
    REACTION_CURRENT_SQL,
    [messageId, sessionId, String(userId)],
  );
  const problem = explainReactionNoop(current[0], { op, reaction, userId });
  if (problem) return jsonError(problem.status, new Error(problem.message));
  return json({ data: { messageId, reactions: current[0]?.reactions ?? {}, changed: false }, error: null });
 }

 const after = updated[0];
 // The before/after-map contract, unchanged: the flow module still diffs two
 // real maps. The before-image is DERIVED from the after-image and the op rather
 // than re-read, because a SELECT for it would reintroduce the race this route
 // exists to remove. Awaited (not fire-and-forget) only so the serverless
 // container is not frozen mid-insert; a failure is logged and dropped.
 try {
  await emitReactionFlowEventsForUpdate({
   db: query,
   // @netlify/database REQUIRES the stringified form for a $n::jsonb bind — the
   // exact opposite of the Fly lane. Deliberately not unified; see
   // tests/jsonb-bind-hygiene.test.cjs.
   encodeJsonb: (payload) => JSON.stringify(payload),
   priorRows: [{ ...after, reactions: priorReactionMap(after.reactions, { op, reaction, userId }) }],
   updatedRows: updated,
   nextReactions: after.reactions,
   actorUserId: userId,
   onWarn: (message) => console.warn('[flows] reaction events:', message),
  });
 } catch (error) {
  console.error('[flows] failed to queue reaction event:', error?.message || error);
 }

 return json({ data: { messageId, reactions: after.reactions ?? {}, changed: true }, error: null });
}

async function handleAdvanceReadMarker(req, sessionId, userId) {
 const body = await readBody(req);
 const messageId = String(body?.lastSeenMessageId || body?.last_seen_message_id || '').trim();
 if (!messageId) return jsonError(400, badRequest('lastSeenMessageId is required'));
 const threadParentId = optionalReadReceiptThreadParent(body?.threadParentId || body?.thread_parent_id);

 const blocked = rateLimitBlock(readReceiptRateLimiter, `${userId}:${sessionId}:${threadParentId || 'channel'}`);
 if (blocked) return blocked;

 const gate = await authorizeSessionForUser(sessionId, userId, 'read');
 if (gate.error) return gate.error;

 const rows = await query(
  ADVANCE_READ_MARKER_SQL,
  [sessionId, String(userId), messageId, threadParentId],
 );
 // Always ok, exactly like the Fly lane: "already at or ahead of this point" is
 // success, and so is "I have receipts switched off" — a caller must not be able
 // to detect a setting by probing.
 return json({ data: { ok: true, marker: rows[0] ? toReadMarker(rows[0]) : null }, error: null });
}

async function handleSessionReadState(req, sessionId, userId) {
 const gate = await authorizeSessionForUser(sessionId, userId, 'read');
 if (gate.error) return gate.error;
 const threadParentId = optionalReadReceiptThreadParent(
  new URL(req.url).searchParams.get('thread_parent_id'),
 );
 const rows = await query(SESSION_READ_STATE_SQL, [sessionId, String(userId), threadParentId]);
 return json({ data: { markers: rows.map(toReadMarker) }, error: null });
}

async function handleClearSession(sessionId, userId) {
 const gate = await authorizeSessionForUser(
  sessionId,
  userId,
  'manage',
  { concealUnavailable: true },
 );
 if (gate.error) return gate.error;
 if (!isPrivateSessionRow(gate.session)) {
  return jsonError(400, new Error('Only private conversations can be deleted this way'));
 }
 // Locking and mutating must be separate statements in one transaction. A
 // single CTE takes its snapshot before it waits on a concurrent message
 // INSERT's session lock and can therefore miss the row that just committed.
 const result = await withDbTransaction(async (transactionQuery) => {
  const locked = await transactionQuery(
   `with recursive clear_workspace_chain as (
      select id, parent_id, 0 as depth
        from workspaces
       where id = $5::uuid
      union all
      select parent.id, parent.parent_id, chain.depth + 1
        from workspaces parent
        join clear_workspace_chain chain on parent.id = chain.parent_id
       where chain.depth < 10
    ),
    clear_locked_workspace_chain as materialized (
      select workspace.id, workspace.user_id
        from workspaces workspace
        join clear_workspace_chain chain on chain.id = workspace.id
      for share of workspace
    ),
    clear_manager_membership as materialized (
      select membership.workspace_id
        from workspace_members membership
        join clear_locked_workspace_chain workspace
          on workspace.id = membership.workspace_id
       where membership.user_id = $2
         and membership.role in ('owner', 'admin')
      for share of membership
    )
    select clear_session_scope.id
      from chat_sessions clear_session_scope
      join chat_session_members clear_session_member
        on clear_session_member.session_id = clear_session_scope.id
       and clear_session_member.user_id = $2
     where clear_session_scope.id = $1::uuid
       and clear_session_scope.deleted_at is null
       and clear_session_scope.visibility is not distinct from $3
       and clear_session_scope.folder is not distinct from $4
       and (
         exists (
           select 1 from clear_locked_workspace_chain workspace
            where workspace.user_id = $2
         )
         or exists (select 1 from clear_manager_membership)
       )
       and ${sessionReadableSql('clear_session_scope', '$2')}
     for update of clear_session_scope, clear_session_member`,
   [
    sessionId,
    userId,
    gate.session.visibility ?? null,
    gate.session.folder ?? null,
    gate.session.workspace_id,
   ],
  );
  if (locked.length !== 1) {
   throw forbidden('Conversation access changed before the delete completed');
  }
  const effects = await settleSessionClosure({
   query: transactionQuery,
   hostSessionIds: [sessionId],
   closeHostSessions: true,
  });
  if (!effects.sessions.some(row => String(row.id) === String(sessionId))) {
   throw forbidden('Conversation access changed before the delete completed');
  }
  return effects;
 });
 return json({
  data: {
   sessionId,
   clearedMessages: result.clearedMessages,
   cancelledJobs: result.jobs.length,
   closed: true,
  },
  error: null,
 });
}

async function handleCloseSession(sessionId, userId) {
 const gate = await authorizeSessionForUser(sessionId, userId, 'read');
 if (gate.error) return gate.error;
 const derived = Boolean(gate.session.parent_message_id || gate.session.split_parent_id);
 await assertWorkspaceRole({
  userId,
  workspaceId: gate.session.workspace_id,
  capability: derived ? 'write' : 'manage',
  db: query,
 });
 const result = await withDbTransaction(async (transactionQuery) => {
  const locked = await transactionQuery(
   `select close_session_scope.id
      from chat_sessions close_session_scope
     where close_session_scope.id = $1::uuid
       and close_session_scope.workspace_id = $3::uuid
       and close_session_scope.parent_message_id is not distinct from $4::uuid
       and close_session_scope.split_parent_id is not distinct from $5::uuid
       and ${sessionReadableSql('close_session_scope', '$2', { lockMembership: true })}
     for update of close_session_scope`,
   [
    sessionId,
    userId,
    gate.session.workspace_id,
    gate.session.parent_message_id ?? null,
    gate.session.split_parent_id ?? null,
   ],
  );
  if (locked.length !== 1) {
   throw forbidden('Conversation access changed before the close completed');
  }
  const effects = await settleSessionClosure({
   query: transactionQuery,
   hostSessionIds: [sessionId],
   closeHostSessions: true,
  });
  if (!effects.sessions.some(row => String(row.id) === String(sessionId))) {
   throw forbidden('Conversation access changed before the close completed');
  }
  return effects;
 });
 return json({
  data: {
   sessionId,
   clearedMessages: result.clearedMessages,
   cancelledJobs: result.jobs.length,
   closed: true,
  },
  error: null,
 });
}

async function handleSplitSession(sessionId, userId) {
 const gate = await authorizeSessionForUser(sessionId, userId, 'write');
 if (gate.error) return gate.error;
 const result = await withDbTransaction((transactionQuery) => createSessionSplit({
  query: transactionQuery,
  sourceSessionId: sessionId,
  userId,
  // node-postgres/@netlify/database requires serialized jsonb parameters.
  jsonParam: value => JSON.stringify(value),
 }));
 return json({
  data: {
   session: result.session,
   baselineMessageId: result.baselineMessage.id,
   sourceBoundaryMessageId: result.sourceBoundaryMessageId,
  },
  error: null,
 }, 201);
}

async function handleDb(pathname, req, userId) {
 const body = await readBody(req);

 if (pathname === '/backend/db/select') {
  const { table, columns = '*', filters = [], orderBy = null, limit = null, single = false } = body || {};
  const tableSql = ensureTable(table);
  assertGenericSelectAllowed(table);
  await enforceDbOperationAccess({ userId, table, op: 'select', filters, db: query });
  // `workspaces` SELECT is scoped to rows the user owns or is a member of.
  // chat_sessions / messages SELECT is scoped to sessions the user may read —
  // enforceDbOperationAccess answers "may you", it cannot drop rows.
  const where = table === 'workspaces'
   ? appendWorkspaceAccessClause(buildWhereClause(filters, []), userId)
   : appendSessionAccessClause(buildWhereClause(filters, []), userId, table);
  const { clause, params } = where;
  const limitSql = Number.isInteger(limit) ? ` LIMIT ${Number(limit)}` : '';
  // M7: project the requested columns through the shared per-table read
  // allow-list first, so `columns: "*"` on app_users can never return the
  // caller's password_hash / token_version.
  const safeColumns = safeSelectColumns(table, columns);
  const normalizedColumns = normalizeColumns(safeColumns);
  const requestedColumns = String(safeColumns || '*').split(',').map((column) => column.trim());
  const appendedDeletedAt = table === 'messages'
   && normalizedColumns !== '*'
   && !requestedColumns.includes('deleted_at');
  const queryColumns = appendedDeletedAt
   ? `${normalizedColumns}, "deleted_at"`
   : normalizedColumns;
  const rows = await query(`select ${queryColumns} from ${tableSql}${clause}${buildOrderClause(orderBy)}${limitSql}`, params);
  const publicRows = table === 'messages'
   ? redactDeletedMessageRows(rows).map((row) => {
    if (!appendedDeletedAt) return row;
    const { deleted_at: _projectionOnly, ...projected } = row;
    return projected;
   })
   : rows;
  return json({ data: single ? (publicRows[0] ?? null) : publicRows, error: null });
 }

 if (pathname === '/backend/db/insert') {
  const { table, values, returning = '*', single = false } = body || {};
  const tableSql = ensureTable(table);
  await enforceDbOperationAccess({ userId, table, op: 'insert', payload: { values }, db: query });
  const messageAuthor = table === 'messages'
   ? await loadBrowserMessageAuthor({ userId, db: query })
   : null;
  // Force a workspace's owner to the authed user (never trust a client user_id).
  // Strip privileged columns (storage_path, mcp_approved, …) from generic writes.
  const rows = (Array.isArray(values) ? values : [values]).map((row) => {
   // Validate before any object spread can turn an array or other non-record
   // value into a record that appears safe only after server normalization.
   validateUniformInsertRows([row]);
   let next = stripPrivilegedDbValues(table, row);
   next = stampTaskWriteIdentity(table, next, userId, { insert: true });
   next = applyAgentPurposeInsertDefaults(table, next);
   if (table === 'workspaces') next = { ...next, user_id: userId };
   if (table === 'messages') next = stampBrowserMessageInsert(next, messageAuthor);
   // Mirrors server/index.cjs — see the comment there for why this route
   // strips the title but never infers parent_id from it.
   if (table === 'tasks' && typeof next.title === 'string') {
    const normalized = normalizeTaskTitle(next.title);
    if (normalized.changed) next = { ...next, title: normalized.title };
   }
   // Mirrors server/index.cjs: @channel addresses every agent in a channel, so
   // no agent may answer to `channel`. A guard on one backend only is a rule the
   // other half of the deployment does not have.
   if (table === 'workspace_agents' && isReservedAgentHandle(next.handle)) {
    throw badRequest(reservedAgentHandleMessage(next.handle));
   }
   // Mirrors server/index.cjs: creation-time identity choices are HUMAN
   // choices — synthesize the human_set locks server-side (discarding any
   // client-supplied ones) so an agent's first connect cannot replace them.
   next = synthesizeHumanIdentityInsert(table, next);
   return next;
  });
  // Validate the caller-visible projection before opening a transaction or
  // writing anything. A forbidden/invalid RETURNING shape must not create a
  // conversation and then fail while formatting the response.
  if (table === 'chat_sessions') {
   projectSessionCreateRows([], returning);
   // This is a pure shape check. Keep it outside the transaction so a malformed
   // child (both parent edges set) cannot even open a write transaction.
   rows.forEach(sessionLineageKind);
  }
  const insertRows = async (db) => {
   let effectiveRows = rows;
   let lineage = null;
   if (table === 'chat_sessions') {
    const prepared = await prepareSessionCreateRows({
     db,
     userId,
     rows,
    });
    effectiveRows = prepared.rows;
    lineage = prepared.lineage;
   }
   const columns = validateUniformInsertRows(effectiveRows);
   const params = [];
   const valueSql = effectiveRows.map((row) => `(${columns.map((column) => {
    return bindDbParam(params, table, column, row[column]);
   }).join(', ')})`).join(', ');
   const returningColumns = table === 'chat_sessions' ? '*' : returning;
   const inserted = await db(
    `insert into ${tableSql} (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning ${normalizeColumns(safeSelectColumns(table, returningColumns))}`,
    params,
   );
   if (table === 'chat_sessions') {
    await installCreatedSessionMemberships({
     db,
     userId,
     createdRows: inserted,
     lineage,
    });
   }
   return inserted;
  };
  const result = table === 'chat_sessions'
   ? await withDbTransaction(insertRows)
   : await insertRows(query);
  if (table === 'messages') {
   await logMessageActivity(result);
  }
  if (table === 'workspaces') {
   for (const row of result) {
    try {
     await seedDefaultAgents(row.id, row.user_id ?? userId);
    } catch (seedError) {
     console.error('seedDefaultAgents failed', seedError);
    }
   }
  }
  const responseRows = table === 'chat_sessions'
   ? projectSessionCreateRows(result, returning)
   : table === 'messages' ? redactDeletedMessageRows(result) : result;
  return json({ data: single ? (responseRows[0] ?? null) : responseRows, error: null });
 }

 if (pathname === '/backend/db/update') {
  const { table, values, filters = [], returning = '*', single = false } = body || {};
  const tableSql = ensureTable(table);
  if (!values || typeof values !== 'object') return jsonError(400, new Error('Update values are required'));
  await enforceDbOperationAccess({ userId, table, op: 'update', filters, payload: { values }, db: query });
  // Mirrors server/index.cjs: renaming an agent INTO the reserved handle is the
  // same door as creating one there.
  if (table === 'workspace_agents' && isReservedAgentHandle(values.handle)) {
   return jsonError(400, new Error(reservedAgentHandleMessage(values.handle)));
  }
  const safeValues = stampTaskWriteIdentity(
   table,
   stripImmutableDbUpdateValues(table, stripPrivilegedDbValues(table, values)),
   userId,
  );

  // Mirrors server/index.cjs: a human's edit to an agent's identity is recorded
  // in identity.human_set, so the agent's next self-declaration on connect
  // treats it as already chosen. The identity jsonb is NEVER written from the
  // client's object — only a validated `voice` is grafted onto the STORED
  // column in SQL — so a payload like {"identity":{"human_set":{...}}} (or
  // {"identity":{}}) can neither forge a lock nor erase one.
  // See shared/agentIdentity.cjs.
  const { values: markedValues, voice, lockPatch } = markHumanIdentityWrite(table, safeValues);
  const keys = Object.keys(markedValues);
  if (keys.length === 0 && !lockPatch) {
   return jsonError(400, new Error('No updatable fields provided'));
  }
  // Mirrors Fly: workspace_agents.version is stripped before this point, so
  // every genuine agent edit advances the stored optimistic-concurrency token.
  const shouldBumpVersion = VERSIONED_TABLES.has(table) && safeValues.version == null;

  const params = [];
  const setParts = keys.map((column) => `${quoteIdent(column)} = ${bindDbParam(params, table, column, markedValues[column])}`);
  if (table === 'tasks' && Object.prototype.hasOwnProperty.call(markedValues, 'assignee_id')) {
   const assigneeBind = bindDbParam(params, table, 'assignee_id', markedValues.assignee_id);
   const assigned = typeof markedValues.assignee_id === 'string'
    ? markedValues.assignee_id.trim()
    : markedValues.assignee_id;
   const requesterBind = bindDbParam(
    params,
    table,
    'dispatch_requested_by',
    assigned ? userId : null,
   );
   setParts.push(taskDispatchRequesterSql(assigneeBind, requesterBind));
  }
  if (lockPatch) {
   const voiceBound = voice !== undefined ? bindDbParam(params, table, 'identity', voice) : null;
   setParts.push(`"identity" = ${identityWriteSql(voiceBound, bindDbParam(params, table, 'identity', lockPatch))}`);
  }
  if (shouldBumpVersion) {
   setParts.push('"version" = COALESCE("version", 0) + 1');
  }
  const setClause = setParts.join(', ');

  // Mirrors server/index.cjs: a reaction event is the DIFFERENCE between the
  // stored map and the one being written, and the write replaces the whole
  // column — so the before-image has to be read first, and only for the writes
  // that actually touch `reactions`. Swallowed on failure: a reaction that
  // saves without an event is a missing signal, but a reaction that fails to
  // save because the event machinery could not read is a lost user action.
  let priorReactionRows = [];
  if (table === 'messages' && Object.prototype.hasOwnProperty.call(safeValues, 'reactions')) {
   const priorWhere = buildWhereClause(filters, []);
   priorReactionRows = await query(
    `select id, session_id, reactions, sender_kind, sender_id, sender_name, thread_parent_id, created_at
       from ${tableSql}${priorWhere.clause}`,
    priorWhere.params,
   ).catch(() => []);
  }

  const mutationFilters = appendMessageAuthorshipFilters({
   userId,
   table,
   op: 'update',
   filters,
   values,
  });
  const where = appendMessageMutationAccessClause(
   buildWhereClause(mutationFilters, params),
   userId,
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
  if (closesSessions) {
   const forwarded = await forwardConversationControl(req, pathname, body);
   if (forwarded) return forwarded;
  }
  const changesSessionPrivacy = table === 'chat_sessions'
   && (
    Object.prototype.hasOwnProperty.call(safeValues, 'visibility')
    || Object.prototype.hasOwnProperty.call(safeValues, 'folder')
   );
  let canonicalClosedSessionRows = [];
  const integrityReturning = editsMessageContent
   ? `${normalizeColumns(returning)}, id as "__integrity_id", session_id as "__integrity_session_id"`
   : closesSessions
    ? `${normalizeColumns(returning)}, id as "__integrity_id"`
    : changesSessionPrivacy
     ? `${normalizeColumns(returning)}, id as "__integrity_id", visibility as "__integrity_visibility", folder as "__integrity_folder"`
     : normalizeColumns(returning);
  const rawResult = editsMessageContent || changesSessionPrivacy || closesSessions
   ? await withDbTransaction(async (transactionQuery) => {
    let lockedSessionIds = [];
    if (closesSessions) {
     const lockWhere = buildWhereClause(filters, []);
     lockWhere.params.push(userId);
     const userParam = `$${lockWhere.params.length}`;
     const accessJoin = lockWhere.clause ? ' and ' : ' where ';
     const locked = await transactionQuery(
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
     await settleSessionClosure({
      query: transactionQuery,
      hostSessionIds: lockedSessionIds,
      closeHostSessions: false,
     });
    }
    const updated = await transactionQuery(
     `update ${tableSql} set ${setClause}${where.clause} returning ${integrityReturning}`,
     where.params,
    );
    if (closesSessions && updated.length !== lockedSessionIds.length) {
     throw forbidden('Conversation access changed before the close completed');
    }
    if (closesSessions) {
     // Production forwards this request to Fly, where these rows become the
     // realtime lifecycle event. Keep the local mirror's contract identical:
     // caller-selected RETURNING is never accepted as an affected-row snapshot.
     canonicalClosedSessionRows = await transactionQuery(
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
      await scrubEditedMessageActivityByMessageId({
       db: transactionQuery,
       messageId: row.__integrity_id,
       sessionId: row.__integrity_session_id,
      });
     }
    } else if (!closesSessions) {
     for (const row of updated) {
      if (!closesSessions && !isPrivateSessionRow({
       visibility: row.__integrity_visibility,
       folder: row.__integrity_folder,
      })) continue;
      await scrubMessageActivityBySession({
       db: transactionQuery,
       sessionId: row.__integrity_id,
      });
     }
    }
    return updated;
   })
   : await query(
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
  if (closesSessions && canonicalClosedSessionRows.length !== result.length) {
   throw forbidden('Conversation closure could not be canonicalized');
  }

  // AFTER the row is written, and awaited only so the serverless container is
  // not frozen mid-insert — a failure here is logged and dropped, never
  // returned. The reaction is already saved.
  if (priorReactionRows.length > 0) {
   try {
    await emitReactionFlowEventsForUpdate({
     db: query,
     // @netlify/database REQUIRES the stringified form for a $n::jsonb bind —
     // the exact opposite of the Fly lane's porsager driver. Deliberately not
     // unified; see tests/jsonb-bind-hygiene.test.cjs.
     encodeJsonb: (payload) => JSON.stringify(payload),
     priorRows: priorReactionRows,
     updatedRows: result,
     nextReactions: safeValues.reactions,
     actorUserId: userId,
     onWarn: (message) => console.warn('[flows] reaction events:', message),
    });
   } catch (error) {
    console.error('[flows] failed to queue reaction event:', error?.message || error);
   }
  }

  const publicResult = table === 'messages' ? redactDeletedMessageRows(result) : result;
  return json({ data: single ? (publicResult[0] ?? null) : publicResult, error: null });
 }

 if (pathname === '/backend/db/delete') {
  const { table, filters = [], single = false } = body || {};
  const tableSql = ensureTable(table);
  // Refuse an unfiltered delete — it would wipe the entire table.
  if (!Array.isArray(filters) || filters.length === 0) {
   return jsonError(400, new Error('Delete requires at least one filter'));
  }
  const mutationFilters = appendMessageAuthorshipFilters({
   userId,
   table,
   op: 'delete',
   filters,
  });
  const where = appendMessageMutationAccessClause(
   buildWhereClause(mutationFilters, []),
   userId,
   table,
  );
  if (!where.clause) {
   return jsonError(400, new Error('Delete requires a non-empty where clause'));
  }
  await enforceDbOperationAccess({ userId, table, op: 'delete', filters, db: query });
  const result = table === 'messages'
   ? await withDbTransaction(async (transactionQuery) => {
    const deleted = await transactionQuery(
     `update ${tableSql}
         set deleted_at = coalesce(deleted_at, now())
         ${where.clause} and deleted_at is null
       returning *`,
     where.params,
    );
    if (deleted.length === 0) {
     throw forbidden('Message access changed before the delete completed');
    }
    await scrubMessageActivityByMessageId({
     db: transactionQuery,
     messageId: deleted[0].id,
     sessionId: deleted[0].session_id,
    });
    return deleted;
   })
   : await query(`delete from ${tableSql}${where.clause} returning *`, where.params);
  if (table === 'messages' && result.length === 0) {
   throw forbidden('Message access changed before the delete completed');
  }
  const publicResult = table === 'messages' ? redactDeletedMessageRows(result) : result;
  return json({ data: single ? (publicResult[0] ?? null) : null, error: null });
 }

 return jsonError(404, new Error('Backend route not found'));
}

const MESSAGE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PENDING_AI_REPLY = 'Thinking …';
const EMPTY_AI_REPLY = 'AI response finished without content.';

function aiStatusError(status, error) {
 const issue = error instanceof Error ? error : new Error(String(error || 'AI request failed'));
 issue.status = status;
 return issue;
}

async function handleAiChat(req, userId) {
 const {
 messages, model, memory, documents, workspaceContext, agentContext, workspaceId,
  sessionId, messageId, seedMessageId, threadParentId, replyAgentId,
 } = await readBody(req);
 let executionModel = model;
 let executionAgentContext = agentContext;
 let hasVerifiedReplyAgent = false;
 let replyAgentSnapshotVersion = null;
 let storedReplyContext = null;
 // A valid token is required (enforced by the router). workspaceId is mandatory
 // and the user must be allowed to run agents there — otherwise any signed-up
 // user could omit workspaceId to skip authorization and stream completions on
 // the app-level ANTHROPIC_API_KEY (M4, 2026-07 review). Mirrors the daemon.
 if (!workspaceId) return jsonError(400, new Error('workspaceId is required'));
 await assertWorkspaceRole({ userId, workspaceId, capability: 'run_agents', db: query });

 let replyPersistence = null;
 if (sessionId != null || messageId != null || threadParentId != null) {
  if (!MESSAGE_UUID_RE.test(String(sessionId || ''))
    || !MESSAGE_UUID_RE.test(String(messageId || ''))
    || !MESSAGE_UUID_RE.test(String(seedMessageId || ''))) {
   return jsonError(
    400,
    new Error('Valid sessionId, messageId, and seedMessageId are required to save an AI reply'),
   );
  }
  if (threadParentId && !MESSAGE_UUID_RE.test(String(threadParentId))) {
   return jsonError(400, new Error('threadParentId must be a valid message id'));
  }
  const gate = await authorizeSessionForUser(String(sessionId), userId, 'write');
  if (gate.error) return gate.error;
  if (String(gate.session.workspace_id) !== String(workspaceId)) {
   return jsonError(404, new Error('Conversation not found'));
  }
  const sessionDetails = await query(
   'select participants, deleted_at from chat_sessions where id = $1::uuid limit 1',
   [String(sessionId)],
  );
  if (!sessionDetails[0] || sessionDetails[0].deleted_at) {
   return jsonError(404, new Error('Conversation not found'));
  }
  if (threadParentId) {
   const parents = await query(
    'select id from messages where id = $1::uuid and session_id = $2::uuid limit 1',
    [String(threadParentId), String(sessionId)],
   );
   if (!parents[0]) return jsonError(400, new Error('Thread parent is not in this conversation'));
  }
  const replyAttribution = {
   senderKind: 'assistant',
   senderId: '',
   senderName: 'Agensis',
  };
  if (replyAgentId != null && String(replyAgentId).trim()) {
   const requestedAgentId = String(replyAgentId);
   if (!MESSAGE_UUID_RE.test(requestedAgentId)) {
    return jsonError(400, new Error('replyAgentId must be a valid agent id'));
   }
   const isSessionAgent = parseJsonArray(sessionDetails[0].participants).some((participant) =>
    participant?.kind === 'agent' && String(participant.agent_id || '') === requestedAgentId,
   );
   if (!isSessionAgent) {
    return jsonError(400, new Error('Reply agent is not a participant in this conversation'));
   }
   const agentRows = await query(
    `select id, name, handle, description, system_prompt, soul, instructions,
            tools, skills, model, run_mode, version
       from workspace_agents
      where id = $1::uuid and workspace_id = $2::uuid and enabled is not false
      limit 1`,
    [requestedAgentId, String(workspaceId)],
   );
   const replyAgent = agentRows[0];
   if (!replyAgent) {
    return jsonError(400, new Error('Reply agent is not available'));
   }
   const replyRunMode = String(replyAgent.run_mode || 'builtin');
   if (replyRunMode !== 'builtin') {
    return jsonError(
     409,
     new Error('Reply agent must answer through its configured connected runtime'),
    );
   }
   replyAttribution.senderKind = 'agent';
   replyAttribution.senderId = String(replyAgent.id);
   replyAttribution.senderName = String(replyAgent.name || 'Agent');
   // An attributed response must run as the verified participant, not as an
   // arbitrary client-supplied model/persona wearing that participant's name.
   executionModel = String(replyAgent.model || 'auto');
   executionAgentContext = {
    id: String(replyAgent.id),
    name: String(replyAgent.name || 'Agent'),
    handle: String(replyAgent.handle || ''),
    description: String(replyAgent.description || ''),
    systemPrompt: String(replyAgent.system_prompt || ''),
    soul: String(replyAgent.soul || ''),
    instructions: String(replyAgent.instructions || ''),
    tools: parseJsonArray(replyAgent.tools),
    skills: parseJsonArray(replyAgent.skills),
    model: executionModel,
    runMode: replyRunMode,
   };
   replyAgentSnapshotVersion = Number.isInteger(Number(replyAgent.version))
    ? Number(replyAgent.version)
    : 1;
   hasVerifiedReplyAgent = true;
  }
  replyPersistence = {
   reserved: false,
   finalized: false,
   async reserve() {
    await withDbTransaction(async (transactionQuery) => {
     await lockAiChatRunScope({ db: transactionQuery, workspaceId, userId });
     const reservedRows = await transactionQuery(
     `insert into messages
        (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
      with current_reply_agent as materialized (
        select agent.id
          from workspace_agents agent
         where $10::uuid is not null
           and agent.id = $10::uuid
           and agent.workspace_id = $9::uuid
           and agent.enabled is not false
           and agent.run_mode = 'builtin'
           and agent.version = $11::integer
	         for share of agent
	      ),
	      current_reply_seed as materialized (
	        select seed.id
	          from messages seed
	         where seed.id = $12::uuid
	           and seed.session_id = $2::uuid
	           and seed.deleted_at is null
	           and seed.role = 'user'
	           and seed.sender_kind = 'user'
	           and seed.sender_id::text = $8::text
	           and length(btrim(coalesce(seed.content, ''))) > 0
	           and (
	             ($4::uuid is null and seed.thread_parent_id is null)
	             or seed.thread_parent_id = $4::uuid
	           )
	         for share of seed
	      ),
	      accessible_ai_reply_session as materialized (
        select ai_reply_session_scope.id
          from chat_sessions ai_reply_session_scope
         where ai_reply_session_scope.id = $2::uuid
           and ai_reply_session_scope.workspace_id = $9::uuid
	           and ${sessionReadableSql('ai_reply_session_scope', '$8', { lockMembership: true })}
	           and exists (select 1 from current_reply_seed)
           and (
             $4::uuid is null
             or exists (
               select 1
                 from messages reply_parent
                where reply_parent.id = $4::uuid
                  and reply_parent.session_id = ai_reply_session_scope.id
                  and reply_parent.deleted_at is null
             )
           )
           and (
             $10::uuid is null
             or (
               $5 = 'agent'
               and $6 = $10::text
               and exists (select 1 from current_reply_agent)
               and exists (
                 select 1
                   from jsonb_array_elements(
                     coalesce(ai_reply_session_scope.participants, '[]'::jsonb)
                   ) participant
                  where participant->>'kind' = 'agent'
                    and participant->>'agent_id' = $10::text
               )
             )
           )
         for share of ai_reply_session_scope
      )
      select $1::uuid, $2::uuid, 'assistant', $3, $4::uuid, $5, $6, $7
        from accessible_ai_reply_session
      returning *`,
     [
      String(messageId),
      String(sessionId),
      PENDING_AI_REPLY,
      threadParentId ? String(threadParentId) : null,
      replyAttribution.senderKind,
      replyAttribution.senderId,
      replyAttribution.senderName,
      userId,
      String(workspaceId),
	      hasVerifiedReplyAgent ? replyAttribution.senderId : null,
	      replyAgentSnapshotVersion,
	      String(seedMessageId),
	     ],
     );
     if (reservedRows.length !== 1) {
      throw aiStatusError(403, new Error('AI reply could not be reserved from the caller-owned seed'));
     }
     storedReplyContext = await loadStoredAiChatContext({
      db: transactionQuery,
      sessionId: String(sessionId),
      seedMessageId: String(seedMessageId),
      threadParentId: threadParentId ? String(threadParentId) : null,
      userId,
     });
     return reservedRows;
    });
    this.reserved = true;
   },
	   async finalize(content) {
	    const text = typeof content === 'string' && content ? content : EMPTY_AI_REPLY;
	    const rows = await withDbTransaction(async (transactionQuery) => {
	     await lockAiChatRunScope({ db: transactionQuery, workspaceId, userId });
	     return transactionQuery(
	     `with current_reply_agent as materialized (
	        select agent.id
	          from workspace_agents agent
	         where $8::uuid is not null
	           and agent.id = $8::uuid
	           and agent.workspace_id = $7::uuid
	           and agent.enabled is not false
	           and agent.run_mode = 'builtin'
	           and agent.version = $9::integer
	         for share of agent
	      ),
	      current_reply_seed as materialized (
	        select seed.id
	          from messages seed
	         where seed.id = $10::uuid
	           and seed.session_id = $2::uuid
	           and seed.deleted_at is null
	           and seed.role = 'user'
	           and seed.sender_kind = 'user'
	           and seed.sender_id::text = $6::text
	           and seed.content = $11
	           and (
	             ($12::uuid is null and seed.thread_parent_id is null)
	             or seed.thread_parent_id = $12::uuid
	           )
	         for share of seed
	      ),
	      accessible_ai_reply_session as materialized (
	        select reply_session.id
	          from chat_sessions reply_session
	         where reply_session.id = $2::uuid
	           and reply_session.workspace_id = $7::uuid
	           and ${sessionReadableSql('reply_session', '$6', { lockMembership: true })}
	           and exists (select 1 from current_reply_seed)
	           and (
	             $8::uuid is null
	             or (
	               exists (select 1 from current_reply_agent)
	               and exists (
	                 select 1
	                   from jsonb_array_elements(coalesce(reply_session.participants, '[]'::jsonb)) participant
	                  where participant->>'kind' = 'agent'
	                    and participant->>'agent_id' = $8::text
	               )
	             )
	           )
	         for share of reply_session
	      )
	      update messages reply
	         set content = $3
	        from accessible_ai_reply_session reply_scope
	       where reply.id = $1::uuid
	         and reply.session_id = reply_scope.id
	         and reply.role = 'assistant'
	         and reply.sender_kind = $4
	         and reply.sender_id = $5
	         and reply.deleted_at is null
	       returning reply.*`,
	     [
	      String(messageId),
	      String(sessionId),
	      text,
	      replyAttribution.senderKind,
	      replyAttribution.senderId,
	      userId,
	      String(workspaceId),
	      hasVerifiedReplyAgent ? replyAttribution.senderId : null,
	      replyAgentSnapshotVersion,
	      String(seedMessageId),
	      storedReplyContext.seedContent,
	      threadParentId ? String(threadParentId) : null,
	     ],
	     );
	    });
	    if (rows.length !== 1) {
	     throw new Error('Reserved AI reply could not be finalized');
	    }
	    this.finalized = true;
	    await logMessageActivity(rows);
	   },
	   async abort() {
	    if (!this.reserved || this.finalized) return;
	    await query(
	     `update messages
	         set deleted_at = coalesce(deleted_at, now())
	       where id = $1::uuid
	         and session_id = $2::uuid
	         and role = 'assistant'
	         and sender_kind = $3
	         and sender_id = $4`,
	     [String(messageId), String(sessionId), replyAttribution.senderKind, replyAttribution.senderId],
	    );
	    this.finalized = true;
	   },
	  };
 }
 try {
  if (replyPersistence) await replyPersistence.reserve();
  const apiKey = await resolveSecret('ANTHROPIC_API_KEY', workspaceId);
  if (!apiKey) throw aiStatusError(503, new Error('ANTHROPIC_API_KEY is not configured'));
  const executionModelId = String(executionModel || '');
  if (executionModelId.startsWith('gateway:') || executionModelId.startsWith('agensis/')) {
   throw aiStatusError(400, new Error('This configured model requires the realtime backend'));
  }
  const resolvedModel = resolveAnthropicModel(executionModelId);
	  const chat = storedReplyContext
	   ? { messages: storedReplyContext.messages, systemPrompt: '' }
	   : normalizeAiChatMessages(messages);
  // role=system is caller-controlled too. It remains supported for the generic
  // assistant, but it cannot become elevated instruction for a named agent.
	  const clientSystemPrompt = storedReplyContext ? '' : chat.systemPrompt;
	  const trustedAgentContext = hasVerifiedReplyAgent
	   ? executionAgentContext
	   : (storedReplyContext ? null : executionAgentContext);
	  const resolvedAgentContext = clientSystemPrompt
	   ? {
	    ...(trustedAgentContext && typeof trustedAgentContext === 'object' ? trustedAgentContext : {}),
	    systemPrompt: [trustedAgentContext?.systemPrompt, clientSystemPrompt].filter(Boolean).join('\n\n'),
	   }
	   : trustedAgentContext;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
   'Content-Type': 'application/json',
   'x-api-key': apiKey,
   'anthropic-version': '2023-06-01',
   'anthropic-beta': 'messages-2023-12-15',
  },
  body: JSON.stringify({
   model: resolvedModel,
   max_tokens: 4096,
   stream: true,
   messages: chat.messages,
	   system: truncateUtf8Middle(
	    buildSystemPrompt(
	     hasVerifiedReplyAgent ? null : memory,
	     hasVerifiedReplyAgent ? null : documents,
	     hasVerifiedReplyAgent ? null : workspaceContext,
	     resolvedAgentContext,
	    ),
	    AI_CHAT_SYSTEM_MAX_BYTES,
	   ),
  }),
  });

  if (!upstream.ok || !upstream.body) {
   throw aiStatusError(upstream.status, new Error(await upstream.text()));
  }

  const stream = new ReadableStream({
  async start(controller) {
   const reader = upstream.body.getReader();
   const decoder = new TextDecoder();
   const encoder = new TextEncoder();
   // Decode incrementally and carry a partial-line buffer across reads so an
   // upstream SSE frame or multibyte char split across two chunks isn't
   // dropped/corrupted (M12).
   let buffer = '';
   // Token counts, read off the frames on their way past. The browser is only
   // sent text deltas, so this relay is the sole place this turn's usage is
   // ever visible — exactly as on the Fly lane, using the same accumulator.
   const usage = createAnthropicUsageAccumulator();
   let fullContent = '';
   let streamError = '';
   const handleLine = (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6);
    if (data === '[DONE]') return;
    try {
     const parsed = JSON.parse(data);
     usage.event(parsed);
     streamError = aiStreamErrorText(parsed) || streamError;
     if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      fullContent += parsed.delta.text;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: { text: parsed.delta.text } })}\n\n`));
     }
    } catch {
     // Ignore malformed upstream chunks.
    }
   };
   try {
    while (true) {
     const { done, value } = await reader.read();
     if (done) break;
     buffer += decoder.decode(value, { stream: true });
     const lines = buffer.split('\n');
     buffer = buffer.endsWith('\n') ? '' : (lines.pop() ?? '');
     for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    for (const line of buffer.split('\n')) handleLine(line);
    // Never throws (fail-open), so it cannot break the stream it is closing.
    await recordAnthropicUsage(query, {
     workspaceId,
     model: resolvedModel,
     kind: 'ai_chat',
     counts: usage.result(),
    });
    if (streamError) throw new Error(streamError);
    if (replyPersistence) await replyPersistence.finalize(fullContent);
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
   } catch (error) {
    const errorText = error?.message || 'AI stream failed';
    if (replyPersistence?.reserved && !replyPersistence.finalized) {
     try {
      await replyPersistence.finalize(errorText);
	     } catch (persistError) {
	      console.error('[ai-chat] failed to finalize reserved reply:', persistError?.message || persistError);
	      try {
	       await replyPersistence.abort();
	      } catch (abortError) {
	       console.error('[ai-chat] failed to remove reserved reply:', abortError?.message || abortError);
	      }
	     }
    }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errorText })}\n\n`));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
   }
  },
  });

  return new Response(stream, {
   headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
   },
  });
 } catch (error) {
  const errorText = error?.message || 'AI request failed';
  if (replyPersistence?.reserved && !replyPersistence.finalized) {
   try {
    await replyPersistence.finalize(errorText);
	   } catch (persistError) {
	    console.error('[ai-chat] failed to finalize reserved reply:', persistError?.message || persistError);
	    try {
	     await replyPersistence.abort();
	    } catch (abortError) {
	     console.error('[ai-chat] failed to remove reserved reply:', abortError?.message || abortError);
	    }
	   }
  }
  return jsonError(error.status || 500, error);
 }
}

async function route(req) {
 const requestUrl = new URL(req.url);
 const pathname = requestUrl.pathname;

 if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
 // The long-running Fly process is the canonical owner of join-link and
 // workspace-controller management: it holds the one-use transaction,
 // realtime fanout, controller credential minting, and owner checks. Netlify
 // must still match these paths so an explicit Netlify backend base cannot turn
 // a valid invite or the Users controller panel into a misleading 404.
 // Forwarding keeps one security implementation rather than creating a second
 // credential issuer or revocation path in this serverless mirror.
 if (isJoinBackendPath(pathname)
  || isLegacyMembershipInvitePath(pathname)
  || isFlyOwnedControlPath(pathname)) {
  const forwarded = await forwardCanonicalRoute(req, requestUrl);
  if (forwarded) return forwarded;
 }
 if (pathname === '/backend/health') {
  await query('select 1');
  return json({ ok: true });
 }
 if (req.method === 'POST' && pathname === '/backend/nostr-communities/preview') {
  await requireUserId(req);
  const body = await readBody(req);
  const preview = await netlifyNostrProtocol.previewInvite(body?.inviteUrl);
  // The invite code and canonical URL are bearer material. The browser already
  // retains the submitted URL for the later connect request; do not echo either
  // field in a preview response, matching server/nostr-community-manager.cjs.
  const { code: _code, inviteUrl: _inviteUrl, ...safePreview } = preview;
  return json({ data: safePreview, error: null });
 }
 if (req.method === 'GET' && pathname === '/backend/openpets/catalog') {
  try {
   let payload = { version: 3, page: 0, pageSize: 0, pets: [] };
   let remoteError = null;
   try {
    const response = await fetch(OPENPETS_CATALOG_URL, {
     headers: { 'User-Agent': 'agensis/1.0 (+https://openpets.dev)' },
    });
    if (!response.ok) {
     remoteError = new Error(`OpenPets catalog returned ${response.status}`);
    } else {
     payload = await response.json();
    }
   } catch (error) {
    remoteError = error;
   }
   const merged = mergeLocalCodexPets(payload);
   if (remoteError && merged.pets.length === 0) return jsonError(502, remoteError);
   return json({ data: merged, error: null });
  } catch (error) {
   return jsonError(502, error);
  }
 }
 const codexPetAssetMatch = pathname.match(/^\/backend\/codex-pets\/([^/]+)\/([^/]+)$/);
 if (req.method === 'GET' && codexPetAssetMatch) {
  try {
   const petDir = path.resolve(CODEX_PETS_ROOT, decodeURIComponent(codexPetAssetMatch[1]));
   const assetName = path.basename(decodeURIComponent(codexPetAssetMatch[2]));
   const assetPath = path.resolve(petDir, assetName);
   if (!assetName || !/\.(webp|png|gif|jpe?g)$/i.test(assetName)) return jsonError(404, new Error('Pet asset not found'));
   if (!isPathInside(CODEX_PETS_ROOT, petDir) || !isPathInside(petDir, assetPath)) return jsonError(404, new Error('Pet asset not found'));
   if (!fs.existsSync(path.join(petDir, 'pet.json')) || !fs.existsSync(assetPath)) return jsonError(404, new Error('Pet asset not found'));
   const body = await fs.promises.readFile(assetPath);
   return new Response(body, {
    headers: {
     'Content-Type': contentTypeForImageAsset(assetPath),
     'Cache-Control': 'public, max-age=3600',
    },
   });
  } catch (error) {
   return jsonError(500, error);
  }
 }
 if (req.method === 'GET' && pathname === '/backend/system/capabilities') {
  return handleSystemCapabilities(req);
 }
 if (req.method === 'GET' && pathname === '/backend/workspaces') {
  return handleWorkspaces(await requireUserId(req));
 }
 const workspaceMemberMatch = pathname.match(/^\/backend\/workspaces\/([^/]+)\/members\/([^/]+)$/);
 if (req.method === 'PATCH' && workspaceMemberMatch) {
  return handleUpdateWorkspaceMember(
   decodeURIComponent(workspaceMemberMatch[1]),
   decodeURIComponent(workspaceMemberMatch[2]),
   req,
   await requireUserId(req),
  );
 }
 if (req.method === 'DELETE' && workspaceMemberMatch) {
  return handleDeleteWorkspaceMember(
   decodeURIComponent(workspaceMemberMatch[1]),
   decodeURIComponent(workspaceMemberMatch[2]),
   await requireUserId(req),
  );
 }
 const workspaceAgentsMatch = pathname.match(/^\/backend\/workspaces\/([^/]+)\/agents$/);
 if (req.method === 'GET' && workspaceAgentsMatch) {
  return handleWorkspaceAgents(decodeURIComponent(workspaceAgentsMatch[1]), await requireUserId(req));
 }

 // Agent-stewarded shared resources. These routes mirror Fly's dedicated
 // surface and delegate to the exact same service; neither backend exposes the
 // underlying tables through the generic DB API or realtime subscriptions.
 const resourceCollectionMatch = pathname.match(/^\/backend\/workspaces\/([^/]+)\/resources$/);
 if (resourceCollectionMatch) {
  const workspaceId = decodeURIComponent(resourceCollectionMatch[1]);
  const userId = await requireUserId(req);
  const actor = { kind: 'user', userId, workspaceId };
  if (req.method === 'GET') {
   const data = await workspaceResources.listResources({
    workspaceId,
    actor,
    status: requestUrl.searchParams.get('status') || undefined,
    limit: requestUrl.searchParams.get('limit') || undefined,
   });
   return json({ data, error: null });
  }
  if (req.method === 'POST') {
   const blocked = await dbRateLimitBlock(
    resourceOperationRateLimiter,
    resourceOperationDbRateLimiter,
    `${userId}:${workspaceId}`,
   );
   if (blocked) return blocked;
   const body = await readBody(req);
   const data = await workspaceResources.createResource({
    workspaceId,
    stewardAgentId: body?.stewardAgentId ?? body?.steward_agent_id,
    definition: resourceDefinition(body),
    actor,
   });
   return json({ data, error: null }, 201);
  }
 }

 const operationCollectionMatch = pathname.match(/^\/backend\/workspaces\/([^/]+)\/resource-operations$/);
 if (req.method === 'GET' && operationCollectionMatch) {
  const workspaceId = decodeURIComponent(operationCollectionMatch[1]);
  const userId = await requireUserId(req);
  const data = await workspaceResources.listOperations({
   workspaceId,
   actor: { kind: 'user', userId, workspaceId },
   resourceId: requestUrl.searchParams.get('resourceId')
    || requestUrl.searchParams.get('resource_id')
    || undefined,
   status: requestUrl.searchParams.get('status') || undefined,
   limit: requestUrl.searchParams.get('limit') || undefined,
   includeArtifacts: queryBoolean(
    requestUrl.searchParams.get('includeArtifacts')
      ?? requestUrl.searchParams.get('include_artifacts'),
    false,
   ),
  });
  return json({ data, error: null });
 }

 const operationItemMatch = pathname.match(/^\/backend\/workspaces\/([^/]+)\/resource-operations\/([^/]+)$/);
 if (req.method === 'GET' && operationItemMatch) {
  const workspaceId = decodeURIComponent(operationItemMatch[1]);
  const userId = await requireUserId(req);
  const data = await workspaceResources.getOperation({
   workspaceId,
   operationId: decodeURIComponent(operationItemMatch[2]),
   actor: { kind: 'user', userId, workspaceId },
   includeArtifacts: queryBoolean(
    requestUrl.searchParams.get('includeArtifacts')
      ?? requestUrl.searchParams.get('include_artifacts'),
    true,
   ),
  });
  return json({ data, error: null });
 }

 const resourceOperationMatch = pathname.match(/^\/backend\/workspaces\/([^/]+)\/resources\/([^/]+)\/operations$/);
 if (resourceOperationMatch) {
  const workspaceId = decodeURIComponent(resourceOperationMatch[1]);
  const resourceId = decodeURIComponent(resourceOperationMatch[2]);
  const userId = await requireUserId(req);
  const actor = { kind: 'user', userId, workspaceId };
  if (req.method === 'GET') {
   const data = await workspaceResources.listOperations({
    workspaceId,
    resourceId,
    actor,
    status: requestUrl.searchParams.get('status') || undefined,
    limit: requestUrl.searchParams.get('limit') || undefined,
    includeArtifacts: queryBoolean(
     requestUrl.searchParams.get('includeArtifacts')
       ?? requestUrl.searchParams.get('include_artifacts'),
     false,
    ),
   });
   return json({ data, error: null });
  }
  if (req.method === 'POST') {
   const blocked = await dbRateLimitBlock(
    resourceOperationRateLimiter,
    resourceOperationDbRateLimiter,
    `${userId}:${workspaceId}`,
   );
   if (blocked) return blocked;
   const body = await readBody(req);
   const bodyHasKey = body?.idempotencyKey !== undefined || body?.idempotency_key !== undefined;
   const headerKey = String(req.headers.get('idempotency-key') || '').trim();
   const request = !bodyHasKey && headerKey ? { ...body, idempotencyKey: headerKey } : body;
   const data = await workspaceResources.requestOperation({
    workspaceId,
    resourceId,
    requester: actor,
    request,
   });
   return json({ data, error: null }, 202);
  }
 }

 const resourceItemMatch = pathname.match(/^\/backend\/workspaces\/([^/]+)\/resources\/([^/]+)$/);
 if (resourceItemMatch) {
  const workspaceId = decodeURIComponent(resourceItemMatch[1]);
  const resourceId = decodeURIComponent(resourceItemMatch[2]);
  const userId = await requireUserId(req);
  const actor = { kind: 'user', userId, workspaceId };
  if (req.method === 'GET') {
   const data = await workspaceResources.getResource({ workspaceId, resourceId, actor });
   return json({ data, error: null });
  }
  if (req.method === 'PATCH') {
   const blocked = await dbRateLimitBlock(
    resourceOperationRateLimiter,
    resourceOperationDbRateLimiter,
    `${userId}:${workspaceId}`,
   );
   if (blocked) return blocked;
   const body = await readBody(req);
   const data = await workspaceResources.updateResource({
    workspaceId,
    resourceId,
    changes: body?.changes ?? body,
    actor,
   });
   return json({ data, error: null });
  }
 }

 const workspaceUsageMatch = pathname.match(/^\/backend\/workspace\/([^/]+)\/usage$/);
 if (req.method === 'GET' && workspaceUsageMatch) {
  return handleWorkspaceUsage(decodeURIComponent(workspaceUsageMatch[1]), await requireUserId(req));
 }
 const voiceCapabilitiesMatch = pathname.match(/^\/backend\/workspaces\/([^/]+)\/voice\/capabilities$/);
 if (req.method === 'GET' && voiceCapabilitiesMatch) {
  return handleVoiceCapabilities(decodeURIComponent(voiceCapabilitiesMatch[1]), await requireUserId(req));
 }
 const voiceTtsTokenMatch = pathname.match(/^\/backend\/workspaces\/([^/]+)\/voice\/tts-token$/);
 if (req.method === 'POST' && voiceTtsTokenMatch) {
  return handleVoiceTtsToken(decodeURIComponent(voiceTtsTokenMatch[1]), await requireUserId(req));
 }
 if (req.method === 'GET' && pathname === '/backend/cursorbuddy/connection-keys') {
  return handleCursorBuddyConnectionKeys(req, await requireUserId(req));
 }
 if (req.method === 'POST' && pathname === '/backend/cursorbuddy/connection-keys') {
  return handleCreateCursorBuddyConnectionKey(req, await requireUserId(req));
 }
 if (req.method === 'POST' && pathname === '/backend/cursorbuddy/provider-agent') {
  const userId = await requireUserId(req);
  const body = await readBody(req);
  const workspaceId = String(body?.workspaceId || body?.workspace_id || '').trim();
  if (!workspaceId) return jsonError(400, new Error('workspaceId is required'));
  await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
  const agent = await ensureCursorBuddyProviderAgent({ workspaceId, userId, body });
  const providerTool = parseJsonArray(agent.tools).find(tool => tool?.type === 'provider' && tool?.name === 'cursorbuddy');
  const providerMetadata = {
   ...parseJsonObject(providerTool?.metadata),
   ...parseJsonObject(parseJsonObject(agent.metadata).cursorbuddyProvider),
  };
  return json({
   data: {
    workspaceId,
    workspace_id: workspaceId,
    agentId: agent.id,
    agent_id: agent.id,
    provider: 'cursorbuddy',
    mode: 'built_in_provider',
    providerScope: providerMetadata.providerScope || '',
    domain: providerMetadata.domain || '',
    agent: publicWorkspaceAgent(agent),
   },
   error: null,
  });
 }
 if (req.method === 'POST' && pathname === '/backend/cursorbuddy/connection-keys/claim') {
  return handleClaimCursorBuddyConnectionKey(req);
 }
 if (req.method === 'GET' && pathname === '/backend/cursorbuddy/guides/community') {
  const blocked = await dbRateLimitBlock(cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, clientIpFromRequest(req));
  if (blocked) return blocked;
  return Response.json(
   { data: await listCommunityGuides(query), error: null },
   { headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' } },
  );
 }
 if (req.method === 'GET' && pathname === '/backend/cursorbuddy/guides/resolve') {
  const blocked = await dbRateLimitBlock(cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, clientIpFromRequest(req));
  if (blocked) return blocked;
  const targetUrl = new URL(req.url).searchParams.get('url');
  return Response.json(
   { data: await resolveCommunityGuide(query, targetUrl), error: null },
   { headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' } },
  );
 }
 if (req.method === 'GET' && pathname === '/backend/cursorbuddy/guides') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, userId);
  if (blocked) return blocked;
  return json({ data: await listOwnedGuides(query, userId), error: null });
 }
 if (req.method === 'POST' && pathname === '/backend/cursorbuddy/guides') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, userId);
  if (blocked) return blocked;
  return json({
   data: await createOwnedGuide(query, userId, await readBody(req), { stringifyJson: true }),
   error: null,
  }, 201);
 }
 const cursorBuddyGuideMatch = pathname.match(/^\/backend\/cursorbuddy\/guides\/([^/]+)$/);
 if (req.method === 'PATCH' && cursorBuddyGuideMatch) {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, userId);
  if (blocked) return blocked;
  return json({
   data: await updateOwnedGuide(
    query,
    userId,
    decodeURIComponent(cursorBuddyGuideMatch[1]),
    await readBody(req),
    { stringifyJson: true },
   ),
   error: null,
  });
 }
 if (req.method === 'DELETE' && cursorBuddyGuideMatch) {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, userId);
  if (blocked) return blocked;
  return json({
   data: await deleteOwnedGuide(query, userId, decodeURIComponent(cursorBuddyGuideMatch[1])),
   error: null,
  });
 }
 const cursorBuddyGuideSubmitMatch = pathname.match(/^\/backend\/cursorbuddy\/guides\/([^/]+)\/submit$/);
 if (req.method === 'POST' && cursorBuddyGuideSubmitMatch) {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, userId);
  if (blocked) return blocked;
  return json({
   data: await submitOwnedGuide(query, userId, decodeURIComponent(cursorBuddyGuideSubmitMatch[1])),
   error: null,
  });
 }
 if (req.method === 'GET' && pathname === '/backend/agents/connections') {
  return handleAgentConnections(req, await requireUserId(req));
 }
 if (req.method === 'POST' && pathname === '/backend/agents/dispatch') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(dispatchRateLimiter, dispatchDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  return handleAgentDispatch(req, userId);
 }
 // In-app feedback. Mirrors server/index.cjs exactly — a route on only one
 // backend is a live 404 for half the deployment.
 //
 // SUBMIT only. Reading a report is not a route: reports are ordinary rows of
 // the System workspace, read through /backend/db, where
 // enforceDbOperationAccess already requires 'read' on that workspace. The
 // client never names the destination workspace; ensureSystemWorkspace resolves
 // it server-side, so `workspaceId` in the body is context, never authority.
 if (req.method === 'POST' && pathname === '/backend/feedback') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(feedbackRateLimiter, feedbackDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  const body = await readBody(req);
  // Re-validate, re-clamp and RE-REDACT server-side: the browser scrubbed the
  // payload before sending, but a request that did not come from our client
  // would not have.
  const submission = normalizeFeedbackSubmission(body);
  const result = await insertFeedbackReport({
   db: query,
   // node-postgres/Neon: bind the STRINGIFIED value. Binding a raw JS array
   // here throws "invalid input syntax for type json" — the opposite of the
   // Fly side, which must bind the object. Verified against the live database;
   // see insertFeedbackReport in shared/backend-core.cjs.
   jsonParam: (value) => JSON.stringify(value),
   userId,
   sourceWorkspaceId: String(body?.workspaceId || body?.workspace_id || '').trim() || null,
   submission,
  });
  return json({ data: { ok: true, taskId: result.taskId }, error: null });
 }
 // Tenants (system-owner admin surface). Mirrors server/index.cjs exactly — a
 // route on only one backend is a live 404 for half the deployment, and an
 // ADMIN route present on one backend and absent on the other is worse: the
 // half that has it is the half nobody remembers to re-audit.
 //
 // Authorization is `assertSystemOwner` and nothing else: the caller's email is
 // read from app_users by their authenticated userId and compared to
 // AGENSIS_SYSTEM_OWNER_EMAIL, which must be set. No email is ever taken from
 // the request, and there is no workspace-membership path to this data.
 // `/access` answers only about the CALLER: it runs the same gate and
 // translates only its 403 into `{ owner: false }`, so an ordinary session is
 // not a console error. Anything else propagates — a broken check is an
 // error, not "not the owner".
 if (req.method === 'GET' && pathname === '/backend/tenants/access') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(tenantsRateLimiter, tenantsDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  let owner = true;
  try {
   await assertSystemOwner({ userId, db: query });
  } catch (error) {
   if (error?.status !== 403) throw error;
   owner = false;
  }
  return json({ data: { owner }, error: null });
 }
 if (req.method === 'GET' && pathname === '/backend/tenants') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(tenantsRateLimiter, tenantsDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  await assertSystemOwner({ userId, db: query });
  return json({ data: await listTenantAccounts(query), error: null });
 }
 if (req.method === 'GET' && pathname === '/backend/tenants/guide-submissions') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(tenantsRateLimiter, tenantsDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  await assertSystemOwner({ userId, db: query });
  return json({ data: await listGuideSubmissions(query), error: null });
 }
 const guideReviewMatch = pathname.match(/^\/backend\/tenants\/guide-submissions\/([^/]+)\/review$/);
 if (req.method === 'POST' && guideReviewMatch) {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(tenantsRateLimiter, tenantsDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  const reviewerId = await assertSystemOwner({ userId, db: query });
  return json({
   data: await reviewGuideSubmission(
    query,
    decodeURIComponent(guideReviewMatch[1]),
    reviewerId,
    await readBody(req),
   ),
   error: null,
  });
 }
 // Owner broadcasts. Mirrors server/index.cjs route for route — an admin WRITE
 // route present on one backend and absent on the other is the worst version of
 // the "one lane only" bug: the lane that has it is the one nobody re-audits.
 //
 // MATCHED BEFORE the '/backend/tenants/:id' regex below, which would otherwise
 // swallow '/backend/tenants/campaigns' as an account id.
 if (req.method === 'GET' && pathname === '/backend/tenants/campaigns/categories') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(tenantsRateLimiter, tenantsDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  await assertSystemOwner({ userId, db: query });
  return json({
   data: {
    categories: CAMPAIGN_CATEGORIES.map(({ id, label, days }) => ({ id, label, days: days === true })),
   },
   error: null,
  });
 }
 if (req.method === 'POST' && pathname === '/backend/tenants/campaigns/preview') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(tenantsRateLimiter, tenantsDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  await assertSystemOwner({ userId, db: query });
  const body = await readBody(req);
  const segment = normalizeSegment(body?.segment);
  return json({ data: buildSegmentPreview(segment, await loadTenantFacts(query)), error: null });
 }
 if (req.method === 'GET' && pathname === '/backend/tenants/campaigns') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(tenantsRateLimiter, tenantsDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  await assertSystemOwner({ userId, db: query });
  return json({ data: await listCampaigns(query), error: null });
 }
 if (req.method === 'POST' && pathname === '/backend/tenants/campaigns') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(tenantsRateLimiter, tenantsDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  const ownerId = await assertSystemOwner({ userId, db: query });
  const body = await readBody(req);
  const input = normalizeCampaignInput(body);
  const matched = selectSegmentMatches(input.segment, await loadTenantFacts(query));
  // The audience is recomputed here from the segment in THIS request, and the
  // confirmed count must equal it — the preview's list is never trusted.
  assertSendable(matched.length, body?.confirm_recipient_count);
  const ownerRows = await query('select email from app_users where id = $1 limit 1', [ownerId]);
  const campaign = await createCampaign(query, {
   title: input.title,
   body: input.body,
   surface: input.surface,
   // STRING, not the object: @netlify/database is the exact opposite of
   // porsager and requires a stringified bind for a ::jsonb cast. The Fly
   // server binds the object. See tests/jsonb-bind-hygiene.test.cjs.
   segmentBind: JSON.stringify(input.segment),
   summary: describeSegment(input.segment),
   recipientIds: matched.map((account) => account.user_id),
   createdBy: ownerId,
   createdByEmail: ownerRows?.[0]?.email || '',
  });
  console.log('[campaign] sent', {
   id: campaign.id,
   by: ownerId,
   surface: campaign.surface,
   recipients: campaign.recipient_count,
   segment: campaign.summary,
  });
  return json({ data: { campaign }, error: null });
 }
 const tenantDetailMatch = pathname.match(/^\/backend\/tenants\/([^/]+)$/);
 if (req.method === 'GET' && tenantDetailMatch) {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(tenantsRateLimiter, tenantsDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  await assertSystemOwner({ userId, db: query });
  const detail = await getTenantAccount(query, decodeURIComponent(tenantDetailMatch[1]));
  if (!detail) return jsonError(404, new Error('No such account'));
  return json({ data: detail, error: null });
 }

 // The receiving end. NOT owner-gated, on a different path prefix so that stays
 // obvious: any signed-in user reads and dismisses their OWN messages. The user
 // id comes from the verified session and is bound into both statements.
 if (req.method === 'GET' && pathname === '/backend/campaign-messages') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(campaignMessageRateLimiter, campaignMessageDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  return json({ data: await listUserCampaignMessages(query, userId), error: null });
 }
 const campaignDismissMatch = pathname.match(/^\/backend\/campaign-messages\/([^/]+)\/dismiss$/);
 if (req.method === 'POST' && campaignDismissMatch) {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(campaignMessageRateLimiter, campaignMessageDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  return json({
   data: await dismissCampaignMessage(query, userId, decodeURIComponent(campaignDismissMatch[1])),
   error: null,
  });
 }
 if (req.method === 'POST' && pathname === '/backend/agent-webhooks') {
  return handleCreateAgentWebhook(req, await requireUserId(req));
 }
 const connectionCommandMatch = pathname.match(/^\/backend\/agents\/([^/]+)\/connection-command$/);
 if (req.method === 'POST' && connectionCommandMatch) {
  return handleAgentConnectionCommand(req, decodeURIComponent(connectionCommandMatch[1]), await requireUserId(req));
 }
 if (req.method === 'POST' && (pathname === '/backend/auth/signup' || pathname === '/backend/auth/signin')) {
  return handleAuth(pathname, req);
 }
 if (req.method === 'POST' && pathname === '/backend/auth/oauth') {
  return handleOAuthAuth();
 }
 if (req.method === 'POST' && pathname === '/backend/auth/signout') {
  return handleSignOut(await requireUserId(req));
 }
 if (req.method === 'POST' && pathname === '/backend/rpc/lookup_user_by_email') {
  // F9: same fix as server/index.cjs — rate limit + require 'manage' on the
  // workspace the caller is inviting into (this RPC is only meaningfully
  // used by the "invite existing user" flow, src/hooks/useSharing.ts).
  const userId = await requireUserId(req);
  const blocked = rateLimitBlock(emailLookupRateLimiter, userId);
  if (blocked) return blocked;
  const body = await readBody(req);
  const workspaceId = String(body?.workspace_id || '').trim();
  if (!workspaceId) return jsonError(400, new Error('workspace_id is required'));
  await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
  const lookupEmail = String(body?.lookup_email || '').trim().toLowerCase();
  const rows = await query('select id, email from app_users where email = $1 limit 1', [lookupEmail]);
  return json({ data: rows, error: null });
 }
 if (req.method === 'GET' && pathname === '/backend/users/me') {
  return handleGetMyProfile(await requireUserId(req));
 }
 if (req.method === 'PATCH' && pathname === '/backend/users/me') {
  const userId = await requireUserId(req);
  const body = await readBody(req);
  if (body?.share_read_receipts !== undefined) {
   // Netlify owns no websocket clients. Route privacy changes through Fly in a
   // deployed split so marker deletion and live revocation happen together.
   const forwarded = await forwardReadReceiptControl(req, pathname, body);
   if (forwarded) return forwarded;
  }
  return handleUpdateMyProfile(req, userId, body);
 }
 if (req.method === 'POST' && pathname === '/backend/users/me/change-password') {
  return handleChangeMyPassword(req, await requireUserId(req));
 }
 // Reactions and read receipts. Mirrors server/reactions-routes.cjs and
 // server/read-receipts-routes.cjs statement for statement — the SQL and the
 // guards are single-sourced in shared/reaction-toggle.cjs and
 // shared/read-receipts.cjs, so the only thing this lane owns is the plumbing.
 // A route that exists on one backend and not the other is a UI that 404s
 // against whichever deploy the user happens to reach.
 const reactionMatch = pathname.match(/^\/backend\/messages\/([^/]+)\/reactions$/);
 if (req.method === 'POST' && reactionMatch) {
  return handleToggleReaction(req, decodeURIComponent(reactionMatch[1]), await requireUserId(req));
 }
 const sessionReadMatch = pathname.match(/^\/backend\/sessions\/([^/]+)\/read$/);
 if (req.method === 'POST' && sessionReadMatch) {
  return handleAdvanceReadMarker(req, decodeURIComponent(sessionReadMatch[1]), await requireUserId(req));
 }
 const sessionReadStateMatch = pathname.match(/^\/backend\/sessions\/([^/]+)\/read-state$/);
 if (req.method === 'GET' && sessionReadStateMatch) {
  return handleSessionReadState(req, decodeURIComponent(sessionReadStateMatch[1]), await requireUserId(req));
 }
 const sessionClearMatch = pathname.match(/^\/backend\/sessions\/([^/]+)\/clear$/);
 if (req.method === 'POST' && sessionClearMatch) {
  const userId = await requireUserId(req);
  const forwarded = await forwardConversationControl(req, pathname);
  if (forwarded) return forwarded;
  return handleClearSession(decodeURIComponent(sessionClearMatch[1]), userId);
 }
 const sessionCloseMatch = pathname.match(/^\/backend\/sessions\/([^/]+)\/close$/);
 if (req.method === 'POST' && sessionCloseMatch) {
  const userId = await requireUserId(req);
  const forwarded = await forwardConversationControl(req, pathname);
  if (forwarded) return forwarded;
  return handleCloseSession(decodeURIComponent(sessionCloseMatch[1]), userId);
 }
 const sessionSplitMatch = pathname.match(/^\/backend\/sessions\/([^/]+)\/split$/);
 if (req.method === 'POST' && sessionSplitMatch) {
  const userId = await requireUserId(req);
  const forwarded = await forwardConversationControl(req, pathname);
  if (forwarded) return forwarded;
  return handleSplitSession(decodeURIComponent(sessionSplitMatch[1]), userId);
 }
 if (req.method === 'POST' && pathname.startsWith('/backend/db/')) {
  return handleDb(pathname, req, await requireUserId(req));
 }
 if (req.method === 'GET' && pathname === '/backend/settings/secrets') {
  const userId = await requireUserId(req);
  const url = new URL(req.url);
  const workspaceId = String(url.searchParams.get('workspaceId') || '').trim() || null;
  // Managed secrets (ANTHROPIC_API_KEY etc.) require workspace manage rights.
  // The workspaceId check is NOT optional: when it was, omitting the query param
  // skipped authorization entirely and listManagedSecrets fell back to the
  // app-level secret, handing any signed-up user a masked preview of the
  // platform ANTHROPIC_API_KEY. Mirrors the POST handler directly below.
  if (!workspaceId) {
   return jsonError(403, new Error('App-level secret management is not available to users'));
  }
  await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
  const keys = await listManagedSecrets(workspaceId);
  return json({ data: { keys }, error: null });
 }
 if (req.method === 'POST' && pathname === '/backend/settings/secrets') {
  const userId = await requireUserId(req);
  const body = await readBody(req);
  const workspaceId = String(body?.workspaceId || '').trim() || null;
  // App-level secret writes are not available to ordinary users (match Fly daemon).
  if (!workspaceId) {
   return jsonError(403, new Error('App-level secret management is not available to users'));
  }
  if (!vaultWritesEnabled()) return vaultWriteUnavailable();
  await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
  const updates = {};
  for (const key of MANAGED_SECRET_KEYS) {
   if (typeof body?.[key] === 'string') updates[key] = body[key].trim();
  }
  if (Object.keys(updates).length === 0) {
   return jsonError(400, new Error('No managed keys provided'));
  }
  for (const [key, value] of Object.entries(updates)) {
   await setWorkspaceSecretValue(workspaceId, key, value, userId);
  }
  const keys = await listManagedSecrets(workspaceId);
  return json({ data: { keys }, error: null });
 }

 // --- The workspace vault (mirror) -------------------------------------------
 // Same rows, same classification (shared/backend-core.cjs), same 'manage' gate as
 // the Fly routes. WRITE-ONLY in the same sense: the list does not decrypt and its
 // SQL never selects `value` or `secret_cipher`.
 //
 // Two deliberate differences from the primary:
 //   * writes require SECRETS_ENCRYPTION_KEY here (see vaultWritesEnabled), because
 //     divergent key material writes a secret nothing can read back;
 //   * unset PROVIDER SLOTS are not listed. Slot enumeration comes from the sandbox
 //     skill definitions, which live in the Fly server's module graph — and nothing
 //     on this host makes a provider call, so it has no use for them.
 if (pathname.startsWith('/backend/workspaces/') && pathname.includes('/vault')) {
  const rest = pathname.slice('/backend/workspaces/'.length);
  const [rawWorkspaceId, marker, ...keyParts] = rest.split('/');
  const workspaceId = decodeURIComponent(rawWorkspaceId || '').trim();
  if (marker === 'vault' && workspaceId) {
   const userId = await requireUserId(req);
   const key = decodeURIComponent(keyParts.join('/') || '').trim();

   if (req.method === 'GET' && !key) {
    await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
    const data = await listWorkspaceVaultEntries(workspaceId, { db: query, managedKeys: MANAGED_SECRET_KEYS });
    return json({ data, error: null });
   }

   if ((req.method === 'PUT' || req.method === 'DELETE') && key) {
    // The charset is the namespace guard: no colon, so this route can never reach
    // a `sandbox:` entry however the caller spells it.
    if (!VAULT_KEY_RE.test(key)) {
     return jsonError(400, new Error(key.includes(':')
      ? 'Namespaced vault entries are set by the surface that owns them.'
      : 'key must be 1-128 chars of letters, digits, _ . -'));
    }
    if (MANAGED_SECRET_KEYS.includes(key)) return jsonError(400, new Error('That key is managed elsewhere'));
    if (!vaultWritesEnabled()) return vaultWriteUnavailable();
    await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
    if (req.method === 'DELETE') {
     await query('delete from workspace_secrets where workspace_id = $1 and key = $2', [workspaceId, key]);
     return json({ data: { key }, error: null });
    }
    const body = await readBody(req);
    const value = typeof body?.value === 'string' ? body.value : '';
    const description = typeof body?.description === 'string' ? body.description.slice(0, 300) : null;
    await coreSetWorkspaceSecretValue(workspaceId, key, value, { db: query, getAuthSecret, userId, description });
    return json({ data: { key, configured: Boolean(value) }, error: null });
   }
  }
 }

 if (req.method === 'POST' && pathname === '/backend/ai-chat') {
  const userId = await requireUserId(req);
  const blocked = await dbRateLimitBlock(aiChatRateLimiter, aiChatDbRateLimiter, userId || clientIpFromRequest(req));
  if (blocked) return blocked;
  return handleAiChat(req, userId);
 }

 return jsonError(404, new Error('Backend route not found'));
}

export default async function handler(req) {
 try {
  return await route(req);
 } catch (error) {
  return jsonError(error.status || 500, error);
 }
}

export const config = {
 path: '/backend/*',
};
