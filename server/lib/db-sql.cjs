'use strict';

// SQL construction for the generic /backend/db/* RPC surface.
//
// Moved verbatim out of server/index.cjs (Wave 1 of the index.cjs reduction).
// The ROUTES stay in index.cjs — this is only the builders they call.
//
// A pure leaf: no database handle, no module state, no request objects. Its
// entire input surface is the four schema tables it imports from
// shared/backend-core.cjs, which is also where the Netlify mirror gets them, so
// the two lanes cannot disagree about which tables exist or which columns are
// jsonb.
//
// SECURITY: this file decides which identifiers reach Postgres unquoted
// (quoteIdent), which tables are addressable at all (ensureTable), whether a
// workspace query is scoped to the caller (appendWorkspaceAccessClause), and
// what a database error is allowed to tell a client (mapDbError). It is on
// MUST_BE_LINTED in tests/lint-coverage.test.cjs for that reason — it was
// covered while it lived in index.cjs and must not lose coverage by moving.

const {
 ALLOWED_TABLES,
 JSON_COLUMNS_BY_TABLE,
 arrayColumnElemType,
 normalizeSessionParticipants,
 toPgArrayLiteral,
} = require('../../shared/backend-core.cjs');

function quoteIdent(value) {
 if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
  throw new Error(`Invalid identifier: ${value}`);
 }
 return `"${value}"`;
}

function ensureTable(table) {
 if (!ALLOWED_TABLES.has(table)) {
  throw new Error(`Table not allowed: ${table}`);
 }
 return quoteIdent(table);
}

function normalizeColumns(columns) {
 if (!columns || columns === '*') return '*';
 const list = String(columns).split(',').map((column) => column.trim()).filter(Boolean);
 if (list.length === 0) return '*';
 return list.map(quoteIdent).join(', ');
}

// A VALUES list directly under INSERT inherits types from the target columns.
// Once the values move into a derived table for the same-session parent proof,
// PostgreSQL instead resolves otherwise-untyped binds as text. Keep the full
// messages row shape here so UUID/boolean/timestamp fields remain assignable.
// An explicit failure for a future column is safer than a production-only 500
// caused by silently treating its bind as text.
const MESSAGE_INSERT_COLUMN_TYPES = Object.freeze({
 id: 'uuid',
 session_id: 'uuid',
 role: 'text',
 content: 'text',
 message_kind: 'text',
 tool_name: 'text',
 tool_detail: 'text',
 created_at: 'timestamptz',
 thread_parent_id: 'uuid',
 sender_kind: 'text',
 sender_id: 'text',
 sender_name: 'text',
 pinned: 'boolean',
 reactions: 'jsonb',
 deleted_at: 'timestamptz',
 attachments: 'jsonb',
 broadcast_to_channel: 'boolean',
 source_task_id: 'uuid',
 huddle_id: 'uuid',
 permission_request_id: 'uuid',
});

/**
 * Build the source rows for a generic INSERT. Message replies need one extra
 * invariant that a plain foreign key cannot express: thread_parent_id must
 * name a message in the same session as the new row. Keep that proof inside
 * the INSERT statement so a preflight check cannot race the write.
 *
 * Every parent check is combined into one predicate. A malformed row in a
 * bulk insert therefore rejects the whole batch instead of inserting only the
 * valid subset. The duplicate parent binds are intentional: they keep the
 * caller-provided values in the derived table while giving PostgreSQL an
 * explicit uuid type for the scope checks.
 */
