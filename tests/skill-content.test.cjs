'use strict';

// ============================================================================
// tests/skill-content.test.cjs
// ----------------------------------------------------------------------------
// The Skills browser now shows a skill's real text. Two things have to hold:
//
//   1. It never invents one. A skill name a daemon advertised has no body here,
//      and the resolver must say WHICH kind of nothing that is ('not-synced',
//      not 'not-found') because the two are fixed in completely different
//      places.
//   2. Reading a library entry is a FILE READ on the backend host, so the only
//      addressable paths are the ones detectSkillLibraries itself produced, the
//      entry name cannot leave its directory, and a `config` library — which is
//      where ~/.gemini/settings.json and ~/.codex/config.toml live — is never
//      readable at all.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SKILL_CONTENT_MAX_BYTES,
  READABLE_LIBRARY_TYPES,
  findReadableLibrary,
  isSafeSkillEntryName,
  listLibraryEntries,
  normalizeSkillDocument,
  normalizeSkillDocuments,
  readLibraryEntry,
  renderSandboxSkillDocument,
  resolveLibraryEntryFile,
  resolveSkillContent,
} = require('../server/skill-content.cjs');
const { BUNDLED_SANDBOX_SKILLS, normalizeSandboxSkill } = require('../server/sandbox-skills.cjs');

const boxSkill = normalizeSandboxSkill(
  BUNDLED_SANDBOX_SKILLS.find((s) => s.id === 'sandbox-provider-box'),
);

// --------------------------------------------------------------------------
// Precedence: show the real thing, or name the reason there isn't one
// --------------------------------------------------------------------------

test('a daemon-mirrored body is shown as the skill content', () => {
  const result = resolveSkillContent({
    skill: 'deploy-targets',
    documents: [{ skill: 'deploy-targets', content: '# Deploy targets\n\nFly, then Netlify.', path: '/home/j/.claude/skills/deploy-targets/SKILL.md', byteSize: 40 }],
  });
  assert.equal(result.available, true);
  assert.equal(result.source, 'daemon');
  assert.match(result.markdown, /Fly, then Netlify/);
  assert.equal(result.path, '/home/j/.claude/skills/deploy-targets/SKILL.md');
});

test('a sandbox skill renders the EXACT block the agent is given', () => {
  const result = resolveSkillContent({ skill: 'sandbox-provider-box', sandboxSkills: [boxSkill] });
  assert.equal(result.available, true);
  assert.equal(result.source, 'sandbox');
  // Not a paraphrase: these are lines out of renderSkillBlock itself.
  assert.match(result.markdown, /Provider skill: Box sandboxes/);
  assert.match(result.markdown, /Operations \(name one as `operation`\)/);
  assert.match(result.markdown, /Base URL: https:\/\/ascii\.dev\/api\/box\/v1/);
});

test('a mirrored body wins over a definition with the same name', () => {
  // They should never collide, but if they do the machine's real file is what a
  // reader is shown, not agensis's own description of it.
  const result = resolveSkillContent({
    skill: 'sandbox-provider-box',
    documents: [{ skill: 'sandbox-provider-box', content: 'the real file' }],
    sandboxSkills: [boxSkill],
  });
  assert.equal(result.source, 'daemon');
  assert.equal(result.markdown, 'the real file');
});

test('a name a live daemon advertised reports not-synced, not not-found', () => {
  // The whole point: "the daemon has not sent the file" and "no such skill"
  // look identical to a user unless the pane can tell them apart.
  const result = resolveSkillContent({ skill: 'browse', daemonAdvertised: true });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'not-synced');
});

test('a name nothing advertises reports not-found', () => {
  const result = resolveSkillContent({ skill: 'typed-into-a-form' });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'not-found');
});

test('an empty skill name never resolves to content', () => {
  assert.equal(resolveSkillContent({ skill: '' }).available, false);
  assert.equal(resolveSkillContent({}).available, false);
});

