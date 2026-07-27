'use strict';

// The Fly backend's source, as one string.
//
// WHY THIS EXISTS
// ---------------
// A number of tests assert against the Fly backend's SOURCE TEXT rather than its
// behaviour — parity with the Netlify mirror, "this route is rate limited",
// "every Anthropic call path meters", "the predicate is declared exactly once".
// Those assertions are about what the FLY LANE does. They are not about which
// file it lives in.
//
// Wave 2 of the server/index.cjs reduction moves self-contained route blocks out
// into server/<name>-routes.cjs modules that index.cjs mounts. Reading only
// index.cjs would silently narrow every one of those assertions as blocks move —
// a regex that no longer matches anything looks identical to a regex whose
// subject was correctly removed. Three tests went red exactly this way before
// this helper existed (feedback, usage-metering, sandbox-agent-wiring), each
// caught by the gate's test-count guard rather than by review.
//
// So: the lane is index.cjs plus every server/*-routes.cjs, discovered from the
// directory rather than listed, so a new extraction needs no test edit.
//
// Use `flyLaneSource()` for lane-wide assertions ("the backend does X").
// Use a direct readFileSync when the assertion is genuinely about ONE file
// ("index.cjs must not re-declare this predicate") — that distinction matters,
// and this helper deliberately does not hide it.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

// Modules Wave 4 lifted out of index.cjs that are NOT route surfaces, so the
// `-routes.cjs` glob does not find them. Listed explicitly rather than globbed
// because server/ also holds modules that were ALWAYS separate — mcp.cjs,
// huddles.cjs, voice.cjs, orbs.cjs, link-preview.cjs, skills.cjs. Those were
// never part of index.cjs, and sweeping them in would silently widen every
// assertion below to cover code these tests never meant to describe.
const EXTRACTED_NON_ROUTE_MODULES = [
  'server/realtime.cjs',
  'server/agent-connections.cjs',
  'server/task-dispatch.cjs',
];

function flyLaneFiles() {
  const serverDir = path.join(root, 'server');
  return ['server/index.cjs']
    .concat(
      fs.readdirSync(serverDir)
        .filter((name) => name.endsWith('-routes.cjs'))
        .sort()
        .map((name) => `server/${name}`),
    )
    .concat(EXTRACTED_NON_ROUTE_MODULES.filter((rel) => fs.existsSync(path.join(root, rel))));
}

function flyLaneSource() {
  return flyLaneFiles()
    .map((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8'))
    .join('\n');
}

module.exports = { flyLaneFiles, flyLaneSource };
