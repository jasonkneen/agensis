# media-blossom — Media blob storage (Blossom)

Pack: `media-blossom`, domain `media`, rank 10, priority 40.
Source: `/Users/jkneen/Documents/GitHub/repo-grab/out/extract-pack/media-blossom/`
Stated target surface: "server files-routes + storage backend".
Analysed 2026-07-29 against branch `main-next`, Fly app `agensis-backend` machine
`185d65dc793598`.

---

## 1. Verdict

**Reject the Blossom protocol. Defer content-addressed storage. Adopt a small,
unrelated hardening carve-out that this investigation surfaced.**

Three findings drive this, all verified rather than assumed:

1. **The durability hazard the pack implies is already closed.** Uploads do not
   live on ephemeral container disk. `fly.toml:29` sets
   `AGENSIS_UPLOAD_ROOT = "/data/uploads"` and `fly.toml:31-33` mounts the
   `agensis_uploads` volume at `/data`. `fly volumes list` confirms a 3GB
   encrypted volume `vol_vjymyx3lg0ozm0zv` in `fra`, attached to the single
   running machine. This landed in commit `79faf88` (2026-07-08). There is no
   data-loss-on-deploy problem to solve.

2. **There is no media problem to solve at all right now.**
   `fly ssh console -C "df -h /data"` returns **15.1M used of 2.9G, 1%**. The
   entire product holds about fifteen megabytes of uploads. Dedup, tiering,
   content-addressing and an S3 backend are all optimisations for a data volume
   that does not exist. Building any of them today is speculative work.

3. **Content-addressing is already half-present and deliberately inert.**
   `server/files-routes.cjs:82` already computes a SHA-256 of every upload and
   `:84-88` already stores it in `uploaded_files.content_sha256`
   (`database/neon-schema.sql:444`, `server/index.cjs:1229`). Nothing reads it.
   The valuable half of "content-addressed storage" — having the digest — is
   done; the missing half is worth roughly nothing at 15MB.

The pack's actual proposal — the **Blossom protocol** — is a reject on model
grounds, not on effort grounds. Blossom's premise is that a blob is identified
by its hash and *any server holding that hash will serve it*, with authorisation
carried by a signed Nostr event. agensis is a multi-tenant RBAC product whose
file route is `requireAuth` + `enforceWorkspaceRole(read)`
(`server/files-routes.cjs:96-101`) and whose entire frontend was deliberately
built so that **no URL to file bytes is ever public** — see the header comment at
`src/components/chat/MessageAttachments.tsx:9-13`: *"There is no public URL and no
`<img src>` pointing at the route directly — the route requires an Authorization
header."* A `/blob/<sha256>` endpoint would take that property away. Adopting
Blossom means adopting the one thing this codebase spent a hardening plan
(`plans/002-harden-file-upload-xss.md`) explicitly designing against.

**What I recommend building instead** is Phase 0 below: three cheap correctness
and safety fixes to the *existing* storage path, found while reading it. They are
worth about 2 engineer-days, are independent of this pack's concept, and none of
them require a protocol. Phase 1 (a storage-backend seam) is specified but should
not be built until a named trigger fires.

---

## 2. What the pack actually proposes

`pack.json` is thin — a single anchor, `crates/buzz-media`, whose entire excerpt
is a directory listing (`Cargo.toml`, `src`, `tests`, 231 bytes total). There is
no source, no interface, no schema. `PROMPT.md` restates the one-line
description four times. Everything below the description line is boilerplate
shared across all twelve packs.

The concept, stated fully, is one sentence: *"Dedicated media upload/download
path (Blossom/S3) separate from chat events, with content-addressed or
blob-oriented storage."*

Unpacked, that is four separable ideas:

| Idea | Already true in agensis? |
| --- | --- |
| Media path separate from chat events | **Yes.** `server/files-routes.cjs` is a dedicated route module; `messages.attachments` and `tasks.attachments` store only `{id,name,type,size}` references, never bytes (`server/index.cjs:1204`, `:1247`; `shared/backend-core.cjs:122-127`). |
| Blob-oriented (not row-blob) storage | **Yes.** Bytes go to the filesystem, only metadata to Postgres (`server/files-routes.cjs:80-88`). |
| Content-addressed | **Half.** Digest computed and stored, never used as an address or for dedup. |
| Blossom protocol / interchangeable servers | **No** — and correctly so, see below. |

