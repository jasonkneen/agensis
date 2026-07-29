'use strict';

const net = require('node:net');

// CursorBuddy Guide Standard v1 storage and matching.
//
// Guides are deliberately kept out of the generic DB surface. A private guide
// belongs to one user; a published guide is readable without authentication so
// the browser extension can resolve it while visiting a matching site. All
// writes go through the dedicated routes and all cross-account review goes
// through the system-owner gate.

const GUIDE_SCHEMA_URL = 'https://cursorbuddy.app/cursorbuddy-guide.schema.json';
const GUIDE_VERSION = '1.0';
const GUIDE_MAX_BYTES = 24_000;
const GUIDE_LIST_LIMIT = 200;
const REVIEW_STATES = new Set(['draft', 'pending', 'approved', 'rejected']);
const REVIEW_DECISIONS = new Set(['approved', 'rejected']);
const ACTIVATIONS = new Set(['hover', 'immediate', 'message', 'manual']);
const SHAPES = new Set(['rect', 'circle', 'ellipse']);

function httpError(status, message) {
 const error = new Error(message);
 error.status = status;
 return error;
}

function compactText(value, max = 240) {
 return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function compactList(value, maxItems = 12, maxLength = 180) {
 if (!Array.isArray(value)) return [];
 return value
  .map(item => compactText(item, maxLength))
  .filter(Boolean)
  .slice(0, maxItems);
}

function boundedNumber(value, min, max) {
 const number = Number(value);
 return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : null;
}

function normalizeActivation(value, fallback = 'immediate') {
 const activation = compactText(value, 20).toLowerCase();
 return ACTIVATIONS.has(activation) ? activation : fallback;
}

function normalizeGuideUrl(value) {
 const raw = compactText(value, 2048);
 if (!raw) throw httpError(400, 'Site URL is required');
 let url;
 try {
  url = new URL(raw);
 } catch {
  throw httpError(400, 'Enter a complete http or https site URL');
 }
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
  throw httpError(400, 'Enter a public http or https site URL');
 }
 url.search = '';
 url.hash = '';
 return url;
}

function normalizeGuideHost(value) {
 const raw = compactText(value, 253).toLowerCase().replace(/\.$/, '');
 if (!raw || raw.includes('/') || raw.includes(':') || raw.includes('*')) {
  throw httpError(400, 'Guide host must be one exact hostname');
 }
 const labels = raw.split('.');
 if (
  !/^[a-z0-9.-]+$/.test(raw)
  || labels.some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))
 ) {
  throw httpError(400, 'Guide host is invalid');
 }
 return raw;
}

function isPublicGuideHost(host) {
 if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
 const ipVersion = net.isIP(host);
 if (!ipVersion) return true;
 if (ipVersion === 6) return false;
 const octets = host.split('.').map(Number);
 return !(
  octets[0] === 10
  || octets[0] === 127
  || (octets[0] === 169 && octets[1] === 254)
  || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
  || (octets[0] === 192 && octets[1] === 168)
 );
}

function normalizePathPattern(value, fallback = '/*') {
 const raw = compactText(value || fallback, 500);
 if (!raw.startsWith('/') || raw.includes('?') || raw.includes('#')) {
  throw httpError(400, 'Path match must start with / and must not include a query or hash');
 }
 const star = raw.indexOf('*');
 if (star !== -1 && star !== raw.length - 1) {
  throw httpError(400, 'Path match may use one trailing * only');
 }
 if ((raw.match(/\*/g) || []).length > 1) throw httpError(400, 'Path match may use one trailing * only');
 return raw;
}

function defaultPathPattern(url) {
 const pathname = url.pathname || '/';
 if (pathname === '/') return '/*';
 return `${pathname.replace(/\/+$/, '')}*`;
}

function sameSiteHref(value) {
 const href = compactText(value, 500);
 if (!href || !href.startsWith('/') || href.startsWith('//')) return '';
 return href;
}

