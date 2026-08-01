'use strict';

const AI_CHAT_CONTEXT_MAX_BYTES = 8 * 1024;
const AI_CHAT_SYSTEM_MAX_BYTES = 16 * 1024;
const AI_CHAT_CONTEXT_MAX_ROWS = 80;

function utf8Bytes(value) {
 return Buffer.byteLength(String(value || ''), 'utf8');
}

function aiChatMessageBytes(message) {
 return utf8Bytes(message?.role) + utf8Bytes(message?.content) + 4;
}

/**
 * Keep both ends of an oversized newest message. The opening normally carries
 * the request/labels while the end carries the latest branch or final
 * constraint; dropping either side can change the meaning of the request.
 */
function truncateUtf8Middle(value, maxBytes) {
 const text = String(value || '');
 if (utf8Bytes(text) <= maxBytes) return text;
 const marker = '\n\n[... middle truncated at the AI context limit ...]\n\n';
 const markerBytes = utf8Bytes(marker);
 if (maxBytes <= markerBytes + 2) return '';
 const codepoints = [...text];
 const contentBudget = maxBytes - markerBytes;
 const targetHeadBytes = Math.ceil(contentBudget / 2);
 let head = '';
 let headBytes = 0;
 let headIndex = 0;
 while (headIndex < codepoints.length) {
  const next = codepoints[headIndex];
  const nextBytes = utf8Bytes(next);
  if (headBytes + nextBytes > targetHeadBytes) break;
  head += next;
  headBytes += nextBytes;
  headIndex += 1;
 }
 let tail = '';
 let tailBytes = 0;
 let tailIndex = codepoints.length - 1;
 while (tailIndex >= headIndex) {
  const next = codepoints[tailIndex];
  const nextBytes = utf8Bytes(next);
  if (headBytes + tailBytes + nextBytes > contentBudget) break;
  tail = next + tail;
  tailBytes += nextBytes;
  tailIndex -= 1;
 }
 return `${head}${marker}${tail}`;
}

function boundAiChatMessages(messages, maxBytes = AI_CHAT_CONTEXT_MAX_BYTES) {
 const source = Array.isArray(messages) ? messages : [];
 const budget = Math.max(256, Number(maxBytes) || AI_CHAT_CONTEXT_MAX_BYTES);
 const selected = [];
 let used = 0;
 for (let index = source.length - 1; index >= 0; index -= 1) {
  const message = source[index];
  const normalized = {
   role: message?.role === 'assistant' ? 'assistant' : 'user',
   content: typeof message?.content === 'string' ? message.content : '',
  };
  if (!normalized.content) continue;
  const fullBytes = aiChatMessageBytes(normalized);
  if (used + fullBytes <= budget) {
   selected.unshift(normalized);
   used += fullBytes;
   continue;
  }
  if (selected.length === 0) {
   const available = budget - aiChatMessageBytes({ ...normalized, content: '' });
   const content = truncateUtf8Middle(normalized.content, available);
   if (content) selected.unshift({ ...normalized, content });
  }
  break;
 }
 while (selected.length > 1 && selected[0].role !== 'user') selected.shift();
 return selected;
}

function normalizeAndBoundAiChatMessages(messages, maxBytes = AI_CHAT_CONTEXT_MAX_BYTES) {
 const normalized = [];
 const system = [];
 if (Array.isArray(messages)) {
  for (const message of messages) {
   const role = String(message?.role || '').trim().toLowerCase();
   const content = typeof message?.content === 'string' ? message.content : '';
   if (!content) continue;
   if (role === 'system') {
    system.push(content);
    continue;
   }
   normalized.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
  }
 }
 return {
  messages: boundAiChatMessages(normalized, maxBytes),
  systemPrompt: truncateUtf8Middle(system.join('\n\n'), maxBytes),
 };
}

/**
 * Build a prompt transcript only from rows already durably stored in the
 * requested session. The seed is the exact human-authored message that caused
 * the reply. Client-supplied history and context never become the words of a
 * named agent.
 */
async function loadStoredAiChatContext({
 db,
 sessionId,
 seedMessageId,
 threadParentId = null,
 userId,
}) {
 const rows = await db(
  `with ai_chat_seed as materialized (
     select id, content, created_at
       from messages
      where id = $2
        and session_id = $1
        and deleted_at is null
        and role = 'user'
        and sender_kind = 'user'
        and sender_id::text = $4::text
        and length(btrim(coalesce(content, ''))) > 0
        and (
          ($3::uuid is null and thread_parent_id is null)
          or thread_parent_id = $3::uuid
        )
      for share
   )
   select context_message.id,
          context_message.role,
          context_message.content,
          context_message.created_at,
          seed.content as seed_content
     from ai_chat_seed seed
     join messages context_message
       on context_message.session_id = $1
      and context_message.deleted_at is null
      and (
        context_message.created_at < seed.created_at
        or context_message.id = seed.id
      )
      and (
        ($3::uuid is null and context_message.thread_parent_id is null)
        or (
          $3::uuid is not null
          and (
            context_message.id = $3::uuid
            or context_message.thread_parent_id = $3::uuid
          )
        )
      )
    order by context_message.created_at desc, context_message.id desc
    limit ${AI_CHAT_CONTEXT_MAX_ROWS}`,
  [String(sessionId), String(seedMessageId), threadParentId ? String(threadParentId) : null, String(userId)],
 );
 if (!rows[0]) {
  const error = new Error('AI reply seed is not a live caller-owned message');
  error.status = 403;
  throw error;
 }
 return {
  seedContent: String(rows[0].seed_content || ''),
  messages: boundAiChatMessages([...rows].reverse()),
 };
}

/**
 * Lock the direct/inherited workspace role lineage used by a persisted AI turn.
 * The caller performs the reserve/final update in the same transaction, so a
 * downgrade either wins before this proof and is observed or waits until the
 * write has committed.
 */
async function lockAiChatRunScope({ db, workspaceId, userId }) {
 const roles = await db(
  `with recursive ai_chat_workspace_chain as (
     select id, parent_id, 0 as depth
       from workspaces
      where id = $1
     union all
     select parent.id, parent.parent_id, chain.depth + 1
       from workspaces parent
       join ai_chat_workspace_chain chain on parent.id = chain.parent_id
      where chain.depth < 10
   ),
   ai_chat_locked_workspaces as materialized (
     select workspace.id, workspace.user_id
       from workspaces workspace
       join ai_chat_workspace_chain chain on chain.id = workspace.id
      for share of workspace
   ),
   ai_chat_locked_memberships as materialized (
     select membership.workspace_id, membership.role
       from workspace_members membership
       join ai_chat_locked_workspaces workspace
         on workspace.id = membership.workspace_id
      where membership.user_id = $2
      for share of membership
   )
   select 'owner'::text as role
     from ai_chat_locked_workspaces workspace
    where workspace.user_id = $2
   union
   select membership.role
     from ai_chat_locked_memberships membership`,
  [String(workspaceId), String(userId)],
 );
 if (roles.some(row => ['owner', 'admin', 'editor'].includes(String(row.role || '')))) return;
 const error = new Error('AI reply access changed before it could be saved');
 error.status = 403;
 throw error;
}

module.exports = {
 AI_CHAT_CONTEXT_MAX_BYTES,
 AI_CHAT_SYSTEM_MAX_BYTES,
 AI_CHAT_CONTEXT_MAX_ROWS,
 aiChatMessageBytes,
 boundAiChatMessages,
 loadStoredAiChatContext,
 lockAiChatRunScope,
 normalizeAndBoundAiChatMessages,
 truncateUtf8Middle,
 utf8Bytes,
};