So three of the four ideas are already shipped. The pack is a capability-gap
report generated from a directory name.

### Where buzz's assumptions do not transfer

- **Nostr identity.** Blossom's upload authorisation is a signed kind-24242
  event; the signer's pubkey is the identity. agensis has no Nostr keys. Its
  identities are `app_users.id` behind an HMAC session token
  (`shared/backend-core.cjs:442-449`) and agent connect-tokens (`aga_…`). There
  is nothing to map a Blossom auth event onto.
- **Interchangeable servers.** Blossom's payoff is that a client can try mirror
  A, then mirror B. agensis runs exactly one backend machine holding exactly one
  volume, and the product is a private workspace tool. There is no second server
  and no user demand for one.
- **Hash as identifier.** In Blossom the hash *is* the URL. In a multi-tenant
  product the hash is a capability — see section 4.
- **Rust crate boundaries.** `crates/buzz-media` being a separate crate says
  nothing about agensis; our equivalent separation already exists as
  `server/files-routes.cjs` + `server/lib/storage-paths.cjs`.

---

## 3. What already exists today (citations)

**Upload** — `server/files-routes.cjs:32-94`
- `requireAuth` + `enforceWorkspaceRole(req.userId, workspaceId, 'write')` (`:38`).
- Client-reported MIME is **ignored**; stored type derived from an extension
  allowlist (`:43-47`, allowlist at `server/lib/storage-paths.cjs:76-110`), with
  `.html`/`.svg` neutralised to `text/plain` at storage time (`:83`, `:105`).
- Pre-decode base64 length guard, then shape validation, then a 25MB decoded cap
  (`:52-67`). Client mirrors the cap at `src/components/files/FileUpload.tsx:39`.
- Per-workspace quota, default 2GB, env `WORKSPACE_STORAGE_QUOTA_BYTES`
  (`:69-77`; documented at `AGENTS.md:375`).
- Path built by `storagePathFor(workspaceId, id, name)` →
  `<workspaceId>/<uuid>-<safeName>` (`server/lib/storage-paths.cjs:32-34`).
- SHA-256 computed and stored (`:82`, `:84-88`).

**Serve** — `server/files-routes.cjs:96-142`
- `requireAuth` + `enforceWorkspaceRole(..., 'read')` (`:101`).
- Double containment: `resolveStoragePathForWorkspace` checks the stored path
  belongs to the row's workspace *and* resolves under the upload root
  (`server/lib/storage-paths.cjs:46-60`).
- `X-Content-Type-Options: nosniff` (`:111`), forced `attachment` by original
  extension **and** by stored type (`:123-124`), and — the subtle one — the
  served `Content-Type` is overridden to `application/octet-stream` when forcing
  attachment, because `response.blob()` ignores `Content-Disposition` (`:126-135`).

**Delete** — `server/files-routes.cjs:149-174`. Removes row and blob together;
the header comment at `:144-148` records why (generic `/backend/db/delete` left
blobs orphaned and drifted the quota below real usage).

**RBAC / column guards** — `shared/backend-core.cjs:257-261` strips
`storage_path`, `content_sha256` and `type` from any generic `/backend/db` write;
pinned by `tests/backend-rbac.test.cjs:122-134`.

**Client authorisation model** — `src/hooks/useAuthenticatedObjectUrl.ts:5-17,
19-60`. Every consumer fetches the route with an `Authorization` header and
renders from a `blob:` URL. Consumers: `MessageAttachments.tsx`,
`FilePanelItems.tsx:230-262`, `CanvasObjectRenderer.tsx:794` and `:891-892`
(canvas image/video/file objects store the route URL as `src` and the renderer
routes it through the authenticated hook — verified, this is not a leak).