test('the rendered sandbox document carries no credential VALUE', () => {
  const markdown = renderSandboxSkillDocument(boxSkill, { configuredKeys: ['sandbox:box:api_key'] });
  // The key name and the env var name are fine — the vault surface already
  // shows both. A value is not, and a normalized definition has nowhere to put
  // one, so this is the assertion that keeps it that way.
  assert.match(markdown, /sandbox:box:api_key/);
  assert.match(markdown, /CONFIGURED/);
  assert.doesNotMatch(markdown, /Bearer [A-Za-z0-9]{8,}/);
});

// --------------------------------------------------------------------------
// Sync ingest
// --------------------------------------------------------------------------

test('a document with no skill name is dropped, not stored blank', () => {
  assert.equal(normalizeSkillDocument({ content: 'orphan' }), null);
  assert.equal(normalizeSkillDocument(null), null);
  assert.equal(normalizeSkillDocument('nope'), null);
});

test('a synced document is capped and reports that it was cut', () => {
  const doc = normalizeSkillDocument({ skill: 'huge', content: 'x'.repeat(SKILL_CONTENT_MAX_BYTES + 500) });
  assert.equal(doc.truncated, true);
  assert.equal(Buffer.byteLength(doc.content), SKILL_CONTENT_MAX_BYTES);
  assert.equal(doc.byteSize, SKILL_CONTENT_MAX_BYTES + 500);
});

test('a sync push dedupes by skill and bounds how many it accepts', () => {
  const docs = normalizeSkillDocuments([
    { skill: 'a', content: 'first' },
    { skill: 'a', content: 'second' },
    { skill: 'b', content: 'other' },
    null,
    { content: 'nameless' },
  ]);
  assert.deepEqual(docs.map((d) => d.skill), ['a', 'b']);
  assert.equal(docs[0].content, 'first');

  const many = normalizeSkillDocuments(
    Array.from({ length: 500 }, (_, i) => ({ skill: `s${i}`, content: 'x' })),
  );
  assert.ok(many.length <= 200, `expected the push to be bounded, got ${many.length}`);
});

test('a malformed sync payload yields nothing rather than throwing', () => {
  // The handler runs inside the shared websocket try/catch, so a throw here would
  // send the daemon an error frame instead of ingesting — but more to the point,
  // a daemon must never be able to wedge its own sync with a bad row. Garbage in
  // any shape returns an empty list.
  for (const garbage of [null, undefined, 'not an array', 42, {}, [null], [[]], [{ content: 'no name' }]]) {
    assert.deepEqual(normalizeSkillDocuments(garbage), [], `threw or accepted: ${JSON.stringify(garbage)}`);
  }
  // A non-string name is coerced rather than bound raw — every field the insert
  // binds has to be a primitive of the type its column expects.
  const [coerced] = normalizeSkillDocuments([{ skill: 42, content: 7 }]);
  assert.equal(typeof coerced.skill, 'string');
  assert.equal(typeof coerced.content, 'string');
  assert.equal(typeof coerced.byteSize, 'number');
  assert.equal(typeof coerced.truncated, 'boolean');
});

test('an OLD daemon is never nudged and never blocked', () => {
  // Several machines will not update immediately. A daemon that knows nothing
  // about skills sends no skillsHash, gets no nudge, and its skills simply have
  // no body yet — breaking its heartbeat would take its agents offline.
  const { capabilitiesDriftNudges } = require('../server/index.cjs').__test;
  const stored = { skills: ['a'], clis: [], mcpServers: [], memoryRoot: null, hash: 'CAP1', memoryHash: 'MEM1' };
  assert.deepEqual(capabilitiesDriftNudges(stored, { capabilitiesHash: 'CAP1', memoryHash: 'MEM1' }), []);
  // And the sync action is optional: nothing calls it for such a daemon, so its
  // documents stay absent and resolve to the honest 'not-synced'.
  assert.equal(resolveSkillContent({ skill: 'browse', daemonAdvertised: true }).reason, 'not-synced');
});

// --------------------------------------------------------------------------
// The file read
// --------------------------------------------------------------------------

