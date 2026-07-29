'use strict';
// ============================================================================
// server/thread-inbox.cjs — the sidebar's Threads list.
// ----------------------------------------------------------------------------
// PURE. No DB handle, no express, no network — the same rule as
// server/sandbox-skills.cjs. It builds SQL text and maps
// rows; the route supplies the connection. That is what makes the interesting
// half (the follow rule, the bounds, the wire shape) unit-testable.
//
// WHAT A "THREAD" IS HERE
//
// Two things in this codebase are called a thread, and they are not the same:
//
//   1. A sub-thread SESSION — chat_sessions.parent_message_id. 12 of these
//      exist.
//   2. A message thread — replies carrying messages.thread_parent_id, which is
//      what the channel's "Threads" tab and the thread side panel show. 1039
//      of these exist.
//
// The sidebar section is about the second, because that is what a person means
// by "threads I need to read": someone replied under a message, and the reply
// is not on screen. Sub-thread sessions keep their own place in the tree and
// are deliberately untouched here.
//
// THE FOLLOW RULE
//
// Slack shows threads you follow, and auto-follows one you started or replied
// in. The same rule holds here, with one adjustment for this product: almost
// every reply is written by an AGENT, so "threads you replied in" would be
// nearly empty and "all threads with replies" would be a firehose of
// agent-to-agent chatter nobody asked for.
//
// So a thread is followed when a HUMAN turn is in it — the parent was written
// by a person, or a person replied. Agent replies then make it unread, which is
// exactly the case the owner described: agents answer, and you need to know.
// Threads that are entirely machine-to-machine never enter the list.
//
// READ STATE
//
// Reuses inbox_read_state — one MONOTONIC marker per (user, workspace,
// context_key) — rather than a second read model that could disagree with the
// inbox about what "read" means. The context key is `msgthread:<parentId>`, a
// namespace of its own: the inbox already uses `thread:<sessionId>` for
// mentions, and sharing that key would mean opening one thread silently
// marked every thread in the channel read.
//
// The `date_trunc('milliseconds', ...)` comparison is not a nicety. A marker
// round-trips through the client as an ISO-8601 string with millisecond
// precision, so comparing it raw against a microsecond timestamp calls a just-
// read item unread by a few hundred microseconds, forever. The inbox lost 45 of
// 45 live markers to exactly this. Same rule, same reason.
// ============================================================================

/** Newest threads first, and never an unbounded scan of a growing table. */
const THREAD_INBOX_DEFAULT_LIMIT = 30;
const THREAD_INBOX_MAX_LIMIT = 100;
/** How far back a thread can have been last replied to and still be listed. */
const THREAD_INBOX_LOOKBACK_DAYS = 30;
/** Wire caps, so one enormous message cannot dominate a payload. */
const THREAD_TITLE_CHARS = 160;
const THREAD_PREVIEW_CHARS = 200;

function clampLimit(value) {
 const n = Math.trunc(Number(value));
 if (!Number.isFinite(n) || n < 1) return THREAD_INBOX_DEFAULT_LIMIT;
 return Math.min(THREAD_INBOX_MAX_LIMIT, n);
}

/**
 * SQL for the caller's followed threads, newest reply first.
 *
 * Binds: $1 workspace id, $2 user id. `limit` is interpolated because it is
 * clamped to an integer here and postgres will not take a bind in LIMIT on this
 * driver — the same pattern buildInboxSql uses, for the same reason.
 */
