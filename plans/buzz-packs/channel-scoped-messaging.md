# Pack 4 — channel-scoped-messaging

Source pack: `/Users/jkneen/Documents/GitHub/repo-grab/out/extract-pack/channel-scoped-messaging/`
Domain: messaging. Rank 4, priority 80. Stated target surface: "server channel model + src channel UI".
Audited against `main-next` on 2026-07-29.

---

## 1. Verdict

**Adopt-modified, and heavily narrowed. Reject the pack's premise.**

The pack's stated goal — "channels as first-class scopes … not global free-for-all
message dumps" — describes something agensis already has, and has in a stronger form
than buzz's. `messages` has no `workspace_id` column at all; a message can only be
reached through `session_id -> chat_sessions.workspace_id`, so channel scoping is a
*structural* property of the schema rather than a convention a query can forget.
Every read path I traced is scoped: the paginated transcript route binds
`session_id = $1` (`server/sessions-routes.cjs:121-126`), the generic
`POST /backend/db/select` refuses any `messages` filter it cannot resolve to a
workspace (`shared/backend-core.cjs:551-555`, `:575-580`, `:953-957`), the realtime
subscribe path runs the *same* resolver before accepting a binding
(`server/realtime.cjs:331-332`), and the client subscribes with an explicit
`session_id=eq.<id>` filter (`src/hooks/useChat.ts:200-208`). Thread counters exist in
three places already (`src/hooks/useChat.ts:442-450`, `src/lib/threadSummary.ts:54-105`,
`server/thread-inbox.cjs:80-94`). There is no global message dump to remove. Building
the pack as written would be re-implementing the system we have.

What the audit *did* find is four concrete defects and one architectural limit that
the pack's framing usefully surfaces. Those are the work, and they are cheap:

| id | what | kind | file |
| --- | --- | --- | --- |
| F1 | The thread-inbox `replies` CTE aggregates **every tenant's** thread replies for 30 days, then throws almost all of it away | perf, cross-tenant scan | `server/thread-inbox.cjs:80-94` |
| F2 | The server-side `replyCount` counts `tool_step` rows; the two client counters do not. The same thread shows two different numbers | correctness, user-visible | `server/thread-inbox.cjs:82` vs `src/hooks/useChat.ts:445` |
| F3 | The agent-status broadcast keys on `row.workspace_id`, a column `messages` does not have, so it never fires. Its test invents the column and passes | dead feature + vacuous test | `server/realtime.cjs:217`, `tests/agentStatusBroadcast.test.cjs:33-42` |
| F4 | `taskThreadLastWordAt` filters `messages.source_task_id` alone, but the only index is `(session_id, source_task_id)` — unusable, so this is a sequential scan evaluated per task | perf | `server/task-dispatch.cjs:211-221`, index at `database/neon-schema.sql:266` |
| S1 | Read authorization has exactly one granularity: the workspace. There is no channel- or DM-level check anywhere | design limit, documented assumption | `server/index.cjs:3749-3752` |

F1–F4 are the v1. S1 is a decision for Jason, not a fix (section 3.3).

The Nostr side of the pack — group/`h` tags, kind integers, signed events, a relay as
single source of truth — is **rejected outright** and no part of this plan implements
it. See section 2.2.

---

## 2. What the pack actually proposes

### 2.1 The concept

The pack is thin. Its three `code_anchors` are two bare directory listings
(`crates/buzz-relay`, `crates/buzz-db` — literally `Cargo.toml` / `src`) and a truncated
excerpt of buzz's `ARCHITECTURE.md`. There is no source, no schema, no query, and no
API shape to compare against. Everything actionable is the one-line description,
repeated verbatim four times across `pack.json`, `PROMPT.md` and `recommendation.json`:

> Channels as first-class scopes (group/h tags), thread counters, and filters that
> always scope queries to a channel — not global free-for-all message dumps.

Reduced to its two `interfaces`:

1. All message queries scoped to a channel/workspace id.
2. Thread/reply counters, or an equivalent aggregation.

In buzz that means: every event carries an `h` tag naming its group; the relay indexes
on that tag; a `REQ` subscription filters on it; and a client that omits the tag gets
nothing rather than everything. The scoping is enforced by *convention plus index* —
a tag is a string in an array, and a query that forgets it is syntactically valid.

### 2.2 Where buzz's assumptions do not transfer

- **Nostr events and `kind` integers.** buzz's whole extensibility story is "add a
  feature by defining a new kind number". agensis has a typed Postgres schema, a
  three-place schema rule (`AGENTS.md:22-30`), and `message_kind` as a *text* column
  with three values. Adopting kind integers would replace a checked schema with an
  untyped namespace. Reject.
- **The `h`/group tag itself.** A tag is a weaker construct than a foreign key. Our
  equivalent is `messages.session_id uuid REFERENCES chat_sessions(id) ON DELETE
  CASCADE` (`database/neon-schema.sql:212`) — not nullable in practice, enforced by
  Postgres, and cascade-deleted. Swapping an FK for a tag is a downgrade. Reject.
- **The relay as single source of truth over one WebSocket.** We have a Node/Express
  server plus a WS fanout, and the WS path is deliberately *not* the write path:
  `server/realtime.cjs` authorizes subscriptions and relays, but writes go through
  HTTP routes with RBAC. Merging them would collapse a boundary that currently works.
  Reject.
- **Signed events / client-side signatures.** We authorize with a session token
  (`shared/backend-core.cjs:406-436`) and an agent connect token (`aga_…`). No transfer.
- **`resolve_host(connection.host)` per-community tenancy.** Our tenant boundary is
  `workspaces.id` carried in the path or the filter, not the HTTP Host header.

What *does* transfer is the pack's discipline as an audit lens: "find the query that
forgot the scope". Applied to agensis it found F1 and F4. That is the pack's real value.

---

## 3. Impact on our system

### 3.1 What already exists (the "do we have this?" pass)

**Channel scoping — already structural.**
`messages` carries no workspace id (every column: `database/neon-schema.sql:210-220`,
`:224`, `:241-250`, `:261`, `:265`, `:1071`, `:1224`; runtime ALTERs
`server/index.cjs:1192-1254`). The only route from a message to a tenant is
`session_id -> chat_sessions.workspace_id`. This is why every scoped query in the repo
either binds `session_id` or joins `chat_sessions` — there is no shortcut to skip.

**The generic DB path is fail-closed for messages.**
`resolveOperationWorkspace` (`shared/backend-core.cjs:547-581`) resolves a `messages`
operation only through `values.session_id` on insert (`:551-554`) or an `eq` filter on
`session_id` on select (`:561-573`). `messages` is deliberately absent from
`WORKSPACE_SCOPED_TABLES` (`:160-170`), so the `id`-filter fallback at `:575-579`
does **not** apply to it — a select filtered only on `messages.id` returns
`{ unscoped: true }` and is rejected with a 400 at `:955`. Note the special case at
`:918`: `messages` is admitted to the RBAC block by name precisely because it is not in
the scoped-table set. An unfiltered `select` on `messages` cannot be expressed.

I checked whether a filter set could *widen* rather than narrow. It cannot:
`buildWhereClause` (`server/lib/db-sql.cjs:112-140`) supports exactly two operators
(`eq`, and `not is null`) and joins them with `AND`. There is no `or`, no `in`, no
`neq`. Every additional filter can only shrink the result set, so authorizing from one
`eq` filter and then running the client's whole filter list is sound.

**Realtime cannot leak another channel's rows.**
`authorizeRealtimeBinding` (`server/realtime.cjs:319-333`) parses the subscription
filter with the same `column=eq.value` grammar the fanout uses (`:121-126`), converts it
into a one-element filter list, and hands it to `enforceDbOperationAccess`. An
unparseable or absent filter produces `filters = []`, which for `messages` resolves
`unscoped` and throws. So the `if (!parsed) return true` fallback in `matchesFilter`
(`:130`) — which would otherwise match every row — is unreachable for `messages`,
because no such subscription can be authorized in the first place. Membership changes
re-authorize live subscriptions and drop the ones that no longer pass
(`revokeRealtimeAccessForMember`, `:140-158`). I could not construct a leak here.

**Thread counters — three of them, all real.**
- `threadReplyCounts` (`src/hooks/useChat.ts:442-450`) — per parent, tool steps excluded.
- `buildThreadReplySummaries` (`src/lib/threadSummary.ts:54-105`) — count, `toolCount`,
  `lastReplyAt`, capped participant avatars, overflow. Tool steps split out at `:69-75`.
- `buildThreadInboxSql` (`server/thread-inbox.cjs:76-143`) — server-side `reply_count`,
  `last_reply_at`, `human_replied`, unread-vs-marker, for the sidebar Threads list.

The client pair is computed over the in-memory transcript. That is safe despite the
transcript being a *page*: `/backend/sessions/:id/messages` returns a contiguous
newest-N window (`server/sessions-routes.cjs:120-128`), and a reply is always newer than
its parent, so if a parent is in the window every one of its replies is too. The
counts cannot silently under-report.

**The two thread lanes are documented and distinct.** `server/thread-inbox.cjs:11-23`
draws the line: a *sub-thread session* is `chat_sessions.parent_message_id` (12 of them);
a *message thread* is `messages.thread_parent_id` (1039). The sidebar Threads list is
about the second. `shared/tenant-admin.cjs:236-244` uses the same conventions to
classify `chat_sessions` into channel / DM / thread / huddle transcript. Nothing in
this plan changes either lane.