**Deploy shape** — one machine, one volume, `min_machines_running = 1`
(`fly.toml:41-44`). The Netlify mirror `netlify/functions/backend.mjs` implements
**no** `/backend/files` routes (it only reads `uploaded_files` for usage stats at
`:1071-1072`), so file serving is Fly-exclusive. `FilePanelItems.tsx:243-244`
already degrades gracefully for that case.

**Absent:** any object-storage client (no `@aws-sdk`, no `minio`, nothing in
`package.json`), any presigned/signed URL, any dedup, any integrity check on
read, any orphan sweep, any MCP tool that uploads or reads a file, and any media
handling in `server/channel-bridges.cjs`.

---

## 4. Authorization: the hazard, answered directly

The brief asks exactly how authorization would work, and rejects "the hash is
unguessable".

**In the design I recommend, authorization does not change at all, because the
hash never becomes an address.** `uploaded_files.id` (a UUID scoped to a
workspace row) stays the only public identifier. `content_sha256` stays an
internal storage-layout and integrity detail, never routable. If Phase 2 is ever
built, the on-disk path becomes `blobs/<sha[0:2]>/<sha>` but the **route** stays
`GET /backend/files/:id/content`, still `requireAuth` + `enforceWorkspaceRole(read)`
on the row's workspace. Two users in different workspaces who upload identical
bytes share one blob on disk and still cannot read each other's row.

This matters concretely: a naive content-addressed rewrite that also exposes
`/blob/<sha>` would make **any workspace's file readable by any authenticated
user who can learn the digest**, and digests leak — they are in
`uploaded_files.content_sha256`, which `select: 'read'` exposes to every
workspace member (`shared/backend-core.cjs:192`, `DEFAULT_TABLE_ACCESS` at
`:180-185`) and which the bootstrap payload already ships to clients
(`server/index.cjs:3271`). A hash-as-URL scheme would turn an already-readable
column into a cross-tenant capability. That alone disqualifies Blossom's
addressing model here.

**If a header-less consumer ever appears** (outbound Telegram/Slack media from
`server/channel-bridges.cjs`, an emailed link, an external embed), the answer is
a short-lived signed URL, not a hash:

- `POST /backend/files/:id/share-url` — `requireAuth`, role `read`. Returns
  `{ url, expires_at }`.
- Signature over `v1.<fileId>.<workspaceId>.<userId>.<expUnix>` using
  `createHmac('sha256', AUTH_SECRET).digest('base64url')`, the same construction
  as `issueAuthToken` (`shared/backend-core.cjs:447-449`), verified with
  `timingSafeEqual` as at `:468-471`.
- TTL 300s, hard-capped server-side. The signature is checked *in addition to*
  re-reading the row's `workspace_id`, so a signed URL for a file that later
  moves workspace stops working.
- Known and accepted gap: a signed URL survives the signer losing workspace
  membership until it expires. The 5-minute TTL is the mitigation; there is no
  revocation list and none should be built for v1.

Do not build this until a consumer exists. Today there is none.

---

## 5. The real problems, in priority order

These came out of reading the code. Only #1–#3 are worth acting on now.

**P0-a — The volume cannot satisfy the quota it advertises.**
Volume is 3GB (`fly volumes list`, 2.9G usable). Default per-workspace quota is
2GB (`server/files-routes.cjs:69`). **Two** workspaces at quota is ENOSPC. There
is no global disk guard anywhere — the quota query at `:70-73` filters
`where workspace_id = $1`. When `/data` fills, `fs.writeFileSync` at `:81` throws
after the row-count guard has already passed, and the failure lands on the same
machine that terminates every browser WebSocket and every agent daemon
connection. Currently at 1% used, so this is a latent trap, not a live incident.

