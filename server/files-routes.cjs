'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Uploads: store, serve, delete.
//
// The stored and served Content-Type is NEVER the browser-reported one — it is
// derived from the extension allowlist in server/lib/storage-paths.cjs, and
// .html/.svg are neutralised to text/plain at storage time. Serving additionally
// forces Content-Disposition: attachment for those extensions and for a set of
// dangerous stored types, because `uploaded_files` is also reachable through the
// generic /backend/db/* routes and a write-role user could PATCH `type` directly.
//
// Every path read or written goes through resolveStoragePathForWorkspace, which
// enforces containment under both the upload root and the file's own workspace.

function mountFilesRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, notifyDbSubscribers,
  FORCE_ATTACHMENT_CONTENT_TYPES, FORCE_ATTACHMENT_EXTENSIONS,
  getUploadExtension, lookupUploadContentType, resolveStoragePath,
  resolveStoragePathForWorkspace, safeFileName, storagePathFor,
 } = deps;

 app.post('/backend/files/upload', requireAuth, async (req, res) => {
  try {
   const { workspace_id: workspaceId, name, contentBase64 } = req.body || {};
   if (!workspaceId || !name || typeof contentBase64 !== 'string') {
    return jsonError(res, 400, new Error('workspace_id, name, and contentBase64 are required'));
   }
   await enforceWorkspaceRole(req.userId, workspaceId, 'write');
   // The client's `type` (req.body.type) is deliberately ignored — it is
   // browser-reported and trivially spoofed. The stored Content-Type is
   // always derived server-side from the file extension via the allowlist
   // above (see plan 002 for the full rationale).
   const extension = getUploadExtension(name);
   const normalizedType = lookupUploadContentType(extension);
   if (!extension || normalizedType === undefined) {
    return jsonError(res, 400, new Error(`Unsupported file type: .${extension || 'unknown'}`));
   }
   const id = crypto.randomUUID();
   const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB; matches the client FileUpload cap
   // Pre-decode guard: base64 inflates ~4/3, so a decoded 25MB cap ≈ 33.6M encoded chars.
   // Reject before allocating the Buffer so an oversized payload can't spike memory.
   if (contentBase64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) {
    return jsonError(res, 413, new Error('File exceeds the 25MB upload limit'));
   }
   // Validate base64 shape before decoding — Buffer.from silently drops invalid
   // chars, so a malformed payload would otherwise write truncated garbage.
   const b64 = contentBase64.trim();
   if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return jsonError(res, 400, new Error('contentBase64 is not valid base64'));
   }
   const buffer = Buffer.from(b64, 'base64');
   if (buffer.length === 0) {
    return jsonError(res, 400, new Error('Decoded file is empty'));
   }
   if (buffer.length > MAX_UPLOAD_BYTES) {
    return jsonError(res, 413, new Error('File exceeds the 25MB upload limit'));
   }
   // Per-workspace storage quota (server-side; the client only caps per-batch).
   const WORKSPACE_STORAGE_QUOTA_BYTES = Number(process.env.WORKSPACE_STORAGE_QUOTA_BYTES) || 2 * 1024 * 1024 * 1024; // 2GB default abuse guard
   const usageRows = await getDb().unsafe(
    'select coalesce(sum(size), 0)::bigint as total from uploaded_files where workspace_id = $1',
    [workspaceId],
   );
   if (Number(usageRows[0]?.total || 0) + buffer.length > WORKSPACE_STORAGE_QUOTA_BYTES) {
    const gb = (WORKSPACE_STORAGE_QUOTA_BYTES / (1024 * 1024 * 1024)).toFixed(1);
    return jsonError(res, 413, new Error(`Workspace storage quota exceeded (${gb}GB). Delete files to free space.`));
   }
   const storagePath = storagePathFor(workspaceId, id, name);
   const fullPath = resolveStoragePath(storagePath);
   fs.mkdirSync(path.dirname(fullPath), { recursive: true });
   fs.writeFileSync(fullPath, buffer);
   const sha = crypto.createHash('sha256').update(buffer).digest('hex');
   const rows = await getDb().unsafe(
    `insert into uploaded_files (id, workspace_id, name, size, type, storage_path, content_sha256)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
    [id, workspaceId, String(name), buffer.length, normalizedType, storagePath, sha],
   );
   notifyDbSubscribers('uploaded_files', 'INSERT', rows);
   res.json({ data: rows[0], error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/files/:id/content', requireAuth, async (req, res) => {
  try {
   const rows = await getDb().unsafe('select workspace_id, name, type, storage_path from uploaded_files where id = $1 limit 1', [req.params.id]);
   const file = rows[0];
   if (!file?.storage_path) return jsonError(res, 404, new Error('File content is not stored'));
   await enforceWorkspaceRole(req.userId, file.workspace_id, 'read');
   let fullPath;
   try {
    fullPath = resolveStoragePathForWorkspace(file.workspace_id, file.storage_path);
   } catch (pathError) {
    return jsonError(res, pathError.status || 403, pathError);
   }
   if (!fs.existsSync(fullPath)) return jsonError(res, 404, new Error('File content is missing on disk'));
   // Never let the browser sniff/execute uploaded content as something
   // other than the Content-Type we explicitly set below.
   res.setHeader('X-Content-Type-Options', 'nosniff');
   // Force a download (never `inline`) for anything that can carry script
   // when rendered by a browser. Checked two ways:
   //  - by the ORIGINAL FILENAME's extension, because the upload handler
   //    already neutralizes .html/.svg's stored type to `text/plain`,
   //    which would make a stored-type-only check below a no-op for the
   //    normal upload path;
   //  - by the STORED type value, as a belt-and-suspenders guard against
   //    any other write path (e.g. a generic `/backend/db/uploaded_files`
   //    update — `uploaded_files` is in ALLOWED_TABLES) that could set
   //    `type` to a dangerous value without going through the upload
   //    handler above.
   const mustForceAttachment = FORCE_ATTACHMENT_EXTENSIONS.has(getUploadExtension(file.name))
    || FORCE_ATTACHMENT_CONTENT_TYPES.has(file.type);
   const disposition = mustForceAttachment ? 'attachment' : 'inline';
   // IMPORTANT: the app's own viewer (ChatWindowContent's openUploadedFile)
   // fetches this endpoint and calls response.blob(), then
   // URL.createObjectURL()/window.open() on the blob. The Fetch/Blob APIs
   // take the blob's type from the Content-Type header and completely
   // IGNORE Content-Disposition — so forcing `attachment` alone does not
   // stop that in-app viewer from rendering a stored `text/html`/
   // `image/svg+xml` type as script in the app's own origin. When forcing
   // attachment, the served Content-Type must ALSO be overridden to a
   // safe, non-renderable value, regardless of what's stored.
   const servedType = mustForceAttachment ? 'application/octet-stream' : (file.type || 'application/octet-stream');
   res.setHeader('Content-Type', servedType);
   res.setHeader('Content-Disposition', `${disposition}; filename="${safeFileName(file.name)}"`);
   fs.createReadStream(fullPath).pipe(res);
  } catch (error) {
   jsonError(res, 500, error);
  }
 });

 // Deleting an upload through the generic /backend/db/delete only removes the row,
 // so the blob stayed on the Fly volume forever and the per-workspace quota (a
 // sum(size) over surviving rows) drifted below real disk usage until ENOSPC.
 // This route removes both. The path is resolved BEFORE the row is deleted, since
 // the containment check needs the row's workspace_id and storage_path.
 app.delete('/backend/files/:id', requireAuth, async (req, res) => {
  try {
   const rows = await getDb().unsafe('select id, workspace_id, storage_path from uploaded_files where id = $1 limit 1', [req.params.id]);
   const file = rows[0];
   if (!file) return jsonError(res, 404, new Error('File was not found'));
   await enforceWorkspaceRole(req.userId, file.workspace_id, 'write');
   let fullPath = '';
   if (file.storage_path) {
    try {
     fullPath = resolveStoragePathForWorkspace(file.workspace_id, file.storage_path);
    } catch (pathError) {
     return jsonError(res, pathError.status || 403, pathError);
    }
   }
   const deleted = await getDb().unsafe('delete from uploaded_files where id = $1 returning *', [file.id]);
   if (deleted.length > 0) notifyDbSubscribers('uploaded_files', 'DELETE', deleted);
   // Best effort: the row is already gone, so a missing/undeletable blob must not
   // fail the request — it would just leave the caller unable to retry.
   if (fullPath) {
    try { fs.rmSync(fullPath, { force: true }); } catch { /* blob already gone */ }
   }
   res.json({ data: { id: file.id }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountFilesRoutes };
