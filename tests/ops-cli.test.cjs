'use strict';

// ============================================================================
// tests/ops-cli.test.cjs
// ----------------------------------------------------------------------------
// The operator CLI (cli/) drives the real `runOpsCommand(argv, io)` here — the
// same function the binary calls — with `fetch` injected and both streams
// captured. Nothing is stubbed except the network.
//
// WHY THE STUBS ARE NOT VACUOUS. The known trap in this repo is a mock that
// restates the logic under test. These stubs restate nothing:
//
//   * The tool list served to the CLI is the REAL `buildTools()` from
//     server/mcp.cjs, not a fixture written to match the CLI's expectations. If
//     a tool's schema changes, this suite sees the change.
//   * Every assertion is about EXIT CODES and STREAM DISCIPLINE. A stub that
//     returns a canned MCP envelope cannot itself decide that `isError` maps to
//     5, or that a warning belongs on stderr.
//   * The strongest assertions are about requests that were NOT made — a stub
//     cannot fake an absence.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { __test } = require('../server/mcp.cjs');

const cliPath = (file) => path.join(__dirname, '..', 'cli', 'src', file);
const loadCli = () => Promise.all([
  import(cliPath('index.mjs')),
  import(cliPath('exitCodes.mjs')),
  import(cliPath('rpc.mjs')),
  import(cliPath('render.mjs')),
  import(cliPath('auth.mjs')),
]).then(([index, exitCodes, rpc, render, auth]) => ({ ...index, ...exitCodes, ...rpc, ...render, ...auth }));

// Exactly what `tools/list` returns (server/mcp.cjs createMcpHandler).
const REAL_TOOLS = __test.buildTools().map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

const TEST_TOKEN = 'aga_TESTSECRETTOKENVALUE';
const TEST_URL = 'https://agensis-backend.fly.dev/backend/mcp';

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

/**
 * A recording fetch. `plan` maps a JSON-RPC method to a response (or a function
 * of the call index, for the retry case). Every request is recorded so a test
 * can assert on what was and was not sent.
 */
function makeFetch(plan) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: init.method, rpcMethod: body.method, params: body.params, headers: init.headers });
    const entry = plan[body.method];
    if (entry === undefined) throw new Error(`unplanned rpc method: ${body.method}`);
    const seen = calls.filter((c) => c.rpcMethod === body.method).length;
    return typeof entry === 'function' ? entry(seen) : entry;
  };
  fn.calls = calls;
  fn.rpcMethods = () => calls.map((c) => c.rpcMethod);
  return fn;
}

const toolsListOk = response({ jsonrpc: '2.0', id: 1, result: { tools: REAL_TOOLS } });

function toolOk(value) {
  return response({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
  });
}

function harness({ fetchFn, isTTY = false, env } = {}) {
  const stdout = [];
  const stderr = [];
  return {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    env: env || { AGENSIS_TOKEN: TEST_TOKEN, AGENSIS_URL: 'https://agensis-backend.fly.dev' },
    isTTY,
    fetchFn,
    sleep: async () => {},
    homedir: '/nonexistent-home-for-tests',
    out: () => stdout.join(''),
    errText: () => stderr.join(''),
  };
}

// ---------------------------------------------------------------------------
// Invariant 1: a tool error exits 5 and stdout stays empty.
// Mutation that must fail this: return OK when `isError` is set, or write the
// error text to stdout. Both verified.
// ---------------------------------------------------------------------------
test('a tool error exits 5 and writes nothing to stdout', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = makeFetch({
    'tools/list': toolsListOk,
    'tools/call': response({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'Channel not found' }], isError: true },
    }),
  });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['read', 'missing-channel'], io);

  assert.equal(code, EXIT.TOOL_ERROR);
  assert.equal(code, 5);
  assert.equal(io.out(), '', 'stdout must stay empty when the tool refused');
  assert.match(io.errText(), /Channel not found/);
});

// ---------------------------------------------------------------------------
// Invariant 2: HTTP 401 exits 3, stdout empty, and stderr names WHICH credential
// source was used — the only question a 401 needs answered — never the token.
// ---------------------------------------------------------------------------
test('HTTP 401 exits 3 and names the credential source, not the credential', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = makeFetch({
    'tools/list': response({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, { status: 401 }),
  });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['channels'], io);

  assert.equal(code, EXIT.AUTH);
  assert.equal(code, 3);
  assert.equal(io.out(), '');
  assert.match(io.errText(), /env AGENSIS_TOKEN/, 'stderr should say which source supplied the token');
  assert.ok(!io.errText().includes(TEST_TOKEN));
});