### 3.2 The four defects, in detail

#### F1 — the thread-inbox `replies` CTE is not workspace-scoped

`server/thread-inbox.cjs:80-94`:

```sql
with replies as (
  select r.thread_parent_id as parent_id,
         count(*) as reply_count,
         max(r.created_at) as last_reply_at,
         bool_or(...) as human_replied
    from messages r
   where r.thread_parent_id is not null
     and r.deleted_at is null
     and r.created_at > now() - interval '30 days'
   group by r.thread_parent_id
)
```

There is no workspace or session predicate. The workspace filter arrives two joins
later, at `:113-115` (`join chat_sessions s on s.id = p.session_id and s.workspace_id
= $1::uuid`). Postgres cannot push a qualifier on `chat_sessions` through a `GROUP BY`
on `messages` into the aggregate, so this genuinely aggregates **every tenant's** thread
replies from the last 30 days on every load of the sidebar Threads list
(`GET /backend/workspaces/:workspaceId/threads`, `server/inbox-routes.cjs:24-39`).

Cost scales with total platform message volume, not with the requesting workspace.
At today's 1039 threads it is invisible; it is a slow leak that gets worse with every
tenant we add and never shows up in single-tenant testing.

This is **not** a data leak. The outer join filters correctly and no other workspace's
content reaches the response. It is purely a scan-amplification bug — but it is exactly
the failure the pack names, and it is the one query in the repo that fits the
description.

The contrast that proves it is an oversight rather than a design choice: the *inbox*
SQL right next door scopes every one of its six union branches inside the branch —
`ti.workspace_id = $1::uuid` (`server/index.cjs:3386`), `dc.workspace_id = $1::uuid`
(`:3407`), `tc.workspace_id = $1::uuid` (`:3429`), `mc.workspace_id = $1::uuid`
(`:3449`), `ae.workspace_id = $1::uuid` (`:3467`), `j.workspace_id = $1::uuid`
(`:3490`). Same author, same file family, same `$1`. The threads query is the outlier.

#### F2 — the server-side reply count disagrees with the client's

`server/thread-inbox.cjs:82` is a bare `count(*)`. Tool steps are inserted as ordinary
message rows carrying `thread_parent_id` — `role='assistant'`, `sender_kind='agent'`,
`message_kind='tool_step'` (`server/agent-jobs.cjs:1056-1061`). Both client counters
explicitly exclude them (`src/hooks/useChat.ts:444`, `src/lib/threadSummary.ts:72-74`),
which was a deliberate correctness fix: "a chip that folds a Bash step into 'N replies'
reads as the agent having said more than it did".

That fix never reached the server counter. The result is visible in the product:
- `src/components/layout/Sidebar.tsx:789` renders `threadReplyLabel(thread.replyCount)`
  from the server — **tool steps included**.
- `src/components/windows/ChatWindowContent.tsx:2682` renders `replyCount` from
  `threadReplyCounts` — **tool steps excluded**.

An agent turn with 20 Bash calls shows "21 replies" in the sidebar and "1 reply" in the
channel, for the same thread, on the same screen.

Two secondary effects of the same omission:
- The last-reply preview lateral (`:122-129`) has no `message_kind` filter, so
  `lastReplyPreview` can be a tool-step line (`Bash · npm test`) rather than the agent's
  actual answer.
- `last_reply_at` is `max(created_at)` over all replies including tool steps, so a
  thread flips to unread because a tool chip landed. That one is arguably *correct*
  (activity is activity) and I am proposing to leave it — but it should be a stated
  decision, not an accident, and it should be inconsistent with `reply_count` on
  purpose rather than by omission.

#### F3 — the agent-status broadcast has never fired

`server/realtime.cjs:215-226` emits a lean `agent_status` broadcast for agent-authored
message rows:

```js
if (!row || row.sender_kind !== 'agent' || !row.sender_id || !row.workspace_id) continue;
relayBroadcast(`agent-status:${row.workspace_id}`, 'agent_status', { … });
```

`messages` has no `workspace_id` column — verified against every DDL site that touches
the table (`database/neon-schema.sql:210-220`, `:224`, `:241-250`, `:261`, `:265`,
`:1071`, `:1224`; `server/index.cjs:1192-1254`). Every one of the ~18 call sites passes
rows straight out of `insert into messages … returning *` (e.g.
`server/agent-jobs.cjs:1061`, `:518`, `:1184`; `server/builtin-turn.cjs:427`, `:511`;
`server/index.cjs:5369`; `server/mcp.cjs:1617`). I checked for enrichment at every call
site and found none. So `row.workspace_id` is always `undefined`, the guard always
short-circuits, and `relayBroadcast` is never reached.

