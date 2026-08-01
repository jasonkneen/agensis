'use strict';

// ============================================================================
// tests/provider-proxy.test.cjs
// ----------------------------------------------------------------------------
// The credential-injecting provider proxy, wired: the MCP tool, the vault read,
// the outbound call, the fence, and the audit row.
//
// The PURE decisions — where a URL comes from, what a caller may name, what a
// path parameter may contain, what a described call may carry — are in
// tests/unit/sandboxSkills.test.ts, which is where the security boundary reads
// as a list. This file covers the four things a pure test cannot see:
//
//   1. THE CREDENTIAL ACTUALLY REACHES THE PROVIDER, and reaches NOTHING ELSE.
//      A pure test can prove `describeProviderCall` has no field for a secret.
//      Only a wired one can prove that the secret which went into the request
//      header is absent from the tool's return value, from the audit row, and
//      from the error path — including when the provider echoes it back.
//
//   2. AN AGENT-SUPPLIED URL IS UNREACHABLE. Not "filtered" — the fetch must
//      never happen. This asserts on the stub's call count, because a refusal
//      that still made the request is not a refusal.
//
//   3. SCOPING. The vault key is built from the SKILL DEFINITION and the
//      workspace comes from the TOKEN, so the SQL binds must show a
//      cross-workspace read is not merely rejected but never issued.
//
//   4. THE TOOL SURFACE. `kinds: ['agent']` — invitation URLs are not MCP
//      credentials, and no workspace control token may spend provider keys.
//
// No live Box API is called. The bundled Box skill's own operations, paths,
// methods and credential key drive every call here; only its host is redirected
// (via an agent-authored definition on the same id, which is the documented
// override path) to a public IP literal so `assertSafeOutboundUrl` resolves
// without DNS and the stub answers instead of a real provider.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { withEnv } = require('./helpers/test-env.cjs');

// The preload has already scrubbed AUTH_SECRET, so this is now always the
// literal below — never the machine's real HMAC secret.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'provider-proxy-test-secret';

const { createMcpHandler } = require('../server/mcp.cjs');
const { __test } = require('../server/index.cjs');
const {
  BUNDLED_SANDBOX_SKILLS,
  SANDBOX_BOX_SKILL_ID,
  SANDBOX_OVERALL_SKILL_ID,
} = require('../server/sandbox-skills.cjs');

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_AGENT_ID = '44444444-4444-4444-8444-444444444444';

// The real Box skill with its host pointed at a stub. Everything that matters —
// the six operation names, their methods, their `{id}` paths, the `api_key`
// credential and the `Authorization: Bearer <value>` header — is the shipped
// definition, not a fixture invented for the test.
const BOX = BUNDLED_SANDBOX_SKILLS.find((s) => s.id === SANDBOX_BOX_SKILL_ID);
const STUB_HOST = 'https://1.1.1.1/api/box/v1';
const BOX_AT_STUB = { ...BOX, baseUrl: STUB_HOST };

