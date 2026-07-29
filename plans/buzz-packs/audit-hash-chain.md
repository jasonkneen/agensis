# audit-hash-chain — Hash-chain audit log

Buzz feature pack #9 (priority 45, domain: security, target surface "server auth +
audit tables"). Source pack:
`/Users/jkneen/Documents/GitHub/repo-grab/out/extract-pack/audit-hash-chain/`.

Planned 2026-07-29 against `main-next` @ `5844ea1`. **No code was written.**

---

## 1. Verdict

**Adopt-modified.** Split the pack in two and ship only the first half.

**Adopt now: a real audit log.** agensis today has **no audit record at all** for
its most sensitive actions. Not a weak one — none. Role changes, member removal,
invite creation and revocation, `permission_mode` flips to `yolo` (unrestricted
shell on the daemon host), permanent tool-permission grants, connect-token
minting and revocation, and every vault secret write all complete without
writing a single durable row anywhere. This is the finding worth acting on, and
it is bigger than the pack that surfaced it.

**Reject the hash chain for v1**, on two independent grounds:

1. *Threat model.* A chain is only evidence if the head is anchored where the
   adversary cannot reach it. agensis runs one Neon Postgres, reached with one
   connection string (`server/index.cjs:698`, `:1806`), with no row-level
   security, no `REVOKE`, and no per-role grants anywhere in
   `database/neon-schema.sql`. The only party who can edit rows behind the app's
   back is the party holding `DATABASE_URL` — which is the operator. A chain
   written by the operator, anchored in the operator's database, verified by the
   operator, against the operator, proves nothing. There is currently no second
   party to anchor to. Until there is, the chain is ceremony.
2. *Cost.* The chain's real price is not SHA-256, it is **serialization**. Every
   entry must read the current tail before it can write, so an independent
   `INSERT` becomes a lock-taking read-modify-write. On a per-workspace chain
   that is a per-workspace write lock on the audit table; on a global chain it
   is a global one. Audit writes sit inline with role changes, token mints and
   secret writes — paths that must never deadlock or stall.

