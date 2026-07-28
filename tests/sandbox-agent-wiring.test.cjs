'use strict';

// ============================================================================
// tests/sandbox-agent-wiring.test.cjs
// ----------------------------------------------------------------------------
// The Sandbox Agent's skill layer is decided in server/sandbox-skills.cjs and
// tested as pure data in tests/unit/sandboxSkills.test.ts. This file covers the
// three things a pure test cannot see, each of which is a failure this repo has
// actually shipped before:
//
//   1. A LANE SILENTLY MISSED. There are three places a turn's prompt is
//      composed (builtin system prompt, daemon prompt, MCP/external prompt). A
//      note wired into two of them is a feature that works for some agents and
//      is invisible for others, with nothing failing.
//
//   2. THE PROMPT ROUND-TRIP. agentRuntimePayload feeds the browser's agent edit
//      form, and that form SAVES system_prompt back. Appending anything there —
//      the obvious place to put it — would overwrite the operator's real prompt
//      with a rendered copy of itself the next time anyone edited the agent.
//
//   3. A CREDENTIAL LEAKING BACK OUT. The vault LIST route returns a masked
//      preview of every key it does not explicitly exclude.
//
// Source-scan assertions in the style of tests/jsonb-bind-hygiene.test.cjs: they
// are the only kind that can catch
// "someone wired two of the three places".
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const { flyLaneSource } = require('./helpers/fly-lane.cjs');
// The Fly lane, not one file — Wave 2 of the index.cjs reduction moves route
// blocks into server/*-routes.cjs. See tests/helpers/fly-lane.cjs.
const SERVER = flyLaneSource();
// The one assertion below that IS about a single file keeps its own read.
const INDEX_ONLY = read('server/index.cjs');
const TEMPLATES = read('src/lib/agentTemplates.ts');

test('the server loads the skill-layer module', () => {
  assert.match(SERVER, /require\('\.\/sandbox-skills\.cjs'\)/);
});

// --- 1. Every lane gets the skill layer -------------------------------------

test('all three prompt lanes receive the sandbox skill note', () => {
  // builtin: appended to the system prompt, exactly as the channel-intent and
  // voice notes are.
  assert.match(
    SERVER,
    /if \(sandboxSkillNote && agentContext\) \{\s*\n\s*agentContext\.systemPrompt = `\$\{agentContext\.systemPrompt\}\\n\\n\$\{sandboxSkillNote\}`/,
    'the builtin lane must append the sandbox note to agentContext.systemPrompt',
  );
  // daemon + MCP/external: threaded through buildDaemonPrompt. Every call site
  // must pass it — a call site left on the old arity compiles and runs fine.
  const calls = (SERVER.match(/(?<!function )buildDaemonPrompt\(contextMessages[^)]*\)/g) || []);
  assert.equal(calls.length, 3, `expected exactly three buildDaemonPrompt call sites, found ${calls.length}`);
  for (const call of calls) {
    assert.ok(
      call.includes('sandboxSkillNote'),
      `a buildDaemonPrompt call site does not pass sandboxSkillNote: ${call}`,
    );
  }
});

test('the daemon prompt puts the skill layer before the transcript', () => {
  const { __test } = require('../server/index.cjs');
  const prompt = __test.buildDaemonPrompt(
    [{ role: 'user', content: 'spin me up a node sandbox' }],
    { handle: 'sandbox', name: 'Sandbox Agent' },
    [],
    '',
    false,
    '',
    '<sandbox_skills>\nProviders you can provision with: `box`.\n</sandbox_skills>',
  );
  const noteAt = prompt.indexOf('<sandbox_skills>');
  const transcriptAt = prompt.indexOf('Conversation so far:');
  assert.ok(noteAt >= 0, 'the daemon prompt must carry the sandbox skill note');
  assert.ok(
    noteAt < transcriptAt,
    'operating instructions must be readable before the request they apply to',
  );
});

test('an ordinary agent turn is unchanged — no note, no query', () => {
  const { __test } = require('../server/index.cjs');
  const prompt = __test.buildDaemonPrompt(
    [{ role: 'user', content: 'hello' }],
    { handle: 'coder', name: 'Coder' },
    [],
  );
  assert.ok(!prompt.includes('sandbox_skills'));
  // The pure guard that keeps the vault query off every other agent's turn.
  const { isSandboxAgent } = require('../server/sandbox-skills.cjs');
  assert.equal(isSandboxAgent({ skills: ['research'], metadata: {} }), false);
});