const SECRET = 'box_live_7Qk2VeryRealLookingKeyMaterial';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeDb({ credential = SECRET, agents } = {}) {
  const defaultAgents = {
    [AGENT_ID]: {
      id: AGENT_ID,
      workspace_id: WS,
      name: 'Sandbox Agent',
      handle: 'sandbox',
      skills: [SANDBOX_OVERALL_SKILL_ID, SANDBOX_BOX_SKILL_ID],
      metadata: { sandbox_skills: [BOX_AT_STUB] },
      enabled: true,
    },
    // Carries the overall skill but NO provider skill: the "you have nothing to
    // call" path, and the proof that one agent cannot reach another's provider.
    [OTHER_AGENT_ID]: {
      id: OTHER_AGENT_ID,
      workspace_id: WS,
      name: 'Scout',
      handle: 'scout',
      skills: [SANDBOX_OVERALL_SKILL_ID],
      metadata: {},
      enabled: true,
    },
  };
  const rows = agents || defaultAgents;
  const db = {
    calls: [],
    activity: [],
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ n, params });
      if (n.startsWith('select id, workspace_id, name, handle, skills, metadata, enabled from workspace_agents')) {
        const [id, workspaceId] = params;
        const agent = rows[id];
        return agent && agent.workspace_id === workspaceId ? [agent] : [];
      }
      if (n.startsWith('select value, secret_cipher from workspace_secrets')) {
        const [workspaceId, key] = params;
        // Only ever answers for the workspace it was asked about. The legacy
        // plaintext column is used so the test does not have to hold the vault
        // encryption key; getWorkspaceSecretValue falls back to it.
        if (workspaceId !== WS || key !== 'sandbox:box:api_key') return [];
        return credential ? [{ value: credential, secret_cipher: '' }] : [];
      }
      if (n.startsWith('insert into activity_events')) {
        const row = {
          id: `ae-${db.activity.length + 1}`,
          workspace_id: params[0],
          user_id: params[1],
          event_type: 'provider_call',
          entity_type: 'agent',
          entity_id: params[1],
          title: params[2],
          metadata: params[3],
        };
        db.activity.push(row);
        return [row];
      }
      return [];
    },
  };
  return db;
}

function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

function textResponse(status, body, { headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    body: null,
    async text() { return body; },
  };
}

async function callProvider(db, args, { workspaceId = WS, agentId = AGENT_ID } = {}) {
  __test.setTestDb(db);
  try {
    return await __test.callProviderOperation({ workspaceId, agentId, args });
  } finally {
    __test.resetTestState();
  }
}

// Recursively collect every string in a value, so an assertion cannot be fooled
// by a secret hiding one level deeper than the test looked.
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, out);
  else if (value != null) out.push(String(value));
  return out;
}

