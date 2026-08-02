'use strict';

// ============================================================================
// shared/agentTemplates.cjs
// ----------------------------------------------------------------------------
// The one validator for agent templates ("persona packs"), shared by both
// backends. PURE: no db, no network, no express, no clock beyond what a caller
// passes in — the same convention server/sandbox-skills.cjs states, and what
// lets the whole security surface be unit-tested without Postgres.
//
// WHAT A TEMPLATE IS. Today agensis's 15 agent templates are CODE, in a frontend
// array (src/lib/agentTemplates.ts). They can only be added by editing that file
// and running a Netlify deploy. A user cannot author one, cannot save an agent
// they tuned as a starting point, and cannot move one between workspaces. That
// narrow gap — templates as data rather than as code — is the whole feature.
// The substance of a "persona" (prompt layers, tools, skills, model, run mode)
// already exists as columns on workspace_agents and has for a long time.
//
// ----------------------------------------------------------------------------
// THE SECURITY RULE, which is the reason this file exists as its own module:
//
//   A template carries PROSE, REQUESTS and DESCRIPTIVE INTENT. It never carries
//   AUTHORITY.
//   The columns that grant authority are not fields of the artifact — not in
//   its table, not in its envelope, not in this validator's output.
//   You cannot import what the shape cannot hold.
//
// That is enforced STRUCTURALLY, three times over, and deliberately not by a
// filter:
//
//   1. `workspace_agent_templates` has no column for any of them. A dropped
//      field is not a filtered field; there is nowhere for it to land.
//   2. normalizeAgentTemplate REBUILDS its output from CARRIED_FIELDS rather
//      than deleting keys from the input, so an unknown key cannot survive by
//      being unanticipated.
//   3. Instantiation reuses the EXISTING human-reviewed create path — a template
//      prefills the Agents window form and nothing is written until a person
//      submits it, through the generic /backend/db/insert where
//      stripPrivilegedDbValues and setsManageOnlyDbColumn already apply. This
//      feature adds NO new write path to workspace_agents, and must not.
//
// Why each never-carried field is never carried:
//
//   permission_mode   'yolo' is unrestricted shell on the daemon host. It is in
//                     PRIVILEGED_DB_COLUMNS_BY_TABLE precisely so no generic
//                     write can reach it, and changing it is audited.
//   metadata          carries host_folders, which the daemon turns into
//                     `--add-dir <path>` on a real machine, and sandbox_skills,
//                     whose definitions hold a baseUrl the SERVER will fetch and
//                     a credential naming a workspace-vault key. It is
//                     MANAGE_ONLY for exactly those reasons. It looks like a
//                     harmless bag; it is the sharpest edge here.
//   sandbox_provider  } provisioning authority, MANAGE_ONLY on the agent row.
//   sandbox_config    }
//   connect_token*    the daemon's whole identity; minted only behind a manage
//                     check.
//   mcp_approved      an approval decision, not a description.
//   memory_dir        a filesystem path on someone's machine.
//   identity/enabled/workspace_id/created_by/id/version — row identity and
//                     lifecycle, never authored.
//
// ADDING A FIELD TO CARRIED_FIELDS IS A SECURITY DECISION, not a schema
// tidy-up. tests/agent-template-privilege-guard.test.cjs fails if any
// never-carried name becomes carried.
//
// One honest limit, stated here so nobody reads the above as more than it is: a
// template is by definition words that change what an agent does. A malicious
// system prompt needs no privileged column to be harmful — it can instruct an
// already-yolo agent to do damage. Non-privilege-bearing artifacts make
// ESCALATION impossible; they do not make SOCIAL ENGINEERING THROUGH PROSE
// impossible. The defences for that are the review-before-instantiate step,
// showing the body, and provenance — not this validator.
// ============================================================================

const crypto = require('node:crypto');

/**
 * Prose and cosmetics. A `write` member can already type every one of these
 * straight into an agent, so carrying them grants nothing new.
 */
const PROSE_FIELDS = Object.freeze([
 // `slug` is the template's identity within its workspace. A caller may propose
 // one, but slugify() rewrites whatever arrives and the UNIQUE (workspace_id,
 // slug) constraint settles collisions — so it is carried, sanitised, and never
 // trusted as given.
 'slug',
 'name', 'category', 'description', 'handleHint',
 'systemPrompt', 'soul', 'instructions', 'avatar', 'accentColor', 'model',
]);

