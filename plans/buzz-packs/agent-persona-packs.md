# agent-persona-packs — plan

Pack rank 8, priority 55. Domain `agent-ux`. Source: buzz `crates/buzz-persona`.
Stated target surface: "agent profiles / persona config in platform".
Written 2026-07-29 against `main-next`.

---

## 1. Verdict

**Adopt-modified, and roughly one tenth the size the pack implies.**

agensis already has the *substance* of a persona pack and has had it for a long
time: an agent's behaviour, prompt layers, tool list, skill list, model, run
mode, permission mode and execution metadata are all columns on
`workspace_agents` (`server/index.cjs:828-851`), all read through one projection
(`agentContextFromRow`, `server/index.cjs:3595-3611`), and all editable in the
Agents window. There is even a second, closer analogue that the brief did not
mention: `server/sandbox-skills.cjs` is already a *skill-definition registry*
with a bundled source, an agent-authored source
(`workspace_agents.metadata.sandbox_skills`), one shared validator, and an
explicit "adding a provider is authoring a skill, not shipping a deploy"
contract (`server/sandbox-skills.cjs:1-100`). That is a pack format. It is just
scoped to one domain.

What is genuinely missing is narrow and specific: **agent templates are code,
not data.** All 15 live in a frontend array (`src/lib/agentTemplates.ts:102`),
they can only be added by editing that file and running a Netlify deploy, a user
cannot author one, cannot save an agent they tuned as a starting point for the
next one, cannot export one, and cannot move one between workspaces. That is the
whole gap. It is worth closing and it is small.

What should be **rejected outright** is the rest of buzz's model: the OPS-superset
`plugin.json` manifest, zip distribution with `.sha256` sidecars, `pack.lock`,
a registry/app-store phase, lifecycle hooks, per-persona MCP server blocks, and
the five-level precedence/merge engine (buzz spec sections 2, 9, 10, 11). Every
one of those assumes buzz's trust model — a filesystem artifact installed by an
operator into a local harness they own, where the operator *is* the trust
boundary and hooks running "with buzz-acp's privileges" is stated as acceptable
(buzz spec section 13). agensis has no such boundary. A workspace has members
holding different roles, and anything installed there executes against the
workspace's credentials, the workspace vault, and — for a `daemon` agent —
somebody's actual laptop. Importing a privilege-bearing artifact is an
escalation path, and section 2 below treats that as the main deliverable of this
document rather than a footnote.

There is also a **sequencing argument that may make this whole pack wait**: see
section 2.4. A persona artifact that names skills is only portable if the skills
are portable. Today they are not. If only one thing gets built, build the skill
store, not the persona pack.

### What already exists today (cited)

| Capability the pack asks for | Where it already is |
|---|---|
| Persona as structured config, not inline prompt | `workspace_agents.system_prompt` / `soul` / `instructions` / `description` — `server/index.cjs:828-851`; projected by `agentContextFromRow` `server/index.cjs:3595-3611` |
| Tool surface as config | `workspace_agents.tools jsonb` — `server/index.cjs:830`. **Advisory only**, see 3.3 |
| Skill list as config | `workspace_agents.skills jsonb` — `server/index.cjs:831`; string ids by deliberate design, `server/sandbox-skills.cjs:22-40` |
| Model / behaviour config | `model`, `run_mode`, `permission_mode`, `sandbox_provider`, `sandbox_config`, `memory_dir` — `server/index.cjs:845-849`, `:1258` |
| Pack-level defaults applied to many agents | `DEFAULT_AGENT_SEEDS` + `seedDefaultAgents` — `server/index.cjs:~6530-6620` (5 agents seeded into every new workspace) |
| Reusable starting points | `AGENT_TEMPLATES` — `src/lib/agentTemplates.ts:102-254`, applied by `applyTemplate` `src/components/windows/AgentsWindowContent.tsx:537` |
| Skill definitions with instructions, endpoints, MCP block, code, credential ref | `server/sandbox-skills.cjs:42-64` — the definition shape, validated by `normalizeSandboxSkill`, resolved by `sandboxSkillsForAgent` `:699` |
| Skill *bodies* shared across machines | `agent_skill_documents` — DDL `server/index.cjs:1283-1300`, upsert `server/agent-connections.cjs:899`, drift-hash sync `server/agent-connections.cjs:768-791` |
| On-disk mirror of the resolved persona | `soul.md` + `agent.json` under `~/.agensis/<ws>/<agent>/` — `packages/agensis-cli/src/state.mjs:1-30`, `:153-154` |
| A revision counter on the config | `workspace_agents.version integer` — `server/index.cjs:849`, bumped at `:2659` and `:2892` |

### Correction to a premise in the brief

The brief says "agent instructions truncate silently at 4000 chars". **That is not
true of agent instructions.** `workspace_agents.instructions` is `text` with no
application cap; the create path (`src/hooks/useAgents.ts:104-133`) and the
generic insert do not slice it. The 4000 figure is
`SANDBOX_MAX_INSTRUCTION_CHARS` at `server/sandbox-skills.cjs:205`, which bounds
*sandbox skill* instructions only.