test('an entry name cannot contain a separator or start with a dot', () => {
  assert.equal(isSafeSkillEntryName('deploy-targets'), true);
  assert.equal(isSafeSkillEntryName('SKILL.md'), true);
  assert.equal(isSafeSkillEntryName('..'), false);
  assert.equal(isSafeSkillEntryName('../../etc/passwd'), false);
  assert.equal(isSafeSkillEntryName('a/b'), false);
  assert.equal(isSafeSkillEntryName('a\\b'), false);
  assert.equal(isSafeSkillEntryName('.env'), false);
  assert.equal(isSafeSkillEntryName(''), false);
  assert.equal(isSafeSkillEntryName('x'.repeat(200)), false);
});

test('a library id is only addressable when the SERVER detected it', () => {
  const detected = [
    { id: 'agents-user-skills', type: 'skills', path: '/home/j/.agents/skills', available: true },
    { id: 'missing-lib', type: 'skills', path: '/nope', available: false },
  ];
  assert.equal(findReadableLibrary(detected, 'agents-user-skills').path, '/home/j/.agents/skills');
  // Not detected, not available, or not named at all -> nothing to read. The
  // caller never supplies a path, only an id, so this lookup IS the guard.
  assert.equal(findReadableLibrary(detected, 'missing-lib'), null);
  assert.equal(findReadableLibrary(detected, 'made-up'), null);
  assert.equal(findReadableLibrary(detected, ''), null);
  assert.equal(findReadableLibrary([], 'agents-user-skills'), null);
});

test('a config library is NEVER readable', () => {
  // detectSkillLibraries also reports ~/.gemini/settings.json and
  // ~/.codex/config.toml. Those hold API keys. A reader that accepted any
  // detected library would turn "show me a skill" into "read the operator's
  // credentials".
  assert.deepEqual([...READABLE_LIBRARY_TYPES], ['skills', 'agents', 'commands']);
  const detected = [{ id: 'gemini-config', type: 'config', path: '/home/j/.gemini/settings.json', available: true }];
  assert.equal(findReadableLibrary(detected, 'gemini-config'), null);
});

test('reading is confined to the library directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const library = path.join(root, 'skills');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(library, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.md'), 'do not read me');

  fs.mkdirSync(path.join(library, 'deploy-targets'));
  fs.writeFileSync(path.join(library, 'deploy-targets', 'SKILL.md'), '# Deploy targets\n');
  fs.writeFileSync(path.join(library, 'reviewer.md'), '# Reviewer\n');
  fs.writeFileSync(path.join(library, 'notes.txt'), 'not markdown');
  fs.mkdirSync(path.join(library, 'empty-folder'));

  // Both real layouts resolve: agentskills.io folders and flat .md files.
  assert.equal(resolveLibraryEntryFile(library, 'deploy-targets'), path.join(library, 'deploy-targets', 'SKILL.md'));
  assert.equal(resolveLibraryEntryFile(library, 'reviewer.md'), path.join(library, 'reviewer.md'));
  // Everything else does not.
  assert.equal(resolveLibraryEntryFile(library, 'notes.txt'), null, 'only markdown is readable');
  assert.equal(resolveLibraryEntryFile(library, 'empty-folder'), null, 'a folder with no SKILL.md is not a skill');
  assert.equal(resolveLibraryEntryFile(library, '../outside/secret.md'), null);
  assert.equal(resolveLibraryEntryFile(library, '..'), null);
  assert.equal(resolveLibraryEntryFile(library, 'missing'), null);

  const listed = listLibraryEntries(library);
  assert.deepEqual(listed.map((e) => e.entry), ['deploy-targets', 'reviewer.md']);

  const read = readLibraryEntry(library, 'deploy-targets');
  assert.equal(read.available, true);
  assert.equal(read.source, 'host');
  assert.match(read.markdown, /# Deploy targets/);

  assert.equal(readLibraryEntry(library, '../outside/secret.md').available, false);
  assert.equal(readLibraryEntry(library, 'notes.txt').available, false);
});

test('a name that walks out of the library is refused before any stat', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-skills-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const library = path.join(root, 'skills');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(root, 'secret.md'), 'private');
  try {
    fs.symlinkSync(path.join(root, 'secret.md'), path.join(library, 'escape.md'));
  } catch {
    return; // no symlink permission on this host — the containment test above still stands
  }
  // The link's own NAME is inside the library and ends in .md, so the path
  // check alone would pass it. It resolves, and that is the honest state of
  // this guard: a link planted INSIDE a skills directory by whoever owns that
  // directory is that owner's file. What must not resolve is a name that walks
  // out, which the entry-name check refuses before any stat happens.
  assert.equal(resolveLibraryEntryFile(library, '../secret.md'), null);
  assert.equal(resolveLibraryEntryFile(library, 'escape.md'), path.join(library, 'escape.md'));
});