/**
 * Carried as a REQUEST, never as a grant. Each is a string (or list of strings)
 * that NAMES something; a name resolves to nothing on its own.
 *
 *   tools    advisory today — see the note on TOOLS_ARE_ADVISORY below.
 *   skills   an unknown skill id resolves to no definition.
 *   runMode  'daemon' grants nothing without a connect token, which is minted
 *            only behind a manage check.
 *   runtime  which coding CLI, if it ever connects.
 *
 * Instantiation re-validates these against what the workspace actually has.
 */
const REQUEST_FIELDS = Object.freeze(['tools', 'skills', 'runMode', 'runtime']);

/**
 * Descriptive intent, orthogonal to execution and authority.
 *
 * A resource facet says what teammates may use the agent for. It does not
 * attach a tool, permission mode, host folder, runtime or placement.
 */
const INTENT_FIELDS = Object.freeze(['purpose', 'resourceFacets']);

function normalizeAgentIntent(purpose = 'collaborator', resourceFacets = []) {
 const errors = [];
 const normalizedPurpose = String(purpose || 'collaborator').trim() || 'collaborator';
 if (!PURPOSES.has(normalizedPurpose)) {
  errors.push(`purpose must be one of ${[...PURPOSES].join(', ')}`);
 }
 const source = Array.isArray(resourceFacets) ? resourceFacets : null;
 if (!source) {
  errors.push('resourceFacets must be an array of strings');
 }
 const values = source || [];
 const invalid = values.filter((facet) => typeof facet !== 'string' || !RESOURCE_FACET_SET.has(facet));
 if (invalid.length) {
  errors.push(`resourceFacets may contain only ${RESOURCE_FACETS.join(', ')}`);
 }
 const selected = new Set(values.filter((facet) => RESOURCE_FACET_SET.has(facet)));
 const normalizedFacets = RESOURCE_FACETS.filter((facet) => selected.has(facet));
 if (normalizedPurpose === 'resource' && normalizedFacets.length === 0) {
  errors.push('a resource agent must select at least one resource facet');
 }
 if (normalizedPurpose === 'collaborator' && normalizedFacets.length > 0) {
  errors.push('a collaborator agent cannot carry resource facets');
 }
 return {
  ok: errors.length === 0,
  errors: [...new Set(errors)],
  purpose: normalizedPurpose,
  resourceFacets: normalizedFacets,
 };
}

const CARRIED_FIELDS = Object.freeze([...PROSE_FIELDS, ...REQUEST_FIELDS, ...INTENT_FIELDS]);

/**
 * Never carried, at any role, in any envelope. Listed in BOTH camelCase and the
 * snake_case column spelling, because a hostile or careless payload will use
 * whichever the reader forgot.
 */
const NEVER_CARRIED_FIELDS = Object.freeze([
 'permission_mode', 'permissionMode',
 'controller_id', 'controllerId',
 'metadata',
 'sandbox_provider', 'sandboxProvider',
 'sandbox_config', 'sandboxConfig',
 'connect_token', 'connectToken',
 'connect_token_hash', 'connectTokenHash',
 'mcp_approved', 'mcpApproved',
 'memory_dir', 'memoryDir',
 'identity',
 'enabled',
 'workspace_id', 'workspaceId',
 'created_by', 'createdBy',
 'id',
 'version',
 'host_folders', 'hostFolders',
 'sandbox_skills', 'sandboxSkills',
]);

/**
 * `workspace_agents.tools` gates NOTHING today. On the daemon lane it is
 * interpolated as literal prompt text; on the builtin lane the tool list handed
 * to the model comes from toolSpecs, not from the column. So a template sharing
 * `tools` shares a LABEL, not a SURFACE. The UI must say so rather than imply
 * otherwise. Making it real is separate work with real compatibility risk (every
 * existing agent has tools: [], and empty currently means "all").
 */
const TOOLS_ARE_ADVISORY = true;