The real silent-truncation hazard is worse and is in the daemon.
`buildPrompt` (`packages/agensis-cli/src/agensis.mjs:1295-1330`) composes the
prompt in this order — description, soul, system_prompt, instructions, tools,
skills, widgets, status/identity notes, heartbeat, **then** the user message —
and returns `truncateUtf8Start(prompt, LEAN_PROMPT_MAX_BYTES)` when `leanCli` is
on, which it is by default (`agensis.mjs:697`, `LEAN_PROMPT_MAX_BYTES = 10 * 1024`
at `:48`). `truncateUtf8Start` (`:1332-1347`) keeps the **tail**. So when a
persona is large, the parts dropped first are exactly the persona: description,
soul, system prompt, instructions — while the user message survives. The marker
`[... older or optional Agensis context omitted ...]` is prepended, so it is not
literally invisible, but nothing in the app surfaces it and no author would
expect their system prompt to be the first casualty.

Any persona feature must handle this or it will ship personas that silently do
nothing on the daemon lane. Concretely: budget and warn at authoring time
(section 4), and treat "does the composed persona fit under 10 KiB with room for
a message" as a first-class validation, not a nicety. The server-side analogue is
`CHANNEL_CONTEXT_MAX_BYTES = 8 * 1024` (`server/index.cjs:3619`), already
deliberately sized to keep history under the daemon's ceiling.

---

## 2. What the pack proposes, and the security story

### 2.1 The concept, in my words

The pack itself is **thin — say so plainly**. `anchors.json` is 246 bytes: one
crate path, `crates/buzz-persona`, with a directory listing (`Cargo.toml`,
`PERSONA_PACK_SPEC.md`, `src`, `tests`) and **no source excerpt at all**.
`pack.json` and `PROMPT.md` restate a single sentence — "reusable persona/config
packs for agents so behavior and tool surfaces are shareable artifacts, not only
inline prompts" — five times in different wrappers. There is no design in the
pack. Judging the idea therefore has to be done on merits, which is what this
document does.

The buzz source is present locally at
`/Users/jkneen/Documents/GitHub/buzz/crates/buzz-persona/`, and its
`PERSONA_PACK_SPEC.md` (1149 lines) is the real specification. Read for intent,
not copied, it describes:

- A pack is a directory or zip that is a **superset of the Open Plugin Spec**,
  manifested by `.plugin/plugin.json` (spec section 2).
- It contains N personas as `agents/*.persona.md` — YAML frontmatter (identity,
  skills, per-persona MCP servers, behavioural config) plus a markdown body that
  is the prompt (spec section 4).
- Shared across the personas in the pack: a `skills/` tree of `SKILL.md` files, a
  `.mcp.json` of MCP servers, `hooks/hooks.json` of lifecycle hooks, and an
  `instructions.md` injected pack-wide (spec section 3).
- A five-level precedence chain resolves effective config at deploy time:
  operator env vars > desktop UI per-agent > persona frontmatter > pack defaults
  > built-in defaults, with shallow replacement and explicit `null`-is-absent /
  `[]`-is-an-override semantics (spec section 10).
- Distribution in three phases: zip with a mandatory `.sha256`, then git with a
  `pack.lock` pinning a commit, then a registry with signatures TBD (section 11).

### 2.2 Where buzz's assumptions do not transfer

- **Rust crate to Node/Postgres.** Nothing carries over mechanically. Every line
  would be original work regardless.
- **Filesystem-first to database-first.** buzz packs are inspected with `unzip`
  and no buzz tooling. agensis has no per-workspace filesystem; a workspace is
  rows in a shared Neon DB reached by two backends. A pack in agensis is a row
  or a JSON blob, not a directory.
- **Single operator to multi-tenant RBAC.** This is the load-bearing difference
  and the whole of 2.3.
- **Nostr/relay identity to workspace membership.** buzz personas subscribe to
  `#channels` and are addressed through the relay. agensis addressing is
  `workspace_agents.handle` plus channel membership; `subscribe` and `triggers`
  have no counterpart and should not acquire one from this pack.
- **Per-persona MCP servers.** buzz lets a persona declare arbitrary MCP servers
  with `command`/`args`/`env`. agensis deliberately does not: the daemon builds
  `--mcp-config` itself with `--strict-mcp-config`
  (`packages/agensis-cli/src/agensis.mjs:1380-1389`), pointing at the agensis MCP
  server and nothing else. Letting an imported artifact add an MCP server is
  letting it add a local process with tool access. Do not adopt this field.
- **Lifecycle hooks.** buzz's own spec says hooks "run with buzz-acp's
  privileges — significant attack surface. Only install packs from trusted
  sources" (spec section 13). That mitigation is "trust the human", which works
  when the human owns the machine and does not work when the artifact arrives in
  a shared workspace. Do not adopt hooks.

### 2.3 Security: a persona artifact must be non-privilege-bearing, by construction

This is the most important section of the document.

agensis's existing controls are good and they are specific. In
`shared/backend-core.cjs`:

- `workspace_agents` uses `DEFAULT_TABLE_ACCESS` (`:180-185`, `:200`) — select
  needs `read`, insert/update/delete need `write`. So **any member with `write`
  can already create an agent with an arbitrary `system_prompt`.** Prose is not
  privileged today and this plan does not change that.
- `PRIVILEGED_DB_COLUMNS_BY_TABLE.workspace_agents` (`:258-264`) strips
  `mcp_approved`, `connect_token_hash`, `connect_token` and `permission_mode`
  from *every* generic `/backend/db` write, via `stripPrivilegedDbValues` (`:352`).
  They are unreachable through the generic path at any role.
