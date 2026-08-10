'use strict';

// ============================================================================
// shared/marketplace.cjs
// ----------------------------------------------------------------------------
// The one validator for marketplace listings, shared by both backends. PURE:
// no db, no network, no express — the same convention shared/agentTemplates.cjs
// states, and what lets the whole security surface be unit-tested without
// Postgres.
//
// WHAT A LISTING IS. workspace_agent_templates made a persona shareable INSIDE
// a workspace. A marketplace listing makes one shareable ACROSS workspaces, in
// exactly two shapes:
//
//   'template'  the full persona body travels. A browser can read every field
//               before copying it, and instantiation still goes through the
//               existing human-reviewed Agents-window form. Copying is
//               review-before-instantiate, on purpose.
//   'hire'      the persona body does NOT travel. The hirer sees the name, the
//               description and the publisher-written capabilities list, and
//               gets a roster entry served by the publisher's own hosted agent.
//               The prompt, soul, instructions and skills stay with the host.
//
// ----------------------------------------------------------------------------
// THE TWO SECURITY RULES, which are the reason this file exists as its own
// module:
//
//   1. A listing carries PROSE, REQUESTS and DESCRIPTIVE INTENT. It never
//      carries AUTHORITY. This is the workspace_agent_templates rule applied
//      across the tenant boundary, where it matters more: the template body is
//      validated by normalizeAgentTemplate, which REFUSES (naming the key) any
//      never-carried field — permission_mode, metadata/host_folders,
//      sandbox_config, connect tokens. The marketplace_listings table has no
//      column those fields could land in. You cannot publish what the shape
//      cannot hold.
//
//   2. A 'hire' listing NEVER carries the persona body — not projected away,
//      structurally absent. normalizeMarketplaceListing refuses a hire listing
//      whose payload includes a template; the table CHECK refuses a hire row
//      whose prose columns are non-empty; and publicMarketplaceListing builds
//      no template object for a hire row. Three independent layers, because
//      "the projection strips it" alone is not a control (the next call site
//      will not have it — see channel_bridges.config in AGENTS.md).
//
// The hired ROSTER ROW is the third shape here: hiredAgentDraft PICKS named
// cosmetic fields from a listing and never spreads it. The row it describes
// holds no prompt, no skills, no tools, permission_mode 'default' and
// run_mode 'external' — a Connector shell the host serves. A hostile listing
// therefore cannot place prose or authority into the hirer's workspace: there
// is nothing to place, because nothing copies it.
// ============================================================================

const {
 normalizeAgentTemplate,
 templateFingerprint,
 slugify,
 CARRIED_FIELDS,
 RESOURCE_FACETS,
 normalizeAgentIntent,
} = require('./agentTemplates.cjs');

/** Closed set. Anything else is refused, never coerced. */
const LISTING_TYPES = Object.freeze(new Set(['template', 'hire']));

/** Closed set. 'unlisted' keeps existing hires working while hiding the card. */
const LISTING_STATUSES = Object.freeze(new Set(['published', 'unlisted']));

const MAX_NAME = 120;
const MAX_CATEGORY = 60;
const MAX_DESCRIPTION = 600;
/**
 * Capabilities are the publisher's own words for what the agent can do — the
 * ONLY detail a hire listing shows. Bounded like every other list here.
 */
const MAX_CAPABILITIES = 12;
const MAX_CAPABILITY = 200;

function text(value, max) {
 if (value === null || value === undefined) return '';
 return String(value).slice(0, max);
}

/**
 * Strict list-of-strings: returns null when the array holds a non-string, so
 * the caller can REFUSE rather than silently drop. Same contract as
 * stringListOrNull in shared/agentTemplates.cjs, with this module's bounds.
 */
function capabilityListOrNull(value) {
 if (value === undefined || value === null) return [];
 if (!Array.isArray(value)) return null;
 if (value.some((item) => typeof item !== 'string')) return null;
 const out = [];
 for (const item of value) {
  const trimmed = item.trim().slice(0, MAX_CAPABILITY);
  if (trimmed) out.push(trimmed);
  if (out.length >= MAX_CAPABILITIES) break;
 }
 return out;
}

