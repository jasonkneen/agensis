'use strict';

// Fly and Netlify must share the pure SQL builders in server/lib/db-sql.cjs.
// Netlify may keep a driver-specific jsonb normalizer; it must not re-declare
// quoteIdent / ensureTable / buildWhereClause.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const netlifyPath = path.join(__dirname, '../netlify/functions/backend.mjs');
const dbSqlPath = path.join(__dirname, '../server/lib/db-sql.cjs');
const netlify = fs.readFileSync(netlifyPath, 'utf8');
const dbSql = fs.readFileSync(dbSqlPath, 'utf8');

test('shared db-sql exports pure builders and createBindDbParam', () => {
  const mod = require('../server/lib/db-sql.cjs');
  for (const name of [
    'quoteIdent', 'ensureTable', 'normalizeColumns', 'buildWhereClause',
    'buildOrderClause', 'mapDbError', 'createBindDbParam', 'bindDbParam',
  ]) {
    assert.equal(typeof mod[name], 'function', `${name} must be exported`);
  }
  assert.match(dbSql, /function createBindDbParam/);
});

test('Netlify imports shared builders instead of redefining them', () => {
  assert.match(netlify, /from ['"]\.\.\/\.\.\/server\/lib\/db-sql\.cjs['"]/);
  assert.match(netlify, /createBindDbParam/);
  assert.match(netlify, /quoteIdent/);
  assert.match(netlify, /ensureTable/);
  assert.match(netlify, /buildWhereClause/);

  // Local redefinitions of the pure stack are the dual-backend footgun.
  assert.equal(
    /function quoteIdent\s*\(/.test(netlify),
    false,
    'Netlify must not redeclare quoteIdent',
  );
  assert.equal(
    /function ensureTable\s*\(/.test(netlify),
    false,
    'Netlify must not redeclare ensureTable',
  );
  assert.equal(
    /function buildWhereClause\s*\(/.test(netlify),
    false,
    'Netlify must not redeclare buildWhereClause',
  );
  assert.equal(
    /function mapDbError\s*\(/.test(netlify),
    false,
    'Netlify must not redeclare mapDbError',
  );

  // Driver-specific jsonb binding remains local (stringify path).
  assert.match(netlify, /function normalizeJsonParam/);
  assert.match(netlify, /JSON\.stringify\(value\)/);
  assert.match(netlify, /const bindDbParam = createBindDbParam\(normalizeJsonParam\)/);
});

test('createBindDbParam uses the host normalizer for jsonb columns', () => {
  const { createBindDbParam } = require('../server/lib/db-sql.cjs');
  const seen = [];
  const bind = createBindDbParam((table, column, value) => {
    seen.push({ table, column, value });
    return JSON.stringify(value);
  });
  const params = [];
  // workspace_agents.metadata is a known jsonb column on both hosts.
  const placeholder = bind(params, 'workspace_agents', 'metadata', { a: 1 });
  assert.match(placeholder, /\$1::jsonb/);
  assert.equal(params.length, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].column, 'metadata');
});