The consumer is `src/hooks/useAgentStatusFeed.ts:181-195`, which subscribes to
`agent-status:${workspaceId}` and waits for a payload that never arrives. The sidebar's
live activity line ("thinking → reading → editing → done") is inert; it sits on the two
generic presence strings for the whole job.

`tests/agentStatusBroadcast.test.cjs` passes because its fixtures hand-construct rows
with `workspace_id: 'ws-1'` (`:33-42`, `:61-67`, `:77-79`, `:92-94`). It is testing a
row shape that no production code path produces. This is precisely the vacuous-mock
failure mode: the test restates the guard instead of exercising the caller.

Worth naming the near-miss: `server/huddles.cjs:934-935` documents `sender_kind='system'`
as what "keeps it out of the agent-status broadcast in notifyDbSubscribers" — written by
someone who reasonably believed the broadcast was live.

#### F4 — the task-thread subquery cannot use its index

`taskThreadLastWordAt` (`server/task-dispatch.cjs:211-221`) is:

```sql
select max(m.created_at)
  from messages m
  join messages root on root.id = coalesce(m.thread_parent_id, m.id)
 where root.source_task_id = <task>.id
   and root.thread_parent_id is null
   and root.deleted_at is null and m.deleted_at is null
   and m.sender_kind <cmp> 'agent'
```

The only index covering `source_task_id` is
`idx_messages_source_task_id ON messages(session_id, source_task_id)`
(`database/neon-schema.sql:266`, `server/index.cjs:1255`). Postgres has no index skip
scan, so a predicate on the *trailing* column alone cannot use it — this degrades to a
sequential scan of `messages`.

It is then embedded in `taskWaitingSql` (`:226-231`), which evaluates it **twice** (once
with `=`, once with `<>`), and `taskWaitingSql` appears in the WHERE of the queue drain
(`:476`) and twice more in the queue-position query (`:271`, `:273`). This is the
hottest scan on the table and it runs on every task dispatch.

Not a security issue: `root.source_task_id` correlates to a `tasks` row that is itself
workspace-filtered. Purely cost.

### 3.3 S1 — where scoping becomes a security story

**Read authorization in agensis has exactly one granularity: the workspace.**

Every read path resolves a `workspace_id` and calls `enforceWorkspaceRole(userId,
workspaceId, 'read')`. Below that, scoping is done by *filtering* — the SQL narrows to a
session because the caller asked for that session, not because a permission check said
that caller may see it. There is no per-channel ACL, no DM participant check, and no
`chat_sessions`-level capability anywhere in the codebase.

Concretely, a workspace member holding only `viewer` (the weakest role,
`shared/backend-core.cjs:177`) can:

- read the full transcript of **any** session in the workspace via
  `GET /backend/sessions/:id/messages` (`server/sessions-routes.cjs:95-133`) — the check
  is `enforceWorkspaceRole(…, 'read')` at `:101` and nothing else;
- receive **any** session's live rows by subscribing with
  `session_id=eq.<that session>` (`server/realtime.cjs:331-332`);
- pull every session in the workspace, including every DM, from the bootstrap payload
  (`server/index.cjs:3247-3251`).

And an agent's MCP identity is likewise workspace-level: `search_messages`
(`server/mcp.cjs:367-398`) does a substring search across every channel *and every DM*
in the workspace, and `list_channels` (`:289-320`) enumerates all of them.
`buildAgentActivityDigest` (`server/index.cjs:4174-4200`) crosses sessions too, though it
is correctly narrowed to the agent's own authored rows.

This is a **stated assumption, not an oversight**. `server/index.cjs:3749-3752`:

> Resolve (or lazily create) the human↔agent Direct message session for an agent. …
> **Workspaces are effectively single-human, so the DM keys on the agent alone.**

Under that assumption everything above is fine: a DM is a human talking to an agent,
and an agent is a workspace resource, not a person with privacy. But the product
contradicts the assumption — `workspace_members`, five distinct roles, an invite flow,
and `revokeRealtimeAccessForMember` all exist to support multi-human workspaces. The
moment a second human joins, "my DM with @coder" is readable by every viewer in the
workspace, and nothing in the code will object.

**Recommendation: do not fix this in v1, and do not let it ride silently either.**
Adding a channel-level ACL is a large piece of work (a `chat_session_members` table, a
new capability, a migration for 1000+ existing sessions, and a rewrite of every read
path listed above) and it is a *product* decision about what a DM means here, not a bug
fix. What v1 should do is make the assumption explicit and testable: a comment at the
DM creation site is not enough. See the S1 work item in section 4.

