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

## Recent cross-cutting features (2026-07)

- **Sessions scoped to a project (canvas layer)** — `chat_sessions.canvas_id`
  (nullable text, mirrors `canvas_objects.layer_id`; **null = unassigned, shown
  in every project**). New channels stamp the active `activeLayerId`; splits
  inherit the parent's. DMs stay global (null). The sidebar filters **channels +
  threads** by `activeCanvasId` but keeps DMs/archive global. The bootstrap
  sessions select (`server/index.cjs`) lists columns explicitly — add new
  session columns there or they load blank.
- **Silo (daemon agent) host folders** — stored on
  `workspace_agents.metadata.host_folders` (no schema change; `metadata` jsonb
  already exists). Edited per-agent in the Agents window (daemon agents only).
  Dispatch forwards them via `agentRuntimePayload`; the daemon
  (`buildAgentCommand`) injects `--add-dir <path>` per folder for Claude, and a
  repeatable `--host-folder` CLI flag persists in the connect profile. **The
  bootstrap + `/agents` selects and `sanitizeRealtimeRow` now include
  `metadata`** — needed so host_folders survive a realtime update.
- **Sandbox Agent + provider skills** — sandboxes are no longer a server feature.
  The `sandbox` agent template (`src/lib/agentTemplates.ts`, `runMode: 'daemon'`)
  is a provisioner, and a provider is a **skill**: `workspace_agents.skills` holds
  skill **ids** (it stays `string[]` — the Agents window round-trips it through a
  comma-separated input, so an object in there is destroyed by the next edit), and
  `server/sandbox-skills.cjs` resolves them against bundled definitions plus
  per-agent ones in `workspace_agents.metadata.sandbox_skills` (the same no-DDL
  route `metadata.host_folders` took). **Adding a provider is one jsonb write — no
  migration, no `fly deploy`, no daemon release.** The resolved layer is rendered
  into the prompt in all THREE lanes (builtin system prompt + both
  `buildDaemonPrompt` call sites) and deliberately NOT into `agentRuntimePayload`,
  which the browser edit form saves back. Provider API keys live in the workspace
  vault under `sandbox:<provider>:<key>`, write-only via
  `/backend/workspaces/:id/sandbox-credentials` (manage role, Fly-only): no route
  returns one, not even masked, and the per-turn path only reads whether the
  cipher column is non-empty. A requester asks through the normal doors —
  `@sandbox spin up a node sandbox` in a channel, or the existing `dispatch_agent`
  MCP tool; there is no sandbox-specific tool.
- **Inference gateways** — `gateway_configs` table (workspace-scoped; API key
  stored AES-256-GCM-encrypted in `api_key_cipher` via the workspace vault, NEVER
  returned to the client — only `has_key`). Managed in Settings → AI. Selecting a
  `gateway:<id>` model in chat routes that turn through `/backend/ai-chat`'s
  gateway branch, which streams the external OpenAI-compatible endpoint's SSE
  straight through. NOT in the backendClient allowlists — reached only via the
  dedicated `/backend/workspaces/:id/gateways` routes (Fly server only).

## Tests (two runners)

- `npm test` — Node's built-in runner over `tests/*.test.cjs` (backend/integration,
  mock DBs). 334 tests. Note the glob is **top-level only** — a `.test.cjs` in a
  subdirectory is never run (`visual-editor/test/` is invisible to both runners).
- `npm run test:unit` — Vitest over `tests/unit/**/*.test.ts` (frontend/pure). 205.
- Keep both green. `tests/cursorbuddy-manifest.test.cjs` asserts guided-tour
  selectors exist in source — if you remove/rename a selector it references,
  update the tour JSON (`public/.well-known/cursorbuddy.json`) + that test.
- `npm run lint` is now clean and exits 0. The 6 previously-documented
  `_`-prefixed unused-var errors are fixed by an `argsIgnorePattern: '^_'` rule
  on the backend block in `eslint.config.js`. **A red lint is now a real
  regression — don't wave it through.**