- `MANAGE_ONLY_DB_COLUMNS_BY_TABLE.workspace_agents` (`:293-298`) requires
  `manage` to set `metadata`, `sandbox_provider` or `sandbox_config`, detected by
  `setsManageOnlyDbColumn` (`:300-318`). The comment there states exactly why:
  `metadata.host_folders` is forwarded to the daemon and becomes `--add-dir <path>`
  on the coding CLI (`packages/agensis-cli/src/agensis.mjs:1717-1726`, `:1448-1449`),
  so a `write` member could otherwise widen an agent's filesystem reach to `/`
  or `~/.ssh`.
- `metadata` also carries `sandbox_skills` (`server/sandbox-skills.cjs:699-707`),
  whose definitions include a `baseUrl` the server will call and a `credential`
  naming a workspace-vault key. An artifact that could write `metadata` could
  point a provisioning agent at an attacker-chosen host holding a real
  credential.

**Therefore the security design is a single rule, enforced structurally rather
than by a check:**

> A persona artifact carries prose and *requests*. It never carries authority.
> The columns that grant authority are not fields of the artifact — they are not
> in its table, not in its envelope, and not in its validator's output. You
> cannot import what the shape cannot hold.

Concretely, split the fields of `workspace_agents` into three sets:

**Carried (prose and cosmetics — no new authority, a `write` member can already type these):**
`name`, `handle` (as a hint only, deduped on use), `description`, `system_prompt`,
`soul`, `instructions`, `avatar`, `accent_color`, `model`, `category`.

**Carried as a request, never as a grant:**
`tools`, `skills`, `run_mode`, `runtime`. These are strings that name things. A
name resolves to nothing on its own — see 3.3 for `tools`, and note that
`run_mode: 'daemon'` grants nothing without a connect token, which is minted only
through `buildAgentConnectionCommand` behind a `manage` check
(`server/mcp.cjs:1393-1430`, and the HTTP twin). An unknown skill id resolves to
no definition. So these may ride along, and the instantiation step re-validates
them against what the workspace actually has.

**Never carried, at any role, in any envelope:**
`permission_mode`, `metadata` (and therefore `host_folders` and
`sandbox_skills`), `sandbox_provider`, `sandbox_config`, `connect_token_hash`,
`connect_token`, `mcp_approved`, `memory_dir`, `identity`, `enabled`,
`workspace_id`, `created_by`, `id`, `version`.

The mechanism that makes this real, and cheap:

1. **The template table has no columns for them** (section 4.2 DDL). A dropped
   field is not a filtered field; there is nowhere for it to land.
2. **Instantiation reuses the existing human-reviewed create path.** A template
   prefills the Agents window form (`applyTemplate`,
   `src/components/windows/AgentsWindowContent.tsx:537`); nothing is created until
   the person reviews and submits, and submission goes through
   `useAgents.createAgent` (`src/hooks/useAgents.ts:104`) into the generic
   `/backend/db/insert`, where `stripPrivilegedDbValues` and
   `setsManageOnlyDbColumn` apply unchanged. **No new write path to
   `workspace_agents` is introduced by this plan.** That is the single most
   important design constraint here and it should be stated in the PR
   description.
3. **Crossing the workspace boundary needs `manage`.** Authoring a template
   in-workspace is `write` (it is no more than typing a system prompt, which
   `write` can already do). *Importing* one from outside is `manage`. The
   difference is not the privilege of the content — it is attention: nobody reads
   4 KB of pasted prose, and an imported system prompt is attacker-influenced
   text that will later be spoken by an agent wearing a teammate's trust. Making
   it an admin action, with the body shown before the click, is the mitigation
   that fits this product. It mirrors how `thread_harvests` handles
   model-proposed content: `insert/update` gated to `manage`
   (`shared/backend-core.cjs:232`) with a human review screen and a provenance
   line written into the artifact itself (`server/thread-harvest.cjs:212-230`).
4. **Provenance is stored, not just displayed.** An imported template records who
   imported it, when, from where, and a SHA-256 of the envelope. When an agent
   later behaves oddly, "this prompt came from a file Dave pasted on the 3rd" is
   the answer someone will need.
5. **Imported prose is untrusted content when rendered.** It goes through
   `MarkdownContent` like any other body; it must not be interpolated into a
   trusted region of a composed prompt. The existing precedent is
   `sanitizeSandboxMeta` (`server/sandbox-skills.cjs:225-240`) and the fenced
   untrusted region for provider output.

**One risk this plan explicitly does not solve:** a persona is, by definition,
words that change what an agent does. A malicious system prompt does not need
`permission_mode` to be harmful — it can instruct a `yolo` daemon agent that
already exists to do damage. Non-privilege-bearing artifacts make *escalation*
impossible; they do not make *social engineering through prose* impossible. The
only defences are the `manage` gate on import, showing the full body before
acceptance, and provenance. Say this out loud in the UI rather than implying the
feature is safe.

### 2.4 Overlap with `thread_harvests`, and the skill-store question

Yes, and the answer matters more than the persona work.

`server/thread-harvest.cjs:184-201` documents the constraint precisely: a
`skill`-kind proposal is accepted into `documents` under a `Skills` folder,
**because there is no app-side skill store to accept into.** A skill in this
product is a `SKILL.md` a daemon owns on its own disk and mirrors up into
`agent_skill_documents`, which is daemon-write / browser-read only
(`server/index.cjs:1283-1300`, `server/skill-content.cjs:1-27`). Attaching a bare
name to `workspace_agents.skills` "would record a claim without the procedure
that makes it true". `tests/thread-harvest-review.test.cjs:53` and
`tests/unit/threadHarvest.test.ts:185` both pin that reasoning.