---

## 4. Work breakdown

Ordered. Step 0 is the vertical slice: one query, one counter, one test file, shippable
alone.

### Step 0 — F1 + F2 together (the vertical slice)

They are the same twelve lines of SQL, so splitting them costs two deploys for one edit.

**Modify `server/thread-inbox.cjs`** — scope the `replies` CTE and split the counters.
Replace `:80-94` with:

```sql
with replies as (
  select r.thread_parent_id as parent_id,
         count(*) filter (where coalesce(r.message_kind, '') <> 'tool_step') as reply_count,
         count(*) filter (where coalesce(r.message_kind, '') = 'tool_step')  as tool_count,
         max(r.created_at) as last_reply_at,
         bool_or(r.role = 'user' and coalesce(r.sender_kind, '') <> 'system'
                 and coalesce(r.sender_kind, '') <> 'agent') as human_replied
    from messages r
    join chat_sessions rs
      on rs.id = r.session_id
     and rs.workspace_id = $1::uuid
     and rs.deleted_at is null
   where r.thread_parent_id is not null
     and r.deleted_at is null
     and r.created_at > <window>
   group by r.thread_parent_id
)
```

and change the last-reply lateral (`:122-129`) to skip tool steps:

```sql
  left join lateral (
    select m.content, m.sender_name
      from messages m
     where m.thread_parent_id = x.parent_id
       and m.deleted_at is null
       and coalesce(m.message_kind, '') <> 'tool_step'
     order by m.created_at desc
     limit 1
  ) last_msg on true
```

Three decisions to record in the file's header comment, because each is a place a
future edit will get it wrong:

1. `last_reply_at` deliberately still spans **all** replies including tool steps — it
   drives ordering and unread, and a thread where the agent is actively working *is*
   recent. It is intentionally inconsistent with `reply_count`.
2. A thread whose only replies are tool steps now has `reply_count = 0` but a non-zero
   `tool_count`. It stays in the list (the agent is working; that is worth seeing) and
   the sidebar renders the tool count instead of "0 replies".
3. The workspace join goes in the CTE **in addition to** the existing outer join at
   `:113-115`, not instead of it. Redundant, and cheap, and the outer one is what the
   existing tests pin.

**Modify `server/thread-inbox.cjs` `toThreadInboxItem` (`:146-160`)** — add
`toolCount: Number(row.tool_count) || 0` to the wire shape.

**Modify `src/lib/threadInbox.ts`** — add `toolCount: number` to the item type
(alongside `replyCount` at `:21`), mirroring `ThreadReplySummary.toolCount` in
`src/lib/threadSummary.ts:20`.

**Modify `src/components/layout/Sidebar.tsx:789`** — render the tool count next to the
reply label so the sidebar and the channel row now agree on the reply number and both
account for tool work. Reuse the phrasing already used in
`src/components/windows/ChatWindowContent.tsx:2686`.

No DDL. No new route. No migration. Frontend + backend, so both Netlify and `fly deploy`.

### Step 1 — F4, the index

**DDL (all three places, per `AGENTS.md:22-30`):**

```sql
CREATE INDEX IF NOT EXISTS idx_messages_source_task_root
  ON messages(source_task_id)
  WHERE source_task_id IS NOT NULL AND thread_parent_id IS NULL;
```

Partial on both predicates because `taskThreadLastWordAt` always pairs
`root.source_task_id = …` with `root.thread_parent_id is null`
(`server/task-dispatch.cjs:215-216`), and only thread *roots* carry `source_task_id`
(`server/index.cjs:3848-3854`) — so the partial index is a small fraction of the table.

1. `server/index.cjs` `ensureRuntimeSchema` — next to the existing
   `idx_messages_source_task_id` at `:1255`. Runs on Fly boot.
2. `database/neon-schema.sql` — next to `:266`.
3. `supabase/migrations/<UTC>_messages_source_task_root_index.sql` — new file.

Keep the existing `(session_id, source_task_id)` index: `postTaskSubthreadMention`
(`server/index.cjs:4152-4157`) queries on both columns and does use it.

No code change. `fly deploy` only.

### Step 2 — F3, make the agent-status broadcast actually fire

The constraint is that `notifyDbSubscribers` (`server/realtime.cjs:199-266`) is
synchronous and holds no DB handle. It already handles this exact problem twice, by
firing an async side-effect and not awaiting it: `void logMessageActivity(rowList)`
(`:206`) and `void enqueueFlowWebhookEvents(…)` (`:228`). Follow that pattern rather
than enriching 18 call sites.

