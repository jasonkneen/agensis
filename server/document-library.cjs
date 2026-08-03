'use strict';

// ---------------------------------------------------------------------------
// The AGENT DOCUMENT MIRROR — validating what a daemon pushes on
// `agent_document_sync`, before any of it reaches `agent_documents`.
//
// A connected agent sees markdown the workspace cannot: the README of the repo
// it works in, an AGENTS.md, a docs/ tree, a spec somebody left in a folder.
// The daemon enumerates those and pushes an index up; this module decides what
// a valid entry is, so the ingest handler in server/agent-connections.cjs stays
// a database write and nothing more.
//
// Everything here is PURE. No fs, no db, no clock — the caps and the derivation
// rules are the interesting part and they are unit-testable without either
// (tests/agent-document-library.test.cjs).
//
// FAIL-CLOSED AND ALLOWLIST-ONLY, matching normalizeSkillDocument: an entry
// that cannot name its path is dropped rather than stored under a blank key,
// and a field this module does not know about never survives into the row. The
// caps are not politeness — a daemon is a program on someone else's machine,
// and "it will only ever send a few small files" is not a property of anything.
// ---------------------------------------------------------------------------

/** Hard ceiling on any single document body. Matches SKILL_CONTENT_MAX_BYTES. */
const DOCUMENT_CONTENT_MAX_BYTES = 64 * 1024;

/**
 * Most documents one daemon may mirror in a single sync.
 *
 * Higher than the skill ceiling (200) because a repo's docs tree legitimately
 * runs to hundreds of files where a skill set does not, and a library that
 * silently stopped at the first 200 of 400 would be worse than one that says
 * nothing: it would look complete.
 */
const DOCUMENT_MAX_FILES = 1000;

const MAX_PATH = 1024;
const MAX_TITLE = 300;
const MAX_DOMAIN = 200;
const MAX_SUMMARY = 2000;
const MAX_HASH = 128;

/**
 * File extensions the mirror accepts.
 *
 * Markdown and plain text only, deliberately. This is a DOCUMENT library, and
 * the moment it accepts `.env`, `.pem` or `.json` it becomes a way to siphon a
 * developer's working directory into a shared workspace through a feature
 * labelled "documents". A daemon can still be pointed at a directory full of
 * secrets; what it cannot do is have them rendered here as documents.
 */
