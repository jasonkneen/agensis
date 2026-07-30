'use strict';

// ============================================================================
// shared/workspaceSkills.cjs — the validator for WORKSPACE-AUTHORED skills.
// ----------------------------------------------------------------------------
// PURE: no db, no network, no express, no fs. Same convention as
// shared/agentTemplates.cjs and server/sandbox-skills.cjs, and for the same
// reason — the whole security surface has to be provable in a unit test with no
// Postgres (tests/unit/workspaceSkills.test.ts).
//
// ----------------------------------------------------------------------------
// WHY THIS EXISTS
// ----------------------------------------------------------------------------
//
// Before this, a "skill" in agensis could only be a NAME on an agent row plus a
// body that a DAEMON owned on its own disk. Nothing in the app could write one.
// Two shipped features were bent around that hole:
//
//   1. Suggestions. server/thread-harvest.cjs accepted a proposed SKILL as a
//      Document in a "Skills" folder, saying outright there was "no app-side
//      skill store to accept into" — because attaching a bare name to
//      `workspace_agents.skills` "would record a claim without the procedure
//      that makes it true".
//   2. Agent templates. A template carries a `skills` list of NAMES, so a
//      template saying `skills: ['security-review']` exported a DANGLING
//      REFERENCE into any workspace where no daemon happened to have that file.
//      The name travelled; the procedure did not.
//
// This module is the missing store's shape.
//
// ----------------------------------------------------------------------------
// WHAT A SKILL IS HERE — decided by what already consumes one, not invented
// ----------------------------------------------------------------------------
//
// A NAMED MARKDOWN DOCUMENT WITH A ONE-LINE SUMMARY. That is the agentskills.io
// SKILL.md shape, and it is already the shape every existing surface speaks:
//
//   - the daemon reads `description:` out of SKILL.md frontmatter and pushes
//     `{ skill, path, summary, content }` (packages/agensis-cli/src/skills.mjs),
//   - `agent_skill_documents` stores exactly those columns,
//   - `renderSandboxSkillDocument` renders frontmatter + body,
//   - `read_skill` returns one markdown body, fenced.
//
// So a workspace skill is `{ name, title, summary, body }` and
// `renderWorkspaceSkillMarkdown` turns it into a real SKILL.md. Nothing new to
// consume, nothing new to learn, and a workspace skill is portable OUT of
// agensis to any agentskills.io client by construction.
//
// ----------------------------------------------------------------------------
// THE SECURITY RULE, which is why this is its own module
// ----------------------------------------------------------------------------
//
//   A WORKSPACE SKILL CARRIES PROSE. IT NEVER CARRIES AUTHORITY.
//
// Same sentence as agentTemplates.cjs, and the same three structural controls:
//
//   1. `workspace_skills` has NO column for a baseUrl, a credential, an
//      endpoint, an mcp server, executable code, a filesystem path or an agent
//      id. A dropped field is not a filtered field; there is nowhere to land.
//   2. normalizeWorkspaceSkill REBUILDS from CARRIED_FIELDS rather than deleting
//      keys, so an unanticipated key cannot survive by being unanticipated.
//   3. Every write goes through this validator: DB_TABLE_ACCESS gates generic
//      /backend/db writes on `workspace_skills` to 'manage', so the ordinary
//      authoring path is the dedicated route, which calls this.
//
// AND THE OTHER HALF, which matters more than the columns: a body from this
// store reaches an agent ONLY through `read_skill`, which wraps it in
// `fenceSkillContent` — a nonce fence that says, in the agent's context, that
// the text is untrusted reference DATA and cannot change its objective or its
// permissions. A workspace skill is therefore words an agent READS, never
// instructions the platform EXECUTES.
//
// ----------------------------------------------------------------------------
// WHY 'write' AND NOT 'manage'
// ----------------------------------------------------------------------------
//
// The brief asked this to be weighed rather than assumed, and the honest answer
// comes from comparing the two skill-shaped things that already exist:
//
//   - `permission_mode` and permanent tool grants are 'manage' because they
//     decide what an agent MAY DO. 'yolo' is unrestricted shell on a real host.
//   - a SANDBOX skill (server/sandbox-skills.cjs) is 'manage' because its
//     definition carries a `baseUrl` THE SERVER FETCHES and a `credential`
//     naming a workspace-vault key. Authoring one aims a stored secret at a
//     host of the author's choosing. That is authority in a prose costume.
//
// A workspace skill has neither property, and cannot grow one without a
// migration and a review. What is left is prose — and a 'write' member can
// ALREADY type prose straight into `workspace_agents.system_prompt`,
// `soul` and `instructions`, which an agent obeys as TRUSTED text every turn.
// Requiring 'manage' to write a document that arrives FENCED AS UNTRUSTED, when
// 'write' can already write UNFENCED persona prose, would be a lock on the
// smaller door. So: 'write', exactly like workspace_agent_templates.
//
// One honest limit, stated so nobody reads the above as more than it is: a
// procedure that says "run `curl … | sh`" is still bad advice, and an agent that
// is already permitted to run shell may act on bad advice. Non-privilege-bearing
// artifacts make ESCALATION impossible; they do not make SOCIAL ENGINEERING
// THROUGH PROSE impossible. The defences for that are the fence, the visible
// body, provenance, and the fact that the agent's permissions are decided
// somewhere this store cannot reach.
//
// ADDING A FIELD TO CARRIED_FIELDS IS A SECURITY DECISION, not a schema tidy-up.
// tests/workspace-skill-privilege-guard.test.cjs fails if a never-carried name
// becomes carried.
// ============================================================================