test('no token at all exits 3 before any request', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = makeFetch({});
  const io = harness({ fetchFn, env: {} });
  const code = await runOpsCommand(['channels'], io);

  assert.equal(code, EXIT.AUTH);
  assert.equal(fetchFn.calls.length, 0);
  assert.match(io.errText(), /AGENSIS_TOKEN/);
});

// ---------------------------------------------------------------------------
// Invariant 3: in JSON mode stdout is EXACTLY one JSON document. Run a command
// that also triggers the truncation note, so both streams have content.
// Mutation: emit the note on stdout — JSON.parse then throws.
// ---------------------------------------------------------------------------
test('JSON mode puts exactly one JSON document on stdout and notes on stderr', async () => {
  const { runOpsCommand } = await loadCli();
  const channels = Array.from({ length: 3 }, (_v, i) => ({ id: `id-${i}`, title: `c${i}` }));
  const fetchFn = makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk({ channels }) });
  const io = harness({ fetchFn, isTTY: true });

  const code = await runOpsCommand(['channels', '--limit', '3', '--json'], io);
  assert.equal(code, 0);

  const parsed = JSON.parse(io.out());
  assert.deepEqual(parsed, { channels });
  assert.match(io.errText(), /hit the requested limit of 3/);
  assert.ok(!io.out().includes('note:'), 'notes must never touch stdout');
});

test('the truncation note is silent when the page is short', async () => {
  const { runOpsCommand } = await loadCli();
  const fetchFn = makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk({ channels: [{ id: 'a' }] }) });
  const io = harness({ fetchFn });
  await runOpsCommand(['channels', '--limit', '50'], io);
  assert.ok(!io.errText().includes('hit the requested limit'));
});

// ---------------------------------------------------------------------------
// Invariant 4: the token appears in NO output on ANY path.
// Mutation: dump request headers in --raw, or interpolate the token into an
// error message. Both verified to fail this test.
// ---------------------------------------------------------------------------
test('the token never reaches stdout or stderr on any failure path', async () => {
  const { runOpsCommand } = await loadCli();

  const paths = [
    ['401', { 'tools/list': response({ error: { code: -32001, message: `bad token ${TEST_TOKEN}` } }, { status: 401 }) }, ['channels']],
    ['429', { 'tools/list': response({ data: null, error: { message: 'Rate limit exceeded', code: 'rate_limited' } }, { status: 429, headers: { 'retry-after': '1' } }) }, ['channels']],
    ['transport', { 'tools/list': response('<!doctype html><html>the SPA</html>') }, ['channels']],
    ['raw', { 'tools/list': toolsListOk, 'tools/call': toolOk({ kind: 'agent', token: TEST_TOKEN }) }, ['whoami', '--raw']],
  ];

  for (const [label, plan, argv] of paths) {
    const io = harness({ fetchFn: makeFetch(plan) });
    await runOpsCommand(argv, io);
    assert.ok(!io.out().includes(TEST_TOKEN), `${label}: token leaked to stdout`);
    assert.ok(!io.errText().includes(TEST_TOKEN), `${label}: token leaked to stderr`);
  }
});

test('--raw prints the response only; the request is never dumped', async () => {
  const { runOpsCommand } = await loadCli();
  const fetchFn = makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk({ kind: 'agent' }) });
  const io = harness({ fetchFn });
  assert.equal(await runOpsCommand(['whoami', '--raw'], io), 0, io.errText());

  // Redaction is the second line of defence and is asserted separately. This is
  // the first: the request — the only place the bearer lives — is never a
  // candidate for printing at all.
  const raw = JSON.parse(io.out());
  assert.deepEqual(Object.keys(raw).sort(), ['id', 'jsonrpc', 'result']);
  assert.ok(!io.out().toLowerCase().includes('authorization'));
  assert.ok(!io.out().toLowerCase().includes('bearer'));
});