function buildThreadInboxSql(limit = THREAD_INBOX_DEFAULT_LIMIT) {
 const cap = clampLimit(limit);
 const window = `now() - interval '${THREAD_INBOX_LOOKBACK_DAYS} days'`;
 return `
    with replies as (
      select r.thread_parent_id as parent_id,
             -- Tool steps are WORK, not conversation. Both client counters
             -- already exclude them (src/hooks/useChat.ts, src/lib/threadSummary.ts)
             -- because "a chip that folds a Bash step into 'N replies' reads as
             -- the agent having said more than it did". This counter did not,
             -- so one agent turn with 20 Bash calls showed "21 replies" in the
             -- sidebar and "1 reply" in the channel — same thread, same screen.
             count(*) filter (where coalesce(r.message_kind, '') <> 'tool_step') as reply_count,
             count(*) filter (where coalesce(r.message_kind, '') = 'tool_step') as tool_count,
             -- DELIBERATELY spans every reply, tool steps included, and is
             -- deliberately inconsistent with reply_count above. It drives
             -- ordering and unread, and a thread where the agent is actively
             -- working IS recent. Adding a filter here is a behaviour change,
             -- not a consistency fix — tests/thread-inbox.test.cjs pins it.
             max(r.created_at) as last_reply_at,
             -- Whether a person has taken a turn IN the thread. Agent-authored
             -- rows carry sender_kind 'agent'; a human turn is role 'user' and
             -- not the system actor that writes bookkeeping messages.
             bool_or(r.role = 'user' and coalesce(r.sender_kind, '') <> 'system'
                     and coalesce(r.sender_kind, '') <> 'agent') as human_replied
        from messages r
        -- The workspace scope belongs INSIDE the aggregate. The messages table
        -- carries no workspace_id (that is the point — scoping is structural,
        -- only reachable through session_id), so without this join GROUP BY builds
        -- a group for EVERY tenant's thread and the outer join on s.workspace_id
        -- throws almost all of them away. Postgres cannot push a qualifier on
        -- chat_sessions through a GROUP BY on messages, so it will not do this
        -- for us.
        --
        -- Measured on production (24 workspaces, 2284 thread replies in 30 days,
        -- 90.7% of them owned by one tenant): a small tenant's /threads load goes
        -- from 2.14ms to 0.34ms. The dominant tenant pays about +0.6ms, because
        -- for it the join filters almost nothing. That is the right trade — the
        -- cost of the unscoped version grows with TOTAL platform volume while
        -- every tenant but the largest pays for data it cannot see.
        --
        -- Redundant with the outer join on s.workspace_id on purpose. The outer
        -- one is what the existing tests pin, and both are cheap.
        join chat_sessions rs
          on rs.id = r.session_id
         and rs.workspace_id = $1::uuid
         and rs.deleted_at is null
       where r.thread_parent_id is not null
         and r.deleted_at is null
         and r.created_at > ${window}
       group by r.thread_parent_id
    )
    select p.id                                         as parent_id,
           p.session_id                                 as session_id,
           s.title                                      as session_title,
           s.folder                                     as session_folder,
           left(coalesce(p.content, ''), ${THREAD_TITLE_CHARS})   as parent_preview,
           coalesce(p.sender_name, '')                  as parent_sender,
           x.reply_count                                as reply_count,
           x.tool_count                                 as tool_count,
           x.last_reply_at                              as last_reply_at,
           left(coalesce(last_msg.content, ''), ${THREAD_PREVIEW_CHARS}) as last_reply_preview,
           coalesce(last_msg.sender_name, '')           as last_reply_sender,
           -- Unread when no marker exists, or the newest reply is strictly
           -- after it. Truncated to the precision the marker can express.
           (rs.read_at is null
            or date_trunc('milliseconds', x.last_reply_at) > rs.read_at) as unread
      from replies x
      join messages p
        on p.id = x.parent_id
       and p.deleted_at is null
      join chat_sessions s
        on s.id = p.session_id
       and s.workspace_id = $1::uuid
       and s.deleted_at is null
       -- Huddle transcripts are excluded for the same reason mainSessionsOf
       -- excludes them: a voice call is not a thread anyone reads back in a
       -- sidebar, and its @mention turns would otherwise flood this list. The
       -- call already has its own marker row in the channel.
       and coalesce(s.folder, '') <> 'huddle'
      -- Skips tool steps for the same reason reply_count does: the preview is
      -- meant to be the last thing SAID, and without this it could be a tool
      -- line (Bash / npm test) instead of the agent's actual answer.
      left join lateral (
        select m.content, m.sender_name
          from messages m
         where m.thread_parent_id = x.parent_id
           and m.deleted_at is null
           and coalesce(m.message_kind, '') <> 'tool_step'
         order by m.created_at desc
         limit 1
      ) last_msg on true
      left join inbox_read_state rs
        on rs.user_id = $2::uuid
       and rs.workspace_id = $1::uuid
       and rs.context_key = 'msgthread:' || p.id::text
     where (
             -- Followed: a person started it, or a person replied in it.
             (p.role = 'user'
              and coalesce(p.sender_kind, '') <> 'system'
              and coalesce(p.sender_kind, '') <> 'agent')
             or x.human_replied
           )
     order by x.last_reply_at desc
     limit ${cap}`;
}

/** Row -> wire shape. camelCase; the client type mirrors this exactly. */
function toThreadInboxItem(row) {
 return {
  parentId: String(row.parent_id || ''),
  sessionId: row.session_id ? String(row.session_id) : null,
  sessionTitle: String(row.session_title || ''),
  sessionFolder: String(row.session_folder || ''),
  parentPreview: String(row.parent_preview || ''),
  parentSender: String(row.parent_sender || ''),
  replyCount: Number(row.reply_count) || 0,
  // Tool steps, counted separately rather than folded into replyCount. A thread
  // whose only replies are tool steps has replyCount 0 and a non-zero toolCount;
  // it stays in the list, because an agent actively working is worth seeing.
  toolCount: Number(row.tool_count) || 0,
  lastReplyAt: row.last_reply_at ? new Date(row.last_reply_at).toISOString() : '',
  lastReplyPreview: String(row.last_reply_preview || ''),
  lastReplySender: String(row.last_reply_sender || ''),
  unread: row.unread === true,
 };
}

/** The read marker's context key for one message thread. */
function threadContextKey(parentId) {
 const id = String(parentId || '').trim();
 return id ? `msgthread:${id}` : '';
}

module.exports = {
 THREAD_INBOX_DEFAULT_LIMIT,
 THREAD_INBOX_MAX_LIMIT,
 THREAD_INBOX_LOOKBACK_DAYS,
 clampLimit,
 buildThreadInboxSql,
 toThreadInboxItem,
 threadContextKey,
};