That statement is *almost* right, and the exception is the interesting part:
`workspace_agents.metadata.sandbox_skills` **is** an app-side, human-authored,
server-resolved skill definition store (`server/sandbox-skills.cjs:66-84`). It
has a schema, one validator shared with the bundled definitions, no-deploy
authoring, and a credential model. It is simply scoped to the sandbox domain and
is privilege-bearing, which is why it lives behind the `manage` gate on
`metadata`.

So the honest conclusion:

> **A real, general, non-privileged, workspace-scoped skill store is the more
> valuable missing piece, and it is a prerequisite for persona packs being
> portable at all.** A persona that lists `skills: ['security-review']` is
> meaningless in a workspace where no daemon on anyone's machine has that file.
> Exporting such a persona exports a dangling reference.

Recommended order:

1. **Generalise the skill store** — a `workspace_skills` table holding authored
   definitions in the shape `server/sandbox-skills.cjs:42-64` already validates,
   with the sandbox-specific fields (`baseUrl`, `credential`, `endpoints`, `mcp`,
   `code`) remaining `manage`-only and the prose-only subset available at
   `write`. This gives `thread_harvests` a real accept target, gives
   `agent_skill_documents` an app-side sibling that does not need a daemon
   online, and makes a persona's skill list resolvable.
2. **Then** templates-as-data (this plan). It is a genuinely small increment once
   step 1 exists, because a template's `skills` array finally points at
   something.

If Jason wants only one, take step 1. This document plans step 2 in full anyway,
because it was asked for and because it stands alone if the skill list is
accepted as "a request, not a grant" (2.3), which it already is today.

---

## 3. Impact on our system

### 3.1 Subsystems touched

- **Agent creation UI** (`src/components/windows/AgentsWindowContent.tsx`) — the
  template gallery at `:652-712` switches from iterating the hardcoded
  `AGENT_TEMPLATES` to iterating a resolved list from the server, with the
  hardcoded array kept as the bundled fallback source. `applyTemplate` (`:537`)
  is nearly unchanged.
- **Onboarding** (`src/components/onboarding/OnboardingTour.tsx:107-109`) — reads
  `AGENT_TEMPLATES` directly for its four one-click presets and for the Coder
  template. **Leave it on the bundled array.** Onboarding must work before a
  workspace has any authored templates and must not gain a network dependency
  on its critical path.
- **RBAC allowlists** (`shared/backend-core.cjs`) — one new table added to
  `ALLOWED_TABLES` (`:31`), `WORKSPACE_SCOPED_TABLES` (`:160`), `DB_TABLE_ACCESS`
  (`:187`) and `JSON_COLUMNS_BY_TABLE` (`:115`). Both backends import this file,
  so it is a two-lane deploy.
- **Schema** — one new table in all three places (AGENTS.md:23-38).
- **Realtime** — the gallery can subscribe to the new table the same way
  `useAgents` subscribes to `workspace_agents` (`src/hooks/useAgents.ts:73-98`).
  No new heavy fields, so no `REALTIME_HEAVY_FIELDS` entry needed
  (`server/realtime.cjs:175-184`); if template bodies grow past a few KB,
  revisit.

### 3.2 What it breaks or forces

Nothing, if the bundled array is retained as a fallback source. There is no data
migration, no change to any existing row, and no change to any existing write
path. This is additive.

The one real compatibility trap: `workspace_agents.skills` must stay
`string[]`. `server/sandbox-skills.cjs:22-40` enumerates the five surfaces that
read it as strings and the load-bearing one — the Agents window round-trips it
through a comma-separated text input, so an object in that array renders
`[object Object]` and is then **saved back over the real definition** on the next
unrelated edit. A template's `skills` must therefore also be `string[]`. Do not
let a persona artifact carry inline skill objects.

### 3.3 A finding worth acting on separately: `tools` is advisory

`workspace_agents.tools` gates nothing. On the daemon lane it is interpolated as
literal prompt text — `Enabled tools:\n${tools}`
(`packages/agensis-cli/src/agensis.mjs:1317-1318`). On the builtin lane the tool
list handed to the model comes from `toolSpecs`
(`server/builtin-turn.cjs:674`), not from the column. So "tool surface as a
shareable artifact", the pack's headline phrase, would today share a *label*, not
a *surface*.

This is not a regression and not caused by this feature, but it must not be
misrepresented. Either (a) say plainly in the UI that `tools` is a hint to the
agent, or (b) make it real by intersecting `toolSpecs` with the column — which is
a separate, larger piece of work with its own compatibility questions (every
existing agent has `tools: []`, and an empty array currently means "all", so
naively intersecting would silently disable tools for every agent in production).
**Do (a) in v1.** Do not do (b) as part of this.

---

## 4. Work breakdown

### 4.1 Build order (vertical slice first)

**Slice 1 — the table renders the gallery (the real vertical slice).**
DDL, allowlist entries, one resolver route, gallery reads it, bundled array is
the fallback. At the end of slice 1 nothing has changed for a user, and that is
the point: it proves the read path end to end with zero risk before any write
path exists.

**Slice 2 — "Save as template" from an existing agent.** The first user-visible
win, and it is a strip-and-copy of columns the caller can already read.