function normalizeAction(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
 const label = compactText(value.label, 60);
 if (!label) return null;
 const task = compactText(value.task, 500);
 const href = sameSiteHref(value.href);
 const tour = value.tour === true;
 if (!task && !href && !tour) return null;
 return { label, ...(task && { task }), ...(href && { href }), ...(tour && { tour }) };
}

function normalizeTourStep(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
 const selector = compactText(value.selector, 220);
 const text = compactText(value.text || value.say, 500);
 if (!selector || !text) return null;
 const shape = compactText(value.shape, 20).toLowerCase();
 const pad = boundedNumber(value.pad, 0, 48);
 const holdMs = boundedNumber(value.holdMs, 1000, 12_000);
 const waitMs = boundedNumber(value.waitMs, 1000, 14_000);
 return {
  selector,
  text,
  ...(SHAPES.has(shape) && { shape }),
  ...(pad !== null && { pad }),
  ...(holdMs !== null && { holdMs }),
  ...(waitMs !== null && { waitMs }),
 };
}

function normalizeGuideFields(value, { includeMatch = false, fallbackHost = '', fallbackPath = '/*' } = {}) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
 const appearance = value.appearance && typeof value.appearance === 'object' && !Array.isArray(value.appearance)
  ? value.appearance
  : {};
 const name = compactText(value.name, 100);
 const summary = compactText(value.summary, 600);
 const greeting = compactText(value.greeting || appearance.greeting, 160);
 const activation = normalizeActivation(value.activation || appearance.activation);
 const guide = {
  ...(name && { name }),
  ...(summary && { summary }),
  appearance: {
   activation,
   ...(greeting && { greeting }),
  },
  skills: compactList(value.skills),
  important: compactList(value.important, 8, 240),
  avoid: compactList(value.avoid, 8, 240),
  actions: Array.isArray(value.actions)
   ? value.actions.map(normalizeAction).filter(Boolean).slice(0, 6)
   : [],
  tour: Array.isArray(value.tour)
   ? value.tour.map(normalizeTourStep).filter(Boolean).slice(0, 10)
   : [],
 };
 if (includeMatch) {
  const match = value.match && typeof value.match === 'object' && !Array.isArray(value.match)
   ? value.match
   : {};
  const host = normalizeGuideHost(compactList(match.hosts, 1, 253)[0] || fallbackHost);
  const path = normalizePathPattern(compactList(match.paths, 1, 500)[0] || fallbackPath);
  guide.match = { hosts: [host], paths: [path] };
 }
 return guide;
}

function normalizeGuideManifest(value, { host, pathPattern } = {}) {
 const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
 const guide = {
  $schema: GUIDE_SCHEMA_URL,
  version: GUIDE_VERSION,
  ...normalizeGuideFields(raw, {
   includeMatch: true,
   fallbackHost: host,
   fallbackPath: pathPattern,
  }),
  pages: {},
 };
 if (!guide.name) throw httpError(400, 'Guide name is required');
 if (raw.pages && typeof raw.pages === 'object' && !Array.isArray(raw.pages)) {
  for (const [rawPath, page] of Object.entries(raw.pages).slice(0, 50)) {
   let pagePath;
   try {
    pagePath = normalizePathPattern(rawPath, '/');
   } catch {
    continue;
   }
   if (pagePath.includes('*')) continue;
   guide.pages[pagePath] = normalizeGuideFields(page);
  }
 }
 const bytes = Buffer.byteLength(JSON.stringify(guide));
 if (bytes > GUIDE_MAX_BYTES) throw httpError(413, `Guide exceeds the ${GUIDE_MAX_BYTES} byte limit`);
 return guide;
}

function normalizeGuideInput(value) {
 const body = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
 const siteUrl = normalizeGuideUrl(body.site_url || body.siteUrl || body.url);
 const host = normalizeGuideHost(body.host || siteUrl.hostname);
 const pathPattern = normalizePathPattern(
  body.path_pattern || body.pathPattern,
  defaultPathPattern(siteUrl),
 );
 const manifest = normalizeGuideManifest(body.manifest || body.guide, { host, pathPattern });
 // The record is the match authority. Rebuild `match` from it so a caller
 // cannot save one hostname while putting a different hostname in the portable
 // document users download.
 manifest.match = { hosts: [host], paths: [pathPattern] };
 return {
  siteUrl: siteUrl.href,
  host,
  pathPattern,
  name: manifest.name,
  summary: manifest.summary || '',
  manifest,
 };
}

