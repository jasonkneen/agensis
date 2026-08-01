'use strict';

// ============================================================================
// tests/agents-projection-parity.test.cjs
// ----------------------------------------------------------------------------
// The /agents list is served by TWO backends over one DB: the Fly server
// (server/index.cjs, `agentRuntimePayload`) and the Netlify mirror
// (netlify/functions/backend.mjs, `publicWorkspaceAgent`). Any column present
// in one projection and missing from the other blanks in the UI whenever a
// reload happens to be served by the other backend — the repo's documented
// blank-column trap. It has now shipped real bugs TWICE on this exact route
// (host_folders via metadata; then soul / accent_color / openpet_avatar_id),
// and the previous wiring test could not catch either because it only grepped
// for the word `identity`.
//
// So this test does not spot-check named columns. It EXTRACTS both backends'
// SQL column lists and both mappers' output key sets from source and diffs
// them. Adding a column to one side fails here until it is added to the other.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

/** The `select a, b, c from workspace_agents` column list inside `slice`. */
function selectColumns(slice, label) {
  const match = slice.match(/select ([^;`]*?)\s+from workspace_agents/i);
  assert.ok(match, `${label}: could not find a workspace_agents select`);
  const columns = match[1].split(',').map((column) => column.trim()).filter(Boolean);
  // A tiny result means the extraction regex broke, not that the select shrank.
  assert.ok(columns.length >= 15, `${label}: extraction looks broken (${columns.length} columns)`);
  return columns.sort();
}

/** Top-level keys of the object literal a mapper returns. */
function mapperKeys(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.ok(start >= 0, `could not find function ${functionName}`);
  const slice = source.slice(start);
  const body = slice.slice(slice.indexOf('return {'), slice.indexOf('\n };') + 1 || slice.indexOf('\n  };') + 1);
  const keys = [];
  for (const line of body.split('\n')) {
    const entry = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/) // key: value
      || line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*),\s*$/); // shorthand key,
    if (entry) keys.push(entry[1]);
  }
  assert.ok(keys.length >= 15, `${functionName}: extraction looks broken (${keys.length} keys)`);
  return keys.sort();
}

// The Fly LANE — the /agents route moved to server/workspaces-routes.cjs in
// Wave 2 of the index.cjs reduction, while the bootstrap select stayed put.
// This test compares the two, so it must see both.
const flySource = require('./helpers/fly-lane.cjs').flyLaneSource();
const netlifySource = read('netlify/functions/backend.mjs');

function routeSlice(source, marker, label) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `could not find ${label}`);
  return source.slice(start, start + 2000);
}

test('both backends select the same workspace_agents columns for /agents', () => {
  const fly = selectColumns(
    routeSlice(flySource, "app.get('/backend/workspaces/:id/agents'", 'the Fly /agents route'),
    'server/index.cjs /agents',
  );
  const netlify = selectColumns(
    routeSlice(netlifySource, 'async function handleWorkspaceAgents', 'the Netlify /agents handler'),
    'netlify backend.mjs /agents',
  );
  assert.deepEqual(netlify, fly,
    'the two backends\' /agents selects disagree — a reload served by one blanks columns the other returned');
});

test('the bootstrap agents select matches the /agents select (same payload, same columns)', () => {
  // The SPA cold load gets its agents from buildWorkspaceBootstrap, which maps
  // through the same agentRuntimePayload — so its select must feed the mapper
  // the same columns or the first paint blanks what a refetch then restores.
  const route = selectColumns(
    routeSlice(flySource, "app.get('/backend/workspaces/:id/agents'", 'the Fly /agents route'),
    'server/index.cjs /agents',
  );
  const bootstrapStart = flySource.indexOf('async function buildWorkspaceBootstrap');
  assert.ok(bootstrapStart >= 0, 'could not find buildWorkspaceBootstrap');
  const bootstrap = selectColumns(
    flySource.slice(bootstrapStart, flySource.indexOf('from workspace_agents', bootstrapStart) + 60),
    'buildWorkspaceBootstrap agents',
  );
  assert.deepEqual(bootstrap, route);
});

test('both backends emit the same /agents payload keys', () => {
  const fly = mapperKeys(flySource, 'agentRuntimePayload');
  const netlify = mapperKeys(netlifySource, 'publicWorkspaceAgent');
  assert.deepEqual(netlify, fly,
    'agentRuntimePayload (Fly) and publicWorkspaceAgent (Netlify) disagree — the mirror blanks fields the primary returns');
});

test('both agent projections resolve automatic models for the selected runtime', () => {
  const flyStart = flySource.indexOf('function agentRuntimePayload(');
  const netlifyStart = netlifySource.indexOf('function publicWorkspaceAgent(');
  assert.ok(flyStart >= 0, 'could not find agentRuntimePayload');
  assert.ok(netlifyStart >= 0, 'could not find publicWorkspaceAgent');

  const fly = flySource.slice(flyStart, flyStart + 1800);
  const netlify = netlifySource.slice(netlifyStart, netlifyStart + 1800);
  for (const [label, source] of [['Fly', fly], ['Netlify', netlify]]) {
    assert.match(source, /const runtime = normalizeExecutionRuntime\(metadata\.runtime\)/, `${label} must read the saved runtime`);
    assert.match(source, /model: resolveExecutionModel\([^,]+, runtime\)/, `${label} must not apply the Claude default to Codex or Amp`);
  }
});

test('the identity fields that already shipped broken stay in both projections', () => {
  // Belt and braces: the generic diffs above would catch these too, but if
  // someone ever "simplifies" both sides at once, this names the exact fields
  // whose loss users noticed (avatar accents, souls, pet avatars, voices).
  const fly = mapperKeys(flySource, 'agentRuntimePayload');
  for (const column of ['identity', 'soul', 'accent_color', 'openpet_avatar_id', 'metadata']) {
    assert.ok(fly.includes(column), `agentRuntimePayload must keep ${column}`);
  }
});