**Slice 3 — export to JSON envelope, import from JSON envelope.** `manage`-gated
import with a full-body review screen and stored provenance.

**Slice 4 — the persona-size budget warning.** Authoring-time check against the
daemon's 10 KiB ceiling (see section 1 correction).

Deliberately **not** in v1: see section 6.4.

### 4.2 DDL (belongs in `ensureRuntimeSchema()` — runs on Fly boot)

```sql
CREATE TABLE IF NOT EXISTS workspace_agent_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'Custom',
  description text DEFAULT '',
  handle_hint text DEFAULT '',
  system_prompt text DEFAULT '',
  soul text DEFAULT '',
  instructions text DEFAULT '',
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL DEFAULT 'auto',
  run_mode text NOT NULL DEFAULT 'builtin',
  runtime text DEFAULT '',
  avatar text DEFAULT '',
  accent_color text DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  source text NOT NULL DEFAULT 'authored',
  origin jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_workspace_agent_templates_workspace_id
  ON workspace_agent_templates(workspace_id);
```

Notes for the implementer:

- **The absent columns are the security control.** There is deliberately no
  `permission_mode`, `metadata`, `sandbox_provider`, `sandbox_config`,
  `connect_token_hash`, `mcp_approved`, `memory_dir` or `identity`. Adding one
  later is a security decision, not a schema tidy-up. Put that sentence in the
  DDL comment, in the style the file already uses at `server/index.cjs:836`.
- `source` is a closed set: `'authored'` (created in this workspace),
  `'imported'` (crossed a workspace boundary), `'derived'` (saved from an
  existing agent).
- `origin` holds provenance for `source='imported'`:
  `{ importedBy, importedAt, envelopeSha256, statedOrigin }`. `statedOrigin` is
  whatever the envelope claimed and is **never trusted** — it is displayed as a
  claim, not a fact.
- `revision` bumps on update. It is a counter, not history; v1 keeps no history.
- The three places (AGENTS.md:23-38): `ensureRuntimeSchema` in
  `server/index.cjs`; `database/neon-schema.sql`; a new
  `supabase/migrations/<UTC-timestamp>_workspace_agent_templates.sql`. Pinned by
  a test — see 5.1.
- Both jsonb columns must go in `JSON_COLUMNS_BY_TABLE`
  (`shared/backend-core.cjs:115`). Neither is a native PG array, so
  `ARRAY_COLUMNS_BY_TABLE` is not involved. When binding, bind the **object**,
  not a stringified one — `porsager` turns a stringified `::jsonb` bind into a
  jsonb string scalar (the trap documented at
  `server/join-pages-routes.cjs:215-216` and pinned by
  `tests/jsonb-bind-hygiene.test.cjs`).

### 4.3 Allowlist entries (`shared/backend-core.cjs`)

```
ALLOWED_TABLES            (:31)   + 'workspace_agent_templates'
WORKSPACE_SCOPED_TABLES   (:160)  + 'workspace_agent_templates'
JSON_COLUMNS_BY_TABLE     (:115)  + workspace_agent_templates: new Set(['tools','skills','origin'])
DB_TABLE_ACCESS           (:187)  + workspace_agent_templates:
                                      { select:'read', insert:'write', update:'write', delete:'write' }
PRIVILEGED_DB_COLUMNS_BY_TABLE (:258) + workspace_agent_templates:
                                      new Set(['source','origin','workspace_id'])
```

`source` and `origin` are privileged: they are provenance, and a generic write
that could set `source: 'authored'` on an imported template would erase the
audit trail. They are written only by the dedicated routes.

### 4.4 Files to create

| File | Reason |
|---|---|
| `shared/agentTemplates.cjs` | The one validator. Pure functions only, no DB/network/express, mirroring the convention stated at `server/sandbox-skills.cjs:1-10` so it is unit-testable with no Postgres. Exports `normalizeAgentTemplate(raw)`, `templateToAgentDraft(tpl)`, `agentToTemplateDraft(agentRow)`, `exportEnvelope(tpl)`, `parseEnvelope(json)`, and the `CARRIED_FIELDS` / `NEVER_CARRIED_FIELDS` sets from 2.3. Both backends import it, as they already do `backend-core.cjs`. |
| `server/agent-templates-routes.cjs` | New route module following the injected-dependency pattern used by every other `*-routes.cjs` (see the header at `server/mcp-doors-routes.cjs:1-13`) so the auth/RBAC/rate-limit contract stays single-sourced. |
| `src/lib/agentTemplateEnvelope.ts` | Frontend type + client-side envelope parse for the import dialog's preview, so a malformed paste is rejected before a round trip. Types must match `shared/agentTemplates.cjs`; pinned by a test the way `shared/agentIdentity.cjs` is pinned against `src/lib/agentVoice.ts`. |
| `src/components/windows/AgentTemplateImportDialog.tsx` | The `manage`-gated import review screen: full body shown, provenance shown, "this text will become an agent's instructions" stated before the button. |
| `tests/agent-template-import-guard.test.cjs` | Backend runner. The security test. |
| `tests/agent-template-schema.test.cjs` | Backend runner. Three-place schema parity, following `tests/agent-sandbox-schema.test.cjs`. |
| `tests/unit/agentTemplateEnvelope.test.ts` | Frontend runner. Envelope round-trip and asymmetry. |
| `supabase/migrations/<ts>_workspace_agent_templates.sql` | Migration lane of the three-place rule. |

