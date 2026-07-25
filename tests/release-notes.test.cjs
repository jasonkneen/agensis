'use strict';

// public/release-notes.json is hand-maintained and feeds the "A new version is
// available" panel. It went six days and a dozen deploys without an entry, so
// users were shown stale notes for changes that had long since shipped. These
// assertions cannot force someone to write an entry, but they do stop the file
// from silently rotting into a shape the panel renders wrong.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'public', 'release-notes.json');
const notes = JSON.parse(fs.readFileSync(file, 'utf8'));

test('release-notes.json is a non-empty array of well-formed entries', () => {
  assert.ok(Array.isArray(notes), 'release-notes.json must be an array');
  assert.ok(notes.length > 0, 'release-notes.json must not be empty');

  for (const entry of notes) {
    assert.equal(typeof entry.version, 'string', 'every entry needs a version');
    assert.ok(entry.version.trim(), `empty version in ${JSON.stringify(entry).slice(0, 80)}`);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `bad date on ${entry.version}`);
    assert.ok(String(entry.title || '').trim(), `missing title on ${entry.version}`);
    assert.ok(String(entry.summary || '').trim(), `missing summary on ${entry.version}`);
    assert.ok(Array.isArray(entry.highlights), `highlights must be an array on ${entry.version}`);
    for (const line of entry.highlights) {
      assert.ok(String(line || '').trim(), `empty highlight on ${entry.version}`);
    }
  }
});

test('entries are newest-first — the panel shows notes[0] as "Latest"', () => {
  const dates = notes.map((entry) => entry.date);
  const sorted = [...dates].sort().reverse();
  assert.deepEqual(dates, sorted, 'entries must be ordered newest date first');
});

test('versions are unique', () => {
  const seen = new Set();
  for (const entry of notes) {
    assert.ok(!seen.has(entry.version), `duplicate version ${entry.version}`);
    seen.add(entry.version);
  }
});