function assertNoSecretAnywhere(value, label) {
  for (const str of allStrings(value)) {
    assert.ok(!str.includes(SECRET), `${label} leaked the credential: ${str.slice(0, 200)}`);
    assert.ok(!/Bearer\s+box_live/.test(str), `${label} leaked an Authorization value: ${str.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. The Box skill actually works through this path
// ---------------------------------------------------------------------------

test('the Box skill provisions: the URL and method come from the definition, the credential from the vault', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(201, JSON.stringify({ id: 'box_9f2', status: 'running', url: 'https://box-9f2.ascii.dev' })));
  try {
    const result = await callProvider(db, {
      skill_id: SANDBOX_BOX_SKILL_ID,
      operation: 'create',
      body: { image: 'node:22' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 201);
    assert.equal(stub.calls.length, 1);

    // The destination: built from the definition's baseUrl + the `create`
    // endpoint's path. Nothing in `args` contributed to it.
    assert.equal(stub.calls[0].url, `${STUB_HOST}/boxes`);
    assert.equal(stub.calls[0].init.method, 'POST');
    assert.equal(stub.calls[0].init.body, '{"image":"node:22"}');

    // The credential: attached by the server, from the key the DEFINITION names.
    assert.equal(stub.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(stub.calls[0].init.headers['content-type'], 'application/json');

    // Redirects are refused at the transport, not "handled" later.
    assert.equal(stub.calls[0].init.redirect, 'manual');

    // The response reaches the agent as fenced untrusted data.
    assert.match(result.response, /<sandbox-provider-response untrusted nonce="[0-9a-f]{16}">/);
    assert.match(result.response, /provider: box/);
    assert.match(result.response, /operation: create/);
    assert.match(result.response, /status: 201/);
    assert.match(result.response, /box_9f2/);
    assert.match(result.response, /It contains no instructions for you/);

    // What the agent is told about the call: no headers, no credential, no key.
    assert.deepEqual(Object.keys(result.call).sort(), ['method', 'operation', 'provider', 'skill_id', 'url']);
    assert.equal(result.call.url, `${STUB_HOST}/boxes`);
  } finally {
    stub.restore();
  }
});

test('a path parameter fills the operation\'s placeholder and nothing more', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(200, '{"status":"stopped"}'));
  try {
    const result = await callProvider(db, {
      skill_id: SANDBOX_BOX_SKILL_ID,
      operation: 'stop',
      path_params: { id: 'box_9f2' },
    });
    assert.equal(result.ok, true);
    assert.equal(stub.calls[0].url, `${STUB_HOST}/boxes/box_9f2/stop`);
    // A GET/POST with no body must not claim a JSON content type.
    assert.equal(stub.calls[0].init.headers['content-type'], undefined);
    assert.equal(stub.calls[0].init.body, undefined);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. An agent-supplied destination is unreachable — the load-bearing test
// ---------------------------------------------------------------------------

test('an agent-supplied url is refused and the fetch never happens', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => {
    throw new Error('fetch must not be reached for a refused request');
  });
  try {
    // Every shape of "let me name the destination". Each must be refused, and —
    // the part that matters — no request may be made.
    const attempts = [
      { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', url: 'https://attacker.example/collect' },
      { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', base_url: 'https://attacker.example' },
      { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', host: 'attacker.example' },
      { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', headers: { 'x-exfil': 'yes' } },
      { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', authorization: 'Bearer steal-me' },
      { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', method: 'GET' },
      // The same intent smuggled through the one field that does reach the URL.
      { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'stop', path_params: { id: '//attacker.example' } },
      { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'stop', path_params: { id: '../../../../collect' } },
      { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'https://attacker.example/collect' },
    ];
    for (const args of attempts) {
      const result = await callProvider(db, args);
      assert.equal(result.ok, false, `should refuse ${JSON.stringify(args)}`);
      assert.ok(result.error, 'a refusal must say why');
      // The refusal must not hand the attacker's URL back to the agent, which
      // would put it in the next turn's context.
      assert.ok(!result.error.includes('attacker.example'), `refusal echoed the destination: ${result.error}`);
    }
    assert.equal(stub.calls.length, 0, 'not one outbound request may be made for a refused call');
  } finally {
    stub.restore();
  }
});

test('the refusal names the allowed arguments so the agent stops guessing', async () => {
  const db = makeDb();
  const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', url: 'https://x.example' });
  assert.match(result.error, /call_provider does not accept: url/);
  assert.match(result.error, /you name an operation, not a URL/);
  assert.match(result.error, /skill_id, operation, path_params, body/);
});

// A well-behaved agent never sends a `url`, so an attempt is not noise — it is the
// signature of the threat this design refuses, and the owner should see it.
test('an attempt to name a destination is audited, by key name and not by value', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => { throw new Error('must not be reached'); });
  try {
    await callProvider(db, {
      skill_id: SANDBOX_BOX_SKILL_ID,
      operation: 'create',
      url: 'https://attacker.example/collect',
      headers: { authorization: 'Bearer x' },
    });
    assert.equal(db.activity.length, 1);
    const row = db.activity[0];
    assert.equal(row.title, '@sandbox provider call refused: supplied url, headers');
    assert.equal(row.metadata.outcome, 'refused_arguments');
    assert.deepEqual(row.metadata.rejected_arguments, ['url', 'headers']);
    assert.equal(row.metadata.agent_handle, 'sandbox');
    // The VALUE is not recorded. An activity_events row fans out over realtime to
    // every subscribed browser, and the value is an attacker-chosen URL.
    assert.ok(!JSON.stringify(row).includes('attacker.example'));
    assert.ok(!JSON.stringify(row).includes('Bearer'));
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

// The counter-test: ordinary validation errors are frequent and harmless. Logging
// them would bury the row above, which is the only one worth an owner's attention.
test('an ordinary validation error is not audited', async () => {
  const db = makeDb();
  for (const args of [
    { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'creat' },
    { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'stop' },
    { skill_id: 'sandbox-provider-typo', operation: 'create' },
    { operation: 'create' },
  ]) {
    const result = await callProvider(db, args);
    assert.equal(result.ok, false);
  }
  assert.equal(db.activity.length, 0);
});

// ---------------------------------------------------------------------------
// 3. The credential never appears in any output
// ---------------------------------------------------------------------------

test('the credential is absent from the result and the audit row on success', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(201, '{"id":"box_1"}'));
  try {
    const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', body: {} });
    assertNoSecretAnywhere(result, 'the tool result');
    assert.equal(db.activity.length, 1);
    assertNoSecretAnywhere(db.activity[0], 'the audit row');
    // Not even the vault key's NAME rides along in the result — nothing the agent
    // reads should tell it which entry to go looking for.
    assert.ok(!JSON.stringify(result).includes('sandbox:box:api_key'));
  } finally {
    stub.restore();
  }
});

test('a provider that echoes the Authorization header back cannot leak it', async () => {
  const db = makeDb();
  // The realistic leak: a 401 whose body quotes the credential it received. The
  // agent would then quote the 401 into a channel.
  const stub = stubFetch(async (_url, init) => textResponse(
    401,
    JSON.stringify({ error: 'invalid_token', received_header: init.headers.Authorization, hint: `try ${SECRET} again` }),
  ));
  try {
    const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', body: {} });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    // A provider 4xx is DATA the agent must read, not a tool error — so it comes
    // back fenced, with the credential scrubbed out of it.
    assert.match(result.response, /status: 401/);
    assert.match(result.response, /invalid_token/);
    assert.match(result.response, /\[redacted\]/);
    assertNoSecretAnywhere(result, 'a 401 result');
    assertNoSecretAnywhere(db.activity[0], 'the audit row for a 401');
  } finally {
    stub.restore();
  }
});

test('a transport error message is redacted before it reaches the agent', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => {
    // A hostile or careless error path that puts the request header in the message.
    throw new Error(`socket hang up while sending Authorization: Bearer ${SECRET}`);
  });
  try {
    const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', body: {} });
    assert.equal(result.ok, false);
    assert.match(result.error, /The provider could not be reached/);
    assertNoSecretAnywhere(result, 'a transport-error result');
    assert.equal(db.activity.length, 1, 'a failed call is still audited');
    assert.equal(db.activity[0].metadata.outcome, 'error');
    assertNoSecretAnywhere(db.activity[0], 'the audit row for a transport error');
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Redirects
// ---------------------------------------------------------------------------

test('a redirect is refused, not followed, and its target is not reported', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(302, '', { headers: { location: 'https://attacker.example/collect' } }));
  try {
    const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', body: {} });
    assert.equal(result.ok, false);
    assert.equal(result.status, 302);
    assert.equal(result.redirect_refused, true);
    // Exactly one request: the redirect was not followed with the credential
    // attached, which is the entire point.
    assert.equal(stub.calls.length, 1);
    assert.match(result.response, /does not follow redirects on a credentialed call/);
    // The Location is deliberately dropped. Handing the agent an attacker-chosen
    // URL as prose is no safer than handing it as an argument.
    assert.ok(!result.response.includes('attacker.example'));
    assert.equal(db.activity[0].metadata.outcome, 'redirect_refused');
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Authorization: the agent's own skills, the token's own workspace
// ---------------------------------------------------------------------------

test('an agent cannot call a provider skill it does not carry', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(200, '{}'));
  try {
    const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' }, { agentId: OTHER_AGENT_ID });
    assert.equal(result.ok, false);
    assert.match(result.error, /You carry no provider skills/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('an unknown skill id is refused and the agent is told which ones it has', async () => {
  const db = makeDb();
  const result = await callProvider(db, { skill_id: 'sandbox-provider-typo', operation: 'create' });
  assert.equal(result.ok, false);
  assert.match(result.error, /You do not carry a provider skill `sandbox-provider-typo`/);
  assert.match(result.error, /Yours are: `sandbox-provider-box`/);
});

test('the agent row and the vault entry are both bound to the token\'s workspace', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(200, '{}'));
  try {
    // The agent exists — in WS. Asked for in OTHER_WS, it must not resolve, and
    // no vault read may be issued at all.
    const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' }, { workspaceId: OTHER_WS });
    assert.equal(result.ok, false);
    assert.match(result.error, /Agent not found in this workspace/);
    assert.equal(stub.calls.length, 0);

    const agentReads = db.calls.filter((c) => c.n.includes('from workspace_agents'));
    assert.equal(agentReads.length, 1);
    // BOTH ids bound, so a foreign workspace is not "checked afterwards" — the row
    // is never returned.
    assert.deepEqual(agentReads[0].params, [AGENT_ID, OTHER_WS]);
    assert.equal(db.calls.filter((c) => c.n.includes('from workspace_secrets')).length, 0,
      'a request that failed authorization must not touch the vault');
  } finally {
    stub.restore();
  }
});

test('the vault read binds the workspace from the token and the key from the definition', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(200, '{}'));
  try {
    await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' });
    const vaultReads = db.calls.filter((c) => c.n.includes('from workspace_secrets'));
    assert.equal(vaultReads.length, 1);
    assert.deepEqual(vaultReads[0].params, [WS, 'sandbox:box:api_key']);
  } finally {
    stub.restore();
  }
});

test('a disabled agent cannot call a provider', async () => {
  const db = makeDb({
    agents: {
      [AGENT_ID]: {
        id: AGENT_ID, workspace_id: WS, name: 'Sandbox Agent', handle: 'sandbox',
        skills: [SANDBOX_BOX_SKILL_ID], metadata: { sandbox_skills: [BOX_AT_STUB] }, enabled: false,
      },
    },
  });
  const stub = stubFetch(async () => textResponse(200, '{}'));
  try {
    const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' });
    assert.equal(result.ok, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. Credential not configured — the honest answer the code already knew to give
// ---------------------------------------------------------------------------

test('an unconfigured credential is a clear refusal naming the vault key, with no call attempted', async () => {
  const db = makeDb({ credential: '' });
  const stub = stubFetch(async () => textResponse(200, '{}'));
  try {
    // BOX_API_KEY must be genuinely absent for the whole call: the env var is a
    // documented fallback, so a leaked one turns "unconfigured" into
    // "configured" and this test silently stops covering the refusal. `withEnv`
    // asserts the deletion held on both sides rather than trusting it.
    await withEnv('BOX_API_KEY', undefined, async () => {
      const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' });
      assert.equal(result.ok, false);
      assert.equal(result.credential_configured, false);
      assert.match(result.error, /The `box` credential is not configured/);
      assert.match(result.error, /sandbox:box:api_key/);
      // THE VAULT, by name, because that is where an operator fixes it. This message
      // used to name BOX_API_KEY as well, which sends them to edit a file the
      // deployed server never reads — the env var is a local-run fallback only.
      assert.match(result.error, /workspace vault/);
      assert.match(result.error, /Settings -> Vault/);
      assert.ok(!/BOX_API_KEY/.test(result.error), 'an env var is not the fix on the deployed server');
      assert.match(result.error, /do not retry/);
      // A 401 discovered three calls later is the outcome this replaces.
      assert.equal(stub.calls.length, 0);
      assert.equal(db.activity.length, 0, 'nothing was called, so there is nothing to audit');
    });
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 7. The audit record
// ---------------------------------------------------------------------------

test('a credentialed call leaves an inspectable activity_events row', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(201, '{"id":"box_9f2"}'));
  try {
    await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'stop', path_params: { id: 'box_9f2' } });
    assert.equal(db.activity.length, 1);
    const row = db.activity[0];
    assert.equal(row.workspace_id, WS);
    assert.equal(row.event_type, 'provider_call');
    assert.equal(row.entity_type, 'agent');
    assert.equal(row.entity_id, AGENT_ID);
    assert.equal(row.title, '@sandbox called box stop (201)');

    const meta = row.metadata;
    assert.equal(meta.provider, 'box');
    assert.equal(meta.operation, 'stop');
    assert.equal(meta.method, 'POST');
    assert.equal(meta.url, `${STUB_HOST}/boxes/box_9f2/stop`);
    assert.equal(meta.status, 201);
    assert.equal(meta.outcome, 'ok');
    assert.equal(meta.agent_handle, 'sandbox');
    assert.ok(Number.isInteger(meta.duration_ms));

    // The payload is NOT in the audit row: not the request body, not the
    // response body, not a header. What the owner needs is who called what and
    // what came back status-wise; a stored response body would make the audit
    // log a second copy of every secret a provider ever returned.
    for (const forbidden of ['body', 'request', 'response', 'headers', 'credential', 'credential_key']) {
      assert.ok(!(forbidden in meta), `the audit metadata must not carry \`${forbidden}\``);
    }
  } finally {
    stub.restore();
  }
});