/** Closed set. 'authored' here, 'derived' from an agent, 'imported' from outside. */
const TEMPLATE_SOURCES = Object.freeze(new Set(['authored', 'derived', 'imported']));

const RUN_MODES = Object.freeze(new Set(['builtin', 'daemon', 'sandbox', 'external']));
const RUNTIMES = Object.freeze(new Set(['', 'claude', 'codex', 'amp']));
const PURPOSES = Object.freeze(new Set(['collaborator', 'resource']));
const RESOURCE_FACETS = Object.freeze(['context', 'knowledge', 'tooling', 'code']);
const RESOURCE_FACET_SET = new Set(RESOURCE_FACETS);

const MAX_NAME = 120;
const MAX_SLUG = 80;
const MAX_CATEGORY = 60;
const MAX_DESCRIPTION = 600;
/**
 * Prose ceiling per field. Generous, but bounded: the daemon composes the whole
 * persona and truncates from the START at 10 KiB, so an unbounded system prompt
 * does not fail loudly — it silently evicts itself and the agent behaves as if
 * the persona were never written. See personaByteSize below.
 */
const MAX_PROSE = 20_000;
const MAX_LIST_ITEMS = 64;
const MAX_LIST_ITEM = 120;

/** Normalize the persisted wire value at projection boundaries. */
function normalizeAgentRunMode(value) {
 return RUN_MODES.has(String(value)) ? String(value) : 'builtin';
}

/**
 * The daemon's lean-prompt ceiling, mirrored here as a literal.
 *
 * `LEAN_PROMPT_MAX_BYTES = 10 * 1024` in packages/agensis-cli/src/agensis.mjs,
 * and truncation keeps the TAIL — so when a persona is large the parts dropped
 * FIRST are description, soul, system prompt and instructions, while the user
 * message survives. A big persona therefore does nothing rather than failing.
 *
 * The two repos share no constant, so this is a known weak seam: if that number
 * changes there, this one must change here. Named so the trail exists.
 */
const DAEMON_LEAN_PROMPT_MAX_BYTES = 10 * 1024;

function text(value, max) {
 if (value === null || value === undefined) return '';
 return String(value).slice(0, max);
}

/** A list of non-empty strings, bounded. Never objects — see stringListOrNull. */
function stringList(value) {
 if (!Array.isArray(value)) return [];
 const out = [];
 for (const item of value) {
  if (typeof item !== 'string') continue;
  const trimmed = item.trim().slice(0, MAX_LIST_ITEM);
  if (trimmed) out.push(trimmed);
  if (out.length >= MAX_LIST_ITEMS) break;
 }
 return out;
}

/**
 * Strict variant used by the validator: returns null when the array contains a
 * non-string, so the caller can REFUSE rather than silently drop.
 *
 * This protects a specific documented trap: workspace_agents.skills must stay
 * string[] because the Agents window round-trips it through a comma-separated
 * text input — an object in that array renders '[object Object]' and is then
 * saved back OVER the real definition on the next unrelated edit.
 */
function stringListOrNull(value) {
 if (value === undefined || value === null) return [];
 if (!Array.isArray(value)) return null;
 if (value.some((item) => typeof item !== 'string')) return null;
 return stringList(value);
}

/** URL-safe slug from a name. Stable, lowercase, no leading/trailing dashes. */
function slugify(value) {
 return String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, MAX_SLUG);
}

/**
 * Every never-carried key present in a raw payload, at the top level.
 *
 * Used to REFUSE with a message naming the key rather than dropping it quietly:
 * a silent drop is how someone comes to believe they exported a permission mode
 * and that the agent they hand over will run in it.
 */
function rejectedFields(raw) {
 if (!raw || typeof raw !== 'object') return [];
 const present = new Set();
 for (const key of Object.keys(raw)) {
  if (NEVER_CARRIED_FIELDS.includes(key)) present.add(key);
 }
 return [...present];
}

/**
 * Validate and REBUILD a template.
 *
 * Returns `{ ok, errors, template }`. On success `template` is constructed from
 * CARRIED_FIELDS only — it is not the input with keys removed. That distinction
 * is the whole control: a field nobody anticipated cannot ride along, because
 * nothing copies it.
 */