function parseManifest(value) {
 if (!value) return {};
 if (typeof value === 'object' && !Array.isArray(value)) return value;
 try {
  const parsed = JSON.parse(String(value));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
 } catch {
  return {};
 }
}

function publicGuide(row, {
 includeManifest = true,
 includeOwner = false,
 includeReviewMetadata = true,
} = {}) {
 const guide = {
  id: row.id,
  site_url: row.site_url || '',
  host: row.host || '',
  path_pattern: row.path_pattern || '/*',
  name: row.name || '',
  summary: row.summary || '',
  review_status: REVIEW_STATES.has(row.review_status) ? row.review_status : 'draft',
  published_at: row.published_at || null,
  created_at: row.created_at || null,
  updated_at: row.updated_at || null,
 };
 if (includeReviewMetadata) {
  guide.review_notes = row.review_notes || '';
  guide.submitted_at = row.submitted_at || null;
  guide.reviewed_at = row.reviewed_at || null;
 }
 if (includeManifest) guide.manifest = parseManifest(row.manifest);
 if (includeOwner) {
  guide.owner = {
   id: row.owner_user_id || '',
   email: row.owner_email || '',
   display_name: row.owner_display_name || '',
  };
 }
 return guide;
}

function pathMatches(pattern, pathname) {
 let match;
 try {
  match = normalizePathPattern(pattern);
 } catch {
  return false;
 }
 const path = String(pathname || '/') || '/';
 if (match.endsWith('*')) return path.startsWith(match.slice(0, -1));
 return path === match;
}

function sortBySpecificity(rows) {
 return [...rows].sort((left, right) => {
  const length = String(right.path_pattern || '').replace(/\*$/, '').length
   - String(left.path_pattern || '').replace(/\*$/, '').length;
  if (length) return length;
  return Date.parse(String(right.published_at || right.updated_at || ''))
   - Date.parse(String(left.published_at || left.updated_at || ''));
 });
}

async function listOwnedGuides(db, userId) {
 const rows = await db(
  `select *
     from cursorbuddy_guides
     where owner_user_id = $1
     order by updated_at desc
     limit ${GUIDE_LIST_LIMIT}`,
  [userId],
 );
 return rows.map(row => publicGuide(row));
}

async function createOwnedGuide(db, userId, value, { stringifyJson = false } = {}) {
 const input = normalizeGuideInput(value);
 const rows = await db(
  `insert into cursorbuddy_guides
     (owner_user_id, site_url, host, path_pattern, name, summary, manifest)
   values ($1, $2, $3, $4, $5, $6, $7::jsonb)
   returning *`,
  [
   userId,
   input.siteUrl,
   input.host,
   input.pathPattern,
   input.name,
   input.summary,
   stringifyJson ? JSON.stringify(input.manifest) : input.manifest,
  ],
 );
 return publicGuide(rows[0]);
}

async function updateOwnedGuide(db, userId, guideId, value, { stringifyJson = false } = {}) {
 const input = normalizeGuideInput(value);
 const rows = await db(
  `update cursorbuddy_guides
   set site_url = $3,
       host = $4,
       path_pattern = $5,
       name = $6,
       summary = $7,
       manifest = $8::jsonb,
       review_status = 'draft',
       review_notes = '',
       submitted_at = null,
       reviewed_at = null,
       reviewed_by = null,
       published_at = null,
       updated_at = now()
   where id = $1 and owner_user_id = $2
   returning *`,
  [
   guideId,
   userId,
   input.siteUrl,
   input.host,
   input.pathPattern,
   input.name,
   input.summary,
   stringifyJson ? JSON.stringify(input.manifest) : input.manifest,
  ],
 );
 if (!rows[0]) throw httpError(404, 'Guide not found');
 return publicGuide(rows[0]);
}