**P0-b — A 25MB upload blocks the event loop.**
`fs.writeFileSync(fullPath, buffer)` (`:81`) is synchronous on the single Node
thread of a `shared-cpu-2x` machine that is also the WebSocket hub
(`server/realtime.cjs`). Before that, `Buffer.from(b64, 'base64')` (`:61`)
materialises up to 25MB while the ~33MB base64 string is still live, inside a
request whose body limit is `express.json({ limit: '50mb' })`
(`server/index.cjs:6989-6990`) on a 2GB machine. There is also **no rate limiter
on the upload route** — `server/files-routes.cjs:32` takes `requireAuth` only,
where `/backend/db/*`, MCP and browser-proxy all have one
(`server/index.cjs:6975`, `:7118`, `:7531`).

**P0-c — Blobs still leak, and the leak inflates the quota's blind spot.**
The dedicated DELETE route (`:149-174`) removes both row and blob, but
`uploaded_files` is `DEFAULT_TABLE_ACCESS` (`shared/backend-core.cjs:192`), so
`delete: 'write'` reaches it through generic `/backend/db/delete` and removes the
row only. Worse, `uploaded_files.workspace_id` is
`REFERENCES workspaces(id) ON DELETE CASCADE`
(`database/neon-schema.sql:439`) — deleting a workspace silently orphans every
one of its blobs forever, with no row left to find them by. Since the quota is
`sum(size)` over *surviving* rows (`server/files-routes.cjs:70-73`), accounted
usage drifts permanently below real disk usage. This is precisely the failure the
`:144-148` comment describes as fixed; it is only fixed for one of three paths.

**P1 — Single volume pins the backend to one machine.**
`fly.toml:26-28` already records this honestly: *"a single volume attaches to ONE
machine — durable but not shared across machines; multi-machine scale-out needs
object storage."* Scaling to two machines today would make file reads succeed or
404 depending on which machine answered. This is a real ceiling but not a current
pain — one machine is running and holding 15MB.

**P2 — No integrity verification on read, no dedup.** Both are cheap-ish and both
are worth roughly nothing at 15MB across the whole product.

---

## 6. Impact on our system

Phase 0 touches `server/files-routes.cjs`, `server/index.cjs` (one route
mount + one env read), `fly.toml` (env only), and adds one backend test file. It
introduces no schema change, no new table, no new route shape, no frontend
change, and no client-visible behaviour change except clearer 413/429 errors.

It must not regress the plan-002 content-type hardening. The invariants that
`tests/fileUploadContentType.test.cjs` pins — spoofed `.html` stored as the
server's own type, forced `attachment` + `application/octet-stream` on serve,
`nosniff`, `.exe` rejected 400, cross-workspace path traversal blocked
(`:388-439`) — all live in code Phase 0 does not move. The one caution: switching
`fs.writeFileSync` to `await fs.promises.writeFile` changes ordering inside the
handler, so the row must still be inserted **after** the write completes, or a
failed write leaves a row pointing at nothing (which is the *safe* direction, but
inconsistent with the current guarantee).

Interaction with in-flight work: `server/channel-bridges.cjs` (telegram, slack,
whatsapp, signal, openclaw — shipped today) has **zero** media handling. Inbound
media from a bridge, or outbound media to one, is the single most likely thing to
create real demand for the deferred phases. That is the trigger to watch.