**Modify `server/realtime.cjs`:**
- Add a `resolveWorkspaceForSession(sessionId)` dependency to the injected `deps`
  (`:26-57`) — `logMessageActivity` already does this lookup at
  `shared/backend-core.cjs:1007-1008`, so the query exists; wrap it in a bounded
  `Map` cache (a session's workspace never changes, so the cache needs no invalidation,
  only a size cap — 1000 entries, drop-oldest).
- Replace the synchronous block at `:215-226` with `void emitAgentStatus(rowList,
  eventType)`, an async local that resolves the workspace id per distinct `session_id`
  (one lookup per session per batch, not per row) and then calls `relayBroadcast` with
  the identical lean payload. Keep the `sender_kind !== 'agent' || !sender_id` guard;
  drop `!row.workspace_id` and use the resolved id.
- Best-effort: a failed lookup must never throw into the fanout loop. A missing
  workspace means no broadcast, same as today.

**Modify `server/index.cjs`** — pass `resolveWorkspaceForSession` into
`createRealtime(…)` at the existing wiring site. `resolveWorkspaceIdForSession` already
exists and is injected into `mountSessionsRoutes` (`server/sessions-routes.cjs:21`);
reuse it rather than writing a second resolver.

**Rewrite `tests/agentStatusBroadcast.test.cjs`** — see section 5.

`fly deploy` only. No frontend change: `useAgentStatusFeed` already listens correctly.

### Step 3 — S1, pin the assumption

No behaviour change. The point is that "workspace-level read is the only granularity,
and DMs are inside it" becomes something a test asserts and a reviewer can find, instead
of a comment at `server/index.cjs:3751` that a future change can silently invalidate.

- **Modify `AGENTS.md`** — a short subsection under the RBAC material stating: read
  authorization is workspace-granular; a `viewer` can read every session in the
  workspace including DMs; DM privacy is not enforced and must not be assumed by any
  feature built on top.
- **New test `tests/dm-scope-assumption.test.cjs`** — see section 5. It documents the
  current answer and will fail loudly on the day someone adds a per-session check
  without updating the doc, which is the outcome we want either way.

### Deliberately not in v1