function buildGenericInsertSource({ table, columns, valueBindings, rows, params }) {
 const tuples = valueBindings.map((bindings) => `(${bindings.join(', ')})`).join(', ');
 if (table !== 'messages') return `values ${tuples}`;

 const sessionIndex = columns.indexOf('session_id');
 if (sessionIndex < 0) throw new Error('Message inserts require session_id');

 const typedTuples = valueBindings.map((bindings) => `(${bindings.map((binding, index) => {
  const column = columns[index];
  const type = MESSAGE_INSERT_COLUMN_TYPES[column];
  if (!type) throw new Error(`Message insert column has no SQL type: ${column}`);
  return binding.endsWith(`::${type}`) ? binding : `${binding}::${type}`;
 }).join(', ')})`).join(', ');

 const parentChecks = rows.map((row, index) => {
  params.push(row.thread_parent_id ?? null);
  const parentParam = `$${params.length}::uuid`;
  const sessionParam = `${valueBindings[index][sessionIndex]}::uuid`;
  return `(
    ${parentParam} is null
    or exists (
      select 1
        from messages message_parent_scope
        join chat_sessions message_session_scope
          on message_session_scope.id = ${sessionParam}
       where message_parent_scope.id = ${parentParam}
         and message_parent_scope.session_id = message_session_scope.id
    )
  )`;
 });
 const projectedColumns = columns
  .map((column) => `message_input.${quoteIdent(column)}`)
  .join(', ');
 const inputColumns = columns.map(quoteIdent).join(', ');
 return `select ${projectedColumns}
    from (values ${typedTuples}) as message_input (${inputColumns})
   where ${parentChecks.join('\n     and ')}`;
}

function isJsonColumn(table, column) {
 return Boolean(JSON_COLUMNS_BY_TABLE[table]?.has(column));
}

function invalidJsonValue(table, column) {
 const err = new Error(`${table}.${column} must be valid JSON`);
 err.status = 400;
 return err;
}

// Bind the OBJECT, never a pre-stringified value. postgres.js resolves a
// `$n::jsonb` placeholder to a jsonb parameter and JSON-serializes the JS value
// itself — so a value that is ALREADY a JSON string gets serialized again and
// lands as a jsonb STRING SCALAR. That is not a cosmetic difference: `||`
// treats a scalar operand as an array element (identity.human_set rows became
// literal arrays, one corrupted append per human edit) and `jsonb_set` on a
// scalar errors, which is why voice saves failed live. String input is
// parse-validated and bound as the PARSED value so both input shapes bind
// identically. The Netlify copy of this function STRINGIFIES — correct for its
// driver, which sends text params for the cast to parse. The two are
// deliberately opposite; do not "sync" them.
function normalizeJsonParam(table, column, value) {
 if (value == null) return null;
 // chat_sessions.participants: strip the browser's `agent:<uuid>` composite key
 // down to the bare uuid every server-side comparison expects. Done HERE because
 // this is the one function every generic write of the column passes through —
 // see normalizeSessionParticipants in shared/backend-core.cjs for why an agent
 // whose roster row carried the prefix could never be dispatched at all.
 // Applied after the string-parse below too, so both input shapes normalize.
 if (table === 'chat_sessions' && column === 'participants' && typeof value !== 'string') {
  return normalizeSessionParticipants(value);
 }
 // Return the PARSED OBJECT, never a JSON string. On this server's porsager
 // driver a stringified bind — even under an explicit ::jsonb cast — arrives as
 // a jsonb STRING SCALAR. Proved against the live database:
 //
 //   stringified ::jsonb -> 'string'   and  '{}'::jsonb || it -> [{}, "…"]
 //   object      ::jsonb -> 'object'   and  '{}'::jsonb || it -> merged object
 //
 // The string form is what corrupted identity.human_set into an array (one
 // bogus element per human edit) and made jsonb_set() on the voice write throw,
 // so voice choices silently never saved. String input is parse-validated and
 // returned AS THE OBJECT so both input shapes bind identically.
 //
 // The Netlify function has its own copy of this helper that DOES stringify —
 // correct for @netlify/database, whose driver is the exact opposite. Do not
 // "unify" them; the drivers disagree and each side matches its own.
 if (typeof value === 'string') {
  let parsed;
  try {
   parsed = JSON.parse(value);
  } catch {
   throw invalidJsonValue(table, column);
  }
  // Same normalization for the string input shape, so a client that sends
  // participants pre-stringified cannot smuggle the prefix past the guard above.
  return table === 'chat_sessions' && column === 'participants'
   ? normalizeSessionParticipants(parsed)
   : parsed;
 }
 return value;
}

