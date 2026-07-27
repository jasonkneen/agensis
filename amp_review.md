# Code review — Tenants admin (24b618e) + Agent identity (06f593d)

Reviewed 2026-07-26. Working tree was clean; this covers the two features just
merged to main: **Tenants admin** (24b618e) and **Agent identity/voice**
(06f593d). HEAD also contains 3c86d55 ("Huddle voice on Deepgram and
Cartesia"), which supersedes one finding below — that commit was **not**
deep-reviewed.

---

## Tenants admin (24b618e) — solid gate, two real gaps

### What's right

- List/detail routes on both backends auth first, then call the shared
  `assertSystemOwner` (`shared/tenant-admin.cjs`).
- The caller's email comes from `app_users` by authenticated userId with a
  bound param — never from the request.
- Unset / empty / whitespace `AGENSIS_SYSTEM_OWNER_EMAIL` fails closed.
- Plus-addressing, prefix, suffix, and similar-domain near-misses are refused.
- `safeSelectColumns` plus explicit projections: no path found for
  `password_hash`, `token_version`, or ciphertext to reach a response.
- The 403 is just "Not available" — no oracle for the operator's address.
- Nothing added to the backendClient allowlists; no DDL in Netlify.
- Frontend renders names/emails as plain React text — no XSS sink.

### Findings, ranked

1. **Major — the owner email can be squatted via public signup.**
   Authority derives from the email on the row, but signup
   (`server/index.cjs` ~L10482, `netlify/functions/backend.mjs` ~L1614)
   doesn't verify mailbox ownership. If the configured owner account doesn't
   exist yet, the first person to register that address becomes system owner
   over every tenant. Fix: reserve the configured email from ordinary signup,
   or resolve the owner to an immutable user ID out-of-band.

2. **Major — tests never exercise the routes.**
   `tests/tenant-admin-access.test.cjs` calls the helper directly; no test
   proves all three routes on both backends 403 a non-owner, fail closed at
   the route boundary, or that projections drop planted
   `password_hash` / `api_key_cipher` rows. Green tests currently can't
   distinguish "gated" from "forgot the gate."

3. **Moderate — `/backend/tenants/access` deviates from the stated invariant.**
   It calls the boolean `isSystemOwnerUser` (`server/index.cjs` ~L10004,
   `netlify/functions/backend.mjs` ~L2275) and returns `200 {owner:false}`
   instead of `assertSystemOwner`. It leaks no data (it's the
   button-visibility probe), but the commit message claims *every* tenants
   endpoint uses the one gate, and this creates a second authz pattern for
   future routes to copy. The hook already treats 403-no-data as false, so
   converting it is a one-liner.

4. **Minor — Unicode lowercasing is broader than the documented "exact"
   match** (e.g. U+212A Kelvin sign lowercases to `k`). Restrict folding to
   ASCII A–Z or reject non-ASCII owner addresses.

5. **Minor — no `public/release-notes.json` entry.** Defensible for an
   owner-only surface, but AGENTS.md's rule doesn't carve that out.

---

## Agent identity (06f593d) — good shared core, but the "NEVER overwrite" guarantee has holes

### What's right

- Schema is correctly in all three places (`ensureRuntimeSchema`,
  `database/neon-schema.sql`, migration) with matching types/defaults.
- `identity` is in the bootstrap and `/agents` selects and survives
  `sanitizeRealtimeRow` — the exact footgun AGENTS.md warns about was avoided.
- Precedence logic is genuinely centralized in `shared/agentIdentity.cjs`;
  all three doors (MCP register_agent, daemon agent_register, detail panel)
  reach it.
- Declared strings get length caps, color/voice-ID shape checks, emotion
  allowlists.
- `CARTESIA_API_KEY` never reaches the browser; preview is authenticated and
  rate-limited.

### Findings, ranked

1. **Blocker — generic DB writes can forge or erase `human_set`.**
   `workspace_agents.identity` is an ordinary writable JSON column
   (`shared/backend-core.cjs` ~L99). A payload like
   `{"identity":{"human_set":{...}}}` or `{"identity":{}}` skips the
   voice-marking branch and is written verbatim (`server/index.cjs` ~L11088,
   `netlify/functions/backend.mjs` ~L1893). Any workspace editor can wipe
   locks or replace the whole identity object, bypassing the precedence path
   entirely. Also: human-created agents (`src/hooks/useAgents.ts` ~L103) get
   no `human_set` on insert, so an agent's first connect can replace the
   avatar/profile the human just chose.
   Fix: unconditionally discard client-supplied `human_set`, accept only
   `voice`, and synthesize locks on human inserts.

2. **Blocker — the precedence rule isn't concurrency-safe.**
   Agent registration does read → merge-in-JS → unconditional UPDATE
   (`server/index.cjs` ~L5285 read, ~L5305 write). A human edit landing
   between the read and write is overwritten — for the JSON `identity` column
   the stale agent write can destroy both the human's voice *and* the new
   `human_set` flag. Needs `SELECT ... FOR UPDATE` in a transaction or a
   version-guarded UPDATE with retry.

3. **Blocker (cross-repo) — the daemon never sends `identity`.**
   The Fly server consumes `message.identity` on `agent_register`
   (`server/index.cjs` ~L5328), but the public daemon's registration frame
   (`jasonkneen/agensis-agent` @ 6f72e4ab, `agensis.mjs` ~L258) carries no
   identity/voice fields, so "declare on every connect" only works through
   the MCP door. Wire-contract change needs coordinating in the daemon repo.

4. **Major — a read-only MCP invite can mutate an approved agent's unlocked
   identity.** `register_agent` (`server/mcp.cjs` ~L1019) accepts
   invite-scope callers and applies the declaration to an existing
   `mcp_approved` agent without a `write`/`run_agents` check.

5. **Major — saving the detail form locks every field, touched or not.**
   `handleSave` (`src/components/windows/AgentsWindowContent.tsx` ~L1278)
   submits all identity columns, so changing only the model permanently
   human-locks avatar/description/soul at their current (possibly empty)
   values. Send a sparse diff.

6. **Major — Cartesia HTTP contract mismatch.**
   Requests send `X-API-Key` (`server/index.cjs` ~L5171) while pinning
   `Cartesia-Version: 2026-03-01`, whose documented auth is
   `Authorization: Bearer`; the MP3 `output_format` shape
   (`encoding: 'mp3'`, no `bit_rate`) also doesn't match docs. Tests mock
   Cartesia and assert the wrong header, so they can't catch it. This code is
   still in HEAD post-3c86d55 — worth a live smoke test.

7. **Major — Netlify `/agents` mirror drops `soul`, `accent_color`,
   `openpet_avatar_id`** (`netlify/functions/backend.mjs` ~L931 select), so a
   reload through the serverless mirror blanks fields the Fly path returned.
   The wiring test only greps for the word `identity`.

8. **Superseded — "release note claims voices that don't play."**
   True at 06f593d (huddle playback was still `speechSynthesis`, marked
   INTERIM), but 3c86d55 in HEAD builds the Deepgram/Cartesia pipeline.
   Whether it consumes *per-agent* roster voices was not verified — confirm
   when that commit gets reviewed.

9. **Minor** — voice-outage error is swallowed in the panel ("No voice
   available" instead of the error); no timeout on server-side Cartesia
   fetches; MCP `name` arg bypasses the 80-char identity cap; the precedence
   tests never run the full agent → human → agent-reconnect sequence, and the
   "collision" test uses a one-voice catalogue so it can't prove probing
   works.

---

## Bottom line

Tenants is close — fix the owner-email squat and add route-level tests.
Agent identity has a well-designed core but the guarantee in its own commit
message ("can never overwrite a human's choice") is currently defeatable three
ways: generic JSON writes, a write race, and full-form saves; those plus the
daemon contract gap are the priority.

*Review method: two expert review passes (one per commit) over `git show`
diffs plus targeted source inspection; claims spot-checked against the working
tree. No tests or builds were run; no code was changed. Line numbers are
approximate (as of baab046).*