// --- 2. The prompt round-trip ------------------------------------------------

test('agentRuntimePayload does NOT rewrite system_prompt', () => {
  const { __test } = require('../server/index.cjs');
  const systemPrompt = 'You are the sandbox provisioner.';
  const payload = __test.agentRuntimePayload({
    id: 'a', workspace_id: 'w', name: 'Sandbox Agent', handle: 'sandbox',
    run_mode: 'daemon',
    system_prompt: systemPrompt,
    skills: ['sandbox-provisioning', 'sandbox-provider-box'],
    metadata: JSON.stringify({ sandbox_skills: [] }),
  });
  // This payload is what the browser's agent edit form prefills from and posts
  // back. If the rendered skill layer were appended here, editing the agent's
  // name would save the rendered copy over the operator's prompt — and then
  // render the layer into it again on the next turn, compounding.
  assert.equal(payload.system_prompt, systemPrompt);
  assert.ok(!payload.system_prompt.includes('sandbox_skills'));
  // The ids themselves do survive the payload: they are the agent's own config.
  assert.deepEqual(payload.skills, ['sandbox-provisioning', 'sandbox-provider-box']);
});

// --- 3. Credentials ---------------------------------------------------------

test('the vault list route shows sandbox credentials without their values', () => {
  // Previously this route EXCLUDED `sandbox:` keys, because it returned a masked
  // preview of everything it listed and a provisioning credential should not give
  // up even a prefix. The preview is gone, so the entries can be shown: the list
  // no longer decrypts anything, and its SQL does not select the secret columns.
  const { VAULT_META_SELECT, classifyVaultKey } = require('../shared/backend-core.cjs');
  // The secret columns may be MENTIONED (a `coalesce(...) <> ''` boolean is how
  // "configured" is answered without moving the value), but must not be selected.
  // Parenthesised expressions are collapsed first so only bare projections remain.
  const projection = VAULT_META_SELECT
    .slice(VAULT_META_SELECT.indexOf('select') + 'select'.length, VAULT_META_SELECT.indexOf('from'))
    .replace(/\([^()]*\)/g, 'EXPR');
  for (const column of ['value', 'secret_cipher']) {
    assert.ok(
      !new RegExp(`(^|,)\\s*${column}\\s*(,|$)`).test(projection.trim()),
      `the vault metadata projection must not select ${column}`,
    );
  }
  assert.ok(!/decryptVaultSecret/.test(vaultListHandler()), 'the vault LIST route must not decrypt');
  assert.ok(!/preview/.test(vaultListHandler()), 'the vault LIST route must not return a preview');

  const entry = classifyVaultKey('sandbox:box:api_key');
  assert.equal(entry.group, 'provider');
  assert.equal(entry.provider, 'box');
  assert.equal(entry.credential, 'api_key');
  assert.equal(entry.lane, 'provider');
});

// The GET /vault handler as source, so an assertion about "this route" cannot pass
// on the strength of a neighbouring one.
function vaultListHandler() {
  const start = SERVER.indexOf("app.get('/backend/workspaces/:id/vault'");
  const end = SERVER.indexOf("app.put('/backend/workspaces/:id/vault/:key'");
  assert.ok(start > -1 && end > start, 'expected the vault GET handler to precede the PUT');
  return SERVER.slice(start, end);
}