- `tests/lint-coverage.test.cjs` asserts that every security-critical backend
  file is actually matched by an eslint config block. It exists because
  `shared/backend-core.cjs` — auth, RBAC allowlists, both rate limiters — had
  **zero rules applied** for months: the config globbed `shared/**/*.mjs` and the
  file is `.cjs`. eslint reports nothing for a file it doesn't match, so "green"
  and "never looked" are indistinguishable unless you ask. If you add a backend
  entry point, add it to `MUST_BE_LINTED` in that test.
- Onboarding testing: `npm run reset:test-account` wipes `testing@bouncingfish.com`
  (user + all their workspaces) so the onboarding tour can be re-run from scratch;
  also clear the `agensis_tour_complete` / `agensis_getstarted_*` localStorage keys
  (or use incognito) — onboarding state is client-side only.

## Release notes (user-visible changes)

`public/release-notes.json` is **hand-maintained** — nothing generates it. It feeds
the "A new version is available" panel, so if you ship a user-visible change and
don't add an entry, users are shown stale notes for a build that no longer exists
(this went six days and a dozen deploys unnoticed). Newest entry first; keep the
language plain and user-facing — what changed for them, not the commit subject.
`tests/release-notes.test.cjs` only guards the file's shape and ordering; it cannot
tell that you forgot to write one.

## Verify before you ship (every change)

```bash
npm run ci                   # typecheck + both suites + lint, in that order
node --check server/index.cjs                # if you touched the server
node --check netlify/functions/backend.mjs   # if you touched netlify
npm run build                                # if you touched the frontend
```

`npm run ci` is the single gate. Run it locally — **do not infer "tests passed"
from GitHub Actions.** Actions is not currently a working gate on this repo: runs
finish in seconds with zero steps executed, which means no runner is being
assigned (an Actions minutes / spending-limit problem, not a workflow bug).
Confirm with `gh run view <id> --json jobs` — `steps: []` is the signature.

### Optional pre-push hook

`.githooks/pre-push` runs typecheck + both suites before a push. Enable it with:

```bash
npm run hooks:install        # git config core.hooksPath .githooks
```

**If you are an automated pusher, you must set `AGENSIS_SKIP_HOOKS=1`** for WIP
checkpoint pushes — a red hook would otherwise wedge an unattended loop with
nobody watching. Do NOT set it when merging to main. Humans can use
`git push --no-verify` for a one-off. `core.hooksPath` is repo-level config, so
enabling it affects every worktree including the shared checkout.

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
| `CARTESIA_API_KEY` | ✓ | ✓ | Huddle text-to-speech (sonic-3.5). **Never sent to the browser** — exchanged for a 120s `tts`-only access token by `/voice/tts-token`. Unset ⇒ huddles fall back to `speechSynthesis` and say so |
| `DEEPGRAM_API_KEY` | — | ✓ | Huddle speech-to-text (Flux). **Never sent to the browser** — the Fly server relays the audio itself over `/backend/ws`, so this key is useless on Netlify (no websockets). Unset ⇒ fallback to `SpeechRecognition` |


## Agent daemon (separate open-source repository)

The host-side daemon is deliberately outside this closed app/backend repo. Its
source, tests, release workflow, and published bundle live at
`../agensis-agent` locally and
[`jasonkneen/agensis-agent`](https://github.com/jasonkneen/agensis-agent).
The npm package remains `@agensis/agensis-agent`; changes to the server/daemon
wire contract must be coordinated across both repositories.

## Conventions

- Match the surrounding file's style: 2-space indent, its semicolon convention,
  `cn()` for class merging, shadcn/ui primitives already imported in the file.
- No new npm dependencies without a strong reason. Drag-and-drop is native HTML5
  (`draggable` + `onDragStart/onDragOver/onDrop`) or pointer events — see
  `src/components/windows/ThreadWidgetRail.tsx` and `TasksWindowContent.tsx`.
- The root package is the closed Agensis app. Do not copy app, backend, database,
  or deployment code into the public daemon repository.
- User-facing rich text is sanitized through `src/lib/sanitize.ts` (DOMPurify) at
  every render/paste boundary.
