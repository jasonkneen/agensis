'use strict';

// Upload storage paths + the file-type allowlist.
//
// Moved verbatim out of server/index.cjs (Wave 1 of the index.cjs reduction).
// This is a pure leaf: `path`, plus two error helpers and one containment
// predicate from shared/backend-core.cjs. It holds no mutable module state and
// never touches the database, so it needs no injected deps and no reset seam.
//
// `forbidden` comes from the shared core rather than index.cjs's local copy of
// the same three lines — both are `new Error(msg)` with `.status = 403`, and the
// shared one is what the Netlify mirror already throws.

const path = require('path');
const {
 forbidden,
 storagePathBelongsToWorkspace,
} = require('../../shared/backend-core.cjs');

function safeFileName(name) {
 return String(name || 'upload')
  .replace(/[/\\?%*:|"<>]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 180) || 'upload';
}

function getUploadRoot() {
 return process.env.AGENSIS_UPLOAD_ROOT || path.join(process.cwd(), '.agensis_uploads');
}

function storagePathFor(workspaceId, id, name) {
 return path.join(String(workspaceId), `${id}-${safeFileName(name)}`);
}

function resolveStoragePath(storagePath) {
 const root = path.resolve(getUploadRoot());
 const fullPath = path.resolve(root, storagePath || '');
 if (!fullPath.startsWith(root + path.sep)) {
  throw new Error('Invalid storage path');
 }
 return fullPath;
}

/** Ensure a stored path both lives under the upload root and under the file's workspace. */
function resolveStoragePathForWorkspace(workspaceId, storagePath) {
 if (!storagePathBelongsToWorkspace(workspaceId, storagePath)) {
  throw forbidden('Invalid file storage path for this workspace');
 }
 const fullPath = resolveStoragePath(storagePath);
 // Post-resolve containment under <uploadRoot>/<workspaceId>/ (or exact dir).
 // Catches any residual separator/encoding tricks that the string check missed.
 const root = path.resolve(getUploadRoot());
 const workspaceRoot = path.resolve(root, String(workspaceId));
 const withSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
 if (fullPath !== workspaceRoot && !fullPath.startsWith(withSep)) {
  throw forbidden('Invalid file storage path for this workspace');
 }
 return fullPath;
}

// ============================================================
// File upload content-type hardening (plan 002).
//
// Server-side mirror of src/components/files/FileUpload.tsx's
// ALLOWED_EXTENSIONS map — keep the two lists in sync. The client's `type`
// (browser-reported MIME) is untrusted and easily spoofed, so the server
// NEVER stores or serves it verbatim: the stored/served Content-Type is
// always derived from this allowlist, keyed on the upload's file extension.
//
// `.html` and `.svg` can carry executable script when rendered inline by a
// browser, so — per plan 002's "reject-and-neutralize" decision — uploads of
// those two extensions are still accepted (matching the client's advertised
// feature set) but their Content-Type is neutralized to `text/plain` here,
// at storage time, rather than trusting anything downstream to catch it.
const UPLOAD_EXTENSION_CONTENT_TYPES = {
 // Images
 png: 'image/png',
 jpg: 'image/jpeg',
 jpeg: 'image/jpeg',
 gif: 'image/gif',
 webp: 'image/webp',
 svg: 'text/plain', // neutralized — see FORCE_ATTACHMENT_EXTENSIONS below
 bmp: 'image/bmp',
 // Documents
 pdf: 'application/pdf',
 doc: 'application/msword',
 docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 xls: 'application/vnd.ms-excel',
 xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 ppt: 'application/vnd.ms-powerpoint',
 pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 // Text / data
 txt: 'text/plain',
 md: 'text/markdown',
 csv: 'text/csv',
 rtf: 'application/rtf',
 // Code (browsers often report "" or text/plain for these)
 json: 'application/json',
 js: 'text/javascript',
 mjs: 'text/javascript',
 ts: 'text/plain',
 tsx: 'text/plain',
 jsx: 'text/plain',
 html: 'text/plain', // neutralized — see FORCE_ATTACHMENT_EXTENSIONS below
 css: 'text/css',
 xml: 'application/xml',
 yml: 'text/yaml',
 yaml: 'text/yaml',
};

// Extensions whose native rendering can execute script inline — always
// served as a download (Content-Disposition: attachment), independent of
// whatever Content-Type ends up stored (belt-and-suspenders: this check runs
// at serve time using the ORIGINAL FILENAME, since Step 1 above already
// neutralizes the stored type for these two to `text/plain`, which would
// otherwise make a stored-type-only check below a no-op for the normal
// upload path).
const FORCE_ATTACHMENT_EXTENSIONS = new Set(['html', 'svg']);

// Defense-in-depth: `uploaded_files` is also reachable through the generic
// `/backend/db/*` CRUD routes (it's in ALLOWED_TABLES), so a write-role user
// could PATCH a row's `type` column directly to one of these dangerous MIME
// strings without ever going through the upload handler above. Force
// attachment for these regardless of the file's extension/name.
const FORCE_ATTACHMENT_CONTENT_TYPES = new Set([
 'text/html',
 'image/svg+xml',
 'application/xhtml+xml',
 'text/xml',
]);

function getUploadExtension(name) {
 const trimmed = String(name || '');
 const dot = trimmed.lastIndexOf('.');
 return dot >= 0 ? trimmed.slice(dot + 1).toLowerCase() : '';
}

// Deny-by-default lookup: plain bracket/dot access on a POJO also resolves
// inherited members (e.g. `x.constructor` or `x.__proto__` would otherwise
// "match" and return a non-undefined value), which would let an attacker
// smuggle an extension past the allowlist. `Object.hasOwn` restricts the
// lookup to the allowlist's own declared keys.
function lookupUploadContentType(extension) {
 return Object.hasOwn(UPLOAD_EXTENSION_CONTENT_TYPES, extension)
  ? UPLOAD_EXTENSION_CONTENT_TYPES[extension]
  : undefined;
}

module.exports = {
 safeFileName,
 getUploadRoot,
 storagePathFor,
 resolveStoragePath,
 resolveStoragePathForWorkspace,
 getUploadExtension,
 lookupUploadContentType,
 UPLOAD_EXTENSION_CONTENT_TYPES,
 FORCE_ATTACHMENT_EXTENSIONS,
 FORCE_ATTACHMENT_CONTENT_TYPES,
};