/**
 * Validate and REBUILD a listing draft.
 *
 * Returns `{ ok, errors, listing }`. On success `listing` is constructed from
 * named fields only — it is not the input with keys removed, for the same
 * reason normalizeAgentTemplate rebuilds: a field nobody anticipated cannot
 * ride along, because nothing copies it.
 *
 * For a 'template' listing, `raw.template` goes through normalizeAgentTemplate
 * and inherits its loud refusals — a payload naming permissionMode is refused
 * with the key named, never silently stripped.
 *
 * For a 'hire' listing, a template body is REFUSED outright. Silently dropping
 * it would teach a publisher that the body was shared when it was not — the
 * mirror image of the silent-drop problem the template validator documents.
 */
function normalizeMarketplaceListing(raw) {
 const errors = [];
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
  return { ok: false, errors: ['listing must be an object'], listing: null };
 }

 const listingType = String(raw.listingType || '');
 if (!LISTING_TYPES.has(listingType)) {
  errors.push(`listingType must be one of ${[...LISTING_TYPES].join(', ')}`);
 }

 const name = text(raw.name, MAX_NAME).trim();
 if (!name) errors.push('name is required');

 const slug = slugify(raw.slug || name);
 if (!slug && name) errors.push('slug could not be derived from the name');

 const capabilities = capabilityListOrNull(raw.capabilities);
 if (capabilities === null) errors.push('capabilities must be an array of strings');

 if (listingType === 'hire' && (capabilities === null || capabilities.length === 0)) {
  // A hired agent shows the hirer nothing else. With no capabilities it is a
  // black box in someone's roster, which is the failure mode this field exists
  // to prevent.
  errors.push('a hire listing must describe at least one capability');
 }

 let template = null;
 if (listingType === 'template') {
  const result = normalizeAgentTemplate(raw.template);
  if (!result.ok) {
   errors.push(...result.errors);
  } else {
   template = result.template;
  }
 } else if (raw.template !== undefined && raw.template !== null) {
  errors.push('a hire listing never carries the agent definition — the prompt, soul, instructions and skills stay with the host');
 }

 // Cosmetics and intent for the CARD (and, on hire, for the roster row). On a
 // template listing these come from the body so card and body cannot disagree.
 const intentSource = listingType === 'template' && template
  ? template
  : {
    purpose: raw.purpose,
    resourceFacets: Array.isArray(raw.resourceFacets) ? raw.resourceFacets : [],
   };
 const intent = normalizeAgentIntent(intentSource.purpose, intentSource.resourceFacets);
 errors.push(...intent.errors);

 if (errors.length) return { ok: false, errors: [...new Set(errors)], listing: null };

 return {
  ok: true,
  errors: [],
  listing: {
   slug,
   listingType,
   name,
   category: text(raw.category, MAX_CATEGORY).trim() || 'Community',
   description: text(raw.description, MAX_DESCRIPTION),
   capabilities,
   purpose: intent.purpose,
   resourceFacets: intent.resourceFacets,
   avatar: text(listingType === 'template' && template ? template.avatar : raw.avatar, MAX_NAME),
   accentColor: text(listingType === 'template' && template ? template.accentColor : raw.accentColor, 32),
   template,
   fingerprint: template ? templateFingerprint(template) : '',
  },
 };
}

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
 * The row as any signed-in browser of the marketplace sees it.
 *
 * An explicit projection rather than `*`, and the template body is built ONLY
 * when the row says 'template'. A hire row's prose columns are '' by CHECK
 * constraint, but this function does not rely on that — it never reads them on
 * the hire branch at all. `source_agent_id` (which host agent serves hires) is
 * the host's internal wiring and is never projected.
 */