test('redaction covers an unprefixed credential, not only aga_/agw_/agx_', async () => {
  const { redact } = await loadCli();
  // A user LOGIN token is accepted by verifyMcpToken and has no prefix at all,
  // so a pattern-only redactor would print it in full.
  const opaque = 'ey9veryLongOpaqueSessionTokenValue';
  assert.equal(redact(`x ${opaque} y`), `x ${opaque} y`, 'pattern alone cannot catch it');
  assert.equal(redact(`x ${opaque} y`, [opaque]), 'x [redacted] y');
  assert.equal(redact('bearer aga_abc123def456'), 'bearer [redacted]');
});

// ---------------------------------------------------------------------------
// Invariant 5: an unknown COMMAND fails locally with no request at all; an
// unknown FLAG fails locally after the schema fetch but sends no tools/call.
// A stub cannot fake an absence, which is what makes these the strongest
// assertions in the file.
// ---------------------------------------------------------------------------
test('an unknown command exits 2 and sends nothing', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = makeFetch({});
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['frobnicate'], io);

  assert.equal(code, EXIT.USAGE);
  assert.equal(code, 2);
  assert.equal(fetchFn.calls.length, 0, 'no request may be sent for an unknown command');
});

test('an unknown flag exits 2 and never calls the tool', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = makeFetch({ 'tools/list': toolsListOk });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['read', 'chan-1', '--bogus', 'x'], io);

  assert.equal(code, EXIT.USAGE);
  assert.deepEqual(fetchFn.rpcMethods(), ['tools/list'], 'the tool must never be called');
  assert.match(JSON.parse(io.errText()).error.message, /Unknown argument "--bogus"/);
});

test('a missing required argument exits 2 and never calls the tool', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = makeFetch({ 'tools/list': toolsListOk });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['post', 'chan-1'], io);

  assert.equal(code, EXIT.USAGE);
  assert.deepEqual(fetchFn.rpcMethods(), ['tools/list']);
  assert.match(io.errText(), /requires --content/);
});

// ---------------------------------------------------------------------------
// Invariant 6: a non-JSON body is a NAMED transport error (6), not a crash.
// This is the "pointed at agensis.io and got the SPA" case: /backend/mcp is
// mounted on the Fly backend only.
// ---------------------------------------------------------------------------
test('an HTML response body is a named transport error, not a parse crash', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = makeFetch({ 'tools/list': response('<!doctype html><html><body>app shell</body></html>') });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['channels'], io);

  assert.equal(code, EXIT.TRANSPORT);
  assert.equal(code, 6);
  assert.match(io.errText(), /returned HTML/);
  assert.match(io.errText(), /agensis-backend\.fly\.dev/);
});

test('the agensis.io 404 body is a transport error naming the right host', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  // Verified live: agensis.io/backend/mcp returns HTTP 404 with
  // `{ data: null, error: { message: 'Backend route not found' } }` — valid JSON
  // but not a JSON-RPC envelope, because /backend/mcp is mounted on the Fly
  // backend only and NOT in netlify/functions/backend.mjs. Calling that a
  // protocol error would send the operator hunting a JSON-RPC bug that is
  // really a wrong-host mistake.
  const fetchFn = makeFetch({
    'tools/list': response({ data: null, error: { message: 'Backend route not found' } }, { status: 404 }),
  });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['channels'], io);

  assert.equal(code, EXIT.TRANSPORT);
  assert.equal(code, 6);
  assert.match(io.errText(), /not a JSON-RPC 2\.0 envelope/);
  assert.match(io.errText(), /Backend route not found/);
  assert.match(io.errText(), /agensis-backend\.fly\.dev/);
});

test('a connection failure is transport (6), not the catch-all (1)', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' }); };
  const io = harness({ fetchFn });
  assert.equal(await runOpsCommand(['channels'], io), EXIT.TRANSPORT);
});

test('a JSON-RPC error object is a protocol error (7)', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = makeFetch({
    'tools/list': response({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
  });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['channels'], io);
  assert.equal(code, EXIT.PROTOCOL);
  assert.equal(code, 7);
});