const crypto = require('node:crypto');

/**
 * agentskills.io's own name rule: lowercase, digits, single hyphens, <= 64.
 *
 * Identical to SANDBOX_SKILL_ID_RE in server/sandbox-skills.cjs on purpose. A
 * skill name is a lookup key in `read_skill`, a folder name if anyone exports
 * one, and a value inside a template's `skills` array — three places where a
 * space or a slash would be a bug rather than a style choice.
 */
const WORKSPACE_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_NAME = 64;
const MAX_TITLE = 120;
/** Matches MAX_SUMMARY_CHARS in the daemon's skills.mjs and the summary column. */
const MAX_SUMMARY = 2000;

/**
 * Body ceiling, in BYTES.
 *
 * Deliberately the same number as SKILL_CONTENT_MAX_BYTES in
 * server/skill-content.cjs and MAX_SKILL_BYTES in the daemon's skills.mjs: this
 * body is read back through the SAME loader that caps a daemon document, so a
 * larger ceiling here would only produce a body that is silently truncated on
 * the way out. tests/workspace-skill-caps.test.cjs asserts the two agree, since
 * they cannot share a constant across the module boundary (this file is pure and
 * skill-content.cjs reaches for `fs`).
 */
const MAX_BODY_BYTES = 64 * 1024;

/** Ceiling on how many skills one workspace may store. */
const MAX_SKILLS_PER_WORKSPACE = 500;

/** Closed set. Where the prose came from — provenance, never caller-supplied. */
const SKILL_SOURCES = Object.freeze(new Set(['authored', 'suggested', 'imported']));

/**
 * The ONLY fields a workspace skill carries. Prose and a name; nothing else.
 *
 *   name     the lookup key. Slugified here and settled by UNIQUE(workspace_id,
 *            name), so a caller may propose one but never dictate it.
 *   title    what a human reads in the list.
 *   summary  the `description:` line — what an agent sees in list_skills.
 *   body     the procedure itself, as markdown.
 */
const CARRIED_FIELDS = Object.freeze(['name', 'title', 'summary', 'body']);

/**
 * Never carried, at any role, in any envelope. Listed in BOTH camelCase and the
 * snake_case column spelling, because a hostile or careless payload will use
 * whichever spelling the reader forgot.
 *
 * Grouped by what each one would grant if it were ever carried:
 *
 *  - baseUrl / endpoints / mcp / provider / capabilities / code
 *      the sandbox-skill fields. `baseUrl` is a host THE SERVER FETCHES with a
 *      stored credential attached (planProviderCall). `code` is a script. These
 *      belong to `metadata.sandbox_skills`, which is MANAGE_ONLY on the agent
 *      row precisely so a 'write' member cannot author one.
 *  - credential
 *      names a workspace-vault key. Carrying it would let a prose artifact
 *      choose which secret a call is signed with.
 *  - path / memoryDir / hostFolders
 *      filesystem paths on somebody's actual machine. `host_folders` becomes
 *      `--add-dir <path>` for a coding CLI.
 *  - permissionMode / tools / metadata
 *      what an agent MAY DO. A skill describes a procedure; it never widens the
 *      surface the procedure runs against.
 *  - agentId
 *      a workspace skill belongs to the WORKSPACE. Keying one to an agent would
 *      rebuild `agent_skill_documents`, which is daemon-owned and read-only.
 *  - source / origin / revision
 *      provenance and lifecycle, set by the route. A caller that could claim
 *      source='authored' on an imported body would erase the only record of
 *      where attacker-influenced prose came from.
 *  - id / workspaceId / createdBy
 *      row identity, never authored.
 */