function publicMarketplaceListing(row) {
 if (!row) return null;
 const listingType = row.listing_type === 'hire' ? 'hire' : 'template';
 const purpose = row.purpose === 'resource' ? 'resource' : 'collaborator';
 const resourceFacets = purpose === 'resource'
  ? [...new Set(parseList(row.resource_facets))].filter((facet) => RESOURCE_FACETS.includes(facet))
  : [];
 const base = {
  id: row.id,
  slug: row.slug,
  listingType,
  name: row.name,
  category: row.category || 'Community',
  description: row.description || '',
  capabilities: parseList(row.capabilities).filter((item) => typeof item === 'string'),
  purpose,
  resourceFacets,
  avatar: row.avatar || '',
  accentColor: row.accent_color || '',
  status: LISTING_STATUSES.has(String(row.status)) ? String(row.status) : 'published',
  publisher_workspace_id: row.publisher_workspace_id,
  installCount: Number(row.install_count || 0),
  hireCount: Number(row.hire_count || 0),
  fingerprint: row.fingerprint || '',
  created_at: row.created_at,
  updated_at: row.updated_at,
 };
 if (listingType !== 'template') return { ...base, template: null };
 return {
  ...base,
  template: {
   slug: row.slug,
   name: row.name,
   category: row.category || 'Community',
   description: row.description || '',
   handleHint: row.handle_hint || '',
   systemPrompt: row.system_prompt || '',
   soul: row.soul || '',
   instructions: row.instructions || '',
   tools: parseList(row.tools),
   skills: parseList(row.skills),
   purpose,
   resourceFacets,
   model: row.model || 'auto',
   runMode: row.run_mode || 'builtin',
   runtime: row.runtime || '',
   avatar: row.avatar || '',
   accentColor: row.accent_color || '',
  },
 };
}

/**
 * The roster row a hire creates in the HIRER's workspace.
 *
 * PICKS named fields from the listing row; never spreads it. This is the
 * agentToTemplateDraft discipline pointed the other way: there, a full agent
 * row must not leak into a shareable artifact; here, a shared artifact must
 * not write into an agent row anything beyond cosmetics and intent.
 *
 * What is deliberately ABSENT, and must stay absent:
 *   systemPrompt / soul / instructions / skills / tools — the hired persona
 *     lives with the host; the hirer's copy holds NO prose to leak or to obey.
 *   permission_mode / metadata / host folders / connect token — a hire grants
 *     the hirer a capability, never authority on anyone's machine. The route
 *     inserts fixed server-owned defaults for these, from no input.
 *
 * runMode is 'external' (Connector): until the host's runtime claims the
 * queued turn, the server posts its own explicit waiting notice and never
 * impersonates the hired agent — exactly the disconnected-Connector rule in
 * AGENTS.md.
 */
function hiredAgentDraft(row = {}) {
 const purpose = row.purpose === 'resource' ? 'resource' : 'collaborator';
 const capabilities = parseList(row.capabilities).filter((item) => typeof item === 'string');
 const summary = text(row.description, MAX_DESCRIPTION);
 const capabilityLines = capabilities.length
  ? `Capabilities: ${capabilities.join('; ')}`
  : '';
 return {
  name: text(row.name, MAX_NAME) || 'Hired agent',
  handle: slugify(row.handle_hint || row.name) || 'hired-agent',
  description: [summary, capabilityLines].filter(Boolean).join('\n'),
  avatar: text(row.avatar, MAX_NAME) || 'AI',
  accentColor: text(row.accent_color, 32),
  purpose,
  resourceFacets: purpose === 'resource'
   ? RESOURCE_FACETS.filter((facet) => new Set(parseList(row.resource_facets)).has(facet))
   : [],
  model: 'auto',
  runMode: 'external',
 };
}

module.exports = {
 LISTING_TYPES,
 LISTING_STATUSES,
 MAX_CAPABILITIES,
 MAX_CAPABILITY,
 CARRIED_FIELDS,
 normalizeMarketplaceListing,
 publicMarketplaceListing,
 hiredAgentDraft,
};
