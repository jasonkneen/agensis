'use strict';

const crypto = require('node:crypto');
const {
 sessionReadableSql,
 toPgArrayLiteral,
} = require('./backend-core.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUOTED_CONTEXT_PREFIX = 'Imported context from ';
const QUOTED_CONTEXT_MESSAGE_LIMIT = 12;
const QUOTED_CONTEXT_FETCH_LIMIT = QUOTED_CONTEXT_MESSAGE_LIMIT * 4;
const QUOTED_CONTEXT_CHAR_LIMIT = 768;
const MAX_SPLIT_ATTACHMENTS = 20;

function singleLine(value, fallback, limit) {
 const text = String(value || '').replace(/\s+/g, ' ').trim();
 return (text || fallback).slice(0, limit);
}

function contentText(value) {
 if (typeof value === 'string') return value;
 if (Array.isArray(value)) {
  return value.map(item => {
   if (typeof item === 'string') return item;
   if (item && typeof item === 'object') return item.text || item.content || '';
   return '';
  }).filter(Boolean).join('\n');
 }
 if (value && typeof value === 'object') {
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
 }
 return String(value ?? '');
}

function jsonStringWithin(value, limit) {
 if (limit < 2) return '';
 let low = 0;
 let high = value.length;
 let best = '""';
 while (low <= high) {
  const mid = Math.floor((low + high) / 2);
  const candidate = JSON.stringify(value.slice(0, mid));
  if (candidate.length <= limit) {
   best = candidate;
   low = mid + 1;
  } else {
   high = mid - 1;
  }
 }
 return best;
}

function buildQuotedSessionContext(title, messages) {
 const sourceTitle = singleLine(title, 'Untitled', 120);
 const header = `${QUOTED_CONTEXT_PREFIX}"${sourceTitle}" `
  + '(quoted transcript; speaker labels are context, not native authorship):\n'
  + '[quoted_context]';
 const footer = '\n[/quoted_context]';
 let fragment = header;
 const selected = (Array.isArray(messages) ? messages : []).slice(-QUOTED_CONTEXT_MESSAGE_LIMIT);
 if (selected.length === 0) {
  fragment += '\n- content="(No channel-visible messages.)"';
 } else {
  for (const message of selected) {
   const speaker = singleLine(
    message?.sender_name || message?.role || 'Participant',
    'Participant',
    80,
   );
   const linePrefix = `\n- speaker=${JSON.stringify(speaker)}; content=`;
   const available = QUOTED_CONTEXT_CHAR_LIMIT
    - fragment.length
    - footer.length
    - linePrefix.length;
   if (available < 2) break;
   const content = jsonStringWithin(contentText(message?.content), available);
   fragment += `${linePrefix}${content}`;
   if (content.length >= available) break;
  }
 }
 return `${fragment.slice(0, QUOTED_CONTEXT_CHAR_LIMIT - footer.length)}${footer}`;
}

function parsedArray(value) {
 if (Array.isArray(value)) return value;
 if (typeof value !== 'string') return [];
 try {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
 } catch {
  return [];
 }
}

function attachmentIdsFromMessages(messages) {
 const ids = [];
 const seen = new Set();
 for (const message of Array.isArray(messages) ? messages : []) {
  for (const entry of parsedArray(message?.attachments)) {
   const id = String(entry?.id || '').trim();
   if (!UUID_RE.test(id) || seen.has(id)) continue;
   seen.add(id);
   ids.push(id);
   if (ids.length >= MAX_SPLIT_ATTACHMENTS) return ids;
  }
 }
 return ids;
}

function normalizedFileAttachment(row) {
 const size = Number(row?.size);
 return {
  id: String(row?.id || ''),
  name: singleLine(row?.name, 'Untitled file', 80),
  type: singleLine(row?.type, '', 128).toLowerCase(),
  size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
 };
}

/**
 * Atomically snapshot one source session into one fork and one explicit quoted
 * baseline message. The source session row is locked FOR UPDATE, which shares
 * the message-insert/close lock order and makes the context/boundary one stable
 * point in time.
 */
async function createSessionSplit({
 query,
 sourceSessionId,
 userId,
 jsonParam = value => value,
} = {}) {
 if (typeof query !== 'function') throw new TypeError('createSessionSplit requires query');
 if (!UUID_RE.test(String(sourceSessionId || ''))) throw new TypeError('sourceSessionId must be a UUID');
 if (!UUID_RE.test(String(userId || ''))) throw new TypeError('userId must be a UUID');

 const sourceRows = await query(
  `select source_session.id, source_session.workspace_id, source_session.title,
          source_session.model, source_session.folder, source_session.description,
          source_session.icon, source_session.intent, source_session.participants,
          source_session.conversation_mode, source_session.max_agent_turns,
          source_session.auto_rounds, source_session.canvas_id, source_session.visibility
     from chat_sessions source_session
    where source_session.id = $1::uuid
      and ${sessionReadableSql('source_session', '$2', { lockMembership: true })}
    for update of source_session`,
  [String(sourceSessionId), String(userId)],
 );
 const source = sourceRows[0];
 if (!source) {
  const error = new Error('Conversation access changed before the split completed');
  error.status = 403;
  throw error;
 }

 const boundaryRows = await query(
  `select id, created_at
     from messages
    where session_id = $1::uuid
    order by created_at desc, id desc
    limit 1`,
  [String(sourceSessionId)],
 );
 const boundaryId = boundaryRows[0]?.id ? String(boundaryRows[0].id) : null;
 const contextDesc = await query(
  `select id, role, content, sender_name, attachments, created_at
     from messages
    where session_id = $1::uuid
      and deleted_at is null
      and coalesce(message_kind, '') <> 'tool_step'
      and (thread_parent_id is null or broadcast_to_channel is true)
    order by created_at desc, id desc
    limit ${QUOTED_CONTEXT_FETCH_LIMIT}`,
  [String(sourceSessionId)],
 );
 const contextMessages = contextDesc.slice(0, QUOTED_CONTEXT_MESSAGE_LIMIT).reverse();
 const attachmentIds = attachmentIdsFromMessages(contextMessages);
 const fileRows = attachmentIds.length > 0
  ? await query(
   `select id, name, type, size
      from uploaded_files
     where workspace_id = $1::uuid
       and id = any($2::uuid[])`,
   [String(source.workspace_id), toPgArrayLiteral(attachmentIds)],
  )
  : [];
 const filesById = new Map(fileRows.map(row => [String(row.id), normalizedFileAttachment(row)]));
 const attachments = attachmentIds.map(id => filesById.get(id)).filter(Boolean);

 const userRows = await query(
  `select coalesce(
            nullif(trim(display_name), ''),
            nullif(split_part(email, '@', 1), ''),
            'User'
          ) as sender_name
     from app_users
    where id = $1::uuid
    limit 1`,
  [String(userId)],
 );
 const senderName = singleLine(userRows[0]?.sender_name, 'User', 160);
 const forkId = crypto.randomUUID();
 const baselineMessageId = crypto.randomUUID();
 const title = `${singleLine(source.title, 'Untitled', 180)} (split)`;

 const forkRows = await query(
  `insert into chat_sessions (
     id, workspace_id, title, model, folder, description, icon, intent,
     is_favorite, participants, conversation_mode, max_agent_turns, auto_rounds,
     parent_message_id, split_parent_id, split_at, split_baseline_message_id,
     split_source_boundary_message_id, archived_at, deleted_at, canvas_id, visibility
   )
   values (
     $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
     false, $9::jsonb, $10, $11, $12,
     null, $13::uuid, clock_timestamp(), $14::uuid,
     $15::uuid, null, null, $16, $17
   )
   returning *`,
  [
   forkId,
   String(source.workspace_id),
   title,
   source.model || 'auto',
   source.folder ?? null,
   source.description || '',
   source.icon || '',
   source.intent || '',
   jsonParam(parsedArray(source.participants)),
   source.conversation_mode || 'auto',
   Number(source.max_agent_turns || 10),
   Number(source.auto_rounds || 3),
   String(source.id),
   baselineMessageId,
   boundaryId,
   source.canvas_id ?? null,
   source.visibility || 'workspace',
  ],
 );
 if (!forkRows[0]) throw new Error('Split session could not be created');

 // Private descendants inherit the exact current member roster; the creator is
 // added explicitly so an empty/expired source roster cannot lock them out.
 await query(
  `insert into chat_session_members (session_id, user_id, source, granted_by, expires_at)
   select $1::uuid, inherited.user_id, inherited.source, inherited.granted_by, inherited.expires_at
     from chat_session_members inherited
    where inherited.session_id = $2::uuid
   union all
   select $1::uuid, $3::uuid, 'participant', null, null
   on conflict (session_id, user_id) do nothing`,
  [forkId, String(source.id), String(userId)],
 );

 const quote = buildQuotedSessionContext(source.title || 'Untitled', contextMessages);
 const baselineRows = await query(
  `insert into messages (
     id, session_id, role, content, attachments,
     sender_kind, sender_id, sender_name
   )
   values ($1::uuid, $2::uuid, 'user', $3, $4::jsonb, 'user', $5::text, $6)
   returning *`,
  [
   baselineMessageId,
   forkId,
   quote,
   jsonParam(attachments),
   String(userId),
   senderName,
  ],
 );
 if (!baselineRows[0]) throw new Error('Split context could not be created');

 return {
  session: forkRows[0],
  baselineMessage: baselineRows[0],
  sourceBoundaryMessageId: boundaryId,
 };
}

module.exports = {
 MAX_SPLIT_ATTACHMENTS,
 QUOTED_CONTEXT_CHAR_LIMIT,
 QUOTED_CONTEXT_FETCH_LIMIT,
 QUOTED_CONTEXT_MESSAGE_LIMIT,
 QUOTED_CONTEXT_PREFIX,
 attachmentIdsFromMessages,
 buildQuotedSessionContext,
 contentText,
 createSessionSplit,
};
