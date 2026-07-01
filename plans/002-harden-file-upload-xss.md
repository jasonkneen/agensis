# Plan 002: Close the stored-XSS-to-account-takeover path in file upload/serving

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2e41d3..HEAD -- server/index.cjs src/components/files/FileUpload.tsx src/components/windows/ChatWindowContent.tsx`
> If any of these files changed since this plan was written, re-read the "Current state" excerpts
> below against the live file before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

Any workspace member with **write** access (the "editor" role, not just owners) can upload an
`.html` or `.svg` file. When any teammate — including a workspace owner — opens that file from the
Files panel or a chat attachment, it renders with `Content-Type` taken verbatim from what the
uploader claimed, served `Content-Disposition: inline`, with no CSP anywhere in the app. The
viewer's client code fetches the file, wraps it in a `blob:` URL, and opens it with
`window.open()` — a `blob:` URL runs in the app's own origin. That means attacker-controlled
JavaScript executes with full access to the app's `localStorage`, which holds a session token that
(per a separate, already-flagged finding) never expires. This is a privilege-escalation path: a
low-trust "editor" collaborator can compromise any account — including an owner's — that merely
previews the file. The gap is already self-documented in the client code (see excerpt below) as a
known, deliberately-deferred handoff to the server side; this plan is that handoff.

## Current state

**`server/index.cjs:3648-3677`** — the upload handler stores the client-supplied `type` with no
validation:

```js
app.post('/backend/files/upload', requireAuth, async (req, res) => {
  try {
    const { workspace_id: workspaceId, name, type, contentBase64 } = req.body || {};
    if (!workspaceId || !name || typeof contentBase64 !== 'string') {
      return jsonError(res, 400, new Error('workspace_id, name, and contentBase64 are required'));
    }
    await enforceWorkspaceRole(req.userId, workspaceId, 'write');
    const id = crypto.randomUUID();
    const buffer = Buffer.from(contentBase64, 'base64');
    const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB; matches the client FileUpload cap
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return jsonError(res, 413, new Error('File exceeds the 25MB upload limit'));
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
      [id, workspaceId, String(name), buffer.length, String(type || ''), storagePath, sha],
    );
    notifyDbSubscribers('uploaded_files', 'INSERT', rows);
    res.json({ data: rows[0], error: null });
  } catch (error) {
    jsonError(res, error.status || 500, error);
  }
});
```

**`server/index.cjs:3679-3693`** — the content-serving route echoes that stored, attacker-controlled
type and forces inline rendering:

```js
app.get('/backend/files/:id/content', requireAuth, async (req, res) => {
  try {
    const rows = await getDb().unsafe('select workspace_id, name, type, storage_path from uploaded_files where id = $1 limit 1', [req.params.id]);
    const file = rows[0];
    if (!file?.storage_path) return jsonError(res, 404, new Error('File content is not stored'));
    await enforceWorkspaceRole(req.userId, file.workspace_id, 'read');
    const fullPath = resolveStoragePath(file.storage_path);
    if (!fs.existsSync(fullPath)) return jsonError(res, 404, new Error('File content is missing on disk'));
    res.setHeader('Content-Type', file.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${safeFileName(file.name)}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (error) {
    jsonError(res, 500, error);
  }
});
```

**`src/components/files/FileUpload.tsx:32-80`** — the client already has an extension→MIME
allowlist (including `html: ['text/html']` and `svg: ['image/svg+xml']`) and an explicit
self-documenting handoff comment:

```js
// --- Client-side upload validation -----------------------------------------
//
// SECURITY NOTE: this is a client-side guard for UX and casual misuse only and
// is trivially bypassable. The SERVER-SIDE upload handler MUST independently
// enforce the same MIME allowlist and size caps (and ideally sniff content),
// since browser-reported `file.type` is untrusted and easily spoofed. That
// back-end enforcement is owned by another track — this note is the handoff.
```

**`src/components/windows/ChatWindowContent.tsx:1831-1840`** — the viewer, which is what actually
triggers execution:

```js
const openUploadedFile = async (file: UploadedFile) => {
  const response = await fetch(apiUrl(`/backend/files/${encodeURIComponent(file.id)}/content`), {
    headers: apiAuthHeaders(),
  });
  if (!response.ok) return;
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  window.open(objectUrl, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
};
```

**`src/lib/backendClient.ts:10`** — the session token lives at `localStorage` key
`agensis_local_session`, readable by any script executing in the app's origin.

There is no Content-Security-Policy or `X-Content-Type-Options` header set anywhere in the repo
(`index.html`, `vite.config.ts`, `server/index.cjs`, `netlify/functions/backend.mjs` — confirmed by
grep at planning time).

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Typecheck        | `npm run typecheck`               | exit 0, no errors                |
| Lint             | `npm run lint`                    | 0 errors (warnings unchanged)     |
| Node test suite  | `npm test`                        | all pass (baseline 119)          |
| Vitest suite     | `npm run test:unit`               | all pass (baseline 46)           |

## Suggested executor toolkit

- Existing pattern to match: `src/lib/sanitize.ts`'s `ALLOWED_URI_REGEXP` shows the repo's existing
  style for allowlist-based validation (deny-by-default, explicit allowed set). Match that spirit
  for the server-side MIME allowlist rather than a denylist of "dangerous" types.
- `src/components/files/FileUpload.tsx`'s `ALLOWED_EXTENSIONS` map is the client-side source of
  truth to port server-side — do not invent a different list; keep client and server in sync.

## Scope

**In scope** (the only files you should modify):
- `server/index.cjs` (`/backend/files/upload` and `/backend/files/:id/content` handlers)
- `netlify/functions/backend.mjs` (its equivalent upload/serve routes, if present — check for a
  parallel implementation the same way `server/index.cjs`'s security logic is parallel to
  `shared/backend-core.mjs`; if Netlify has its own file-upload route, it needs the identical fix)
- `shared/backend-core.mjs` (if you choose to single-source the MIME allowlist here so both
  backends import one copy — recommended, but not required if time-boxed; note the drift risk in
  Maintenance notes either way)
- `tests/` — add a new test file for this behavior (see Test plan)

**Out of scope** (do NOT touch, even though they look related):
- `src/components/files/FileUpload.tsx`'s client-side allowlist — it is correct as UX-layer
  filtering and explicitly documented as such; do not remove `html`/`svg` from it unless you also
  decide server-side to permanently reject those types (see Step 1's decision point).
- The auth-token-never-expires issue (`server/index.cjs:217-235`) — tracked as a separate plan;
  do not attempt to fix token expiry as part of this plan.
- `electron/main.cjs`'s `setWindowOpenHandler` — a related but separate, optional hardening item
  (see Maintenance notes); not required for this plan's done criteria.
- Any change to the 25MB upload size cap — already correctly enforced, not part of this finding.

## Steps

### Step 1: Decide and implement the server-side content-type policy

Two files can carry executable content when rendered inline in a browser: `.html` (any script tag)
and `.svg` (can embed `<script>` or event-handler attributes). Pick **one** of these two approaches
— do not do a partial mix:

- **(Recommended) Reject-and-neutralize**: keep accepting `.html`/`.svg` uploads (matching the
  client's advertised feature set), but never serve them as their native type. Force
  `Content-Type: text/plain` (or `application/octet-stream`) and `Content-Disposition: attachment`
  for these two extensions specifically, so the browser always downloads rather than renders them.
- **(Alternative, larger effort)** Sanitize SVG content server-side (strip `<script>`/event
  handlers, e.g. reusing the same allowlist approach as `src/lib/sanitize.ts`'s DOMPurify usage)
  and continue serving HTML only as `attachment`. Only pick this if inline SVG preview is a
  required product feature — check with the person who requested this plan before choosing this
  path, since it's more code and a wider attack surface to get right.

Implement in `server/index.cjs`'s `/backend/files/upload` handler (~line 3648): compute the
extension from `name`, look it up in a **server-side allowlist mirroring
`FileUpload.tsx`'s `ALLOWED_EXTENSIONS`**, and store a *normalized* type derived from that
allowlist — not the raw client-supplied `type` string. If the extension isn't in the allowlist,
reject the upload with a 400 (matching the client's existing intent; don't silently accept
unknown types).

**Verify**: after the change, uploading a file whose `name` ends in `.html` but whose claimed
`type` is `image/png` gets stored with the type your server-side allowlist assigns to `.html`
(text/plain per the recommended approach), not `image/png` and not the client's claim.

### Step 2: Force safe serving for anything that can carry script

In `/backend/files/:id/content` (~line 3679), regardless of what's stored in `uploaded_files.type`:
add `res.setHeader('X-Content-Type-Options', 'nosniff')` unconditionally, and force
`Content-Disposition: attachment` (instead of `inline`) whenever the stored type is
`text/html`, `image/svg+xml`, `application/xhtml+xml`, or `text/xml` (belt-and-suspenders even if
Step 1 already neutralizes the stored type — defends against any future upload path that bypasses
Step 1).

**Verify**: fetching `/backend/files/:id/content` for a `.html`-named upload returns
`Content-Disposition: attachment; filename="..."` and `X-Content-Type-Options: nosniff`.

### Step 3: Confirm the Netlify backend has no parallel gap (informational, likely a no-op)

Checked at planning time: `netlify/functions/backend.mjs` references `uploaded_files` only as an
entry in its generic `ALLOWED_TABLES`/`VERSIONED_TABLES` sets (lines 39-58, 60-73) for the generic
`/backend/db/*` CRUD routes — there is **no** dedicated `/backend/files/upload` or
`/backend/files/:id/content` route in the Netlify path; actual file bytes are stored on local disk
and served only by the Express backend (`server/index.cjs`), consistent with the README's
description of file storage living on the self-hosted/Fly backend, not the serverless function.
Re-confirm this hasn't changed (`grep -n "backend/files\|createReadStream\|Content-Disposition" netlify/functions/backend.mjs`)
— if it still returns nothing route-shaped, no Netlify-side change is needed and you can skip
straight to the Test plan. If that grep now finds a real upload/serve route, stop and report back:
that's a codebase change since this plan was written, not something to guess a fix for.

**Verify**: the grep above returns no route handler (only the two `ALLOWED_TABLES`/
`VERSIONED_TABLES` set-membership entries, which are unrelated to content-serving and need no
change).

## Test plan

Add `tests/unit/fileUploadContentType.test.ts` (vitest, following the pattern in
`tests/unit/sanitize.test.ts` for structure) or a `tests/*.test.cjs` file (node:test, following
`tests/backend-rbac.test.cjs`'s pattern of calling the real handler with a mock DB) — whichever
matches where you implemented the logic. Cover:

- Uploading a file named `payload.html` with a spoofed `type: 'image/png'` results in a stored
  type from the server-side allowlist, not the spoofed value.
- Fetching the content of an `.html`-named upload returns `Content-Disposition: attachment` (not
  `inline`) and `X-Content-Type-Options: nosniff`.
- A legitimate `.png` upload is unaffected — still served `inline` with `Content-Type: image/png`
  (confirm you haven't over-broadly forced `attachment` for safe types).
- An upload with an extension outside both the client and server allowlists (e.g. `.exe`) is
  rejected with 400 by the server, independent of what the client already blocks.

Verification: `npm run test:unit` (or `npm test` if you added a `.cjs` suite) → all pass, including
the new tests, with no regressions in the existing 46/119 baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` and `npm run test:unit` exit 0, including new tests for this fix
- [ ] Uploading a `.html` or `.svg` file and then fetching its content returns
      `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, verified by the new
      test (not just by inspection)
- [ ] A `.png`/`.pdf`/other already-supported type is unaffected (still `inline`, correct
      `Content-Type`) — verified by test
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `server/index.cjs:3648-3693` doesn't match the excerpts above (drift since planning).
- Netlify's `backend.mjs` has a file-upload route with a materially different shape than the
  Express one (e.g. streams to object storage instead of local disk) — the fix needs to be adapted,
  not copy-pasted; if the shape is different enough that you're not confident the fix translates,
  stop and describe the difference rather than guessing.
- Forcing `attachment` for `.html`/`.svg` breaks an existing test that asserts `inline` behavior for
  those types specifically (would indicate a legitimate inline-HTML/SVG use case this plan didn't
  account for — confirm with the plan owner before overriding).

## Maintenance notes

- This plan does **not** address the auth-token-never-expires issue (tracked separately) — closing
  this XSS path reduces the *likelihood* of token theft but the *impact* of any future token leak
  (from this or any other vector) remains "permanent account access" until that separate plan lands.
- Optional, cheap, additional hardening (not required for done criteria): `electron/main.cjs`'s
  `setWindowOpenHandler` currently only redirects `http://`/`https://` URLs externally and
  **allows** everything else (including `blob:`) to open as a same-origin Electron window. Flipping
  its default to `{ action: 'deny' }` for any non-http(s) URL would mean that even if a payload like
  this got past future upload-handler changes, opening it inside the packaged Electron app wouldn't
  render it in the app's own security context. Consider as a fast follow, not blocking this plan.
- If SVG inline preview turns out to be a real product requirement later, revisit with the
  sanitize-server-side-content approach (Step 1's alternative) rather than reverting to trusting the
  client's claimed type.