function normalizeAgentTemplate(raw, { allowUnknown = false } = {}) {
 const errors = [];
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
  return { ok: false, errors: ['template must be an object'], template: null };
 }

 // Refuse loudly, before anything else, so the caller learns which key was the
 // problem instead of wondering why their permission mode did not survive.
 const rejected = rejectedFields(raw);
 if (rejected.length && !allowUnknown) {
  return {
   ok: false,
   errors: rejected.map((key) => `${key} cannot be carried by a template (it grants authority; a template carries prose, requests and descriptive intent only)`),
   template: null,
   rejected,
  };
 }

 const name = text(raw.name, MAX_NAME).trim();
 if (!name) errors.push('name is required');

 const slug = slugify(raw.slug || name);
 if (!slug) errors.push('slug could not be derived from the name');

 const runMode = String(raw.runMode || 'builtin');
 if (!RUN_MODES.has(runMode)) errors.push(`runMode must be one of ${[...RUN_MODES].join(', ')}`);

 const runtime = String(raw.runtime || '');
 if (!RUNTIMES.has(runtime)) errors.push(`runtime must be one of ${[...RUNTIMES].filter(Boolean).join(', ')}`);

 const tools = stringListOrNull(raw.tools);
 if (tools === null) errors.push('tools must be an array of strings');
 const skills = stringListOrNull(raw.skills);
 if (skills === null) errors.push('skills must be an array of strings');

 const parsedFacets = stringListOrNull(raw.resourceFacets);
 const intent = normalizeAgentIntent(raw.purpose, parsedFacets === null ? null : parsedFacets);
 errors.push(...intent.errors);

 if (errors.length) return { ok: false, errors, template: null, rejected };

 return {
  ok: true,
  errors: [],
  rejected: [],
  template: {
   slug,
   name,
   category: text(raw.category, MAX_CATEGORY).trim() || 'Custom',
   description: text(raw.description, MAX_DESCRIPTION),
   handleHint: slugify(raw.handleHint || raw.handle || name),
   systemPrompt: text(raw.systemPrompt, MAX_PROSE),
   soul: text(raw.soul, MAX_PROSE),
   instructions: text(raw.instructions, MAX_PROSE),
   tools,
   skills,
   purpose: intent.purpose,
   resourceFacets: intent.resourceFacets,
   model: text(raw.model, MAX_NAME) || 'auto',
   runMode,
   runtime,
   avatar: text(raw.avatar, MAX_NAME),
   accentColor: text(raw.accentColor, 32),
  },
 };
}

/**
 * Build a template draft from an EXISTING AGENT ROW ("save as template").
 *
 * PICKS named fields; never spreads the row. Spreading is the mutation that
 * would carry permission_mode and metadata straight out of a yolo daemon agent
 * and into a shareable artifact, and it is the single most likely way this
 * feature would grow a hole. The row handed in here is a full workspace_agents
 * record including connect_token_hash — none of it is copied.
 */
function agentToTemplateDraft(row = {}) {
 return {
  slug: slugify(row.handle || row.name),
  name: text(row.name, MAX_NAME),
  category: 'Saved',
  description: text(row.description, MAX_DESCRIPTION),
  handleHint: slugify(row.handle || row.name),
  systemPrompt: text(row.system_prompt, MAX_PROSE),
  soul: text(row.soul, MAX_PROSE),
  instructions: text(row.instructions, MAX_PROSE),
  tools: stringList(parseList(row.tools)),
  skills: stringList(parseList(row.skills)),
  purpose: row.purpose === 'resource' ? 'resource' : 'collaborator',
  resourceFacets: row.purpose === 'resource'
   ? RESOURCE_FACETS.filter((facet) => new Set(parseList(row.resource_facets)).has(facet))
   : [],
  model: text(row.model, MAX_NAME) || 'auto',
  runMode: normalizeAgentRunMode(row.run_mode),
  runtime: '',
  avatar: text(row.avatar, MAX_NAME),
  accentColor: text(row.accent_color, 32),
 };
}

/** jsonb from postgres arrives as an array or as a JSON string, depending. */
function parseList(value) {
 if (Array.isArray(value)) return value;
 if (typeof value !== 'string') return [];
 try {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
 } catch {
  return [];
 }
}

/**
 * The draft the Agents window form is prefilled with.
 *
 * Returns NO metadata key at all — not `metadata: {}`. The form spreads what it
 * gets, and an empty object would still be a metadata write on submit, which
 * setsManageOnlyDbColumn would refuse for a `write` member and which would make
 * a template appear to require manage for no reason.
 */
function templateToAgentDraft(template = {}) {
 return {
  name: template.name || '',
  handle: template.handleHint || slugify(template.name),
  description: template.description || '',
  systemPrompt: template.systemPrompt || '',
  soul: template.soul || '',
  instructions: template.instructions || '',
  tools: Array.isArray(template.tools) ? [...template.tools] : [],
  skills: Array.isArray(template.skills) ? [...template.skills] : [],
  purpose: template.purpose === 'resource' ? 'resource' : 'collaborator',
  resourceFacets: template.purpose === 'resource' && Array.isArray(template.resourceFacets)
   ? RESOURCE_FACETS.filter((facet) => template.resourceFacets.includes(facet))
   : [],
  model: template.model || 'auto',
  runMode: normalizeAgentRunMode(template.runMode),
  runtime: template.runtime || '',
  avatar: template.avatar || '',
  accentColor: template.accentColor || '',
 };
}

/**
 * Bytes the composed persona would occupy in the daemon's prompt.
 *
 * Approximate on purpose — the daemon adds framing this cannot see — but it is
 * the same four fields, in the same order, and it is what makes the 10 KiB
 * ceiling visible at authoring time instead of at "why is my agent ignoring its
 * instructions" time.
 */
function personaByteSize(template = {}) {
 const composed = [
  template.description || '',
  template.soul || '',
  template.systemPrompt || '',
  template.instructions || '',
 ].filter(Boolean).join('\n\n');
 return Buffer.byteLength(composed, 'utf8');
}

/**
 * Is this persona at risk of being silently truncated on the daemon lane?
 *
 * The budget leaves room for the user's message and the daemon's own framing;
 * a persona that fills the whole ceiling leaves nothing for the thing the agent
 * is supposed to respond to.
 */
function personaBudget(template = {}) {
 const bytes = personaByteSize(template);
 const budget = Math.floor(DAEMON_LEAN_PROMPT_MAX_BYTES * 0.7);
 return {
  bytes,
  budget,
  ceiling: DAEMON_LEAN_PROMPT_MAX_BYTES,
  overBudget: bytes > budget,
 };
}

// ---------------------------------------------------------------------------
// EXPORT / IMPORT
//
// The envelope exists so a file that arrives is identifiable before it is
// trusted: an unmarked JSON blob has to be guessed at, and guessing is how a
// reader ends up treating some other tool's export as a persona.
//
// THE SECURITY PROPERTY IS NOT IN THIS SECTION. It is in the SHAPE, and it was
// solved before export existed: `workspace_agent_templates` has no column for
// permission_mode, sandbox config, connect tokens or identity, so a template
// cannot carry authority and neither can a file made from one. Import does not
// need to strip anything, because there is nothing here to strip. What it does
// need to do is REFUSE LOUDLY when a file names one of those fields anyway —
// normalizeAgentTemplate already does exactly that, naming the offending key —
// so someone who hand-edited `"permissionMode": "yolo"` into a file learns that
// it was refused rather than believing it took effect.
//
// So: DO NOT ADD A PRIVILEGE-BEARING FIELD HERE to make import "complete". The
// incompleteness is the feature. An imported persona is prose a teammate's
// agent will later speak, and nothing more.
// ---------------------------------------------------------------------------

/** Names the file's kind, so a stranger's JSON cannot be read as a persona. */
const TEMPLATE_EXPORT_FORMAT = 'agensis.agent-template';

/**
 * Bumped only for a BREAKING envelope change.
 *
 * Adding a carried field is not breaking: an older file simply lacks it and
 * normalizeAgentTemplate fills the default. Reading a file from the future is
 * refused, because a v2 field this build does not understand could be one whose
 * absence changes what the persona means.
 */
const TEMPLATE_EXPORT_VERSION = 1;