async function deleteOwnedGuide(db, userId, guideId) {
 const rows = await db(
  'delete from cursorbuddy_guides where id = $1 and owner_user_id = $2 returning id',
  [guideId, userId],
 );
 if (!rows[0]) throw httpError(404, 'Guide not found');
 return { id: rows[0].id };
}

async function submitOwnedGuide(db, userId, guideId) {
 const candidates = await db(
  'select host from cursorbuddy_guides where id = $1 and owner_user_id = $2',
  [guideId, userId],
 );
 if (!candidates[0]) throw httpError(404, 'Guide not found');
 if (!isPublicGuideHost(candidates[0].host)) {
  throw httpError(400, 'Private and local sites can stay in your library but cannot be submitted publicly');
 }
 const rows = await db(
  `update cursorbuddy_guides
   set review_status = 'pending',
       review_notes = '',
       submitted_at = now(),
       reviewed_at = null,
       reviewed_by = null,
       published_at = null,
       updated_at = now()
   where id = $1
     and owner_user_id = $2
     and review_status in ('draft', 'rejected')
   returning *`,
  [guideId, userId],
 );
 if (!rows[0]) throw httpError(409, 'Only a draft or rejected guide can be submitted');
 return publicGuide(rows[0]);
}

async function listCommunityGuides(db) {
 const rows = await db(
  `select *
   from cursorbuddy_guides
   where review_status = 'approved'
   order by published_at desc nulls last, updated_at desc
   limit ${GUIDE_LIST_LIMIT}`,
  [],
 );
 return rows.map(row => publicGuide(row, {
  includeManifest: false,
  includeReviewMetadata: false,
 }));
}

async function resolveCommunityGuide(db, targetUrl) {
 const target = normalizeGuideUrl(targetUrl);
 const host = normalizeGuideHost(target.hostname);
 const rows = await db(
  `select *
   from cursorbuddy_guides
   where review_status = 'approved' and host = $1
   order by published_at desc nulls last, updated_at desc
   limit ${GUIDE_LIST_LIMIT}`,
  [host],
 );
 const match = sortBySpecificity(rows).find(row => pathMatches(row.path_pattern, target.pathname));
 return match ? publicGuide(match, { includeReviewMetadata: false }) : null;
}

async function listGuideSubmissions(db) {
 const rows = await db(
  `select g.*,
          u.email as owner_email,
          u.display_name as owner_display_name
   from cursorbuddy_guides g
   join app_users u on u.id = g.owner_user_id
   where g.review_status in ('pending', 'approved', 'rejected')
   order by
     case when g.review_status = 'pending' then 0 else 1 end,
     g.submitted_at desc nulls last,
     g.updated_at desc
   limit ${GUIDE_LIST_LIMIT}`,
  [],
 );
 return rows.map(row => publicGuide(row, { includeOwner: true }));
}

async function reviewGuideSubmission(db, guideId, reviewerId, value) {
 const decision = compactText(value?.decision, 20).toLowerCase();
 if (!REVIEW_DECISIONS.has(decision)) throw httpError(400, 'Decision must be approved or rejected');
 const notes = compactText(value?.notes, 1000);
 const rows = await db(
  `update cursorbuddy_guides
   set review_status = $3,
       review_notes = $4,
       reviewed_at = now(),
       reviewed_by = $2,
       published_at = case when $3 = 'approved' then now() else null end,
       updated_at = now()
   where id = $1 and review_status = 'pending'
   returning *`,
  [guideId, reviewerId, decision, notes],
 );
 if (!rows[0]) throw httpError(409, 'Only a pending guide can be reviewed');
 return publicGuide(rows[0]);
}

module.exports = {
 GUIDE_SCHEMA_URL,
 GUIDE_VERSION,
 GUIDE_MAX_BYTES,
 normalizeGuideInput,
 normalizeGuideManifest,
 pathMatches,
 publicGuide,
 listOwnedGuides,
 createOwnedGuide,
 updateOwnedGuide,
 deleteOwnedGuide,
 submitOwnedGuide,
 listCommunityGuides,
 resolveCommunityGuide,
 listGuideSubmissions,
 reviewGuideSubmission,
};