test('the sandbox credential routes exist, are manage-only, and are write-only', () => {
  const routes = [
    /app\.get\('\/backend\/workspaces\/:id\/sandbox-credentials'/,
    /app\.put\('\/backend\/workspaces\/:id\/sandbox-credentials\/:provider'/,
    /app\.delete\('\/backend\/workspaces\/:id\/sandbox-credentials\/:provider'/,
  ];
  for (const route of routes) assert.match(SERVER, route);

  // Slice the three handlers out and check each one individually: a single
  // repo-wide grep for 'manage' would pass on the strength of a neighbour.
  //
  // The end marker used to be '--- Cartesia voices', the comment that followed
  // these routes in index.cjs. Once the vault surface moved to
  // server/vault-routes.cjs that comment stayed behind, and since the lane
  // concatenates index.cjs FIRST it now appears BEFORE this block — so the
  // marker resolved to a position ahead of `start` and the slice was empty.
  // Anchor on the end of the vault module instead, falling back to the end of
  // the lane, which is the honest "everything after this route".
  const start = SERVER.indexOf("app.get('/backend/workspaces/:id/sandbox-credentials'");
  assert.ok(start > 0, 'could not locate the sandbox-credentials route block');
  const marker = SERVER.indexOf('module.exports = { mountVaultRoutes }', start);
  const end = marker > start ? marker : SERVER.length;
  const block = SERVER.slice(start, end);

  const manageChecks = block.match(/enforceWorkspaceRole\(req\.userId, workspaceId, 'manage'\)/g) || [];
  assert.equal(manageChecks.length, 3, 'each of the three routes must enforce the manage role');
  const authGuards = block.match(/requireAuth/g) || [];
  assert.equal(authGuards.length, 3);

  // Write-only: nothing in the block decrypts, previews, or returns a value.
  assert.ok(!block.includes('decryptVaultSecret'), 'a sandbox credential must never be decrypted by a route');
  assert.ok(!block.includes('maskSecret'), 'not even a masked preview — that leaks prefix and length');
  assert.ok(!/value: /.test(block), 'no route may return a credential value');
});

test('the credential key is built by the validator, never string-concatenated in the route', () => {
  const start = SERVER.indexOf("app.put('/backend/workspaces/:id/sandbox-credentials/:provider'");
  const end = SERVER.indexOf("app.delete('/backend/workspaces/:id/sandbox-credentials/:provider'", start);
  const block = SERVER.slice(start, end);
  // req.params.provider is a URL path segment. Building the vault key by hand
  // would let a colon in it name an entry outside the sandbox namespace.
  assert.match(block, /sandboxCredentialKey\(req\.params\.provider/);
  assert.ok(!/SANDBOX_VAULT_PREFIX\}\$\{/.test(block), 'the route must not assemble a vault key itself');
});

test('the configured-keys lookup binds no array and reads no plaintext', () => {
  const start = SERVER.indexOf('async function listConfiguredSandboxCredentialKeys');
  const end = SERVER.indexOf('async function loadSandboxSkillNote', start);
  assert.ok(start > 0 && end > start);
  const fn = SERVER.slice(start, end);
  // postgres.js does not array-serialize a raw JS array bound through .unsafe
  // (see AGENTS.md), so the prefix filter is a literal LIKE, not `key = any($2)`.
  assert.match(fn, /key like '\$\{SANDBOX_VAULT_PREFIX\}%'/);
  assert.ok(!fn.includes('any('), 'no array bind on the .unsafe path');
  // "Configured" is decided from the cipher column's presence. The plaintext is
  // never needed, so it is never decrypted on the per-turn path.
  assert.match(fn, /Boolean\(row\.secret_cipher \|\| row\.value\)/);
  assert.ok(!fn.includes('decryptVaultSecret'));
});

// --- 4. The provider proxy is wired, and cannot be given a destination -------
//
// Behaviour is in tests/provider-proxy.test.cjs (wired, mocked fetch) and
// tests/unit/sandboxSkills.test.ts (the pure boundary). These are the
// source-scan assertions those two cannot make: that the ONE place a credential
// enters a request is the one place, and that no second SSRF predicate appeared.

const MCP = read('server/mcp.cjs');
const SKILLS = read('server/sandbox-skills.cjs');
// The outbound SSRF guard, extracted from server/index.cjs in Wave 1 of the
// index.cjs reduction. The "exactly one predicate" assertion below follows it.
const NET_GUARD = read('server/lib/net-guard.cjs');

test('the MCP tool exists, is agent-only, and declares no destination argument', () => {
  assert.match(MCP, /name: 'call_provider'/);
  const start = MCP.indexOf("name: 'call_provider'");
  const end = MCP.indexOf('--- register as an agent', start);
  assert.ok(start > 0 && end > start, 'could not locate the call_provider tool');
  const block = MCP.slice(start, end);

  // Agent-only. An invite bearer is a transient 14-day join secret; a
  // workspace/user token has no agent and so no skill layer to authorize against.
  assert.match(block, /kinds: \['agent'\]/);

  // The schema must not offer a destination. This is documentation (the dispatcher
  // never validates arguments against inputSchema) but a schema that advertised a
  // `url` would have an agent trying to use one every turn.
  const schemaStart = block.indexOf('inputSchema');
  const schemaEnd = block.indexOf('async run(', schemaStart);
  const schema = block.slice(schemaStart, schemaEnd);
  for (const forbidden of ['url', 'base_url', 'host', 'headers', 'header', 'method', 'credential', 'token']) {
    assert.ok(
      !new RegExp(`\\b${forbidden}: \\{`).test(schema),
      `call_provider's inputSchema must not declare a \`${forbidden}\` property`,
    );
  }
  assert.match(schema, /additionalProperties: false/);
});

test('the tool delegates the destination decision — it never builds a URL or fetches', () => {
  const start = MCP.indexOf("name: 'call_provider'");
  const end = MCP.indexOf('--- register as an agent', start);
  const block = MCP.slice(start, end);
  // mcp.cjs is the caller-facing layer. If it ever grows a fetch or a `new URL`,
  // the destination decision has left the pure, tested module.
  assert.ok(!block.includes('fetch('), 'the MCP tool must not make the outbound call itself');
  assert.ok(!block.includes('new URL('), 'the MCP tool must not construct a destination');
  assert.match(block, /deps\.callProviderOperation\(\{\s*\n\s*workspaceId: identity\.workspaceId,\s*\n\s*agentId: identity\.agentId,/,
    'the workspace and agent must come from the TOKEN, never from args');
});

test('the proxy is passed into BOTH tool doors, so the tool is reachable', () => {
  // The tool-facing deps live in one factory (mcpToolDeps) precisely so the MCP
  // endpoint and the built-in tool loop cannot be handed different capabilities —
  // a call_provider that works over MCP and silently does not exist for a builtin
  // agent is the exact drift this file was written to catch.
  const start = SERVER.indexOf('function mcpToolDeps() {');
  const end = SERVER.indexOf('\n}', start);
  assert.ok(start > 0 && end > start, 'could not locate mcpToolDeps');
  const deps = SERVER.slice(start, end);
  assert.match(deps, /\bcallProviderOperation,/);
  assert.match(deps, /\bproviderCallRateLimiter,/);

  // …and both doors are actually built from it.
  const handlerStart = SERVER.indexOf('const mcpHandler = createMcpHandler({');
  const handlerEnd = SERVER.indexOf('});', handlerStart);
  assert.match(SERVER.slice(handlerStart, handlerEnd), /\.\.\.mcpToolDeps\(\),/);
  assert.match(SERVER, /createBuiltinToolset\(mcpToolDeps\(\)\)/);
});

test('exactly one place puts a credential into a request', () => {
  // applyProviderCredential is that place, by name, so a reader can find it. If a
  // second site starts assembling an Authorization value, this fails.
  const injectors = (SERVER.match(/applyProviderCredential\(/g) || []);
  assert.equal(injectors.length, 1, 'server/index.cjs must inject a credential in exactly one place');
  assert.match(SERVER, /headers: applyProviderCredential\(plan, secret\)/);

  // And nothing on the provider path hand-rolls one.
  const start = SERVER.indexOf('async function callProviderOperation');
  const end = SERVER.indexOf('function buildDaemonPrompt', start);
  assert.ok(start > 0 && end > start, 'could not locate callProviderOperation');
  const fn = SERVER.slice(start, end);
  assert.ok(!/Bearer \$\{/.test(fn), 'no hand-assembled Authorization value on the provider path');
  assert.ok(!/Authorization['"]?\s*:/.test(fn), 'the provider path must not name an Authorization header itself');
});

test('the provider call refuses redirects and reuses the existing SSRF guard', () => {
  const start = SERVER.indexOf('async function callProviderOperation');
  const end = SERVER.indexOf('function buildDaemonPrompt', start);
  const fn = SERVER.slice(start, end);

  // Following a redirect re-sends the credential to whatever host the redirect
  // names, and no per-hop re-validation can prevent that.
  assert.match(fn, /redirect: 'manual'/);
  assert.ok(!fn.includes("redirect: 'follow'"));
  assert.ok(!/location/i.test(fn), 'a redirect target must never be read or reported');

  // The resolved-address SSRF check is the SAME function the gateway base_url path
  // uses. A second implementation is a second thing to get wrong, and this repo
  // has already had one SSRF finding from an unvalidated base URL.
  assert.match(fn, /await assertSafeOutboundUrl\(plan\.url, 'the provider URL'\)/);
  assert.ok(!/isBlockedAddress\(/.test(fn), 'do not re-derive the address predicate here');
  assert.ok(!SKILLS.includes('dns'), 'the pure skill module must not resolve anything');

  // The predicate moved to server/lib/net-guard.cjs (index.cjs reduction, Wave 1);
  // the invariant did not. Count it where it now lives, and assert index.cjs has
  // not grown a second copy on its way back in.
  const predicates = (NET_GUARD.match(/function isBlockedAddress\(/g) || []);
  assert.equal(predicates.length, 1, 'there must be exactly one blocked-address predicate');
  assert.ok(!/function isBlockedAddress\(/.test(INDEX_ONLY),
    'server/index.cjs must import the predicate, never re-declare it');
  assert.match(INDEX_ONLY, /require\('\.\/lib\/net-guard\.cjs'\)/);
  // NOTE: server/link-preview.cjs still carries its own v4-only copy for its
  // redirect chain, and tests/link-preview.test.cjs asserts the two agree.
  // Converging them is a behaviour change, not a move, so this count is
  // deliberately scoped to net-guard rather than widened across server/.
});

test('the audit row carries no payload and binds jsonb as an object', () => {
  const start = SERVER.indexOf('async function logProviderCallActivity');
  const end = SERVER.indexOf('// Logs the one refusal worth its own audit row', start);
  assert.ok(start > 0 && end > start, 'could not locate logProviderCallActivity');
  const fn = SERVER.slice(start, end);

  assert.match(fn, /insert into activity_events[\s\S]*?'provider_call'/);
  // Built from describeProviderCall, which has no field that could hold a secret,
  // plus a redaction pass over the free-text parts as a last net.
  assert.match(fn, /const described = describeProviderCall\(plan\)/);
  assert.match(fn, /redactSandboxSecrets\(/);
  assert.ok(!fn.includes('bodyText'), 'the request body must not reach the audit row');
  assert.ok(!fn.includes('fenced'), 'the response body must not reach the audit row');
  assert.ok(!fn.includes('credentialKey'), 'not even the vault key name belongs in the log');
  // porsager turns a stringified bind on `$n::jsonb` into a jsonb STRING SCALAR.
  assert.ok(!/JSON\.stringify\(metadata\)/.test(fn));
  assert.match(fn, /\$4::jsonb[\s\S]*\[workspaceId,[^\]]*metadata\]/);
});

test('the bundled Box skill no longer instructs the agent to send a credential', () => {
  const { BUNDLED_SANDBOX_SKILLS, SANDBOX_BOX_SKILL_ID } = require('../server/sandbox-skills.cjs');
  const box = BUNDLED_SANDBOX_SKILLS.find((s) => s.id === SANDBOX_BOX_SKILL_ID);
  // The definition shipped in 18a10aa told the agent to send
  // `Authorization: Bearer <BOX_API_KEY>` — an instruction it could not carry out,
  // which is why the Sandbox Agent honestly reported it could not provision.
  assert.ok(!box.instructions.includes('Authorization: Bearer <BOX_API_KEY>'));
  assert.match(box.instructions, /call_provider/);
  assert.match(box.instructions, /you never see the key/);
  // Its operations are what the agent now names, so they must still be there.
  assert.deepEqual(box.endpoints.map((e) => e.name), ['create', 'stop', 'resume', 'fork', 'commands', 'prompt']);
});

// --- The template ----------------------------------------------------------

test('the Sandbox Agent template is a daemon agent carrying both bundled skills', () => {
  const { SANDBOX_OVERALL_SKILL_ID, SANDBOX_BOX_SKILL_ID } = require('../server/sandbox-skills.cjs');
  assert.match(TEMPLATES, /id: 'sandbox', name: 'Sandbox Agent', handle: 'sandbox'/);
  assert.match(TEMPLATES, new RegExp(`skills: \\['${SANDBOX_OVERALL_SKILL_ID}', '${SANDBOX_BOX_SKILL_ID}'\\]`));
  assert.match(TEMPLATES, /runMode: 'daemon', runtime: 'claude', icon: Box/);
});

// The old path is deliberately untouched: run_mode='sandbox' still routes to the
// daemon dispatch lane. Retiring it is a separate decision, and this pins that
// this change did not quietly make it.
test('the pre-existing run_mode=sandbox path still behaves as before', () => {
  const { __test } = require('../server/index.cjs');
  assert.equal(__test.resolveRunTarget({ run_mode: 'sandbox' }), 'daemon');
  const payload = __test.agentRuntimePayload({
    id: 'a', workspace_id: 'w', name: 'S', handle: 's',
    run_mode: 'sandbox', sandbox_provider: 'e2b', sandbox_config: JSON.stringify({ template: 'base' }),
  });
  assert.equal(payload.sandbox_provider, 'e2b');
  assert.deepEqual(payload.sandbox_config, { template: 'base' });
});