/**
 * Build a bind helper for a specific JSON normalizer. Fly and Netlify disagree
 * on whether jsonb params should be objects or strings; each host passes the
 * normalizer that matches its driver. Pure identifier/filter builders stay
 * shared so a new table stamp cannot land on one host only.
 */
function createBindDbParam(normalizeJson) {
 if (typeof normalizeJson !== 'function') {
  throw new Error('createBindDbParam requires a normalizeJson function');
 }
 return function bindDbParam(params, table, column, value) {
  const jsonColumn = isJsonColumn(table, column);
  if (jsonColumn) {
   params.push(normalizeJson(table, column, value));
   return `$${params.length}::jsonb`;
  }
  const elemType = arrayColumnElemType(table, column);
  if (elemType) {
   params.push(toPgArrayLiteral(value));
   return `$${params.length}::${elemType}[]`;
  }
  params.push(value ?? null);
  return `$${params.length}`;
 };
}

// Fly / porsager default: bind jsonb as objects.
const bindDbParam = createBindDbParam(normalizeJsonParam);

function buildWhereClause(filters = [], params = []) {
 if (!Array.isArray(filters) || filters.length === 0) {
  return { clause: '', params };
 }

 const clauses = [];
 for (const filter of filters) {
  if (!filter || typeof filter !== 'object') continue;
  const operator = filter.operator || 'eq';
  if (operator === 'eq') {
   params.push(filter.value ?? null);
   clauses.push(`${quoteIdent(filter.column)} = $${params.length}`);
   continue;
  }
  if (operator === 'not') {
   if (filter.subOperator !== 'is' || filter.value !== null) {
    throw new Error(`Unsupported not filter: ${filter.subOperator} ${filter.value}`);
   }
   clauses.push(`${quoteIdent(filter.column)} IS NOT NULL`);
   continue;
  }
  throw new Error(`Unsupported filter operator: ${operator}`);
 }

 return {
  clause: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
  params,
 };
}

function appendWorkspaceAccessClause(where, userId) {
 const params = where.params || [];
 params.push(userId);
 const ownerParam = `$${params.length}`;
 params.push(userId);
 const memberParam = `$${params.length}`;
 const accessClause = `("workspaces"."user_id" = ${ownerParam} OR EXISTS (SELECT 1 FROM "workspace_members" wm WHERE wm.workspace_id = "workspaces"."id" AND wm.user_id = ${memberParam}))`;
 return {
  clause: where.clause ? `${where.clause} AND ${accessClause}` : ` WHERE ${accessClause}`,
  params,
 };
}

function buildOrderClause(orderBy) {
 if (!orderBy || !orderBy.column) return '';
 const direction = orderBy.ascending === false ? 'DESC' : 'ASC';
 return ` ORDER BY ${quoteIdent(orderBy.column)} ${direction}`;
}

function mapDbError(error) {
 // Never return Postgres `detail` to clients — it can contain stored column
 // values and schema internals (e.g. the row that violated a unique/foreign-key
 // constraint). Log it server-side and expose only the message + SQLSTATE code.
 // (L2, 2026-07 review.)
 if (error?.detail) {
  console.error('[db-error]', { code: error.code, detail: error.detail, message: error.message });
 }
 return {
  message: error?.message || 'Database error',
  code: error?.code || null,
 };
}

module.exports = {
 quoteIdent,
 ensureTable,
 normalizeColumns,
 buildGenericInsertSource,
 isJsonColumn,
 invalidJsonValue,
 normalizeJsonParam,
 createBindDbParam,
 bindDbParam,
 buildWhereClause,
 appendWorkspaceAccessClause,
 buildOrderClause,
 mapDbError,
};