const DOCUMENT_EXTENSIONS = Object.freeze(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc']);

/**
 * Filenames accepted with no extension at all.
 *
 * These are the ones that are genuinely documents and genuinely extensionless
 * in the wild. Kept as a closed list rather than "any file with no extension",
 * which would readmit exactly the case the extension rule exists to refuse.
 */
const EXTENSIONLESS_DOCUMENT_NAMES = Object.freeze(['readme', 'license', 'licence', 'notice', 'changelog', 'authors', 'contributing']);

function fileName(filePath) {
 const parts = String(filePath || '').split(/[\\/]+/).filter(Boolean);
 return parts.length > 0 ? parts[parts.length - 1] : '';
}

function extensionOf(filePath) {
 const name = fileName(filePath);
 const dot = name.lastIndexOf('.');
 return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Is this path something the mirror will carry? See DOCUMENT_EXTENSIONS. */
function isDocumentPath(filePath) {
 const name = fileName(filePath).toLowerCase();
 if (!name) return false;
 const ext = extensionOf(filePath);
 if (ext) return DOCUMENT_EXTENSIONS.includes(ext);
 return EXTENSIONLESS_DOCUMENT_NAMES.includes(name);
}

/**
 * Normalize a path for storage: forward slashes, no leading `./` or `/`.
 *
 * NOT a security boundary — agensis never opens this path, it is a label
 * describing where the file sits on the daemon's machine. It is normalized so
 * that `./docs/a.md` and `docs/a.md` from two daemons collate as one document
 * instead of two, which is the whole point of the library.
 *
 * DOES NOT TRUNCATE. A path is an IDENTITY here (it is half the collation key
 * and the whole of the UNIQUE constraint), and a truncated identity is a lie
 * that also collides: cut two 1100-character paths to 1024 and they may become
 * the same row. Over-length paths are dropped by normalizeAgentDocument
 * instead, which is the honest answer for a file we cannot name.
 */
function normalizeDocumentPath(filePath) {
 return String(filePath || '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .replace(/^\/+/, '')
  .replace(/\/{2,}/g, '/')
  .trim();
}

/** Cap a body at DOCUMENT_CONTENT_MAX_BYTES, reporting what it cost. */
function capContent(raw) {
 const text = typeof raw === 'string' ? raw : '';
 const bytes = Buffer.byteLength(text, 'utf8');
 if (bytes <= DOCUMENT_CONTENT_MAX_BYTES) return { content: text, byteSize: bytes, truncated: false };
 // Slice by BYTES, then drop a trailing partial character. Decoding a byte
 // slice that ends mid-codepoint yields U+FFFD, so without the second step
 // every truncated non-ASCII document would end in a visible replacement glyph
 // — and a diff against an untruncated copy would report a difference that is
 // an artefact of our own cut.
 const cut = Buffer.from(text, 'utf8').subarray(0, DOCUMENT_CONTENT_MAX_BYTES).toString('utf8');
 const content = cut.endsWith('\uFFFD') && !text.includes('\uFFFD') ? cut.slice(0, -1) : cut;
 return { content, byteSize: bytes, truncated: true };
}

/**
 * A title for a document that did not send one.
 *
 * First `# heading` if the body has one, else the filename made readable. The
 * heading wins because it is what the document calls ITSELF, and the collation
 * key is built from the title — two agents whose checkouts differ only in
 * filename case should still land on one row.
 */
function deriveDocumentTitle(content, filePath) {
 const heading = String(content || '').match(/^\s{0,3}#\s+(.+?)\s*$/m);
 if (heading && heading[1].trim()) return heading[1].trim().slice(0, MAX_TITLE);
 const name = fileName(filePath);
 const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
 if (!base) return 'Untitled';
 return base.replace(/[-_]+/g, ' ').trim().slice(0, MAX_TITLE) || 'Untitled';
}

/**
 * A grouping hint for a document whose daemon did not send one.
 *
 * The path's first directory, which is the closest thing to a "domain" a file
 * tree offers: `docs/api/auth.md` -> `docs`. A file at the root has no
 * directory to name, and gets '' — the library renders those together rather
 * than inventing a folder they are not in.
 */
function deriveDocumentDomain(filePath) {
 const normalized = normalizeDocumentPath(filePath);
 const parts = normalized.split('/').filter(Boolean);
 if (parts.length < 2) return '';
 return parts[0].slice(0, MAX_DOMAIN);
}

/**
 * Validate one entry from an `agent_document_sync` push.
 *
 * Returns null for anything that cannot be stored honestly: no path, a path
 * that is not a document, or a body that is not text.
 */
function normalizeAgentDocument(raw) {
 if (!raw || typeof raw !== 'object') return null;
 const path = normalizeDocumentPath(raw.path || raw.file || '');
 if (!path) return null;
 // Refused rather than cut — see normalizeDocumentPath. Nothing real is lost:
 // a 1 KB path is pathological, and storing a truncated one would corrupt both
 // the collation key and the UNIQUE(agent_id, path) identity.
 if (path.length > MAX_PATH) return null;
 if (!isDocumentPath(path)) return null;

 const { content, byteSize, truncated } = capContent(raw.content);
 const title = String(raw.title || '').trim().slice(0, MAX_TITLE) || deriveDocumentTitle(content, path);
 const domain = String(raw.domain || raw.folder || '').trim().slice(0, MAX_DOMAIN) || deriveDocumentDomain(path);

 return {
  path,
  title,
  domain,
  summary: String(raw.summary || '').slice(0, MAX_SUMMARY),
  content,
  byteSize,
  truncated: truncated || raw.truncated === true,
  // The daemon's hash of the FILE. Never recomputed here: two daemons agreeing
  // is the signal the library uses to say "identical", and a hash the server
  // derived from a body it may have TRUNCATED would report two different files
  // as the same one.
  contentHash: String(raw.contentHash || raw.hash || '').trim().slice(0, MAX_HASH),
  sourceModifiedAt: normalizeTimestamp(raw.modifiedAt || raw.sourceModifiedAt || raw.mtime),
 };
}

/**
 * An ISO timestamp, or null.
 *
 * Accepts epoch millis too, because that is what `fs.Stats.mtimeMs` hands a
 * daemon author and asking them to format it is asking for a bug. Anything
 * unparseable becomes null rather than a fabricated `now()`: the column ranks
 * versions, and a wrong date silently promotes the wrong agent's copy.
 */
function normalizeTimestamp(value) {
 if (value == null) return null;
 const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
 const time = date.getTime();
 if (!Number.isFinite(time)) return null;
 return date.toISOString();
}

/** Every valid document in a push, deduped by path, first write winning. */
function normalizeAgentDocuments(raw) {
 const list = Array.isArray(raw) ? raw.slice(0, DOCUMENT_MAX_FILES) : [];
 const byPath = new Map();
 for (const item of list) {
  const doc = normalizeAgentDocument(item);
  if (doc && !byPath.has(doc.path)) byPath.set(doc.path, doc);
 }
 return [...byPath.values()];
}

module.exports = {
 DOCUMENT_CONTENT_MAX_BYTES,
 DOCUMENT_MAX_FILES,
 DOCUMENT_EXTENSIONS,
 EXTENSIONLESS_DOCUMENT_NAMES,
 isDocumentPath,
 normalizeDocumentPath,
 deriveDocumentTitle,
 deriveDocumentDomain,
 normalizeAgentDocument,
 normalizeAgentDocuments,
};