test('the audit row is bound as a jsonb OBJECT, not a stringified one', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(200, '{}'));
  try {
    await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' });
    const insert = db.calls.find((c) => c.n.startsWith('insert into activity_events'));
    // porsager turns a stringified bind on a `$n::jsonb` into a jsonb STRING
    // SCALAR, which makes the row load as a quoted blob instead of an object.
    // Same rule tests/jsonb-bind-hygiene.test.cjs enforces across the server.
    assert.equal(typeof insert.params[3], 'object');
    assert.notEqual(typeof insert.params[3], 'string');
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 8. Response size
// ---------------------------------------------------------------------------

test('a huge provider response is capped at the transport, not read whole', async () => {
  // 1 MiB, well past the 256 KiB ceiling. The reader must stop, cancel the
  // stream, and say it truncated.
  const chunk = Buffer.from('a'.repeat(64 * 1024));
  let served = 0;
  let cancelled = false;
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (served >= 16) return { done: true, value: undefined };
            served += 1;
            return { done: false, value: chunk };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
    async text() { throw new Error('text() must not be used when a stream is available'); },
  };
  const read = await __test.readCappedResponseText(response, 256 * 1024);
  assert.equal(read.truncated, true);
  assert.ok(read.text.length <= 256 * 1024);
  assert.equal(cancelled, true, 'the stream must be cancelled, not drained');
  assert.ok(served < 16, 'reading must stop at the cap rather than consume the whole body');
});

