'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../shared/backend-core.cjs');

function assertBadInsert(rows, message) {
  assert.throws(
    () => core.validateUniformInsertRows(rows),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, message);
      return true;
    },
  );
}

test('uniform generic inserts accept the same own keys in a different order', () => {
  const columns = core.validateUniformInsertRows([
    { workspace_id: 'ws-1', title: 'First', status: 'todo' },
    { status: 'done', title: 'Second', workspace_id: 'ws-1' },
  ]);

  assert.deepEqual(columns, ['workspace_id', 'title', 'status']);
});

test('uniform generic inserts reject a later row with a missing key', () => {
  assertBadInsert(
    [
      { workspace_id: 'ws-1', title: 'First' },
      { workspace_id: 'ws-1' },
    ],
    'All insert rows must use the same columns',
  );
});

test('uniform generic inserts reject a later row with an extra key', () => {
  assertBadInsert(
    [
      { workspace_id: 'ws-1', title: 'First' },
      { workspace_id: 'ws-1', title: 'Second', status: 'todo' },
    ],
    'All insert rows must use the same columns',
  );
});

test('uniform generic inserts reject a same-size but different own-key set', () => {
  assertBadInsert(
    [
      { workspace_id: 'ws-1', title: 'First' },
      { workspace_id: 'ws-1', status: 'todo' },
    ],
    'All insert rows must use the same columns',
  );
});

test('generic inserts reject empty payloads and empty rows', () => {
  assertBadInsert([], 'Insert values are required');
  assertBadInsert([{}], 'Insert values are required');
  assertBadInsert(
    [{ workspace_id: 'ws-1' }, {}],
    'Insert values are required',
  );
});

test('generic inserts reject values that are not plain objects', () => {
  assertBadInsert([null], 'Insert values must be plain objects');
  assertBadInsert([['workspace_id', 'ws-1']], 'Insert values must be plain objects');
  assertBadInsert([new Date(0)], 'Insert values must be plain objects');
});

test('a null-prototype record is a safe plain insert object', () => {
  const row = Object.create(null);
  row.workspace_id = 'ws-1';
  row.title = 'One';
  assert.deepEqual(core.validateUniformInsertRows([row]), ['workspace_id', 'title']);
});

test('safe single and multi-row generic inserts keep the first row SQL column order', () => {
  assert.deepEqual(
    core.validateUniformInsertRows([{ workspace_id: 'ws-1', title: 'One' }]),
    ['workspace_id', 'title'],
  );
  assert.deepEqual(
    core.validateUniformInsertRows([
      { workspace_id: 'ws-1', title: 'One' },
      { workspace_id: 'ws-1', title: 'Two' },
    ]),
    ['workspace_id', 'title'],
  );
});

test('Fly and Netlify validate the normalized rows before building generic insert SQL', () => {
  const root = path.resolve(__dirname, '..');
  const surfaces = [
    {
      name: 'Fly',
      source: fs.readFileSync(path.join(root, 'server/index.cjs'), 'utf8'),
      start: "app.post('/backend/db/insert'",
      end: "app.post('/backend/db/update'",
    },
    {
      name: 'Netlify',
      source: fs.readFileSync(path.join(root, 'netlify/functions/backend.mjs'), 'utf8'),
      start: "if (pathname === '/backend/db/insert')",
      end: "if (pathname === '/backend/db/update')",
    },
  ];

  for (const surface of surfaces) {
    const start = surface.source.indexOf(surface.start);
    const end = surface.source.indexOf(surface.end, start);
    assert.ok(start >= 0 && end > start, `${surface.name} generic insert route is present`);
    const route = surface.source.slice(start, end);
    const normalizedRows = route.indexOf('const rows = (Array.isArray(values) ? values : [values]).map');
    const inputValidation = route.indexOf('validateUniformInsertRows([row]);');
    const fieldStripping = route.indexOf('stripPrivilegedDbValues(table, row)');
    const validation = route.indexOf('const columns = validateUniformInsertRows(rows);');
    const sql = route.indexOf('insert into');

    assert.ok(normalizedRows >= 0, `${surface.name} normalizes insert rows`);
    assert.ok(inputValidation > normalizedRows, `${surface.name} validates each input row`);
    assert.ok(fieldStripping > inputValidation, `${surface.name} validates before normalization can spread a value`);
    assert.ok(validation > normalizedRows, `${surface.name} validates after normalization`);
    assert.ok(sql > validation, `${surface.name} validates before SQL`);
    assert.doesNotMatch(route, /Object\.keys\(rows\[0\]\)/);
  }
});