const NEVER_CARRIED_FIELDS = Object.freeze([
 'baseUrl', 'base_url',
 'credential',
 'endpoints',
 'mcp',
 'code',
 'provider',
 'capabilities',
 'path',
 'memoryDir', 'memory_dir',
 'hostFolders', 'host_folders',
 'permissionMode', 'permission_mode',
 'tools',
 'metadata',
 'sandboxSkills', 'sandbox_skills',
 'agentId', 'agent_id',
 'source',
 'origin',
 'revision',
 'id',
 'workspaceId', 'workspace_id',
 'createdBy', 'created_by',
]);

function text(value, max) {
 if (value === null || value === undefined) return '';
 return String(value).slice(0, max);
}

/**
 * URL-safe skill name from arbitrary text. Stable, lowercase, no leading or
 * trailing dashes, no runs of dashes — so the output always satisfies
 * WORKSPACE_SKILL_NAME_RE or is empty.
 */
function slugifySkillName(value) {
 return String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, MAX_NAME)
  // A slice can leave a trailing dash behind; trim again so the result cannot
  // fail the name rule purely because of where the ceiling landed.
  .replace(/-+$/g, '');
}

/**
 * Cap a body at MAX_BODY_BYTES, reporting whether it was cut.
 *
 * By BYTES, because that is what the ceiling protects, and the slice is
 * re-decoded so a multi-byte character split across the boundary cannot leave a
 * lone replacement char mid-word. Same construction as capContent in
 * server/skill-content.cjs.
 */
function capBody(raw) {
 const body = String(raw == null ? '' : raw);
 const bytes = Buffer.byteLength(body, 'utf8');
 if (bytes <= MAX_BODY_BYTES) return { body, byteSize: bytes, truncated: false };
 const sliced = Buffer.from(body, 'utf8')
  .subarray(0, MAX_BODY_BYTES)
  .toString('utf8')
  .replace(/\uFFFD+$/, '');
 return { body: sliced, byteSize: Buffer.byteLength(sliced, 'utf8'), truncated: true };
}

/**
 * Every never-carried key present in a raw payload, at the top level.
 *
 * Used to REFUSE with a message naming the key rather than dropping it quietly.
 * A silent drop is how somebody comes to believe they authored a skill that
 * calls an API, and then wonders why it never does.
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
 * Validate and REBUILD a workspace skill.
 *
 * Returns `{ ok, errors, skill, rejected }`. On success `skill` is constructed
 * from CARRIED_FIELDS only — it is not the input with keys removed. That
 * distinction is the whole control.
 */
function normalizeWorkspaceSkill(raw, { allowUnknown = false } = {}) {
 const errors = [];
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
  return { ok: false, errors: ['skill must be an object'], skill: null, rejected: [] };
 }

 // Refuse loudly, before anything else, so the caller learns WHICH key was the
 // problem instead of wondering why their credential did not survive.
 const rejected = rejectedFields(raw);
 if (rejected.length && !allowUnknown) {
  return {
   ok: false,
   errors: rejected.map((key) => `${key} cannot be carried by a workspace skill (it grants authority; a skill carries prose only)`),
   skill: null,
   rejected,
  };
 }

 const title = text(raw.title || raw.name, MAX_TITLE).trim();
 if (!title) errors.push('title is required');

 const name = slugifySkillName(raw.name || raw.title);
 if (!name) errors.push('name could not be derived from the title');
 else if (!WORKSPACE_SKILL_NAME_RE.test(name)) {
  // Unreachable via slugifySkillName, which cannot emit a failing string. Kept
  // because the rule is the contract every reader downstream relies on, and a
  // future edit to the slugifier must fail HERE rather than in `read_skill`.
  errors.push('name must be lowercase letters, digits and single hyphens');
 }

 const { body, truncated } = capBody(raw.body);
 if (!body.trim()) {
  // The entire reason this store exists is that a NAME without a PROCEDURE
  // "would record a claim without the procedure that makes it true". An empty
  // body would rebuild exactly that, in a new table.
  errors.push('body is required — a skill with no procedure is just a name');
 }

 if (errors.length) return { ok: false, errors, skill: null, rejected: [] };

 return {
  ok: true,
  errors: [],
  rejected: [],
  truncated,
  skill: {
   name,
   title,
   summary: text(raw.summary, MAX_SUMMARY).trim(),
   body,
  },
 };
}

