'use strict';

// ============================================================================
// tests/agent-document-library.test.cjs
// ----------------------------------------------------------------------------
// The DAEMON side of the document library: what a connected agent may push into
// `agent_documents`, and the schema/allowlist wiring that push depends on.
//
// server/document-library.cjs is pure, so the caps and derivation rules are
// tested directly. The wiring is tested as SOURCE TEXT, which is unusual for
// this repo and deliberate for the same reason the fanout allowlist test does
// it: the invariant is "the three schema places agree and the table is
// allowlisted", and only reading the code can check that. The failure mode
// otherwise is silent — a table missing from ALLOWED_TABLES simply makes the
// sidebar empty on a fresh database, with nothing erroring anywhere.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DOCUMENT_CONTENT_MAX_BYTES,
  DOCUMENT_MAX_FILES,
  deriveDocumentDomain,
  deriveDocumentTitle,
  isDocumentPath,
  normalizeAgentDocument,
  normalizeAgentDocuments,
  normalizeDocumentPath,
} = require('../server/document-library.cjs');
const {
  ALLOWED_TABLES,
  WORKSPACE_SCOPED_TABLES,
  DB_TABLE_ACCESS,
  safeSelectColumns,
} = require('../shared/backend-core.cjs');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// --- what counts as a document -----------------------------------------------

test('only text documents are carried, never arbitrary files', () => {
  // THE SECURITY POINT of the extension rule. A daemon can be pointed at a
  // directory full of secrets; what it must not be able to do is have them
  // rendered in a shared workspace under a feature labelled "documents".
  for (const good of ['README.md', 'docs/a.markdown', 'x.mdx', 'notes.txt', 'guide.rst', 'a.adoc']) {
    assert.equal(isDocumentPath(good), true, good);
  }
  for (const bad of ['.env', 'id_rsa', 'key.pem', 'config.json', 'db.sqlite', 'a.js', 'photo.png']) {
    assert.equal(isDocumentPath(bad), false, bad);
  }
});

test('the extensionless names accepted are a closed list, not "anything without a dot"', () => {
  assert.equal(isDocumentPath('README'), true);
  assert.equal(isDocumentPath('LICENSE'), true);
  assert.equal(isDocumentPath('CHANGELOG'), true);
  // MUTATION: accept any extensionless file. That readmits exactly the case the
  // extension rule exists to refuse — `Dockerfile`, `Makefile`, and every
  // secrets file somebody stored without a suffix.
  assert.equal(isDocumentPath('Dockerfile'), false);
  assert.equal(isDocumentPath('secrets'), false);
});

test('a document with no path is dropped rather than stored under a blank key', () => {
  assert.equal(normalizeAgentDocument({ content: 'hi' }), null);
  assert.equal(normalizeAgentDocument({ path: '   ' }), null);
  assert.equal(normalizeAgentDocument(null), null);
  assert.equal(normalizeAgentDocument('README.md'), null);
  // Right shape, wrong kind of file.
  assert.equal(normalizeAgentDocument({ path: 'a.json', content: '{}' }), null);
});

// --- paths --------------------------------------------------------------------

test('paths normalize so two daemons collate as one document', () => {
  // NOT a security boundary — agensis never opens these. It is normalized so
  // `./docs/a.md` and `docs/a.md` are the same document rather than two.
  assert.equal(normalizeDocumentPath('./docs/a.md'), 'docs/a.md');
  assert.equal(normalizeDocumentPath('docs\\api\\a.md'), 'docs/api/a.md');
  assert.equal(normalizeDocumentPath('//docs//a.md'), 'docs/a.md');
  assert.equal(normalizeDocumentPath('  docs/a.md  '), 'docs/a.md');
});

test('an unstorable path is refused, not truncated into a colliding identity', () => {
  // A path is an IDENTITY here — half the collation key and the whole of
  // UNIQUE(agent_id, path). MUTATION: `.slice(0, 1024)`. Two different 1100-char
  // paths then become the same row, and the mirror silently loses a document.
  assert.equal(normalizeAgentDocument({ path: `${'d/'.repeat(2000)}a.md` }), null);
  // Long but storable still works.
  const ok = normalizeAgentDocument({ path: `${'d/'.repeat(200)}a.md` });
  assert.ok(ok);
  assert.ok(ok.path.endsWith('a.md'));
});

// --- derived fields ------------------------------------------------------------