// ---------------------------------------------------------------------------
// Invariant 7: 429 exits 4 after exactly ONE retry. A retry loop would spend the
// same 120/min budget the caller's real agent traffic draws from.
// ---------------------------------------------------------------------------
test('a 429 retries exactly once, then exits 4', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const rateLimited = response(
    { data: null, error: { message: 'Rate limit exceeded. Please retry shortly.', code: 'rate_limited' } },
    { status: 429, headers: { 'retry-after': '2' } },
  );
  const fetchFn = makeFetch({ 'tools/list': rateLimited });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['channels'], io);

  assert.equal(code, EXIT.RATE_LIMITED);
  assert.equal(code, 4);
  assert.equal(fetchFn.calls.length, 2, 'one retry, not zero and not a loop');
  assert.match(io.errText(), /retrying once in 2s/);
});

// ---------------------------------------------------------------------------
// Invariant 8: THE DRIFT GUARD. Drive every command in the surface and assert
// that every request the CLI is capable of making is a POST to the one MCP
// endpoint carrying one of three JSON-RPC methods. This is what makes "add a
// bespoke CLI route" a test failure rather than a code-review opinion.
// ---------------------------------------------------------------------------
test('every command reaches the server only as an MCP JSON-RPC call', async () => {
  const { runOpsCommand, RPC_METHODS } = await loadCli();
  const commands = [
    ['whoami'], ['channels'], ['read', 'c1'], ['search', 'hello'],
    ['post', 'c1', 'hi'], ['dispatch', 'c1', 'hi'], ['tasks'], ['agents'],
    ['tools'], ['call', 'list_docs'],
  ];

  const seen = [];
  for (const argv of commands) {
    const fetchFn = makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk({ ok: true }) });
    const io = harness({ fetchFn });
    const code = await runOpsCommand(argv, io);
    assert.equal(code, 0, `${argv.join(' ')} should succeed: ${io.errText()}`);
    seen.push(...fetchFn.calls);
  }

  assert.ok(seen.length >= commands.length, 'the commands should have made requests');
  for (const call of seen) {
    assert.equal(call.url, TEST_URL, `the CLI must POST only to the MCP endpoint, saw ${call.url}`);
    assert.equal(call.method, 'POST');
    assert.ok(RPC_METHODS.includes(call.rpcMethod), `unexpected JSON-RPC method ${call.rpcMethod}`);
  }
  assert.deepEqual([...new Set(seen.map((c) => c.rpcMethod))].sort(), ['tools/call', 'tools/list']);
});

test('rpc() refuses a method outside the frozen allowlist', async () => {
  const { rpc, RPC_METHODS } = await loadCli();
  assert.deepEqual([...RPC_METHODS], ['initialize', 'tools/list', 'tools/call']);
  await assert.rejects(
    () => rpc('workspace/deleteEverything', {}, { url: TEST_URL, token: TEST_TOKEN, fetchFn: async () => { throw new Error('should not be reached'); } }),
    /not in the allowlist/,
  );
});

// ---------------------------------------------------------------------------
// Invariant 9: an alias whose tool or argument has moved fails LOCALLY with a
// message naming the drift, instead of sending a request the server rejects
// with something opaque.
// ---------------------------------------------------------------------------
test('an alias pointing at a renamed tool fails locally with exit 2', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const renamed = REAL_TOOLS.map((t) => (t.name === 'read_channel' ? { ...t, name: 'read_channel_v2' } : t));
  const fetchFn = makeFetch({ 'tools/list': response({ jsonrpc: '2.0', id: 1, result: { tools: renamed } }) });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['read', 'c1'], io);

  assert.equal(code, EXIT.USAGE);
  assert.deepEqual(fetchFn.rpcMethods(), ['tools/list'], 'nothing may be dispatched against a drifted surface');
  assert.match(io.errText(), /out of step with the server/);
  assert.match(io.errText(), /read_channel/);
});

test('an alias whose positional is no longer an argument fails locally', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const moved = REAL_TOOLS.map((t) => {
    if (t.name !== 'read_channel') return t;
    const { channel_id: _dropped, ...rest } = t.inputSchema.properties;
    return { ...t, inputSchema: { ...t.inputSchema, properties: { ...rest, session_id: { type: 'string' } }, required: ['session_id'] } };
  });
  const fetchFn = makeFetch({ 'tools/list': response({ jsonrpc: '2.0', id: 1, result: { tools: moved } }) });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['read', 'c1'], io);

  assert.equal(code, EXIT.USAGE);
  assert.match(io.errText(), /no longer an argument/);
});