No interaction with `self-update-supervise` (pack #12), `thread_harvests`, or the
permission-request reconnect work.

RBAC: unchanged. Phase 0 adds no new table and no new column, so
`ALLOWED_TABLES`, `WORKSPACE_SCOPED_TABLES` and `PRIVILEGED_DB_COLUMNS_BY_TABLE`
in `shared/backend-core.cjs` need no edit and the Netlify mirror needs no
matching change — which also means no three-place schema-sync obligation.

---

## 7. Work breakdown — Phase 0 (recommended, ~2 engineer-days)

Ordered so each step is independently shippable and testable.

**Step 1 — Global disk guard + honest quota (vertical slice).**
- `server/files-routes.cjs`: before writing, `fs.statfsSync(getUploadRoot())` and
  reject 507 when `bavail * bsize` minus the incoming buffer would fall below a
  reserve (`AGENSIS_UPLOAD_DISK_RESERVE_BYTES`, default 256MB). This is the guard
  that the per-workspace quota structurally cannot provide.
- `fly.toml` `[env]`: set `WORKSPACE_STORAGE_QUOTA_BYTES = "1073741824"` (1GB) so
  the advertised per-workspace ceiling and the 3GB volume are no longer
  contradictory. Alternative: grow the volume with `fly volumes extend`. Pick one
  — do not ship neither.
- `AGENTS.md:375` documents the quota env; add the new reserve env beside it.

**Step 2 — Async write + upload rate limit.**
- `server/files-routes.cjs:80-81`: `await fs.promises.mkdir(...)` /
  `await fs.promises.writeFile(...)`. Keep the DB insert after the write.
- `server/index.cjs`: pass the existing rate-limiter helpers
  (`rateLimiter`, `rateLimitBlocked`, `clientIpFromReq` — already injected into
  other route modules at `:6975`, `:7118`, `:7531`) into `mountFilesRoutes`, and
  apply a per-user limiter to `POST /backend/files/upload` only. Do not
  rate-limit the GET content route; the Files panel fetches many at once.

**Step 3 — Close the blob leak.**
- `shared/backend-core.cjs`: change `uploaded_files` from `DEFAULT_TABLE_ACCESS`
  to `{ select: 'read', insert: 'write', update: 'write', delete: 'manage' }`.
  This does not remove any user capability — `useFiles.deleteFile`
  (`src/hooks/useFiles.ts:74-83`) already uses the dedicated route exclusively —
  it removes the *generic* path that leaks blobs. Confirm no other caller does a
  generic delete before changing it.
- `server/files-routes.cjs`: new `POST /backend/files/reconcile`, role `manage`,
  workspace-scoped. Lists `<uploadRoot>/<workspaceId>/`, diffs against
  `select storage_path from uploaded_files where workspace_id = $1`, and reports
  `{ orphan_blobs: [...], missing_blobs: [...], orphan_bytes }`. **Reports only by
  default**; deletes only when called with `{ apply: true }`. A destructive sweep
  that runs automatically is how you lose the 15MB you were trying to protect.
- Workspace deletion: the FK cascade is the unfixable half here. Add a note in
  `AGENTS.md` that deleting a workspace orphans its blobs and that reconcile with
  `apply` is the cleanup, or (better, and cheap) have the workspace-delete route
  `fs.rm` the workspace's upload directory before the cascade fires. Choose
  deliberately; do not leave it implicit.

**No frontend work in Phase 0.** No new components, no new types, no
`src/types/index.ts` change.

---

## 8. Work breakdown — Phase 1 (specified, do NOT build yet)

**Trigger to build:** any one of — (a) `/data` crosses 50% used; (b) a second Fly
machine is needed; (c) `server/channel-bridges.cjs` gains inbound media; (d) a
customer needs uploads over 25MB.

**Shape:** a storage-backend seam, not a protocol.

- New `server/lib/blob-store.cjs` exporting
  `{ put(key, buffer), get(key) -> stream, del(key), stat(key) }`, chosen by
  `AGENSIS_BLOB_DRIVER` (`fs` default, `s3` opt-in). The `fs` driver is the
  current code moved behind the interface, keeping
  `resolveStoragePathForWorkspace` as its containment check. The `s3` driver
  targets any S3-compatible endpoint (Cloudflare R2 / Tigris — Fly's own Tigris
  needs no new region).
- `uploaded_files.storage_path` keeps its meaning as an opaque key. No DDL.
- Migration is a copy loop, not a cutover: dual-write behind the flag, backfill
  15MB in one pass, flip reads, keep the fs copy for a week. Fully reversible
  while both copies exist.
- Effort: 3–4 engineer-days including the S3 driver and its tests.

**Phase 2 (content-addressed layout + dedup)** — key becomes
`blobs/<sha[0:2]>/<sha>`, plus a `blob_refs (content_sha256, ref_count)` table so
delete decrements rather than unlinks. Only worth it above roughly 50GB or with
observed duplication. At 15MB the ref-count bookkeeping is strictly more code
than it saves. Do not build. Note the route and the authorization model are
**unchanged** by this — see section 4.

---

## 9. Test plan (Phase 0)

**Runner globs, verified today — get these wrong and the test silently never
runs:**
- Backend: `package.json:15` → `node --test tests/*.test.cjs`. **`.cjs` only.**
  There are zero `tests/*.test.mjs` files and one would not be picked up, despite
  what the brief's shorthand suggests. 106 files match today.
- Frontend: `vitest.config.ts:8` → `include: ['tests/unit/**/*.test.ts']`.
  142 files match today.

**New file: `tests/uploadStorageGuards.test.cjs`** (backend runner). Follow the
existing harness in `tests/fileUploadContentType.test.cjs:29-142` — fake db via
`__test.setTestDb`, real `createApp`, real fs against a temp
`AGENSIS_UPLOAD_ROOT`.

| Invariant | Mutation that must break it |
| --- | --- |
| Upload rejected 507 when free disk minus reserve < payload | Delete the `statfs` check → test fails |
| Upload succeeds when free disk is ample (guard is not a blanket deny) | Hardcode the guard to always reject → test fails |
| Nth upload in a window returns 429 | Remove the limiter wiring → test fails |
| GET content is **not** rate-limited | Apply the limiter to the GET route → test fails |
| Row exists on disk after a successful async write (no row-before-write window) | Move the insert above the `await writeFile` → test fails |
| `reconcile` reports an orphan blob and does **not** delete it without `apply` | Make reconcile delete unconditionally → test fails |
| `reconcile` requires `manage`, 403 for `write` | Downgrade to `write` → test fails |

**Amend `tests/backend-rbac.test.cjs`**: assert
`TABLE_ACCESS.uploaded_files.delete === 'manage'`. Mutation: revert to
`DEFAULT_TABLE_ACCESS` → fails.

**Do not touch `tests/fileUploadContentType.test.cjs`.** It must pass unchanged;
that is the regression proof for plan 002. If it needs editing, the change went
too far.

**On mock-DB vacuity:** the `sum(size)` quota mock at
`tests/fileUploadContentType.test.cjs:78-85` reimplements the SQL, so a quota
test written against it tests the mock. That is exactly why the new disk guard is
tested against **real `statfs` on a real temp dir**, not a mocked figure — the
guard's whole value is that it reads the filesystem the DB cannot see.

---

## 10. Migration and rollout

- **Data migration: none.** Phase 0 adds no column, no table, no backfill. This
  is a deliberate property of the carve-out.
- **Deploy lanes needed** (per `deploy-targets`):
  - `fly deploy` — **yes**, required. All Phase 0 code is `server/*.cjs`, plus a
    `fly.toml` `[env]` change. Check `fly logs` after; a lagging Fly has hidden
    broken server changes here before.
  - Netlify — **no**. Zero files under `src/`.
  - npm publish of `@agensis/agensis-agent` — **no**.
  - Local daemon restart — **no**.
- **Feature flags:** the disk reserve is env-driven
  (`AGENSIS_UPLOAD_DISK_RESERVE_BYTES=0` disables it). The rate limit is
  env-driven. The RBAC change and the async write are not flaggable.
- **Rollback**, concretely: `fly deploy` the previous image. Nothing has been
  written that the old code cannot read — `storage_path` semantics, the on-disk
  layout and the schema are all untouched. The only one-way door is the
  `uploaded_files.delete` capability change, and reverting the deploy reverts it
  since it is code, not data.
- **Staged rollout:** ship Step 1 alone first and watch for spurious 507s for a
  day before Steps 2 and 3.

---

## 11. Risk register

Ranked. Data-loss and security-regression risks named explicitly.

1. **DATA LOSS — an automatic reconcile sweep deletes live blobs.** A path-diff
   bug (case, symlink, encoding) marks a real blob orphaned and unlinks it; the
   row survives and the file is gone with no backup. *Mitigation:* report-only
   default, `apply: true` opt-in, `manage` role, and reuse
   `resolveStoragePathForWorkspace` for every candidate path rather than a fresh
   join. Never schedule it.
2. **DATA LOSS — there is no backup of `/data` in this repo.** No `pg_dump`
   equivalent, no snapshot script, nothing in `scripts/`. Fly takes daily volume
   snapshots by default, but nothing here verifies that or documents restore.
   *Mitigation (do this regardless of the rest of the plan):* confirm
   `fly volumes snapshots list vol_vjymyx3lg0ozm0zv` returns snapshots, and write
   the restore procedure into `AGENTS.md`. This is a 30-minute task with a higher
   value-per-minute than anything else in this document.
3. **SECURITY REGRESSION — the async-write reorder weakens a plan-002 guarantee.**
   Any reshuffle of `server/files-routes.cjs:78-88` risks inserting the row
   before the type normalisation or the containment resolve. *Mitigation:*
   `tests/fileUploadContentType.test.cjs` passes unchanged, treated as a hard
   gate.
4. **SECURITY REGRESSION — a future signed-URL route reintroduces public bytes.**
   Not in Phase 0, but section 4 exists so nobody re-derives it wrongly later.
   *Mitigation:* the design is written down with a 5-minute TTL and a mandatory
   row re-read; anything hash-addressed is out of bounds.
5. **Availability — the disk guard rejects legitimate uploads.** A wrong reserve
   or a `statfs` failure on some filesystem breaks all uploads. *Mitigation:*
   treat a `statfs` throw as "allow", not "deny"; env-tunable; ship alone first.
6. **Capability regression — moving `uploaded_files.delete` to `manage` breaks an
   unknown caller.** *Mitigation:* grep every `.from('uploaded_files')` and
   `/backend/db/delete` call site before the change; I found only
   `src/hooks/useFiles.ts:74-83`, which uses the dedicated route.
7. **Scope creep back into Phase 1/2.** The pack's framing invites building S3
   and dedup "while you're in there" for 15MB of data. *Mitigation:* the named
   triggers in section 8.

### Effort

- **Phase 0: 2 engineer-days**, confidence **high**. Small, local, no schema, one
  new test file, one deploy lane.
- Backup verification (risk 2): **0.5 day**, confidence high. Recommend doing
  this first.
- Phase 1 (blob-store seam + S3 driver + dual-write migration): **3–4 days**,
  confidence medium. Do not start.
- Phase 2 (content-addressed layout + refcounts): **3 days**, confidence low. Do
  not start.

**Biggest unknown:** whether anyone actually intends to scale past one Fly
machine. Everything in Phase 1 is justified by that and nothing else. If the
answer is "no, one machine is the plan", Phase 1 should be closed rather than
deferred, and this pack reduces to Phase 0 plus a backup check.

### Deliberately NOT building in v1

- The Blossom protocol, kind-24242 auth events, mirror/discovery, or any
  Nostr-shaped interop.
- Any `/blob/<sha256>` route, or any route where the digest is the address.
- Any public or unauthenticated URL to file bytes.
- Content-addressed on-disk layout, dedup, and blob refcounting.
- S3/R2 driver, presigned uploads, multipart, and the `@aws-sdk` dependency.
- Chunked/streaming upload replacing the base64 JSON body, and raising the 25MB
  cap.
- Image transcoding, thumbnailing, EXIF stripping, or virus scanning.
- Signed share URLs (designed in section 4, built when a consumer exists).
- Inbound/outbound media for `server/channel-bridges.cjs`.
- Any MCP tool that uploads or downloads a file.
- Serving files from the Netlify function lane.

---

## 12. Honest gaps

- I did not read `crates/buzz-media`'s source; the pack does not contain it and
  the brief forbids copying from it. My reading of Blossom is from the concept
  description plus the protocol's public design, not from buzz's implementation.
  If buzz's crate does something materially different from the Blossom spec, this
  analysis would not know.
- I did not query Postgres for the `uploaded_files` row count or the size
  distribution; the 15.1MB `df` figure is the ground truth I used and it is
  sufficient to settle the "is there a problem" question.
- I did not verify whether Fly volume snapshots are actually being taken for
  `vol_vjymyx3lg0ozm0zv` — that is risk 2 and it needs one command I did not run.
- No code was written, no tests were run, nothing was committed.
