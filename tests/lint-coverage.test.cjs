'use strict';

// Guards against the class of bug that left shared/backend-core.cjs — the file
// owning auth, RBAC table allowlists, param binding and both rate limiters —
// with ZERO eslint rules applied for months. eslint.config.js listed
// `shared/**/*.mjs`; the only file in shared/ is `backend-core.cjs`. A remediation
// plan for exactly this was written and marked done, because the plan text
// carried the same wrong extension and nobody ran a command to check.
//
// eslint reports nothing for a file it does not match, so "lint is green" and
// "lint never looked at this file" are indistinguishable without asking directly.
// This test asks directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

const repoRoot = path.resolve(__dirname, '..');

// One ESLint instance for every lookup — `npx eslint --print-config` per file
// is the same answer but costs ~2s a call, which is most of this file's runtime.
const eslint = new ESLint({ cwd: repoRoot });

async function configFor(relativePath) {
  return eslint.calculateConfigForFile(path.join(repoRoot, relativePath));
}

// Files whose rules being silently dropped would be a security or correctness
// problem, not a style one. Add to this list when a new backend entry point
// lands; do not remove an entry to make the test pass.
const MUST_BE_LINTED = [
  // Builds the SQL behind the sidebar's Threads list: which threads a person
  // follows, and the read-marker comparison that decides unread. A silent
  // change here does not error — it just quietly stops surfacing replies.
  'server/thread-inbox.cjs',
  'shared/channelIntent.cjs',
  'shared/backend-core.cjs',
  // Owns the workspace-hierarchy rules the authorization path depends on:
  // which ancestors grant access, and whether a re-parent would create a cycle.
  // A cycle here is a denial of service on every request touching that
  // workspace, and a direction mistake leaks one tenant's data to another.
  'shared/workspace-tree.cjs',
  // Silently rewrites user-authored task titles on every create — a correctness
  // problem, not a style one.
  'shared/taskTitle.cjs',
  // Owns the ONLY check standing between a signed-in account and every other
  // account's data (the owner-only Tenants surface). An unlinted typo here —
  // a shadowed variable, an unused `env` argument silently ignored — is an
  // authorization bug.
  'shared/tenant-admin.cjs',
  // Decides whether an agent's self-declaration on reconnect may overwrite a
  // name, avatar or voice a person chose. Getting it wrong is silent data loss
  // that looks like the app forgetting, and it runs on every daemon restart.
  'shared/agentIdentity.cjs',
  // Decides who a message dispatches — including @channel, which addresses every
  // agent in a channel and therefore spends a paid model turn per member — and
  // which handle no agent may hold. A mention-parsing mistake here either wakes
  // agents nobody addressed or lets an agent capture the mention meant for
  // everyone.
  'shared/channelMentions.cjs',
  // Decides what a reaction event carries out of the workspace, and which
  // Flows connections are entitled to receive it. Both backends call it, so an
  // unlinted mistake here is a delivery to the wrong tenant on both lanes.
  'shared/reaction-events.cjs',
  'server/index.cjs',
  'server/mcp.cjs',
  'server/skills.cjs',
  // Mints LiveKit join tokens and verifies the LiveKit webhook signature.
  'server/huddles.cjs',
  // Verifies inbound orb webhook signatures and decides whether a hostile
  // payload can become agent instructions. It is reached by an UNAUTHENTICATED
  // route, so it is the last file in the repo that should run with zero rules.
  'server/orbs.cjs',
  // Decides whether a provisioning base URL may be called at all (the gateway
  // base_url SSRF, one field over — 169.254.169.254 serves cloud IAM
  // credentials), what a provider credential is named in the vault, and whether
  // a provider API response can climb out of its fence and become instructions.
  'server/sandbox-skills.cjs',
  // Decides which URLs this machine will fetch on a chat message's behalf — the
  // SSRF gate for link preview cards, including the per-redirect re-validation.
  // Anyone who can post a message picks the URL.
  'server/link-preview.cjs',
  // Holds the path-traversal containment for every upload read and write, and
  // the extension→Content-Type allowlist that neutralizes .html/.svg. Both are
  // decided by an attacker-supplied filename. Extracted from server/index.cjs,
  // which is on this list — moving code must not move it out of coverage.
  'server/lib/storage-paths.cjs',
  // Decides which identifiers reach Postgres unquoted, which tables are
  // addressable at all, whether a workspace query is scoped to the caller, and
  // what a database error may tell a client. Every /backend/db/* request goes
  // through it. Extracted from server/index.cjs, which is on this list.
  'server/lib/db-sql.cjs',
  // The entire gate between a workspace column a 'manage' user can write
  // (git_root / local_path) and an fs read or `git -C` on this host. Default is
  // off; this file is what keeps it off. Extracted from server/index.cjs.
  'server/lib/project-fs.cjs',
  // Spawns 12 CLI probes with a resolved absolute path and scans dot-directories
  // in the user's home. It also decides which library types exist at all — the
  // reason `config` is a type the skill-content reader refuses, since
  // ~/.gemini/settings.json holds API keys. Extracted from server/index.cjs.
  'server/lib/capabilities.cjs',
  // The outbound SSRF guard: whether this machine will fetch an operator-supplied
  // URL at all. 169.254.169.254 serves cloud IAM credentials, and the response
  // streams back to the caller. Extracted from server/index.cjs.
  'server/lib/net-guard.cjs',
  // Owns the WebSocket fanout and its authorization: which rows reach which
  // subscriber, and which heavy/secret columns are stripped before they do.
  // authorizeRealtimeBinding is the only thing standing between a subscribe
  // frame and another workspace's data. Extracted from server/index.cjs.
  'server/realtime.cjs',
  // Owns the live-daemon map and the one-live-connection-per-agent invariant.
  // A mistake here delivers a dispatch to a dead process, or lets a superseded
  // daemon keep answering. Extracted from server/index.cjs.
  'server/agent-connections.cjs',
  // Decides which agent a task is handed to and whether a held reply is booked
  // once or twice. claimTaskDispatch is a lease with a timeout; an unlinted
  // mistake either wedges a task or dispatches it twice, and both are billed.
  'server/task-dispatch.cjs',
  // Holds DEEPGRAM_API_KEY and CARTESIA_API_KEY. Every line here exists to keep
  // those two strings out of a browser, so an unlinted edit is exactly the
  // mistake this whole module was written to prevent.
  'shared/voice-core.cjs',
  // Mints the Cartesia access token and relays microphone audio to Deepgram
  // with the server-held key.
  'server/voice.cjs',
  'server/inference-broker.cjs',
  'server/farm-integration.cjs',
  'server/flow-integration.cjs',
  'netlify/functions/backend.mjs',
  // Not a backend entry point, but it is what keeps a developer's real
  // credentials — DATABASE_URL, AUTH_SECRET, every provider key — out of every
  // test process. If it silently stops being linted it silently stops being
  // reviewed, and a mistake here re-points the suite at production data.
  'tests/helpers/test-env.cjs',
];

test('every security-critical backend file is matched by an eslint config block', async () => {
  const uncovered = [];
  for (const relativePath of MUST_BE_LINTED) {
    const config = await configFor(relativePath);
    if (Object.keys(config.rules || {}).length === 0) uncovered.push(relativePath);
  }
  assert.deepEqual(
    uncovered,
    [],
    `These files have 0 eslint rules applied — check the file extensions in the\n`
    + `\`files:\` globs in eslint.config.js against what is actually on disk:\n  `
    + uncovered.join('\n  '),
  );
});

test('no-unused-vars is active on the backend, with the _-prefix escape', async () => {
  const config = await configFor('shared/backend-core.cjs');
  const rule = config.rules?.['no-unused-vars'];
  assert.ok(rule, 'no-unused-vars should be configured for backend files');
  // The resolved config normalises severity to its numeric form: 2 === 'error'.
  assert.ok(
    rule[0] === 'error' || rule[0] === 2,
    `no-unused-vars should be an error, not a warning (got ${JSON.stringify(rule[0])})`,
  );
  assert.equal(
    rule[1]?.argsIgnorePattern,
    '^_',
    'the _-prefix convention must stay whitelisted, or six deliberate discards fail the run',
  );
});