// ---------------------------------------------------------------------------
// Schema-driven behaviour: the CLI holds no hand-written knowledge of a tool.
// ---------------------------------------------------------------------------
test('argument types are coerced from the tool schema, not guessed', async () => {
  const { runOpsCommand } = await loadCli();
  const fetchFn = makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk({ messages: [] }) });
  const io = harness({ fetchFn });

  const code = await runOpsCommand(['read', 'chan-1', '--limit', '25'], io);
  assert.equal(code, 0, io.errText());

  const call = fetchFn.calls.find((c) => c.rpcMethod === 'tools/call');
  assert.equal(call.params.name, 'read_channel');
  // `limit` is declared `integer`, so it must arrive as a NUMBER, not "25".
  assert.deepEqual(call.params.arguments, { channel_id: 'chan-1', limit: 25 });
});

test('a boolean flag needs no value and a bad integer is rejected locally', async () => {
  const { runOpsCommand, EXIT } = await loadCli();

  // `broadcast_to_channel` is the real property name on post_message — asserting
  // it here is a second, independent pin on the flag the CLI actually offers.
  // (The first draft of this test guessed `--broadcast`; the schema-driven
  // parser rejected it, which is the whole point of the parser.)
  const okFetch = makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk({ messages: [] }) });
  const okIo = harness({ fetchFn: okFetch });
  assert.equal(await runOpsCommand(['post', 'c1', 'hello', '--broadcast-to-channel'], okIo), 0, okIo.errText());
  const posted = okFetch.calls.find((c) => c.rpcMethod === 'tools/call');
  assert.equal(posted.params.arguments.broadcast_to_channel, true);

  const badFetch = makeFetch({ 'tools/list': toolsListOk });
  const badIo = harness({ fetchFn: badFetch });
  assert.equal(await runOpsCommand(['read', 'c1', '--limit', 'lots'], badIo), EXIT.USAGE);
  assert.deepEqual(badFetch.rpcMethods(), ['tools/list']);
  assert.match(badIo.errText(), /expects a number/);
});

test('call reaches a tool that has no alias, using only its published schema', async () => {
  const { runOpsCommand } = await loadCli();
  const fetchFn = makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk({ id: 'task-1' }) });
  const io = harness({ fetchFn });

  const code = await runOpsCommand(['call', 'create_task', '--title', 'Ship it', '--status', 'todo'], io);
  assert.equal(code, 0, io.errText());
  const call = fetchFn.calls.find((c) => c.rpcMethod === 'tools/call');
  assert.deepEqual(call.params, { name: 'create_task', arguments: { title: 'Ship it', status: 'todo' } });
});

test('a tool this token cannot reach is a usage error naming the surface', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const narrowed = REAL_TOOLS.filter((t) => t.name !== 'create_task');
  const fetchFn = makeFetch({ 'tools/list': response({ jsonrpc: '2.0', id: 1, result: { tools: narrowed } }) });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['call', 'create_task', '--title', 'x'], io);

  assert.equal(code, EXIT.USAGE);
  assert.deepEqual(fetchFn.rpcMethods(), ['tools/list']);
  assert.match(JSON.parse(io.errText()).error.message, /cannot reach a tool named "create_task"/);
});

// ---------------------------------------------------------------------------
// Output shape.
// ---------------------------------------------------------------------------
test('output defaults to JSON off a TTY and to columns on one', async () => {
  const { runOpsCommand } = await loadCli();
  const value = { channels: [{ id: '11111111-2222-3333-4444-555555555555', title: 'general' }] };

  const piped = harness({ fetchFn: makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk(value) }), isTTY: false });
  assert.equal(await runOpsCommand(['channels'], piped), 0);
  assert.deepEqual(JSON.parse(piped.out()), value);

  const terminal = harness({ fetchFn: makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk(value) }), isTTY: true });
  assert.equal(await runOpsCommand(['channels'], terminal), 0);
  assert.throws(() => JSON.parse(terminal.out()));
  assert.match(terminal.out(), /id\s+title/);
  assert.match(terminal.out(), /11111111…/, 'uuids are shortened in human output');
});

test('--json and --human together is a usage error', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const fetchFn = makeFetch({});
  const io = harness({ fetchFn });
  assert.equal(await runOpsCommand(['channels', '--json', '--human'], io), EXIT.USAGE);
  assert.equal(fetchFn.calls.length, 0);
});