### 4.5 Files to modify

| File | Change |
|---|---|
| `server/index.cjs` | Add the DDL to `ensureRuntimeSchema` near the other agent tables (~`:1283`); mount `agent-templates-routes.cjs` alongside the other route modules. |
| `shared/backend-core.cjs` | The five allowlist entries in 4.3. |
| `database/neon-schema.sql` | Canonical schema lane. |
| `src/lib/agentTemplates.ts` | Keep `AGENT_TEMPLATES` as the bundled source; add `mergeTemplateSources(bundled, authored)` with authored winning on slug collision, mirroring `resolveSandboxSkills`' precedence (`server/sandbox-skills.cjs:699-707`). Do **not** remove the array. |
| `src/components/windows/AgentsWindowContent.tsx` | Gallery iterates the merged list (`:652-712`); add "Save as template" to the agent detail view; add an Import entry visible only with `manage`. |
| `src/hooks/useAgentTemplates.ts` (new, but listed here as it parallels `useAgents.ts`) | Fetch + realtime subscription, copied in shape from `src/hooks/useAgents.ts:41-98`. |
| `AGENTS.md` | One line under "Recent cross-cutting features". |

### 4.6 Routes

All under the Fly backend. The frontend's `BACKEND_BASE` resolves to
`https://agensis-backend.fly.dev` (`src/lib/backendClient.ts:10-19`) and
`netlify/functions/backend.mjs` has no `/workspaces/:id/agents` route today, so
these do **not** need a Netlify twin. (I did not run the app to confirm there is
no fallback path; the implementer should verify before assuming.)

| Method + path | Role | Body / returns |
|---|---|---|
| `GET /backend/workspaces/:id/agent-templates` | `read` | Returns `{ data: { bundled: AgentTemplate[], authored: StoredTemplate[], merged: AgentTemplate[] } }`. Merged is what the gallery renders; the split is kept so the UI can badge "authored here" vs "built in". |
| `POST /backend/workspaces/:id/agent-templates` | `write` | Body is a template draft. Runs `normalizeAgentTemplate`; `source='authored'`. Rejects any never-carried key with a 400 naming the key rather than silently dropping it — a silent drop is how a user believes they exported a permission mode. |
| `PATCH /backend/workspaces/:id/agent-templates/:templateId` | `write` | Same validator; bumps `revision`. |
| `DELETE /backend/workspaces/:id/agent-templates/:templateId` | `write` | Hard delete; templates are not agents and carry no history. |
| `POST /backend/workspaces/:id/agent-templates/from-agent/:agentId` | `write` | Reads the agent row, runs `agentToTemplateDraft` (which copies only `CARRIED_FIELDS`), stores with `source='derived'`. |
| `GET /backend/workspaces/:id/agent-templates/:templateId/export` | `read` | Returns the envelope (4.7) as `application/json` with a `Content-Disposition` filename. |
| `POST /backend/workspaces/:id/agent-templates/import` | **`manage`** | Body `{ envelope }`. Validates, computes the SHA-256, stores with `source='imported'` and a populated `origin`. Rate-limited like the other write routes. |

No new WebSocket message types. The gallery uses the existing
`db_changes`/`notifyDbSubscribers` fanout, which requires only that the table is
workspace-scoped and in the allowlists.

### 4.7 The envelope

```json
{
  "kind": "agensis.agent-template",
  "envelopeVersion": 1,
  "exportedAt": "2026-07-29T00:00:00.000Z",
  "statedOrigin": { "workspaceName": "…", "exportedBy": "…" },
  "template": {
    "slug": "security-reviewer",
    "name": "Security Reviewer",
    "category": "Engineering",
    "description": "…",
    "handleHint": "sec-reviewer",
    "systemPrompt": "…",
    "soul": "…",
    "instructions": "…",
    "tools": [],
    "skills": ["security-review"],
    "model": "auto",
    "runMode": "daemon",
    "runtime": "claude",
    "avatar": "",
    "accentColor": "#00a95c"
  }
}
```

`statedOrigin` is a claim and is stored and displayed as one. `envelopeVersion`
is checked and an unknown version is refused rather than best-effort parsed.
There is deliberately **no signature and no checksum inside the envelope** — a
self-signed artifact proves nothing about who wrote it, and buzz's own spec has
signatures as "TBD" (spec section 11). The SHA-256 we store is computed on
receipt, so it identifies *this* import, which is the question anyone will
actually ask.

---

## 5. Test plan

The globs matter and have bitten twice. Backend tests must be at
`tests/*.test.cjs` — **top level only**, a subdirectory is never run. Frontend
tests must be at `tests/unit/**/*.test.ts`. See AGENTS.md:251-262.

### 5.1 `tests/agent-template-schema.test.cjs` (backend runner)

Follows `tests/agent-sandbox-schema.test.cjs`. Asserts the column set for
`workspace_agent_templates` is identical across `ensureRuntimeSchema` in
`server/index.cjs`, `database/neon-schema.sql`, and the new migration file.

**Mutation that must break it:** add a column to `ensureRuntimeSchema` only. The
test fails naming the two files that lack it.

### 5.2 `tests/agent-template-import-guard.test.cjs` (backend runner)

