# Agent marketplace

Cross-workspace sharing of agents, reached from the **Create Agent** screen and
each agent's detail pane. This document covers what shipped in v1, the security
model, and the designed-but-not-yet-wired hire execution lane (including the
`agensis-agent` CLI work it needs).

## What shipped (v1)

Two listing shapes, one table (`marketplace_listings`), validated by
`shared/marketplace.cjs` and served by `server/marketplace-routes.cjs`
(Fly-owned; Netlify forwards `/backend/marketplace*` and
`/backend/workspaces/:id/marketplace*`):

- **`template`** — the persona body travels. Any signed-in user can browse it;
  "Use" prefills the existing Agents-window create form (review before
  instantiate — nothing is written until a person submits, through the generic
  insert and its column guards), and "Save" copies it into
  `workspace_agent_templates` **through the existing import lane**
  (`importAgentTemplate`), so a marketplace copy gets the same manage gate,
  the same loud validator refusals, and the same `agent_template.imported`
  audit row as a file import.
- **`hire`** — the persona body does **not** travel. The listing carries the
  name, description, and a publisher-written capabilities list, nothing else.
  Hiring (manage-gated) creates a Connector-shell roster row in the hirer's
  workspace — `run_mode 'external'`, empty prompt/skills/tools,
  `permission_mode 'default'`, `ambient_replies false` — plus a
  `marketplace_hires` record, audited in both workspaces.

### Security model, in one place

1. **A listing carries prose, requests and descriptive intent — never
   authority.** Same rule as `workspace_agent_templates`, enforced the same
   three ways: the table has no privilege-bearing column
   (`tests/marketplace.test.cjs` pins that in all three schema places); the
   validator rebuilds from named fields and refuses (naming the key) a payload
   carrying `permissionMode`, `metadata`, etc.; publishing derives the body
   from `agentToTemplateDraft`, which picks named fields and never spreads the
   agent row.
2. **A hire listing structurally carries no body.** The validator refuses a
   template on a hire listing; the `marketplace_listings_hire_carries_no_body`
   CHECK refuses non-empty prose columns on a hire row; and
   `publicMarketplaceListing` never reads the prose columns on the hire
   branch. Three independent layers — the projection alone would not be a
   control.
3. **The hired roster row is server-authored from no caller fields.** The
   caller names a listing id; everything inserted comes from
   `hiredAgentDraft` (cosmetics + intent) or fixed literals in the SQL. The
   host linkage lives in `workspace_agents.metadata.marketplace_hire`, which
   is MANAGE_ONLY on the generic path, so a hirer-side editor cannot rewrite
   it.
4. **Neither marketplace table is in `ALLOWED_TABLES`.** The dedicated routes
   are the only doors, so the validator always runs and generic inserts cannot
   forge a listing or a hire.

## The hire execution lane (designed, not yet wired)

In v1 a hired agent behaves exactly like a disconnected Connector: turns
queue, the server posts its explicit waiting notice, and nothing ever
impersonates the agent. That is safe and honest, but a hired agent only
becomes useful when the **host's** runtime actually serves those turns. The
missing piece is deliberate — routing a hirer's prompts into a machine the
publisher owns is precisely the damage vector the feature must not open
casually. The design:

### Serving hired turns

- The host serves hires with its own runtime (the publisher's daemon, or a
  Connector client), never with the hirer's credentials. The unit of granted
  work is **the hired agent row in the hirer's workspace**: the host claims
  jobs *as that agent*, via the existing `claim_job` lane, using a
  **hire-scoped agent bearer** minted for that hired row.
- Minting and delivery: a manage-gated route on the **host** workspace lists
  its active inbound hires (`marketplace_hires` where
  `host_workspace_id = :id`) and mints/rotates each hired row's connect
  token — the same mint discipline as `get_connect_command`: one secret per
  response, hash at rest, audited. The hirer never sees this credential; the
  host operator feeds it to their runtime.
- Nothing about the wire contract changes for the server: a hired turn is an
  ordinary external-agent job in the hirer's workspace. Session scoping
  already confines what the token can read (`mcpSessionScopeSql`: an agent
  sees the sessions it participates in, not the workspace).

### Protecting the host machine

A hostile hirer's prompt is untrusted input running on the publisher's
hardware. Non-negotiables for the CLI/serving side:

- **Hired jobs run in a dedicated lean profile**: `--safe-mode`, no
  `--dangerously-skip-permissions`, and **no host folders** — the hired lane
  ignores `metadata.host_folders` even if the host agent has them, so a hired
  turn can never receive an `--add-dir` into the operator's disk. A sandboxed
  working directory per hire is the target state.
- **No interactive approvals across the tenant boundary.** The permission
  broker's ask-in-conversation flow would surface a hirer-authored prompt to
  the host as a clickable grant; hired jobs instead fail closed on any tool
  outside the standing allowlist the host configured for the hire.
- **The host's own persona stays home.** The hired row carries no prose by
  construction; the host runtime composes its persona locally, so the hirer
  can neither read nor overwrite it.
- **Kill switches both ways**: the hirer ends a hire (roster row disabled,
  record flipped to `ended` — shipped); the host unpublishes or rotates the
  hire token (revocation, shipped as unpublish + designed as rotate).
- **Metering before general availability**: hired turns spend host-side
  budget, so per-hire turn/byte counters and a host-visible ledger are a
  prerequisite for opening this beyond trusted publishers.

### `agensis-agent` (separate repository) work

The daemon repo (`jasonkneen/agensis-agent`) needs, in order:

1. **Multi-identity connect** — hold N hired-agent bearers alongside the
   primary connect profile and poll/claim for each (the session-slots work
   already broke the one-connection assumption).
2. **The hired lean profile** described above (safe mode, no host folders, no
   interactive approvals), selected whenever the credential is hire-scoped —
   the credential, not daemon config, decides, so a misconfigured host cannot
   accidentally serve hires in yolo.
3. **`agensis hires` CLI surface** — list inbound hires, attach/detach a hire
   token, show per-hire activity.

Wire-contract changes must land in both repos in the same window, per the
existing cross-repo rules (stop reasons, timeout pairs).

## Operational notes

- Schema lives in the usual three places (runtime bootstrap, canonical
  `database/neon-schema.sql`, migration
  `20260810120000_agent_marketplace.sql`); `tests/marketplace.test.cjs`
  fails on drift.
- Audit actions: `marketplace.listing_published`, `marketplace.listing_removed`,
  `marketplace.agent_hired` (hirer side), `marketplace.listing_hired` (host
  side), `marketplace.hire_ended`; copies land as `agent_template.imported`.
- The marketplace UI degrades to nothing when the routes are absent
  (`useMarketplace` falls back, the section renders `null`), so reverting the
  server restores the pre-feature create flow byte-for-byte.