**Adopt a cheaper middle instead of nothing.** v1 stores a per-row `entry_hash`
(SHA-256 over the row's canonical content, no `prev_hash`) plus a `bigserial`
`seq`. That detects *edits* to a row and flags *gaps* suggesting deletion, needs
no lock, and costs two columns. It is honestly weaker than a chain — it cannot
prove ordering and gaps have false positives (a rolled-back transaction consumes
a sequence value) — but it is a real signal at near-zero cost, and it means the
day an external anchor exists, `prev_hash` can be added going forward without
having to pretend the historical rows were ever sealed.

**Defer the chain proper** to a v2 gated on one concrete precondition: a named
external anchor that the `DATABASE_URL` holder cannot write. Section 6 lists the
candidates and why none qualifies today.

### What already exists (verified)

There is an activity trail. It is not an audit record, and the distinction is
not a judgement call — it is settled by two facts in the code.

**Fact one: the activity feed is client-authored.** `src/hooks/useActivity.ts:70`
inserts into `activity_events` straight from the browser via the generic
`/backend/db/insert` route, and there are 11 call sites in `src/App.tsx` alone
(`:1187`, `:1204`, `:1625`, `:1640`, `:1655`, `:1748`, `:1833`, `:1901`,
`:2125`, `:2135`, `:2142`). The client picks the `event_type`, the `title`, the
`entity_id`, the `metadata`, **and the `user_id`** — nothing in
`enforceDbOperationAccess` (`shared/backend-core.cjs:855`) constrains
`activity_events.user_id` to the caller. A member can write a row attributed to
someone else.

**Fact two: it is not append-only.** `DB_TABLE_ACCESS.activity_events` is
`DEFAULT_TABLE_ACCESS` (`shared/backend-core.cjs:204`, defined at `:180-185`) —
`insert: 'write'`, `update: 'write'`, `delete: 'write'`. The table is in
`ALLOWED_TABLES` (`:53`) and `WORKSPACE_SCOPED_TABLES` (`:165`).
`POST /backend/db/delete` (`server/index.cjs:7489`) refuses only an *unfiltered*
delete (`:7494`); with one filter, any `editor` deletes rows.

So the feed is forgeable and erasable by design, at the `write` capability. That
is fine for a feed. It disqualifies it as an audit log, permanently, and it also
means **do not try to promote it** — see section 3.

The six server-side writers, all append-only in practice but not by rule:

| Writer | Location | Event types |
|---|---|---|
| `logMessageActivity` | `server/index.cjs:6264` | `message_sent` |
| `logMessageActivityIdempotent` (Netlify mirror) | `shared/backend-core.cjs:997` | `message_sent` |
| `logConnectionActivity` | `server/index.cjs:6315` | `agent_connected`, `agent_disconnected` |
| `logProviderCallActivity` | `server/index.cjs:4491` | `provider_call` |
| `logProviderCallRefusal` | `server/index.cjs:4539` | `provider_call` (refusal) |
| `logJoinLinkActivity` | `server/index.cjs:2416` | `join_link_created`, `join_link_redeemed` |

`AGENTS.md:139` calls the `provider_call` row "Audit". It is the best of the six
— but it lives in a table any editor can forge a row into with the same
`event_type` and a plausible title, which is precisely the row an owner would
read to answer "what did this agent spend my Stripe key on".

`member_joined` is declared in `src/types/index.ts:381` and mapped in the
Activity window
(`src/components/windows/ActivityWindowContent.tsx:71`, `:129`)
but is **written by no server code** — a dead event type. That is the shape of
the gap: the UI has a slot for membership events; nothing fills it.

### Audit-worthy actions with no record today

Every one of these is `manage`-gated, so the actor is authenticated and
authorized — and entirely untraced:

| Action | Route / function | Recorded? |
|---|---|---|
| Member role change | `server/members-invites-routes.cjs:53-76` | No |
| Member removal | `server/members-invites-routes.cjs:78-97` | No |
| Invite create | `server/members-invites-routes.cjs:123-149` | No |
| Invite revoke | `server/members-invites-routes.cjs:151-166` | No |
| Invite role edit | `server/members-invites-routes.cjs:185` | No |
| `permission_mode` change (incl. `yolo`) | `server/agent-permissions.cjs:543-560` | No |
| Permanent tool grant (`always`) | `server/agent-permissions.cjs:309`, called `:386` | No |
| Permanent grant revoke | `server/agent-permissions.cjs:563-583` | No |
| Connect-token mint / rotate | `server/index.cjs:2868-2927` | No |
| Connect-token revoke (agent disable) | `server/agent-connections.cjs:171` | No |
| Connect-token revoke (farm) | `server/farm-routes.cjs:174` | No |
| Vault secret set | `server/vault-routes.cjs:140-161` | No |
| Vault secret delete | `server/vault-routes.cjs:163-178` | No |
| Sandbox credential set/delete | `server/vault-routes.cjs:210-255` | No |
| Workspace ownership / re-parent | `shared/backend-core.cjs:876-916` | No |

The one exception, and a good precedent: **campaign sends already have a proper
trail** — the `tenant_campaigns` row plus the frozen recipient list in
`tenant_campaign_recipients`, with `created_by` and the sender's email as it read
at send time (`server/tenants-routes.cjs:106-110`), plus a structured
`console.log` at `:190`. The comment there explicitly declines `activity_events`
because a broadcast belongs to no workspace. That reasoning is correct and this
plan does not disturb it. Campaign sends are **out of scope**.

`permission_mode` deserves a callout. `server/agent-permissions.cjs:538-541`
documents that the column sits in `PRIVILEGED_DB_COLUMNS_BY_TABLE`
(`shared/backend-core.cjs:263`) specifically because "any member holding `write`
could flip an agent to `yolo` and hand themselves unrestricted shell on the
daemon host". The guard is right and it works. But when an *admin* legitimately
does it, nothing anywhere records that it happened, who did it, or when. That is
the single highest-value row in this whole plan.

---

## 2. What the pack actually proposes

The pack is thin, and the plan should say so rather than pad. `anchors.json` is
216 bytes: one anchor, `crates/buzz-audit`, whose entire "excerpt" is a directory
listing (`Cargo.toml`, `src`). No source, no schema, no API. `PROMPT.md` and the
`recreation_prompt` in `pack.json` restate the one-line description — "Tamper-
evident hash-chain audit log for sensitive operator and membership actions" —
four times without adding detail.

So the transferable content is: *sensitive operator and membership actions should
produce durable entries, and those entries should be linked by hash so that
deleting or editing one is detectable.* Everything below is designed from
agensis's own code, not reconstructed from buzz.

**Where buzz's assumptions do not transfer:**

- **Rust crate boundary.** `crates/buzz-audit` is a compilation unit with its own
  public API. agensis has no equivalent seam. The nearest analogue is
  `shared/backend-core.cjs`, which both backends import (`AGENTS.md:16-18`), and
  that is where the writer belongs.
- **Nostr event model.** buzz's events are signed by their author's keypair, so
  an entry carries non-repudiable authorship independent of the store. agensis
  has no per-user keypair; identity is a server-issued session token
  (`shared/backend-core.cjs` auth path). Our audit rows are attested by the
  *server*, not by the actor — a weaker claim, and one the plan should not
  overstate. Nobody can prove Jason did not write a row on someone's behalf.
- **Relay model.** buzz can broadcast entries to relays operated by other people,
  which is *exactly* the external anchor a hash chain needs, and it comes free
  with the architecture. agensis has one Postgres and one operator. **This is the
  crux**: the buzz design gets its anchor for free from the relay topology, and
  agensis cannot inherit it. That is why the concept does not transfer whole.
- **Chain over a whole log.** buzz has one global event stream. agensis is
  multi-tenant with hard workspace scoping enforced everywhere
  (`WORKSPACE_SCOPED_TABLES`, `shared/backend-core.cjs:160`). A global chain
  couples unrelated tenants' write throughput; a per-workspace chain multiplies
  the number of heads to anchor. Neither is free.

---

## 3. Impact on our system

### Why a new table, not `activity_events`

Promoting `activity_events` was considered and rejected on four counts:

1. **It is client-authored** (section 1). Making it authoritative would mean
   removing `logEvent` (`src/hooks/useActivity.ts:62-79`) and its 11 call sites,
   which is a rewrite of the Activity feed, not an audit feature.
2. **Read scope is wrong.** `activity_events` selects at `read`
   (`shared/backend-core.cjs:204`) — every member, including `viewer`. Audit rows
   say who changed whose role and which vault key was written. That is
   `manage`-only material.
3. **Realtime fanout is wrong.** `useActivity` subscribes every browser in the
   workspace (`src/hooks/useActivity.ts:45-60`). Audit rows must not fan out to
   viewers.
4. **Retention lifecycles are opposite.** `activity_events` is a firehose — a row
   per chat message (`server/index.cjs:6264`). An audit log needs multi-year
   retention; the firehose needs pruning. Making the firehose append-only would
   freeze it as unprunable forever, which is a real operational problem, not a
   theoretical one.

So: a new `audit_log` table, server-written only, **not in `ALLOWED_TABLES`**,
reachable only through a dedicated `manage`-gated read route. Keeping it out of
`ALLOWED_TABLES` is the strongest available control — `ensureTable`
(`server/index.cjs:7216` onward) rejects unknown tables before any handler runs,
so there is no generic `/backend/db/*` path to it at all. That is a stronger
guarantee than `{insert:'manage', ...}`, which still leaves a route that a future
`manage`-holder or a bug in the gate could travel.

### Subsystems touched

- **`shared/backend-core.cjs`** — gains one exported writer, `recordAuditEntry`,
  and the event-type registry. This is the file both backends import
  (`AGENTS.md:16-18`), so a Netlify-mirrored route logs identically.
- **`server/members-invites-routes.cjs`, `server/agent-permissions.cjs`,
  `server/vault-routes.cjs`, `server/agent-connections.cjs`,
  `server/farm-routes.cjs`, `server/index.cjs`** — each gains call sites. No
  behaviour changes; the writer is fire-and-forget and never fails its caller.
- **`server/realtime.cjs`** — `audit_log` must be absent from subscribable
  tables. It is absent by default (subscription authorization runs through
  `authorizeRealtimeBinding` -> `enforceDbOperationAccess` ->
  `ensureTable`, `server/realtime.cjs:17-18, 148`), so this is a
  *verify-and-pin-with-a-test* item, not a change.
- **Frontend** — one new read-only panel. Nothing existing changes.

### What it breaks

Nothing, if the new table is genuinely new. The migration is additive: one table,
one trigger, one index. No existing column changes type, no existing row moves.

The one place this could break something is the trigger (see 4.2): a
`BEFORE UPDATE OR DELETE` trigger that raises will also refuse *legitimate*
maintenance, including retention pruning. Section 4.2 handles that explicitly
with a `DELETE`-allowed-only-past-a-cutoff carve-out rather than a blanket refusal
that would have to be dropped and recreated by hand every time rows age out.

### Interaction with work in flight

- **`self-update-supervise` (pack #12, shipped in daemon 0.1.43/0.1.44):** no
  overlap. That is daemon-side install management; this is server-side.
- **Permission requests surviving daemon reconnect (shipped today):** touches
  `server/agent-permissions.cjs`, the same file this plan adds two call sites to.
  Rebase risk only, no design conflict.
- **`thread_harvests` + review UI, channel bridges
  (`server/channel-bridges.cjs`):** no overlap. Bridge configuration is arguably
  audit-worthy (an outbound channel to Telegram is a data-egress decision) but is
  deliberately **excluded from v1** — see section 7.
- **Gateway `base_url` SSRF (open finding):** unrelated, but a `gateway_configs`
  write is audit-worthy for the same reason bridges are. Also excluded from v1.

### Security and permission implications

- **Read** requires `manage` on the workspace, enforced by
  `enforceWorkspaceRole(userId, workspaceId, 'manage')` — the same call
  `server/members-invites-routes.cjs:59` already makes. `read`/`write`/`comment`
  holders get 403.
- **Write** is server-only. No route accepts an audit entry from a client, and
  the table is not in `ALLOWED_TABLES`, so `/backend/db/insert` 400s on it before
  authorization is even consulted.
- **Connect-token model:** an agent daemon authenticates with `aga_…` and reaches
  the WS surface, not `/backend/db/*`. The audit read route is `requireAuth`
  (user session) only — a daemon cannot read the audit log. That is deliberate:
  an agent that could read the log could read which vault keys exist by name.
- **Actor recording:** rows record `actor_user_id` from `req.userId` (the
  verified session), never from the request body. An agent-initiated action
  records `actor_agent_id` from the token-resolved agent. Both nullable, never
  both set.

**Correction to the task brief:** it states `shared/backend-core.cjs` is unlinted
because eslint globs `shared/**/*.mjs`. That was true and is now **fixed** —
`eslint.config.js:37` globs `shared/**/*.{cjs,mjs}`, and
`tests/lint-coverage.test.cjs:38` asserts `shared/backend-core.cjs` resolves to a
non-empty rule set specifically so this cannot regress. Growing that file is safe
on those grounds. (It remains a 1,773-line file that both backends depend on, so
"one more export" is still a review-carefully change — just not an unlinted one.)

---

## 4. Exact work breakdown

### 4.1 New table

Belongs in **all three places** (`AGENTS.md:23-31`):
`server/index.cjs` `ensureRuntimeSchema()` (runs on Fly boot),
`database/neon-schema.sql`, and a new
`supabase/migrations/20260730000000_audit_log.sql`.

Place it in `ensureRuntimeSchema` next to `workspace_secrets`
(`server/index.cjs:1403-1414`) — same neighbourhood, same sensitivity.

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_user_id uuid,
  actor_agent_id uuid,
  actor_label text NOT NULL DEFAULT '',
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text,
  target_label text NOT NULL DEFAULT '',
  before_value text NOT NULL DEFAULT '',
  after_value text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_ip text NOT NULL DEFAULT '',
  entry_hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_created
  ON audit_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_log_seq ON audit_log(seq);
```

Two deliberate choices worth defending at review:

- **`workspace_id` is `ON DELETE SET NULL`, not `CASCADE`.** Every other
  workspace-scoped table cascades (`database/neon-schema.sql:853-854` for
  `activity_events`). An audit log must not. "Someone deleted the workspace" is
  the single most audit-worthy action there is, and `CASCADE` would erase the
  evidence of it as a side effect. This is why `workspace_id` is nullable.
- **`before_value` / `after_value` are `text`, not `jsonb`.** They hold short
  scalars — `'editor'` -> `'admin'`, `'default'` -> `'yolo'`. Typed as text they
  cannot accidentally become a place someone dumps a whole row (and with it, a
  secret). See 4.4 on what must never go in them.

### 4.2 Append-only enforcement

Two layers. The API layer (table absent from `ALLOWED_TABLES`) stops every
authenticated client. The DB layer stops app bugs and injection:

```sql
CREATE OR REPLACE FUNCTION audit_log_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log rows are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  -- DELETE is permitted only for rows past the retention horizon, so pruning
  -- never requires dropping this trigger by hand (which is when it stays off).
  IF OLD.created_at > now() - interval '400 days' THEN
    RAISE EXCEPTION 'audit_log rows younger than the retention horizon cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_audit_log_refuse_mutation ON audit_log;
CREATE TRIGGER trg_audit_log_refuse_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_refuse_mutation();
```

This follows the one trigger precedent already in the schema,
`trg_workspaces_reject_parent_cycle` (`database/neon-schema.sql:65-93`, mirrored
in `ensureRuntimeSchema` at `server/index.cjs:1703-1731`) — same
`CREATE OR REPLACE FUNCTION` / `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER` shape,
same `check_violation` errcode, so it is idempotent across Fly boots.

**Be honest about what this trigger is worth.** The app connects as a role that
can `DROP TRIGGER`. Anyone with `DATABASE_URL` disables it in one statement. It
stops app bugs, a SQL-injection reaching a `DELETE`, and a future contributor
adding `audit_log` to `ALLOWED_TABLES` without thinking. It does not stop the
operator, and nothing available in this architecture does.

### 4.3 The writer

New in `shared/backend-core.cjs` (both backends import it, `AGENTS.md:16-18`):

```
recordAuditEntry({ db, workspaceId, actor, action, target, before, after, detail, requestIp })
```

- Fire-and-forget in the same sense as `logProviderCallActivity`
  (`server/index.cjs:4521-4525`): a failed audit write is logged loudly and never
  turns a successful role change into a 500. Awaited so ordinary failures reach
  the server log.
- `action` is validated against an exported `AUDIT_ACTIONS` frozen set. An
  unknown action throws in development and records as `'unknown'` in production —
  a typo must not silently produce an unfilterable row.
- Computes `entry_hash` = `sha256(canonical(workspace_id, actor_user_id,
  actor_agent_id, action, target_type, target_id, before_value, after_value,
  detail, created_at))` using `node:crypto` (already imported,
  `shared/backend-core.cjs:18`). `created_at` is generated in JS and bound, not
  `now()`, so the hash covers the same value the row stores.
- **No `prev_hash`, no read of the tail, no lock.** That is the whole point of
  the v1 shape.
- Binds `detail` as an **object**, never a string — porsager turns a stringified
  `::jsonb` bind into a jsonb string scalar. This is a repo-specific trap with
  its own regression test (`tests/jsonb-bind-hygiene.test.cjs`, cited at
  `server/index.cjs:2418-2419` and `server/tenants-routes.cjs:166-168`).

### 4.4 Redaction rules (non-negotiable)

The audit row must be strictly less sensitive than the thing it describes.
Modelled on `logProviderCallActivity`'s discipline (`server/index.cjs:4486-4490`)
and `logJoinLinkActivity`'s (`server/index.cjs:2412-2414` — "Records the link's
ID, never its token").

| Action | Recorded | Never recorded |
|---|---|---|
| Vault set/delete | key name, `configured` boolean | the value, the ciphertext |
| Connect-token mint | agent id, handle, resulting `permission_mode` | the token, the hash |
| Invite create | invite id, role, email **domain** only | the token, the local-part |
| Role change | member id, old role, new role | the member's email |
| Permanent grant | the rule string, agent id | nothing extra |
| `permission_mode` | old mode, new mode | nothing extra |

Email local-parts are excluded on PII grounds: the audit log has a 400-day
retention and a different erasure path from the user record, so a deleted user's
address must not survive in it. The domain is kept because "someone invited an
external address" is the thing an owner actually needs to see. `target_id`
carries the member row id, which resolves to the current user record at read time
if they still exist — so the log stays useful without duplicating PII.

### 4.5 Call sites

Twelve, one line each, all fire-and-forget:

| File:line | Action recorded |
|---|---|
| `server/members-invites-routes.cjs:70` (after the role UPDATE) | `member.role_changed` |
| `server/members-invites-routes.cjs:92` (after the DELETE) | `member.removed` |
| `server/members-invites-routes.cjs:142` (after the invite INSERT) | `invite.created` |
| `server/members-invites-routes.cjs:161` (after revoke) | `invite.revoked` |
| `server/members-invites-routes.cjs:185` region (role edit) | `invite.role_changed` |
| `server/agent-permissions.cjs:558` (after `setAgentPermissionMode`) | `agent.permission_mode_changed` |
| `server/agent-permissions.cjs:391` (after `grantPermanentRules`) | `agent.permission_rule_granted` |
| `server/agent-permissions.cjs:581` (after revoke) | `agent.permission_rule_revoked` |
| `server/index.cjs:2897` (after `buildAgentConnectionCommand`'s UPDATE) | `agent.connect_token_minted` |
| `server/agent-connections.cjs:171` / `server/farm-routes.cjs:174` | `agent.connect_token_revoked` |
| `server/vault-routes.cjs:157` and `:236` | `vault.secret_set` |
| `server/vault-routes.cjs:172` and `:251` | `vault.secret_deleted` |

Deliberately **not** in v1: workspace ownership transfer and re-parent
(`shared/backend-core.cjs:876-916`) — that gate is inside the generic DB path
rather than a dedicated route, so instrumenting it means threading a writer
through `enforceDbOperationAccess`, which is a change to the hottest
authorization function in the codebase for one event. Section 7 lists it.

### 4.6 Read route

One route, in a new `server/audit-routes.cjs` (mirroring the
`server/vault-routes.cjs` shape — a `mount…Routes(app, deps)` factory):

```
GET /backend/workspaces/:id/audit
  role: manage
  query: ?action=<string>&before=<iso>&limit=<1..200, default 50>
  200 -> { data: AuditEntry[], error: null }
  403 -> non-manage caller
```

Keyset pagination on `(created_at, id)`, not `OFFSET` — the table only grows.
Mounted next to `mountVaultRoutes` (`server/index.cjs:7510`). Rate-limited with
the existing limiter pattern.

**No WebSocket subscription.** Audit rows are read on demand by an owner, not
streamed to browsers.

**Netlify mirror:** the read route is mirrored into
`netlify/functions/backend.mjs` for parity (it is a plain authenticated GET). The
*writers* land wherever the mutating route already lives; routes that exist only
on the Express side stay Express-only. `tests/netlify-parity.test.cjs` covers the
401-before-DB property for the new route.

### 4.7 Frontend

- `src/types/index.ts` — add the `AuditEntry` interface and the `AuditAction`
  union next to `ActivityEventType` (`:371`).
- `src/hooks/useAuditLog.ts` — new. Fetch-only via `backendClient`; **no**
  `useTableSubscription`.
- `src/components/settings/AuditLogPanel.tsx` — new. Mounts as a Settings tab
  beside Vault (which is already `manage`-gated, so the surrounding pattern for
  hiding a tab from non-managers exists). Columns: time, actor, action, target,
  before -> after. Filter by action. "Load more" via keyset cursor.
- No emoji, per repo convention.

### 4.8 Build sequence (vertical slice first)

1. **Slice.** DDL in all three places + trigger + `recordAuditEntry` +
   **one** call site (`agent.permission_mode_changed` — the highest-value row) +
   the read route + backend tests. Ship this. It is independently useful: it
   answers "who put that agent in yolo mode" on day one.
2. Remaining eleven call sites + redaction tests.
3. Read route pagination and filters + Netlify mirror + parity test.
4. Frontend panel.
5. Retention job (section 6).

Steps 1-3 are backend-only (`fly deploy`). Step 4 is frontend-only (Netlify).
They deploy independently and in that order — the panel must not ship before the
route it reads.

---

## 5. Test plan

**The globs matter and have bitten twice.** Backend tests run only from
`tests/*.test.cjs` (`package.json:15` — note the runner takes `.cjs` only; there
are 106 such files and zero `tests/*.test.mjs`, so a `.mjs` test would never
run). Frontend unit tests run only from `tests/unit/**/*.test.ts`
(`vitest.config.ts:8`). Anything else is silently dead.

### `tests/audit-log-append-only.test.cjs`

| Invariant | Mutation that must break it |
|---|---|
| `audit_log` is absent from `ALLOWED_TABLES` | add it -> test fails |
| `audit_log` is absent from `DB_TABLE_ACCESS` | add any mapping -> fails |
| `ensureTable('audit_log')` throws | any allowlisting -> fails |

Reads the real exported sets from `shared/backend-core.cjs`. **Not mock-based**,
so it cannot be vacuous.

### `tests/audit-log-writer.test.cjs`

Drives `recordAuditEntry` with a mock `db(sql, params)` in the style of
`tests/backend-rbac.test.cjs:38-55`. Asserts on the **captured params**, not on
the SQL text — a test that restates the WHERE clause tests the mock.

| Invariant | Mutation that must break it |
|---|---|
| `detail` is bound as an object | bind `JSON.stringify(detail)` -> fails |
| `entry_hash` is non-empty and 64 hex chars | drop the hash computation -> fails |
| Changing any hashed field changes `entry_hash` | hash a constant -> fails |
| A vault entry's params contain no secret value | pass the value through -> fails |
| A connect-token entry's params contain no token or hash | include it -> fails |
| An invite entry contains no local-part | record the full email -> fails |
| A throwing `db` does not reject | remove the try/catch -> fails |
| An unknown `action` does not silently persist | remove the registry check -> fails |

The secret-leak tests are the load-bearing ones. They assert over the **whole
serialized param array**, so a secret arriving via a nested `detail` key is
caught too — that is the failure mode a per-field assertion would miss.

### `tests/audit-log-route.test.cjs`

| Invariant | Mutation that must break it |
|---|---|
| `viewer` / `editor` / `commenter` GET -> 403 | change `'manage'` to `'read'` -> fails |
| Non-member -> 403 | drop the role check -> fails |
| `limit` clamps to 200 | remove the clamp -> fails |
| Response rows carry no `entry_hash` internals beyond the hash itself | widen the projection -> fails |

### `tests/audit-log-realtime.test.cjs`

One invariant: a WS subscribe to `audit_log` is refused. Mutation: add the table
to the subscribable set -> fails. This pins a property that currently holds by
accident (via `ensureTable`) and would otherwise silently break the day someone
allowlists the table for the read route's convenience.

### `tests/unit/auditLogPanel.test.ts` (vitest)

Pure formatting only — actor label, `before -> after` rendering, empty-state.
No component mount needed if the formatter is extracted to
`src/lib/auditEntry.ts`, mirroring `src/lib/activityEntry.ts`. Prefer that.

### Schema parity

`tests/*.test.cjs` already contains schema-shape tests (e.g.
`agent-sandbox-schema.test.cjs`, `canvas-layers-schema.test.cjs`). Add
`audit_log` to whichever asserts the three-place sync, or add a case to a new
`tests/audit-log-schema.test.cjs` asserting the table appears in
`server/index.cjs`, `database/neon-schema.sql` and the migration.

---

## 6. Migration and rollout

**Data migration: none.** Purely additive — one table, one function, one trigger,
four indexes. Nothing backfills, because there is nothing to backfill: the actions
this logs left no trace to reconstruct from. The log starts empty and starts
being true from its first row. Say that in the UI empty state rather than letting
someone assume the absence of rows means the absence of actions.

**Reversible:** yes, completely. `DROP TABLE audit_log CASCADE` plus reverting
the call sites. Because nothing reads the table except its own panel, and nothing
writes it except its own writer, the blast radius of a rollback is the feature
itself.

**Deploy lanes** (per the `deploy-targets` rules):

| Lane | Needed? | Why |
|---|---|---|
| `fly deploy` | **Yes** | `server/index.cjs` DDL in `ensureRuntimeSchema` runs on Fly boot; all routes and writers are server-side |
| Netlify (frontend) | **Yes, for step 4 only** | `src/**` panel, auto-deploys on push |
| npm publish `@agensis/agensis-agent` | **No** | no daemon change |
| Local daemon restart | **No** | no daemon change |

Order: **Fly first, then Netlify.** The panel calls a route that must already
exist, and `/backend/health` does not tell you whether a specific route is live —
probe with an unauthenticated POST (401 = exists, 404 = missing). Check Fly logs
after the deploy: a mocked-DB test cannot catch a column that does not exist, and
a bootstrap DDL failure surfaces only there.

**Feature flag:** none needed for the writers — a table nothing reads is inert.
Gate the *panel* behind a simple env-driven flag if step 4 wants to ship ahead of
step 3.

**Rollback, concretely:** revert the commit and `fly deploy`. The table stays
(harmless, unwritten). No data is lost because no other feature depends on it.

**Retention:** rows expire at 400 days, enforced by the trigger's horizon. v1
does **not** ship an automatic pruner — a scheduled `DELETE` against the audit
table is itself a dangerous piece of machinery, and 400 days of these rows is a
few megabytes at agensis's volume. Ship the horizon in the trigger so pruning is
*possible*, and add the job when the table is actually large. Note this as
deliberate in the PR so it does not read as an oversight.

**The chain's precondition, for whoever revisits this.** v2 adds `prev_hash` and
a verifier only when an anchor exists that the `DATABASE_URL` holder cannot
write. Assessed today:

- *Netlify deploy logs / a git commit in a sibling repo* — same operator
  controls both. Fails.
- *Fly logs* — same operator, and they roll. Fails.
- *A daily digest emailed to workspace owners* — actually the strongest cheap
  option, because recipients hold copies the operator cannot retract. Weak
  (nobody checks) but genuinely external. **This is the one to build first if the
  chain is ever wanted.**
- *Object-locked S3 in a separate account with separate credentials* — works, and
  is the right answer for a compliance-driven customer. Real setup cost.
- *A public transparency log* — works, but publishes the existence and timing of
  a workspace's privileged actions. Almost certainly unacceptable.

Without one of the last three, do not build the chain.

---

## 7. Risks, effort, and what is not being built

### Risk register (ranked)

1. **A secret leaks into an audit row.** Highest severity by a distance: the
   audit log has longer retention than most tables and a `manage`-gated read that
   an owner will grep. A vault value or a connect token landing in `detail` would
   be worse than the gap this plan closes. *Mitigation:* the redaction table in
   4.4 is a hard contract; the writer tests assert over the whole param array so
   a nested key cannot slip through; `before_value`/`after_value` are typed
   `text` specifically so nobody dumps a row into them.
2. **Audit writes break a `manage` action.** A synchronous write that throws
   inside a role-change handler turns a working feature into a 500. *Mitigation:*
   fire-and-forget with an internal try/catch, matching
   `logProviderCallActivity` (`server/index.cjs:4521-4525`); a test asserts a
   throwing `db` does not reject.
3. **The trigger blocks a legitimate operation.** A blanket `BEFORE DELETE`
   refusal makes retention pruning impossible without dropping the trigger — and
   a trigger dropped for maintenance is a trigger that stays off. *Mitigation:*
   the 400-day carve-out in 4.2, so pruning never needs the trigger disabled.
4. **The table is allowlisted later "for convenience".** The read route works
   fine without `ALLOWED_TABLES`; a future contributor wanting `backendClient
   .from('audit_log')` would add it and silently restore generic write access.
   *Mitigation:* `tests/audit-log-append-only.test.cjs` fails on exactly that
   mutation, and the test file says why.
5. **False confidence.** Shipping something called an audit log invites the
   assumption that it is tamper-*proof*. It is tamper-*evident against app-level
   actors only*. *Mitigation:* say so in the panel's own copy and in `AGENTS.md`.
   This is the risk most likely to actually bite, because it is social.
6. **`ON DELETE SET NULL` orphans rows.** Deleting a workspace leaves audit rows
   with a null `workspace_id` that the `manage`-scoped read route can no longer
   reach. That is intentional (evidence outlives the thing it describes) but it
   means those rows are DB-only until someone writes an owner-level view.
   *Mitigation:* note it; do not build the view in v1.
7. **Three-place schema drift.** The repo's documented #1 footgun
   (`AGENTS.md:23`). *Mitigation:* schema parity test in section 5.
8. **Volume.** Twelve call sites on `manage`-gated actions is a handful of rows
   per workspace per week — three to four orders of magnitude below the
   `message_sent` firehose. Cost is negligible; measured against
   `activity_events`, not guessed. The cost that would have mattered is the
   chain's serialization, and v1 does not have it.

Data-loss or security-regression candidates: **1** (security regression), **3**
(evidence loss via a disabled trigger), **6** (evidence becomes unreachable).

### Effort

**4 to 6 engineer-days**, moderate confidence.

- DDL in three places + trigger: 0.5d
- `recordAuditEntry` + registry + hashing: 0.5d
- Twelve call sites: 1d (mechanical, but each needs its redaction decision made)
- Read route + Netlify mirror: 0.75d
- Backend tests: 1d (the redaction tests are the careful part)
- Frontend panel + formatter + vitest: 1d
- Deploy, verify on Fly, docs: 0.5d

**Biggest unknown:** whether the twelve call sites all have the actor and the
before-value in scope at the point the write happens. Most do —
`server/members-invites-routes.cjs:64-70` has `req.userId` and the row, but
`rows[0]` is the *post*-update row, so the old role needs a `SELECT` first or a
`returning` on a CTE. That kind of small restructuring, times twelve, is where
this could grow past 6 days. It does not change the design.

**Confidence is lower on the frontend** (1d assumes the Settings tab pattern
drops in cleanly next to Vault) than on the backend.

### Deliberately NOT in v1

- **The hash chain.** `prev_hash`, the tail read, the verifier, the anchor. This
  is the pack's headline and it is being declined on the reasoning in section 1.
- **Any external anchoring**, including the daily digest email.
- **Automatic retention pruning** (the horizon ships; the job does not).
- **Workspace ownership transfer / re-parent auditing** — requires threading a
  writer through `enforceDbOperationAccess`, the hottest authorization function
  in the codebase, for one event.
- **Channel-bridge and gateway-config auditing** — both genuinely audit-worthy
  (data egress decisions) and both easy to add in v2 once the writer exists.
- **Campaign-send auditing** — already has a better trail
  (`server/tenants-routes.cjs:106-110`).
- **Export / SIEM forwarding.**
- **Realtime streaming of audit rows.**
- **Per-user keypair signing** (buzz's model; agensis has no user keys).
- **Fixing `activity_events`'s forgeability.** Related and worth its own plan —
  see below — but promoting the feed is not this feature, and a separate table is
  the right home regardless.

### One finding to file separately

Independent of this pack: `activity_events` is client-writable at `write`
(`shared/backend-core.cjs:204`; `src/hooks/useActivity.ts:70`), with no
constraint on `event_type` or on `user_id` matching the caller. A member holding
`editor` can insert a row that reads
`@scout called stripe charges.create (200)` with `event_type: 'provider_call'`,
which is the exact row `AGENTS.md:139` describes as the audit trail for
credentialed agent calls, and can attribute it to another user. They can also
delete real ones via `POST /backend/db/delete` with a single filter
(`server/index.cjs:7489`).

This is not fixable by tightening `DB_TABLE_ACCESS` — the client legitimately
writes eleven event types from `src/App.tsx`. The realistic fix is a
**server-side allowlist of client-writable `event_type` values**, rejecting the
server-authored ones (`provider_call`, `join_link_*`, `agent_connected`,
`agent_disconnected`, `message_sent`) on the generic insert path, plus forcing
`user_id` to the caller. That is a small, self-contained change and it should be
its own plan, not smuggled into this one.