test('a title comes from the document itself before the filename', () => {
  // The heading wins because it is what the document calls ITSELF, and the
  // collation key is built from it.
  assert.equal(deriveDocumentTitle('# Real Title\n\nbody', 'docs/some-file.md'), 'Real Title');
  assert.equal(deriveDocumentTitle('no heading here', 'docs/some-file.md'), 'some file');
  assert.equal(deriveDocumentTitle('', ''), 'Untitled');
  // A '#' inside a fenced block is still a heading to this regex, and that is
  // acceptable: the worst case is a slightly odd title, never a wrong document.
  assert.equal(deriveDocumentTitle('   # Indented\n', 'a.md'), 'Indented');
});

test('a daemon-supplied title wins over a derived one', () => {
  const doc = normalizeAgentDocument({ path: 'a.md', title: 'Chosen', content: '# Derived' });
  assert.equal(doc.title, 'Chosen');
});

test('a domain is the first directory, and root files get none', () => {
  assert.equal(deriveDocumentDomain('docs/api/auth.md'), 'docs');
  assert.equal(deriveDocumentDomain('./docs/a.md'), 'docs');
  // A file at the root has no directory to name. '' rather than an invented
  // folder — the library groups those under General itself.
  assert.equal(deriveDocumentDomain('README.md'), '');
});

// --- caps ----------------------------------------------------------------------

test('an oversized body is cut and says so, keeping the real size', () => {
  const big = 'x'.repeat(DOCUMENT_CONTENT_MAX_BYTES + 5000);
  const doc = normalizeAgentDocument({ path: 'a.md', content: big });
  assert.equal(doc.truncated, true);
  assert.ok(Buffer.byteLength(doc.content, 'utf8') <= DOCUMENT_CONTENT_MAX_BYTES);
  // byteSize is the FILE's size, not the stored slice's: the UI says "the file
  // is longer than this on disk", which needs the number it was cut from.
  assert.equal(doc.byteSize, DOCUMENT_CONTENT_MAX_BYTES + 5000);
});

test('cutting by bytes does not split a multi-byte character', () => {
  // MUTATION: slice by `.length`. A character straddling the cut then becomes a
  // replacement char in the middle of the stored body.
  const doc = normalizeAgentDocument({ path: 'a.md', content: '★'.repeat(DOCUMENT_CONTENT_MAX_BYTES) });
  assert.equal(doc.truncated, true);
  assert.ok(!doc.content.includes('�'), 'no replacement characters');
});

test('the file hash is the daemon"s and is never recomputed', () => {
  // Recomputing it here would report two DIFFERENT files as identical whenever
  // the server truncated both to the same cap.
  const doc = normalizeAgentDocument({ path: 'a.md', content: 'body', contentHash: 'sha256:abc' });
  assert.equal(doc.contentHash, 'sha256:abc');
  assert.equal(normalizeAgentDocument({ path: 'a.md', content: 'body' }).contentHash, '');
});

test('an unparseable timestamp becomes null, never a fabricated now()', () => {
  // The column RANKS versions. A wrong date silently promotes the wrong agent's
  // copy to "latest", which is the one thing the compare view must get right.
  assert.equal(normalizeAgentDocument({ path: 'a.md', modifiedAt: 'yesterday' }).sourceModifiedAt, null);
  assert.equal(normalizeAgentDocument({ path: 'a.md' }).sourceModifiedAt, null);
  assert.equal(
    normalizeAgentDocument({ path: 'a.md', modifiedAt: '2026-08-02T10:00:00Z' }).sourceModifiedAt,
    '2026-08-02T10:00:00.000Z',
  );
  // Epoch millis, because that is what fs.Stats.mtimeMs hands a daemon author.
  assert.equal(
    normalizeAgentDocument({ path: 'a.md', modifiedAt: Date.parse('2026-08-02T10:00:00Z') }).sourceModifiedAt,
    '2026-08-02T10:00:00.000Z',
  );
});

test('a push is capped and deduped by path, first write winning', () => {
  const many = Array.from({ length: DOCUMENT_MAX_FILES + 50 }, (_, index) => ({ path: `d/${index}.md` }));
  assert.equal(normalizeAgentDocuments(many).length, DOCUMENT_MAX_FILES);

  const duped = normalizeAgentDocuments([
    { path: 'a.md', title: 'First' },
    { path: './a.md', title: 'Second' },
  ]);
  assert.equal(duped.length, 1);
  assert.equal(duped[0].title, 'First');

  assert.deepEqual(normalizeAgentDocuments(null), []);
  assert.deepEqual(normalizeAgentDocuments('nope'), []);
});

