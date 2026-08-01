'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const core = require('../shared/backend-core.cjs');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('generic projections exclude workspace and agent credential material', () => {
  for (const [table, forbidden] of [
    ['workspaces', ['mcp_token_hash', 'mcp_auto_approve']],
    ['workspace_agents', ['connect_token_hash', 'mcp_approved']],
    ['agent_webhooks', ['token']],
    ['gateway_configs', ['api_key_cipher', 'headers']],
  ]) {
    const projected = core.safeSelectColumns(table, '*')
      .split(',')
      .map((column) => column.trim());
    for (const column of forbidden) {
      assert.equal(projected.includes(column), false, `${table}.${column} leaked through wildcard`);
      assert.throws(
        () => core.safeSelectColumns(table, column),
        { status: 403 },
        `${table}.${column} should be rejected explicitly`,
      );
    }
  }
});

test('Fly and Netlify project insert, update, and delete RETURNING clauses', () => {
  for (const relative of ['server/index.cjs', 'netlify/functions/backend.mjs']) {
    const source = read(relative);
    assert.match(
      source,
      /insert into \$\{tableSql\}[^`]+returning \$\{normalizeColumns\(safeSelectColumns\(table, returningColumns\)\)\}/s,
      `${relative} generic insert must use the safe projection`,
    );
    assert.match(
      source,
      /const returningColumns = table === 'chat_sessions' \? '\*' : returning;/,
      `${relative} may widen only chat_sessions for transactional membership settlement`,
    );
    assert.match(
      source,
      /update \$\{tableSql\}[^`]+returning \$\{normalizeColumns\(safeSelectColumns\(table, returning\)\)\}/s,
      `${relative} generic update must use the safe projection`,
    );
    assert.match(
      source,
      /delete from \$\{tableSql\}[^`]+returning \$\{normalizeColumns\(safeSelectColumns\(table, '\*'\)\)\}/s,
      `${relative} generic delete must use the safe projection`,
    );
  }
});

test('realtime rows strip bearer verifiers even outside generic mutations', () => {
  const { __test } = require('../server/index.cjs');
  for (const [table, field] of [
    ['workspaces', 'mcp_token_hash'],
    ['workspace_agents', 'connect_token_hash'],
    ['agent_webhooks', 'token'],
  ]) {
    const row = { id: 'row-1', [field]: 'secret-material', name: 'Visible' };
    const sanitized = __test.sanitizeRealtimeRow(table, row);
    assert.equal(Object.prototype.hasOwnProperty.call(sanitized, field), false);
    assert.equal(sanitized.name, 'Visible');
    assert.equal(row[field], 'secret-material', 'sanitizer must not mutate its input');
  }
});