/**
 * Render a workspace skill as a real agentskills.io SKILL.md.
 *
 * This is what `read_skill` fences and hands to an agent, and what the Skills
 * pane shows a human — ONE rendering, so the two can never be shown different
 * text for the same skill. The frontmatter is what makes the result portable:
 * copy it into `.claude/skills/<name>/SKILL.md` and any skills-compatible client
 * loads it.
 *
 * `name` and the source line are safe to interpolate unquoted: `name` has passed
 * WORKSPACE_SKILL_NAME_RE (no colons, no newlines, no quotes) and the source
 * line is a literal. `title` and `summary` are NOT, so both are quoted and
 * escaped — a summary containing a newline would otherwise close the frontmatter
 * block early and turn the rest of the value into YAML keys.
 */
function renderWorkspaceSkillMarkdown(skill = {}) {
 const name = String(skill.name || '').trim();
 const yaml = (value) => `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim()}"`;
 const frontmatter = ['---', `name: ${name || 'untitled'}`];
 if (skill.title) frontmatter.push(`title: ${yaml(skill.title)}`);
 if (skill.summary) frontmatter.push(`description: ${yaml(skill.summary)}`);
 frontmatter.push('source: agensis workspace skill', '---');
 return `${frontmatter.join('\n')}\n\n${String(skill.body || '')}\n`;
}

/**
 * Which of a template's named skills actually resolve in a workspace.
 *
 * THE DANGLING-REFERENCE FIX. A template's `skills` array is a list of REQUESTS
 * (shared/agentTemplates.cjs: "an unknown skill id resolves to no definition"),
 * and until this store existed a workspace had no way to satisfy one. Now it
 * does, so instantiation can say which names the workspace can actually back and
 * which are still just words.
 *
 * Case-insensitive, because a template may have been authored anywhere and the
 * name rule is only enforced on skills authored HERE. Returns both lists rather
 * than a boolean: "3 of 4 resolve, `security-review` does not" is the useful
 * sentence, and dropping the unresolved ones silently would recreate the exact
 * bug this fixes.
 */
function resolveTemplateSkills(templateSkills, availableNames) {
 const available = new Set(
  (Array.isArray(availableNames) ? availableNames : [])
   .map((n) => String(n || '').trim().toLowerCase())
   .filter(Boolean),
 );
 const resolved = [];
 const unresolved = [];
 const seen = new Set();
 for (const raw of Array.isArray(templateSkills) ? templateSkills : []) {
  const value = String(raw || '').trim();
  if (!value) continue;
  const key = value.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  (available.has(key) ? resolved : unresolved).push(value);
 }
 return { resolved, unresolved };
}

/** SHA-256 over the carried fields, canonicalised. Identifies a skill body. */
function skillFingerprint(skill = {}) {
 const canonical = {};
 for (const field of [...CARRIED_FIELDS].sort()) canonical[field] = skill[field] ?? '';
 return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

module.exports = {
 CARRIED_FIELDS,
 NEVER_CARRIED_FIELDS,
 SKILL_SOURCES,
 WORKSPACE_SKILL_NAME_RE,
 MAX_NAME,
 MAX_TITLE,
 MAX_SUMMARY,
 MAX_BODY_BYTES,
 MAX_SKILLS_PER_WORKSPACE,
 capBody,
 normalizeWorkspaceSkill,
 rejectedFields,
 renderWorkspaceSkillMarkdown,
 resolveTemplateSkills,
 skillFingerprint,
 slugifySkillName,
};