// --- wiring --------------------------------------------------------------------

test('agent_documents is readable, workspace-scoped, and write-gated to manage', () => {
  // Without ALLOWED_TABLES the browser's subscribe is refused and the fanout
  // reaches nobody — silently, on both ends. Without WORKSPACE_SCOPED_TABLES,
  // enforceDbOperationAccess returns EARLY and every signed-in user reads every
  // other tenant's rows.
  assert.ok(ALLOWED_TABLES.has('agent_documents'));
  assert.ok(WORKSPACE_SCOPED_TABLES.has('agent_documents'));
  assert.deepEqual(DB_TABLE_ACCESS.agent_documents, {
    select: 'read', insert: 'manage', update: 'manage', delete: 'manage',
  });
});

test('the projection is pinned, so a future column is a deliberate exposure', () => {
  const columns = safeSelectColumns('agent_documents', '*').split(',').map(column => column.trim());
  assert.ok(columns.includes('content'), 'the body is readable — the library renders and diffs it');
  assert.ok(columns.includes('content_hash'));
  assert.ok(columns.includes('source_modified_at'));
  // A table in ALLOWED_TABLES with no projection entry returns EVERY column to
  // any member with 'read', including whatever a migration adds next.
  assert.ok(columns.length >= 15 && columns.length <= 20, `unexpected projection width: ${columns.length}`);
});

test('the body is stripped from the realtime fanout', () => {
  // A daemon re-syncs a whole docs tree on reconnect. Broadcasting the bodies
  // would push megabytes to every subscribed browser, every time.
  const source = read('server/realtime.cjs');
  assert.match(source, /agent_documents:\s*\['content'\]/);
});

test('the schema exists in all three places', () => {
  // The repo's documented #1 footgun: a change is only correct when the runtime
  // bootstrap, the canonical schema and a migration all agree, or a fresh
  // database drifts from a deployed one.
  for (const file of ['server/index.cjs', 'database/neon-schema.sql', 'supabase/migrations/20260803120000_agent_document_library.sql']) {
    const source = read(file);
    assert.match(source, /CREATE TABLE IF NOT EXISTS agent_documents/, `${file} is missing agent_documents`);
    assert.match(source, /UNIQUE \(agent_id, path\)/, `${file} is missing the mirror's identity`);
    assert.match(source, /sharing jsonb NOT NULL DEFAULT '\{\}'::jsonb/, `${file} is missing workspace_agents.sharing`);
  }
});

test('the sync handler is routed and the drift hash is carried', () => {
  const realtime = read('server/realtime.cjs');
  assert.match(realtime, /message\.action === 'agent_document_sync'/);
  assert.match(realtime, /documentsHash: message\.documentsHash/);

  const connections = read('server/agent-connections.cjs');
  assert.match(connections, /agent_documents_refresh/);
  // MUTATION: drop documentsHash from the capabilities snapshot. That statement
  // REPLACES the whole blob, so the reference blanks on every capabilities push
  // and the heartbeat nudges documents forever.
  assert.match(connections, /documentsHash: typeof message\.documentsHash === 'string'/);
});

test('every mirror sync is gated on BOTH halves of sharing', () => {
  // Two independent vetoes, and the sync must consult each. The workspace
  // switch is what somebody set in agensis; the policy is what the machine's own
  // .agensis-share declares. MUTATION: drop either call and one side silently
  // stops being able to withhold anything.
  const source = read('server/agent-connections.cjs');
  for (const channel of ['memory', 'skills', 'documents']) {
    assert.match(
      source,
      new RegExp(`pruneWithheldMirror\\([^;]*'${channel}'`, 's'),
      `${channel} sync does not consult the workspace switch`,
    );
    assert.match(
      source,
      new RegExp(`channelAllowed\\(\\w+Policy, '${channel}'\\)`),
      `${channel} sync does not consult the machine policy`,
    );
  }
  // Path rules are re-applied server-side on what actually arrived — the pass
  // that makes the policy a control rather than a convention.
  assert.match(source, /policyFilterPaths\(/);
  // The tool advert is redacted at ingest rather than at render, because
  // publicAgentConnection is a pure row mapper on the fanout path.
  assert.match(source, /applyToolSharing\(capabilities,/);
});