- Any `chat_session_members` table, per-channel ACL, or DM participant check (S1's fix).
- Any change to the two thread lanes (`thread_parent_id` vs `parent_message_id`).
- Server-side pagination or aggregation of `threadReplyCounts` /
  `buildThreadReplySummaries`. They are correct today (section 3.1) and moving them to
  the server buys nothing until a transcript window can drop a parent's replies.
- Any narrowing of MCP `search_messages` / `list_channels` to a channel. That is S1's
  fix wearing a different hat, and narrowing it now would break agents that rely on
  cross-channel recall (`buildAgentActivityDigest` is built on the same premise).
- The `msg` CTE in `WORKSPACE_STATS_SQL` (`shared/tenant-admin.cjs:270-276`), which also
  scans all of `messages`. That one is deliberate and documented (`:264-269`): it is the
  tenant-admin dashboard, it is meant to be cross-tenant, and it is not on a user path.

---

## 5. Test plan

**Runner globs — check this before writing a file.** Backend is
`node --test tests/*.test.cjs` (`package.json:15`). **`.cjs` only** — there is no
`.mjs` in the glob and no `.mjs` test in `tests/`, so a `tests/foo.test.mjs` would never
run. Frontend is `vitest run` with `include: ['tests/unit/**/*.test.ts']`
(`vitest.config.ts:8`); there are currently 142 files there and zero `.test.ts` anywhere
else under `tests/`. Both are wired into `npm run ci` (`package.json:20`).

### `tests/thread-inbox.test.cjs` (extend — F1, F2)

This file already pins SQL *shape* rather than output, and explains why at `:1-9`
("A query that silently loses one of those clauses still returns rows, so nothing else
would notice"). That is exactly the right instrument here. Add:

| invariant | assertion | mutation that must break it |
| --- | --- | --- |
| The reply aggregate is workspace-scoped | the substring between `with replies as (` and its closing `)` contains `workspace_id = $1::uuid` | delete the `join chat_sessions rs` from the CTE — F1 returns |
| The scope is inside the aggregate, not only outside | count of `workspace_id = $1::uuid` occurrences in the full SQL is `>= 2` | move the CTE's join to the outer query only |
| Reply count excludes tool steps | matches `count(*) filter (where coalesce(r.message_kind, '') <> 'tool_step') as reply_count` | drop the `filter` clause back to bare `count(*)` — F2 returns |
| Tool steps are counted separately | SQL projects `as tool_count`, and `toThreadInboxItem` maps it | remove the `tool_count` column |
| The preview skips tool steps | the `left join lateral` block contains `<> 'tool_step'` | remove it, and the preview shows `Bash · npm test` again |
| `last_reply_at` deliberately does **not** filter tool steps | `max(r.created_at)` has no `filter` clause | add one — this test exists to make decision (1) above a decision |

Extract the CTE with a regex on `buildThreadInboxSql()`'s output rather than asserting
against the whole string, so unrelated formatting edits do not churn the test.

### `tests/agentStatusBroadcast.test.cjs` (rewrite — F3)

The current file is the vacuous case: its fixtures invent `workspace_id` on a `messages`
row (`:33-42`), so it asserts a shape no caller produces. Rewrite so the fixtures carry
**only real `messages` columns** — `id, session_id, role, content, sender_kind,
sender_id, sender_name, message_kind, thread_parent_id, created_at` — and the workspace
comes from the injected `resolveWorkspaceForSession`.

| invariant | assertion | mutation that must break it |
| --- | --- | --- |
| A row with real columns only still broadcasts | fixture has no `workspace_id`; a `agent-status:ws-1` frame arrives after the async resolve settles | restore the `!row.workspace_id` guard — the current, shipped behaviour, and the test must go red |
| The workspace comes from the session | resolver stub is called with the row's `session_id` and nothing else | hardcode a workspace |
| One lookup per session per batch | resolver stub counts calls; three rows sharing a `session_id` produce exactly one call | resolve per row |
| A resolver rejection does not break the fanout | resolver throws; a plain `db_changes` subscriber on the same batch still receives its row | let the rejection escape |
| Cross-workspace isolation holds | keep the existing `:87-97` case, adapted | — |

The first row is the whole point. Guard against re-introducing a mock that *restates*
the guard: the test must construct its message rows from a shared fixture helper whose
allowed keys are the real column list, so adding `workspace_id` to a fixture is a
visible edit rather than a silent one.

Also add, in the same file or in `tests/message-tool-steps.test.cjs` (which already
polices `messages` column lists): an assertion that the string `workspace_id` does not
appear in any `messages` DDL in `database/neon-schema.sql`. That is what makes F3
un-reintroducible from the other direction.

### `tests/dm-scope-assumption.test.cjs` (new — S1)

Documents, in executable form, that read authorization is workspace-granular:

- `enforceDbOperationAccess(viewerId, 'messages', 'select', { filters: [session_id in
  a workspace they hold only 'read' on] })` resolves and **does not** throw.
- The same call with no filter throws 400 (`unscoped`).
- The same call filtered only on `messages.id` throws 400 — pinning that `messages` is
  absent from `WORKSPACE_SCOPED_TABLES` (`shared/backend-core.cjs:160-170`) on purpose,
  which is what makes the `id`-fallback at `:575-579` not apply.

The first assertion is the uncomfortable one and it is the reason the file exists: it
states the current answer out loud. If someone later adds a per-session check, this test
goes red and they are forced to update `AGENTS.md` in the same change.

Mock-DB warning for this file: do not hand-roll a `db` stub that reimplements the
membership lookup, or the test measures the stub. Use the same helper the existing
`tests/backend-rbac.test.cjs` uses, and verify each assertion by mutating the *code*
(e.g. temporarily adding `'messages'` to `WORKSPACE_SCOPED_TABLES`) and confirming the
expected test flips.

### Not needed

No `tests/unit/**` additions. Step 0's frontend change is a label render; the counter
logic it aligns with is already covered by the existing `threadSummary` unit tests.

---

## 6. Migration and rollout

**Data migration: none.** No table is created, no column added, no row rewritten. The
only DDL is the Step 1 index.

**Reversibility: total.** Steps 0 and 2 are code-only. Step 1 is a `CREATE INDEX IF NOT
EXISTS`; reverting is `DROP INDEX`, and the query is correct with or without it — only
slower. Nothing here can lose data.

**Deploy lanes** (per the four-lane rule):

| step | lane |
| --- | --- |
| 0 (F1+F2) | `fly deploy` **first** (`server/thread-inbox.cjs` — the new `toolCount` field must exist before the UI reads it), then Netlify auto-deploy on push for `src/**` |
| 1 (F4 index) | `fly deploy` only — the index is created by `ensureRuntimeSchema()` on boot |
| 2 (F3) | `fly deploy` only — `server/realtime.cjs` + the wiring in `server/index.cjs` |
| 3 (S1) | none — docs and tests |

**No npm publish of `@agensis/agensis-agent` and no daemon restart is required for any
step.** Nothing in `packages/agensis-cli` is touched, and the daemon does not read the
thread-inbox SQL or the agent-status broadcast.

Order matters in Step 0 only: ship Fly before Netlify, so the frontend never asks for a
`toolCount` the API does not yet return. Getting this backwards is the single most
repeated deploy mistake in this repo.

**Feature flag: not warranted.** Each step is a few lines and independently revertible
by `git revert` + redeploy, which is faster and less risky than carrying a flag. The one
step where a flag might tempt someone is F3 — a broadcast that has never fired starting
to fire is a behaviour change for every connected client. Mitigate by shipping it last
and watching Fly logs for broadcast volume, not by flagging it: the payload is already
capped to five scalar fields (`server/realtime.cjs:218-224`) and `sendWs` already drops
frames for a backed-up client at 4 MB (`:111`).

**Rollback, concretely:** revert the commit, `fly deploy`, and for Step 0 also let
Netlify redeploy. The sidebar returns to inflated counts and the cross-tenant CTE
returns; nothing is corrupted and no reader breaks, because the old client tolerates an
extra `toolCount` field and the new client tolerates its absence (`Number(undefined) ||
0`).

---

## 7. Risks and effort

### Ranked risks

1. **F3 turns on a broadcast that has never fired in production. (medium likelihood,
   medium impact — the only genuine behaviour change here.)**
   `useAgentStatusFeed` has never received a real payload, so its handling of live data
   is effectively untested against production traffic — including the `~1/s "Thinking"`
   heartbeat rows it explicitly tries to suppress (`src/hooks/useAgentStatusFeed.ts:211-218`).
   *Mitigation:* ship it last, on its own deploy; verify the suppression path against a
   real agent turn before considering it done; the 4 MB `bufferedAmount` drop at
   `server/realtime.cjs:111` is the backstop.

2. **F1's CTE join changes the row set, not just the cost. (low likelihood, high
   impact if wrong.)** The new `join chat_sessions rs` adds `rs.deleted_at is null` to
   the aggregate. The outer query already filtered deleted sessions (`:116`), so the
   result should be identical — but a reply in a soft-deleted session that the outer
   join was already discarding is now discarded earlier, and if any counted thread
   depended on the old behaviour the count changes.
   *Mitigation:* the existing test at `tests/thread-inbox.test.cjs:49-54` already
   asserts `deleted_at is null` appears on every join and counts occurrences; update
   that count deliberately rather than letting it drift. Compare `/threads` output
   before and after on a real workspace.

3. **No security regression is plausible from any step.** F1 makes a query *narrower*.
   F2 changes a displayed integer. F3 broadcasts on a workspace channel that
   `authorizeRealtimeBroadcast` already gates with `enforceWorkspaceRole(…, 'read')`
   (`server/realtime.cjs:339-343`) — and the resolved workspace comes from the row's own
   session, so a message can only ever be broadcast to its own workspace's channel. F4
   is an index. **Named for completeness: the one thing in this area that could become a
   security problem is S1, and this plan deliberately does not touch it.** Do not let a
   later change quietly add a per-session read check on one path and not the others —
   partial enforcement is worse than the current uniform, documented behaviour.

4. **No data-loss risk in any step.** Nothing writes, deletes, or migrates.

5. **The shared checkout.** Several agent loops are live on this repo and the background
   hook auto-commits and pushes. `git diff` before editing; `server/thread-inbox.cjs`
   and `server/realtime.cjs` are both small files that another loop could be mid-edit on.

### Effort

**2.5 engineer-days**, medium-high confidence.

- Step 0 (F1 + F2 + wire shape + sidebar label + tests): 1.0 day
- Step 1 (index, three places, no code): 0.25 day
- Step 2 (F3: resolver injection, cache, async emit, full test rewrite): 0.75 day
- Step 3 (S1 doc + assumption test): 0.25 day
- Deploy, sequencing, verification across two lanes: 0.25 day

**Biggest unknown: F3's real-world broadcast volume.** Every agent-authored message
INSERT *and* UPDATE will now emit — and the delta pump updates a placeholder roughly
once a second per running agent. With several agents running in a workspace that is a
few frames per second to every connected client in that workspace. The payload is small
and the suppression logic exists client-side, but it has never run against live traffic,
and the estimate above assumes it holds. If it does not, F3 needs server-side coalescing
(one broadcast per agent per second, last-write-wins), which is another half day.

**Second unknown: F1's actual cost today.** I could not measure it — no production DB
access from here, and the brief rules out running anything heavy. The argument that the
CTE cannot be pushed down is from the query's structure (an aggregate over `messages`
grouped by `thread_parent_id`, with the workspace qualifier two joins away on
`chat_sessions`), not from an `EXPLAIN`. **Run `EXPLAIN (ANALYZE, BUFFERS)` on
`buildThreadInboxSql(30)` against production before and after Step 0** — that is the
one measurement that would either confirm the finding or retire it, and it is cheap.