test('a truncated response is flagged to the agent and noted in the audit row', async () => {
  const db = makeDb();
  const huge = 'z'.repeat(300 * 1024);
  const stub = stubFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    async text() { return huge; },
  }));
  try {
    const result = await callProvider(db, { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' });
    assert.equal(result.truncated, true);
    // And the fence applies its own, smaller prompt-budget ceiling on top.
    assert.match(result.response, /truncated by agensis/);
    assert.match(db.activity[0].metadata.detail, /response truncated at 262144 bytes/);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 9. The MCP tool surface
// ---------------------------------------------------------------------------

function makeHandler(db, { identity, providerCallRateLimiter } = {}) {
  return createMcpHandler({
    getDb: () => db,
    verifyMcpToken: async (token) => (token === 'agent-token' ? (identity || {
      kind: 'agent', agentId: AGENT_ID, workspaceId: WS, name: 'Sandbox Agent', handle: 'sandbox', agent: {},
    }) : token === 'invite-token' ? {
      kind: 'invite', workspaceId: WS, inviteId: 'inv-1', name: 'x@y.com', autoApprove: true, role: 'admin',
    } : token === 'ws-token' ? { kind: 'workspace', workspaceId: WS, name: 'MCP client' } : null),
    callProviderOperation: async (arg) => {
      __test.setTestDb(db);
      try { return await __test.callProviderOperation(arg); } finally { __test.resetTestState(); }
    },
    providerCallRateLimiter,
    notifyDbSubscribers: () => { },
    slugHandle: (s) => String(s || '').toLowerCase().replace(/\s+/g, '-'),
    roleHasWorkspaceCapability: __test.roleHasWorkspaceCapability,
    rateLimiter: null,
    rateLimitBlocked: null,
    runtimeSchemaReady: Promise.resolve(),
    serverVersion: 'test',
  });
}

async function rpcCall(handler, token, body) {
  const res = {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
  await handler({ headers: { authorization: `Bearer ${token}` }, body, url: '/backend/mcp' }, res);
  return res;
}

const toolCall = (args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_provider', arguments: args } });

test('call_provider is advertised to an agent token and describes itself as capability-not-secret', async () => {
  const db = makeDb();
  const handler = makeHandler(db);
  const res = await rpcCall(handler, 'agent-token', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tool = res.body.result.tools.find((t) => t.name === 'call_provider');
  assert.ok(tool, 'an agent must be able to see the tool');
  assert.match(tool.description, /You never see the credential/);
  assert.match(tool.description, /no url\/host\/header argument/);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['body', 'operation', 'path_params', 'skill_id']);
  assert.deepEqual(tool.inputSchema.required, ['skill_id', 'operation']);
  // Declared for well-behaved clients. It is NOT the guard — the dispatcher never
  // validates arguments against inputSchema, which is why
  // unknownProviderCallArgs exists server-side.
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test('call_provider is not available to an invite or workspace token', async () => {
  const db = makeDb();
  const handler = makeHandler(db);
  for (const token of ['invite-token', 'ws-token']) {
    const list = await rpcCall(handler, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(!list.body.result.tools.some((t) => t.name === 'call_provider'),
      `${token} must not be offered call_provider`);
    // And listing is not the enforcement — calling it directly is refused too.
    const called = await rpcCall(handler, token, toolCall({ skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' }));
    assert.equal(called.body.result.isError, true);
    assert.match(called.body.result.content[0].text, /is not available for a/);
  }
});

test('a call through the MCP tool returns the fenced response and refuses a supplied url', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(201, '{"id":"box_1","status":"running"}'));
  try {
    const handler = makeHandler(db);
    const ok = await rpcCall(handler, 'agent-token', toolCall({ skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', body: { image: 'node:22' } }));
    assert.ok(!ok.body.result.isError);
    const payload = JSON.parse(ok.body.result.content[0].text);
    assert.equal(payload.status, 201);
    assert.match(payload.response, /sandbox-provider-response untrusted/);
    assertNoSecretAnywhere(payload, 'the MCP tool payload');

    const refused = await rpcCall(handler, 'agent-token', toolCall({ skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', url: 'https://attacker.example/collect' }));
    // A refusal must arrive as isError, so a client that only checks isError does
    // not read it as a provisioned sandbox.
    assert.equal(refused.body.result.isError, true);
    assert.match(refused.body.result.content[0].text, /does not accept: url/);
    assert.equal(stub.calls.length, 1, 'the refused call made no request');
  } finally {
    stub.restore();
  }
});

test('the per-agent provider-call rate limit refuses rather than looping', async () => {
  const db = makeDb();
  const stub = stubFetch(async () => textResponse(200, '{}'));
  try {
    let allowed = 2;
    const limiter = { check: () => (allowed-- > 0 ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs: 42_000 }) };
    const handler = makeHandler(db, { providerCallRateLimiter: limiter });
    const args = toolCall({ skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' });
    assert.ok(!(await rpcCall(handler, 'agent-token', args)).body.result.isError);
    assert.ok(!(await rpcCall(handler, 'agent-token', args)).body.result.isError);
    const blocked = await rpcCall(handler, 'agent-token', args);
    assert.equal(blocked.body.result.isError, true);
    assert.match(blocked.body.result.content[0].text, /Too many provider calls — retry in about 42s/);
    assert.match(blocked.body.result.content[0].text, /Do not loop on this/);
    assert.equal(stub.calls.length, 2, 'the rate-limited call must not reach the provider');
  } finally {
    stub.restore();
  }
});

test('a backend with no provider proxy wired says so instead of failing obscurely', async () => {
  const db = makeDb();
  const handler = createMcpHandler({
    getDb: () => db,
    verifyMcpToken: async () => ({ kind: 'agent', agentId: AGENT_ID, workspaceId: WS, name: 'S', handle: 'sandbox', agent: {} }),
    notifyDbSubscribers: () => { },
    slugHandle: (s) => String(s || ''),
    roleHasWorkspaceCapability: __test.roleHasWorkspaceCapability,
    runtimeSchemaReady: Promise.resolve(),
  });
  const res = await rpcCall(handler, 'agent-token', toolCall({ skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create' }));
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /not available on this backend/);
});
