// ============================================================================
// tests/jsonb-bind-hygiene.test.cjs
// ----------------------------------------------------------------------------
// On the Fly server's porsager driver, a JSON.stringify'd bind — even under an
// explicit ::jsonb cast — arrives as a jsonb STRING SCALAR, not an object.
// Proved against the live database (2026-07-26):
//
//   stringified ::jsonb -> 'string'    '{}'::jsonb || it -> [{}, "…"]
//   object      ::jsonb -> 'object'    '{}'::jsonb || it -> merged object
//
// That corrupted identity.human_set into arrays, made jsonb_set() throw so
// voice choices silently never saved, and left 39 string-scalar rows across
// four tables. Fifteen direct stringify-into-::jsonb binds were then swept.
//
// This test keeps the count at zero: any line in server/index.cjs that both
// mentions JSON.stringify and feeds a params array for SQL with a ::jsonb
// placeholder is a regression. (The Netlify function is EXEMPT — its
// @netlify/database driver is the exact opposite and REQUIRES the string.)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('no JSON.stringify reaches a ::jsonb bind on the Fly server', () => {
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  const lines = source.split('\n');
  const offenders = [];

  lines.forEach((line, i) => {
    if (!line.includes('JSON.stringify')) return;
    // A bind line is an array-literal params line or a params.push into SQL.
    const looksLikeBind = /^\s*\[.*\]\s*,?\s*$/.test(line) || /params\.push\(/.test(line);
    if (!looksLikeBind) return;
    // Is there a ::jsonb cast within the surrounding statement (12 lines up)?
    const context = lines.slice(Math.max(0, i - 12), i + 2).join('\n');
    if (/::jsonb/.test(context)) offenders.push(`L${i + 1}: ${line.trim().slice(0, 90)}`);
  });

  assert.deepEqual(offenders, [], 'stringified jsonb binds found — bind the object; porsager turns strings into jsonb string scalars');
});
