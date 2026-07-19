# AGENTS.md

Operational guide for AI agents working in this repo. Complements `README.md`
(which covers product + local setup) with the non-obvious conventions you must
follow to avoid breaking things. Read this before editing.

## Architecture in one breath

- **Frontend**: React 19 + TypeScript + Vite, deployed to **Netlify**.
- **Two backends over ONE Neon Postgres DB**:
  - `server/index.cjs` — the long-running Node/Express/**WebSocket** server. Owns
    realtime (`/backend/ws`), agent daemon orchestration, and the runtime schema
    bootstrap (`ensureRuntimeSchema`). Deployed to **Fly** (`fly deploy`).
  - `netlify/functions/backend.mjs` — the serverless HTTP mirror. Same DB, same
    routes, **no WebSockets**, **no independent DDL**.
  - `shared/backend-core.cjs` — logic both backends import (auth, RBAC table
    access, rate limiters, param binding). Put shared helpers here, not in one
    backend.
- Frontend talks to the backend through `src/lib/backendClient.ts` (a
  Supabase-shaped query builder: `.from(table).select/insert/update/delete/eq`).
  The builder supports `eq`/`not` filters only — no `in`, no `lt`/`gt`.

## Schema changes: update THREE places (the #1 footgun)

A schema change is only correct when all three agree, or a fresh DB drifts:

1. **Runtime bootstrap** — `server/index.cjs` `ensureRuntimeSchema`: idempotent
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.
2. **Canonical schema** — `database/neon-schema.sql` (what `npm run db:neon:push`
   applies to a fresh Neon DB).
3. **Migration** — a new `supabase/migrations/<UTC-timestamp>_name.sql`.

If a column is workspace-scoped, also confirm the table is in the access
allowlists in `shared/backend-core.cjs` (`ALLOWED_TABLES`,
`WORKSPACE_SCOPED_TABLES`, `DB_TABLE_ACCESS`). Array columns (e.g. `uuid[]`) need
`ARRAY_COLUMNS_BY_TABLE` + the `toPgArrayLiteral` bind path in BOTH backends —
postgres.js will not array-serialize a raw JS array bound via `.unsafe`.

## Realtime

Clients receive live updates via `notifyDbSubscribers(table, eventType, rows)` in
`server/index.cjs`, which fans DB-change events to subscribed WebSocket clients.
Streaming agent output works by inserting a `Thinking …` placeholder message,
then `UPDATE`-ing its content (each update broadcasts). Heavy fields are stripped
from the fanout by `sanitizeRealtimeRow` — add to it, don't broadcast large bodies.

## Tests (two runners)

- `npm test` — Node's built-in runner over `tests/*.test.cjs` (backend/integration,
  mock DBs). ~363 tests.
- `npm run test:unit` — Vitest over `tests/unit/**/*.test.ts` (frontend/pure). ~207.
- Keep both green. `tests/cursorbuddy-manifest.test.cjs` asserts guided-tour
  selectors exist in source — if you remove/rename a selector it references,
  update the tour JSON (`public/.well-known/cursorbuddy.json`) + that test.
- Known: `npm run lint` has ~6 PRE-EXISTING errors in `server/index.cjs`
  (`_`-prefixed unused vars). Don't claim a clean lint run; verify your own files.

## Verify before you ship (every change)

```bash
npm run typecheck            # tsc, must be 0
node --check server/index.cjs        # if you touched the server
node --check netlify/functions/backend.mjs   # if you touched netlify
npm test && npm run test:unit
npm run build
```

## Deploy targets

- **Frontend / netlify routes** → `netlify deploy --build --prod`.
- **WebSocket server / daemon orchestration** (`server/index.cjs`) → `fly deploy`.
- A change to `server/index.cjs` needs **Fly**; a frontend-only change needs
  **Netlify**; a change touching both (e.g. a shared-core edit) needs both.
- After deploying, confirm `git rev-parse HEAD` matches the pushed `main`.

## Deploy environment variables (split Netlify + Fly)

The static frontend + serverless HTTP routes run on **Netlify**; the long-running
WebSocket/daemon backend (`server/index.cjs`) runs on **Fly**. Both point at the
**same Neon DB**. The HMAC token secret MUST match across hosts or Netlify-signed
tokens fail to verify on Fly.

Local dev reads a `.env` (see README). For the deployed split:

| Var | Netlify | Fly (server) | Purpose |
|---|:--:|:--:|---|
| `DATABASE_URL` (or `NETLIFY_DATABASE_URL`) | ✓ | ✓ | Neon connection — same DB on both |
| `AUTH_SECRET` (a.k.a. `AGENSIS_AUTH_SECRET`) | ✓ | ✓ | **Must be identical** — HMAC session-token secret. Fly fails closed in prod without it |
| `ANTHROPIC_API_KEY` | ✓ | ✓ | AI chat / built-in agents (per-workspace key overrides it if set) |
| `AGENSIS_DAEMON_BASE_URL` | ✓ | — | Netlify → the Fly backend's public URL, so generated `agensis connect` commands + farm enrolment point at the WS host, not Netlify (which has no WS) |
| `COMMIT_REF` | ✓ (build) | — | Netlify sets this automatically; baked into `__BUILD_ID__` + `version.json` for the update check |
| `SECRETS_ENCRYPTION_KEY` | — | ✓ | Dedicated key for the per-workspace secret vault (else derived from `AUTH_SECRET`) |
| `WORKSPACE_STORAGE_QUOTA_BYTES` | — | ✓ | Per-workspace upload quota (default 2 GB) |
| `AGENSIS_CAPABILITIES_TTL_MS` | — | ✓ | TTL for the `/system/capabilities` cache (default 30 s) |
| `AGENSIS_RUNTIME_SCHEMA` | — | ✓ | Set `false` to disable runtime DDL bootstrap (migrations become the sole schema source) |
| `AGENSIS_PUBLIC_URL` / `AGENSIS_APP_URL` | — | ✓ | Public origin for links the server emits |
| `NETLIFY_WEBHOOK_JWS_SECRET` | — | ✓ | Verifies Netlify deploy webhooks that trigger the update banner |
| `AGENSIS_DEFAULT_AI_MODEL` | — | ✓ | Override the default model (`claude-opus-4-8`) |


## The agent daemon package (third deployable surface)

Besides Netlify (frontend) and Fly (server), there's a **third artifact**: the
daemon users run on their own hosts to connect a coding CLI as an agent.

- **Source of truth**: `agent/agensis-cli/src/*.mjs` (readable). `bin/agensis.mjs`
  there imports from `src/`.
- **Published package**: `@agensis/agensis-agent` — a single minified bundle at
  `agent/agensis-agent/bin/agensis.mjs`, built from the CLI source by
  `agent/agensis-agent/build.mjs` (esbuild). Run `npm run build` in
  `agent/agensis-agent` after editing the CLI source; the `prepack` script also
  runs it on `npm pack`/`publish`. The build stamps `pkg.version` over the
  `AGENSIS_CLI_VERSION` token, so bump **all** of: both `package.json`s, the CLI
  lockfile, the root lockfile's `agent/agensis-cli` entry, the
  `AGENSIS_CLI_VERSION` constant, and `build.mjs`'s `SOURCE_VERSION`.

### Sandbox / container hosts (zero-setup skip-permissions)

Claude Code refuses `--dangerously-skip-permissions` as root/sudo unless
`IS_SANDBOX=1`. Agents on containerized remote hosts run as root, so
`buildAgentCommand` + `isTrustedSandboxHost()` (in `agent/agensis-cli/src/agensis.mjs`)
auto-detect a container (`/.dockerenv`, `/run/.containerenv`, `/proc/1/cgroup`
markers, or explicit `AGENSIS_SANDBOX_HOST=1`) and keep the flag; `runCli`
(`cli.mjs`) then sets `IS_SANDBOX=1` on the Claude child **only when root + the
flag is present**. Bare-metal root drops the flag instead of hard-failing.
Opt out of container auto-detect with `AGENSIS_NO_SANDBOX_AUTODETECT=1`.
`run_mode: 'sandbox'` (e2b) always keeps the flag and sets `IS_SANDBOX=1` in the
VM exec.

### Releasing the daemon

The repo is **private**, so neither delivery path is zero-auth:

- **npm (preferred)**: add a repo secret `NPM_TOKEN` (npm automation token,
  publish rights to `@agensis`), then push a matching tag — `git tag
  agent-v0.1.23 && git push origin agent-v0.1.23` — and
  `.github/workflows/publish-agent.yml` builds + version-guards + publishes.
  Hosts then `npm i -g @agensis/agensis-agent@latest`. **Without `NPM_TOKEN` the
  publish job fails** (the rest of the tag/release still succeeds).
- **GitHub Release tarball**: the same tag has a Release with the `.tgz`
  attached, but a **private-repo asset URL needs auth** — install with
  `gh release download agent-v0.1.23 --repo jasonkneen/open-hatch --dir /tmp &&
  npm i -g /tmp/agensis-agensis-agent-0.1.23.tgz` (host needs `gh` auth or
  `GH_TOKEN`), or `scp` the tarball from a checkout. Restart the daemon after.

## Conventions

- Match the surrounding file's style: 2-space indent, its semicolon convention,
  `cn()` for class merging, shadcn/ui primitives already imported in the file.
- No new npm dependencies without a strong reason. Drag-and-drop is native HTML5
  (`draggable` + `onDragStart/onDragOver/onDrop`) or pointer events — see
  `src/components/windows/ThreadWidgetRail.tsx` and `TasksWindowContent.tsx`.
- The releasable CLI is `agent/agensis-cli` (a `file:` dep of the root). The root
  package is the app.
- User-facing rich text is sanitized through `src/lib/sanitize.ts` (DOMPurify) at
  every render/paste boundary.