test('a body larger than the cap is truncated, not returned whole', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-skills-big-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'big.md'), 'y'.repeat(SKILL_CONTENT_MAX_BYTES + 4096));

  const read = readLibraryEntry(root, 'big.md');
  assert.equal(read.available, true);
  assert.equal(read.truncated, true);
  assert.equal(Buffer.byteLength(read.markdown), SKILL_CONTENT_MAX_BYTES);
});

// --------------------------------------------------------------------------
// Route wiring
// --------------------------------------------------------------------------

test('the skill-content route is authed, rate limited and workspace-scoped', () => {
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  const start = source.indexOf("app.get('/backend/system/skill-content'");
  assert.ok(start > 0, 'the /backend/system/skill-content route must exist');
  const route = source.slice(start, start + 1600);
  assert.match(route, /requireAuth/, 'must require a session');
  assert.match(route, /rateLimitBlocked\(res, skillRateLimiter/, 'must be rate limited');
  assert.match(route, /enforceWorkspaceRole\(req\.userId, workspaceId, 'read'\)/,
    'a member of one workspace must never read another workspace\'s skills');
});

test('the host-filesystem read is gated on AGENSIS_ALLOW_PROJECT_FS', () => {
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  const start = source.indexOf('async function skillLibraryPayload');
  assert.ok(start > 0, 'skillLibraryPayload must exist');
  const fn = source.slice(start, start + 1200);
  assert.match(fn, /projectFsAllowed\(\)/, 'host reads must honour the same opt-in as inspectProjectPath');
  assert.match(fn, /findReadableLibrary\(detectSkillLibraries\(''\), libraryId\)/,
    'the library must be looked up by id in the SERVER-detected list, never by a caller-supplied path');
});

test('the client mirrors the server size cap exactly', () => {
  // The pane tells a user "shown up to N" when a file was cut. Two numbers that
  // can disagree means telling them the wrong N.
  const client = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'skillContent.ts'), 'utf8');
  const match = client.match(/export const SKILL_CONTENT_MAX_BYTES = (\d+) \* (\d+);/);
  assert.ok(match, 'the client must export its mirror of the cap as `<n> * <n>`');
  assert.equal(Number(match[1]) * Number(match[2]), SKILL_CONTENT_MAX_BYTES);
});

test('every skill read is workspace-filtered at the query', () => {
  // The loaders are shared by the browser route and the agent tool loop, so one
  // missing filter would leak across workspaces through BOTH doors at once.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'skill-content.cjs'), 'utf8');
  // Every query in the module, taken as "everything between db.unsafe( and its
  // params array". Enumerating them this way means a NEW read added later is
  // covered automatically rather than needing the test updated.
  const queries = source.split('db.unsafe(').slice(1).map(call => call.slice(0, call.indexOf('[')));
  assert.ok(queries.length >= 6, `expected the shared loaders' reads, found ${queries.length}`);
  for (const query of queries) {
    assert.match(query, /workspace_id = \$1/, `an unfiltered read: ${query.trim().slice(0, 80)}`);
  }
});

test('neither skill tool lets a caller name a workspace', () => {
  // The workspace comes from the token. An argument would be a cross-workspace
  // read primitive handed to a model.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'mcp.cjs'), 'utf8');
  for (const tool of ['list_skills', 'read_skill']) {
    const start = source.indexOf(`name: '${tool}'`);
    assert.ok(start > 0, `${tool} must exist`);
    const block = source.slice(start, start + 2000);
    const schema = block.slice(block.indexOf('inputSchema'), block.indexOf('async run'));
    assert.doesNotMatch(schema, /workspace/i, `${tool} must not accept a workspace argument`);
    assert.match(block, /identity\.workspaceId/, `${tool} must scope to the token's workspace`);
  }
});