The security test. Non-vacuity is the whole design here: the mock DB must
**capture** the values object handed to the insert and the assertions must run
against that captured object. A mock that itself filters privileged keys, or
that restates the `WHERE` clause, tests the mock — this repo has been burned by
exactly that (`tests/skill-agent-access.test.cjs` is the reference for a mock
that answers queries without re-implementing the guard).

| Invariant | Mutation that must break it |
|---|---|
| An import envelope containing `permission_mode: 'yolo'` yields a stored row with no such value, and the captured insert values have no `permission_mode` key | Add `'permission_mode'` to the carried-field list in `shared/agentTemplates.cjs` |
| An envelope containing `metadata: { host_folders: ['/'] }` is dropped entirely | Add `'metadata'` to the carried-field list |
| An envelope containing `metadata: { sandbox_skills: [{ baseUrl: 'http://169.254.169.254' }] }` is dropped, and no `baseUrl` string appears anywhere in the captured insert values | Same as above; this one is asserted separately because it is the SSRF-adjacent path and deserves its own failure message |
| `POST …/import` with a caller holding only `write` is rejected 403 | Change the route's `enforceWorkspaceRole` capability from `'manage'` to `'write'` |
| `POST …/agent-templates` (authoring) with `write` succeeds | Change that route's capability to `'manage'` — catches an over-tightening that would silently remove the feature from editors |
| `source` and `origin` supplied in a generic `/backend/db/insert` body are stripped | Remove the `workspace_agent_templates` entry from `PRIVILEGED_DB_COLUMNS_BY_TABLE` |
| `from-agent` on an agent whose row has `permission_mode: 'yolo'` and `metadata.host_folders` produces a template carrying neither | Change `agentToTemplateDraft` to spread the row instead of picking fields |

### 5.3 `tests/unit/agentTemplateEnvelope.test.ts` (frontend runner)

| Invariant | Mutation that must break it |
|---|---|
| `parseEnvelope(exportEnvelope(t))` is identity on every carried field | Rename a field on one side only |
| Export and import allowlists are the same set | Add a field to the export side only — the asymmetry assertion fails. This is the guard that stops a future field from being exportable-but-not-importable, or worse, importable-but-not-exportable and therefore unreviewed |
| An envelope with `envelopeVersion: 2` is refused, not best-effort parsed | Make the version check a warning |
| A template whose `skills` contains an object rather than a string is refused | Loosen the `string[]` check — this protects the `[object Object]` round-trip trap documented at `server/sandbox-skills.cjs:22-40` |

### 5.4 Extend `tests/unit/agentTemplates.test.ts`

Every entry of the bundled `AGENT_TEMPLATES` passes `normalizeAgentTemplate`
unchanged. Mutation: give a bundled template a field the validator drops — the
test fails, which is the point, because it means the bundled and authored
sources have diverged.

### 5.5 Smoke (`tests/smoke/**/*.smoke.ts`)

Add the template gallery to the smoke gate. It is now data-backed and therefore
capable of showing "no templates" while templates exist — precisely the class the
gate was built for (AGENTS.md:309-326). Assert: with authored templates present,
the gallery shows them and no empty state; and the category filter cannot hide
the control that clears it.

### 5.6 Not tested by any of the above

The persona-size budget check (slice 4) needs a fixture asserting that a template
whose composed persona exceeds ~10 KiB is flagged at authoring time. Put it in
`tests/unit/`. It cannot prove the daemon's behaviour — that lives in the
`agensis-agent` repo — so the test pins our *warning threshold* against
`LEAN_PROMPT_MAX_BYTES` as a literal, with a comment naming
`packages/agensis-cli/src/agensis.mjs:48` so a change there is traceable. This is
a known weak seam: the two repos have no shared constant.

---

## 6. Migration, rollout, risk

### 6.1 Data migration

None. One new table, no backfill, no existing row modified. Reversible with
`DROP TABLE workspace_agent_templates` — with the bundled array retained, the
gallery reverts to exactly today's behaviour.

### 6.2 Deploy lanes

| Lane | Needed? | Why |
|---|---|---|
| `fly deploy` | **Yes** | The DDL is in `ensureRuntimeSchema` (runs on Fly boot) and the new routes are in `server/`. Check the logs after — a lagging Fly has hidden a broken bootstrap before. |
| Netlify | **Yes** | Frontend changes, and `shared/backend-core.cjs` allowlists are imported by `netlify/functions/backend.mjs:33`, which serves the generic `/backend/db/*` routes (`:2010-2166`). If Netlify ships without the allowlist entry, a generic select on the new table 403s from that lane. |
| npm publish `@agensis/agensis-agent` | No | No daemon change. |
| Local daemon restart | No | Same. |

Order: Fly first, then Netlify. Shipping the frontend ahead of Fly produces UI
that calls routes which 404 live — a repeatedly-made mistake in this repo.

### 6.3 Feature flag and rollback

No flag needed if the bundled array stays as the fallback source: with an empty
table, behaviour is byte-identical to today. Concretely, rollback is one of:

1. Revert the frontend (Netlify) — gallery goes back to the bundled array; the
   table sits unused and harmless.
2. Revert the server (Fly) — the routes 404; the frontend's fetch fails and falls
   back to bundled. **The fetch must be written to fall back on failure, not to
   render an error state.** That is a code requirement, not a hope.

### 6.4 Deliberately not in v1

- Any pack format: no zip, no `plugin.json`, no OPS compatibility, no
  `pack.lock`, no `.sha256` sidecar, no registry.