test('errors in JSON mode leave stdout empty and emit one JSON object on stderr', async () => {
  const { runOpsCommand } = await loadCli();
  const fetchFn = makeFetch({
    'tools/list': toolsListOk,
    'tools/call': response({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'nope' }], isError: true } }),
  });
  const io = harness({ fetchFn });
  await runOpsCommand(['read', 'c1', '--json'], io);

  assert.equal(io.out(), '');
  assert.deepEqual(JSON.parse(io.errText()), { error: { code: 'tool_error', message: 'nope' } });
});

test('whoami flags a non-agent identity on stderr, keeping stdout parseable', async () => {
  const { runOpsCommand } = await loadCli();
  const fetchFn = makeFetch({
    'tools/list': toolsListOk,
    'tools/call': toolOk({ kind: 'user', workspaceId: 'ws-1', name: 'MCP client' }),
  });
  const io = harness({ fetchFn });
  assert.equal(await runOpsCommand(['whoami', '--json'], io), 0);

  assert.deepEqual(JSON.parse(io.out()).kind, 'user');
  assert.match(io.errText(), /kind="user", not as an agent/);
});

test('help exits 0 on stdout; a bare invocation exits 2 on stderr', async () => {
  const { runOpsCommand, EXIT } = await loadCli();
  const io = harness({ fetchFn: makeFetch({}) });
  assert.equal(await runOpsCommand(['help'], io), EXIT.OK);
  assert.match(io.out(), /agensis-ops/);

  const bare = harness({ fetchFn: makeFetch({}) });
  assert.equal(await runOpsCommand([], bare), EXIT.USAGE);
  assert.equal(bare.out(), '');
});

// ---------------------------------------------------------------------------
// URL resolution: the MCP door is Fly-only, and a local dev port must not be
// silently pointed at vite.
// ---------------------------------------------------------------------------
test('the MCP path is appended, dev ports are rewritten, and mcp paths pass through', async () => {
  const { normalizeMcpUrl } = await loadCli();
  assert.equal(normalizeMcpUrl('https://agensis-backend.fly.dev').url, 'https://agensis-backend.fly.dev/backend/mcp');
  assert.equal(normalizeMcpUrl('https://agensis-backend.fly.dev/').url, 'https://agensis-backend.fly.dev/backend/mcp');
  assert.equal(normalizeMcpUrl('https://agensis-backend.fly.dev/mcp').url, 'https://agensis-backend.fly.dev/mcp');
  assert.equal(normalizeMcpUrl('http://localhost:5173').url, 'http://127.0.0.1:3142/backend/mcp');
  assert.equal(normalizeMcpUrl('http://localhost:8888').url, 'http://127.0.0.1:3142/backend/mcp');
  assert.equal(normalizeMcpUrl('http://127.0.0.1:3142').url, 'http://127.0.0.1:3142/backend/mcp');
  assert.equal(normalizeMcpUrl('  ').ok, false);
});

test('a daemon profile supplies both the url and the token when nothing else does', async () => {
  const { runOpsCommand } = await loadCli();
  const fetchFn = makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk({ kind: 'agent' }) });
  const io = harness({ fetchFn, env: {} });
  io.readFile = async (file) => {
    assert.match(file, /\.agensis\/daemon-profiles\/default\.json$/);
    return JSON.stringify({ version: 2, config: { url: 'https://example.fly.dev', token: TEST_TOKEN, workspace: 'w', agent: 'a' } });
  };

  assert.equal(await runOpsCommand(['whoami'], io), 0, io.errText());
  assert.equal(fetchFn.calls[0].url, 'https://example.fly.dev/backend/mcp');
  assert.equal(fetchFn.calls[0].headers.authorization, `Bearer ${TEST_TOKEN}`);
});

test('everything after -- is passed through, so a message body may contain --json', async () => {
  const { runOpsCommand } = await loadCli();
  const fetchFn = makeFetch({ 'tools/list': toolsListOk, 'tools/call': toolOk({ id: 'm1' }) });
  const io = harness({ fetchFn });
  const code = await runOpsCommand(['post', 'c1', '--', 'build failed: pass --json next time'], io);

  assert.equal(code, 0, io.errText());
  const call = fetchFn.calls.find((c) => c.rpcMethod === 'tools/call');
  assert.equal(call.params.arguments.content, 'build failed: pass --json next time');
});