/**
 * Build the file. REBUILT from CARRIED_FIELDS, never spread from the row.
 *
 * The stored row carries `id`, `workspace_id` and `created_by`; a spread would
 * put another workspace's identifiers into a file meant to travel, and an
 * import that trusted them would write across a tenant boundary.
 */
function buildTemplateExport(template = {}, { exportedAt = new Date().toISOString() } = {}) {
 const body = {};
 for (const field of CARRIED_FIELDS) {
  const value = template[field];
  body[field] = Array.isArray(value)
   ? [...value]
   : (field === 'tools' || field === 'skills' || field === 'resourceFacets' ? [] : (value ?? ''));
 }
 return {
  format: TEMPLATE_EXPORT_FORMAT,
  formatVersion: TEMPLATE_EXPORT_VERSION,
  exportedAt,
  // The body's own hash, so two files can be compared without reading them and
  // an import can record WHAT it took in. Not a signature and not integrity
  // protection: anyone editing the file can recompute it. It identifies, it
  // does not authenticate, and nothing may treat it as though it does.
  fingerprint: templateFingerprint(body),
  template: body,
 };
}

/**
 * Read a file back. Returns the same `{ ok, errors, template, rejected }` shape
 * as normalizeAgentTemplate, because the caller's handling is identical.
 *
 * Accepts a BARE template object as well as an envelope. Somebody will paste
 * just the inner object, and refusing that would teach nothing — the validation
 * that matters runs either way.
 */
function readTemplateExport(raw) {
 if (typeof raw === 'string') {
  try {
   return readTemplateExport(JSON.parse(raw));
  } catch {
   return { ok: false, errors: ['that file is not valid JSON'], template: null, rejected: [] };
  }
 }
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
  return { ok: false, errors: ['that file does not contain an agent template'], template: null, rejected: [] };
 }

 const hasEnvelope = Object.prototype.hasOwnProperty.call(raw, 'format')
  || Object.prototype.hasOwnProperty.call(raw, 'template');

 if (hasEnvelope) {
  if (String(raw.format || '') !== TEMPLATE_EXPORT_FORMAT) {
   return {
    ok: false,
    errors: [`that file is not an agensis agent template (its format is ${JSON.stringify(String(raw.format || 'missing'))})`],
    template: null,
    rejected: [],
   };
  }
  const version = Number(raw.formatVersion);
  if (!Number.isFinite(version) || version < 1) {
   return { ok: false, errors: ['that file does not say which format version it is'], template: null, rejected: [] };
  }
  if (version > TEMPLATE_EXPORT_VERSION) {
   return {
    ok: false,
    errors: [`that file was written by a newer version of agensis (format ${version}, this one reads ${TEMPLATE_EXPORT_VERSION})`],
    template: null,
    rejected: [],
   };
  }
  return normalizeAgentTemplate(raw.template);
 }

 return normalizeAgentTemplate(raw);
}

/** SHA-256 over the carried fields, canonicalised. Identifies a template body. */
function templateFingerprint(template = {}) {
 const canonical = {};
 for (const field of [...CARRIED_FIELDS].sort()) {
  const value = template[field];
  canonical[field] = Array.isArray(value)
   ? [...value]
   : (field === 'tools' || field === 'skills' || field === 'resourceFacets' ? [] : (value ?? ''));
 }
 return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

module.exports = {
 CARRIED_FIELDS,
 PROSE_FIELDS,
 REQUEST_FIELDS,
 INTENT_FIELDS,
 NEVER_CARRIED_FIELDS,
 TEMPLATE_SOURCES,
 RUN_MODES,
 normalizeAgentRunMode,
 RUNTIMES,
 PURPOSES,
 RESOURCE_FACETS,
 TOOLS_ARE_ADVISORY,
 DAEMON_LEAN_PROMPT_MAX_BYTES,
 MAX_PROSE,
 TEMPLATE_EXPORT_FORMAT,
 TEMPLATE_EXPORT_VERSION,
 normalizeAgentIntent,
 buildTemplateExport,
 readTemplateExport,
 normalizeAgentTemplate,
 agentToTemplateDraft,
 templateToAgentDraft,
 rejectedFields,
 personaByteSize,
 personaBudget,
 templateFingerprint,
 slugify,
};