- Multi-persona bundles. One template is one agent. A "team pack" is a folder
  concept and can be added later as a list of slugs.
- Lifecycle hooks. Rejected on the security argument in 2.2, not deferred.
- Per-persona MCP server config. Same.
- The precedence/merge engine (buzz spec section 10). agensis has two levels —
  bundled and authored — and shallow replacement on slug. Five levels with
  null-vs-empty-container semantics is a spec for a problem we do not have.
- Template version history. `revision` counts; nothing is retained.
- Cross-workspace sharing as a *feature* (a picker that lists other workspaces'
  templates). v1 sharing is: export a file, send it however you send files,
  import it. If a picker is wanted, it needs its own thinking about workspace
  groups (`parent_id`) and is not a small addition.
- Making `tools` actually gate the tool surface (section 3.3). Real work, real
  compatibility risk, separate plan.
- Publishing templates outside a workspace. No public registry, no marketplace.

### 6.5 Risk register (ranked)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | A future field is added to the template shape that grants authority — `metadata` is the obvious candidate since it looks like a harmless bag | **Security regression.** `metadata.host_folders` becomes `--add-dir` on a real machine; `metadata.sandbox_skills` carries a `baseUrl` the server fetches and a vault credential key | The column does not exist (4.2); the DDL comment says why; `tests/agent-template-import-guard.test.cjs` fails on the mutation. Three independent barriers, deliberately |
| 2 | A new write path to `workspace_agents` is added "for convenience" — e.g. a one-click "create from template" that inserts server-side and bypasses `stripPrivilegedDbValues` | **Security regression.** Every column guard in `shared/backend-core.cjs:258-318` is on the generic path | Instantiation stays the existing form + generic insert (2.3 point 2). State it in the PR description. There is no server-side create-agent route in this plan and there must not be one |
| 3 | Imported prose social-engineers a workspace — a plausible-looking "Code Reviewer" whose instructions include an exfiltration step | Real, and **not fully solvable** | `manage` gate on import, full body shown before acceptance, stored provenance, and honest UI copy. Do not claim more than this |
| 4 | Persona silently truncated on the daemon lane (section 1 correction) | Feature appears to work and does not | Slice 4's authoring-time budget check; surface the truncation marker if it can be plumbed back. Weak seam: cross-repo constant (5.6) |
| 5 | A template's `skills` names a skill no daemon in the workspace has | Dangling reference; the agent claims a capability it lacks | Resolve skill ids against what the workspace actually has at instantiation time and show unresolved ones as a warning in the form. Properly fixed only by the skill store (2.4) |
| 6 | A test lands outside the runner globs and never runs | Silent loss of the security test | Section 5 names exact paths. Verify with `npm test 2>&1 \| grep agent-template` before believing it |
| 7 | Mock-DB test is vacuous | The security test proves nothing | 5.2's capture-the-values design; each invariant ships with its mutation |
| 8 | Allowlist ships to one backend only | Generic select 403s from Netlify | 6.2 — both lanes, Fly first |
| 9 | Someone "cleans up" the bundled array once the table works | Onboarding breaks and rollback stops working | `tests/unit/agentTemplates.test.ts` already asserts the four onboarding presets exist (`:28-37`); extend the comment there to say why the array must stay |

No data-loss risk. Nothing in this plan writes to or deletes from an existing
table.

### 6.6 Effort

**6 to 7 engineer-days** for slices 1 to 4 plus the full test plan.

- Slice 1 (DDL, allowlists, resolver route, gallery reads it, fallback): 2 days
- Slice 2 (save-as-template): 0.5 day
- Slice 3 (export/import, `manage`-gated route, review dialog): 2 days
- Slice 4 (size budget): 0.5 day
- Tests across both runners, plus schema parity and smoke: 1.5 days
- Three-place schema, both deploys, post-deploy verification: 0.5 day

Confidence: **high** on slices 1, 2 and 4 and on the tests — these are
well-trodden patterns in this repo with close templates to copy. **Medium** on
slice 3, where the review dialog is the usual place scope grows.

Add **8 to 12 days** if the skill store from 2.4 is built first. That estimate is
low-confidence; it is a bigger design question than this document scoped.

**Biggest unknown:** whether the goal is *reuse within a workspace* (which is
slices 1 and 2, about 2.5 days, and closes most of the real gap) or *distribution
between workspaces and people* (slice 3 onward, plus the skill store, plus a
distribution surface this plan deliberately does not design). The pack's phrase
"shareable artifacts" implies the second; everything I can see in agensis today
suggests the first is what is actually missing. **Ask before building slice 3.**

---

## 7. What I could not determine

- Whether the frontend ever falls back to `netlify/functions/backend.mjs` for
  agent-adjacent reads. I confirmed `BACKEND_BASE` resolves to the Fly host
  (`src/lib/backendClient.ts:10-19`) and that no `/workspaces/:id/agents` route
  exists in the Netlify function, but I did not run the app. Verify before
  relying on "Fly-only routes".
- Whether `revision` collides with an existing optimistic-locking convention.
  `workspace_agents.version` is bumped on update (`server/index.cjs:2659`,
  `:2892`) but I found no reader that compares it, so it appears to be a counter
  rather than a lock. Worth a second look before copying the pattern.
- Per the brief, I ran **no** builds, typechecks or test suites, so every claim
  here is from reading source. Nothing in this document has been executed.
