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
  try {
   return JSON.parse(value);
  } catch {
   throw invalidJsonValue(table, column);
  }
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
