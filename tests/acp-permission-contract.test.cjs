// ============================================================================
// tests/acp-permission-contract.test.cjs
// ----------------------------------------------------------------------------
// Desktop ACP ACCESS / tool-permission contract.
//
// Shipped broken once (v0.1.3 era): Full access in the Agents UI did not call
// session/set_mode bypassPermissions, permission replies used a flat
// { outcome, optionId } that Claude Code ACP treats as deny, and Ask mode
// silent-cancelled with no UI. Users saw "every command rejected" with no
// approval card.
//
// THIS FILE EXISTS SO THAT REGRESSION FAILS CI — not so a comment in a PR can
// claim we checked. If any assertion here goes red, do not "fix" it by
// weakening the assertion. Fix the client or update this file AND AGENTS.md
// together with a written reason.
//
// Layers:
//   1. Pure helpers (shape, mode map) — byte-level contract with Claude ACP
//   2. Wire recording against the fake agent — real JSON-RPC on the pipe
//   3. Source scans — UI → IPC → host must pass permission_mode; client must
//      still contain set_mode + nested outcome + dialog path
// ============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createAcpClient,
  DESKTOP_CLIENT_CAPABILITIES,
  mapAccessModeToAcpSessionMode,
  normalizeAccessMode,
  isElevatedAccessMode,
  pickPermissionOption,
  permissionResultSelected,
  permissionResultCancelled,
  isEditToolCall,
} = require('../electron/acp/client.cjs');

const ROOT = path.resolve(__dirname, '..');
const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');

const CLAUDE_TOOL_OPTIONS = [
  { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
  { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
  { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
];

// ---------------------------------------------------------------------------
// 1. Pure helpers — the shapes Claude Code ACP actually inspects
// ---------------------------------------------------------------------------

test('CONTRACT: all product ACCESS modes map correctly (DB spellings + aliases)', () => {
  // Product/DB/UI: default | accept_edits | yolo
  assert.equal(normalizeAccessMode('default'), 'default');
  assert.equal(normalizeAccessMode('accept_edits'), 'acceptedits');
  assert.equal(normalizeAccessMode('yolo'), 'yolo');
  // Aliases that must not silently become Ask
  assert.equal(normalizeAccessMode('acceptEdits'), 'acceptedits');
  assert.equal(normalizeAccessMode('accept-edits'), 'acceptedits');
  assert.equal(normalizeAccessMode('YOLO'), 'yolo');
  assert.equal(normalizeAccessMode('full_access'), 'yolo');
  assert.equal(normalizeAccessMode('bypassPermissions'), 'yolo');
  // Unknown → Ask (fail closed), never Full access
  assert.equal(normalizeAccessMode(''), 'default');
  assert.equal(normalizeAccessMode('garbage'), 'default');
  assert.equal(normalizeAccessMode('', true), 'yolo');
  assert.equal(normalizeAccessMode('', false), 'default');

  assert.equal(mapAccessModeToAcpSessionMode('default'), 'default');
  assert.equal(mapAccessModeToAcpSessionMode('accept_edits'), 'acceptEdits');
  assert.equal(mapAccessModeToAcpSessionMode('acceptEdits'), 'acceptEdits');
  assert.equal(mapAccessModeToAcpSessionMode('yolo'), 'bypassPermissions');
  assert.equal(mapAccessModeToAcpSessionMode('YOLO'), 'bypassPermissions');

  assert.equal(isElevatedAccessMode('default'), false);
  assert.equal(isElevatedAccessMode('accept_edits'), true);
  assert.equal(isElevatedAccessMode('acceptEdits'), true);
  assert.equal(isElevatedAccessMode('yolo'), true);
});

test('CONTRACT: permission result is nested { outcome: { outcome, optionId } } — flat shape is a deny', () => {
  const selected = permissionResultSelected({ optionId: 'allow_always', kind: 'allow_always' });
  // Claude Code ACP reads response.outcome.outcome and response.outcome.optionId.
  // A flat { outcome: 'selected', optionId } makes outcome a string → optionId undefined → deny.
  assert.equal(typeof selected.outcome, 'object');
  assert.notEqual(typeof selected.outcome, 'string');
  assert.equal(selected.outcome.outcome, 'selected');
  assert.equal(selected.outcome.optionId, 'allow_always');
  assert.equal(selected.optionId, undefined, 'optionId must not sit next to outcome (flat shape)');

  const cancelled = permissionResultCancelled();
  assert.equal(cancelled.outcome.outcome, 'cancelled');
  assert.equal(cancelled.outcome.optionId, undefined);

  // Explicitly reject the broken shape that shipped.
  const brokenFlat = { outcome: 'selected', optionId: 'allow' };
  assert.notDeepEqual(selected, brokenFlat);
  assert.equal(brokenFlat.outcome?.outcome, undefined, 'flat shape has no nested outcome');
});

test('CONTRACT: pickPermissionOption matches Claude Code ACP optionIds', () => {
  assert.equal(pickPermissionOption(CLAUDE_TOOL_OPTIONS, 'allow_always').optionId, 'allow_always');
  assert.equal(pickPermissionOption(CLAUDE_TOOL_OPTIONS, 'allow_once').optionId, 'allow');
  assert.equal(pickPermissionOption(CLAUDE_TOOL_OPTIONS, 'reject').optionId, 'reject');
  // allow_once must not grab allow_always just because the id contains "allow".
  const onceOnly = pickPermissionOption(
    [
      { kind: 'allow_always', optionId: 'allow_always', name: 'Always' },
      { kind: 'allow_once', optionId: 'allow', name: 'Once' },
    ],
    'allow_once',
  );
  assert.equal(onceOnly.optionId, 'allow');
});

test('CONTRACT: acceptEdits auto-allow is edit tools only', () => {
  assert.equal(isEditToolCall({ toolCall: { kind: 'edit', title: 'Edit' } }), true);
  assert.equal(isEditToolCall({ toolCall: { kind: 'execute', title: 'Bash' } }), false);
  assert.equal(isEditToolCall({ toolCall: { title: 'Bash(ls)' } }), false);
});

// ---------------------------------------------------------------------------
// 2. Wire — real JSON-RPC frames the agent process receives
// ---------------------------------------------------------------------------

test('CONTRACT: yolo session/new is followed by session/set_mode bypassPermissions on the wire', async () => {
  /** @type {object[]} */
  const outbound = [];
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'yolo',
    onOutbound: (msg) => outbound.push(msg),
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());

    const setMode = outbound.find((m) => m.method === 'session/set_mode');
    assert.ok(setMode, `expected session/set_mode on the wire, got methods: ${outbound.map((m) => m.method).filter(Boolean).join(', ')}`);
    assert.equal(setMode.params.modeId, 'bypassPermissions');
    assert.equal(setMode.params.sessionId, client.sessionId);
  } finally {
    client.dispose();
  }
});

test('CONTRACT: accept_edits (product spelling) sets mode acceptEdits on the wire', async () => {
  const outbound = [];
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    // DB/UI spelling — this was the real bug: host only matched acceptEdits.
    permissionMode: 'accept_edits',
    onOutbound: (msg) => outbound.push(msg),
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    assert.equal(client.accessMode, 'acceptedits');
    assert.equal(client.acpSessionMode, 'acceptEdits');
    const setMode = outbound.find((m) => m.method === 'session/set_mode');
    assert.ok(setMode, 'accept_edits must call session/set_mode');
    assert.equal(setMode.params.modeId, 'acceptEdits');
  } finally {
    client.dispose();
  }
});

test('CONTRACT: acceptEdits alias also sets mode acceptEdits', async () => {
  const outbound = [];
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'acceptEdits',
    onOutbound: (msg) => outbound.push(msg),
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    const setMode = outbound.find((m) => m.method === 'session/set_mode');
    assert.ok(setMode);
    assert.equal(setMode.params.modeId, 'acceptEdits');
  } finally {
    client.dispose();
  }
});

test('CONTRACT: default/Ask does NOT call set_mode bypassPermissions', async () => {
  const outbound = [];
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'default',
    autoApprove: false,
    onOutbound: (msg) => outbound.push(msg),
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    assert.equal(client.accessMode, 'default');
    assert.equal(client.acpSessionMode, 'default');
    const setMode = outbound.find((m) => m.method === 'session/set_mode');
    // Either no set_mode, or explicit default — never full access by accident.
    if (setMode) {
      assert.notEqual(setMode.params.modeId, 'bypassPermissions');
      assert.notEqual(setMode.params.modeId, 'acceptEdits');
    }
  } finally {
    client.dispose();
  }
});

test('CONTRACT: yolo permission reply on the wire is nested selected + allow_always', async () => {
  const outbound = [];
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'yolo',
    onOutbound: (msg) => outbound.push(msg),
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    const before = outbound.length;
    const result = await client.prompt('NEED_PERMISSION:Bash ls');
    assert.match(result.text, /Permitted/);

    const permReplies = outbound.slice(before).filter((m) => (
      m.result
      && m.result.outcome
      && m.id !== undefined
      && !m.method
    ));
    assert.ok(permReplies.length >= 1, 'expected a permission result frame');
    for (const reply of permReplies) {
      assert.equal(typeof reply.result.outcome, 'object');
      assert.equal(reply.result.outcome.outcome, 'selected');
      assert.ok(
        reply.result.outcome.optionId === 'allow_always' || reply.result.outcome.optionId === 'allow',
        `unexpected optionId ${reply.result.outcome.optionId}`,
      );
      // Flat shape must never appear.
      assert.equal(reply.result.optionId, undefined);
      assert.notEqual(typeof reply.result.outcome, 'string');
    }
  } finally {
    client.dispose();
  }
});

test('CONTRACT: MODE MATRIX residual request_permission (set_mode fallback path)', async () => {
  async function runMode(permissionMode, toolTitle) {
    const client = createAcpClient({
      command: process.execPath,
      args: [FAKE_AGENT],
      cwd: process.cwd(),
      permissionMode,
      autoApprove: false,
    });
    try {
      await client.initialize();
      await client.newSession(process.cwd());
      const result = await client.prompt(`NEED_PERMISSION:${toolTitle}`);
      return result.text;
    } finally {
      client.dispose();
    }
  }

  // Ask: every tool denied without a dialog (no silent allow).
  assert.match(await runMode('default', 'Bash ls'), /Denied/);
  assert.match(await runMode('default', 'Edit file'), /Denied/);

  // Full access: shell and edits allowed.
  assert.match(await runMode('yolo', 'Bash ls'), /Permitted/);
  assert.match(await runMode('yolo', 'Edit file'), /Permitted/);

  // Auto-accept edits (product spelling): edits allowed, shell still asks → deny without dialog.
  assert.match(await runMode('accept_edits', 'Edit file'), /Permitted/);
  assert.match(await runMode('accept_edits', 'Write src/x.ts'), /Permitted/);
  assert.match(await runMode('accept_edits', 'Bash ls'), /Denied/);
  // camelCase alias must behave the same
  assert.match(await runMode('acceptEdits', 'Bash ls'), /Denied/);
  assert.match(await runMode('acceptEdits', 'Edit file'), /Permitted/);
});

test('CONTRACT: Ask without a dialog must not auto-allow shell (no silent full access)', async () => {
  const client = createAcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    permissionMode: 'default',
    autoApprove: false,
  });
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    const result = await client.prompt('NEED_PERMISSION:Bash ls');
    assert.match(result.text, /Denied/, 'Ask mode without UI must reject, not allow');
    assert.doesNotMatch(result.text, /Permitted/);
  } finally {
    client.dispose();
  }
});

// ---------------------------------------------------------------------------
// 3. Source scans — the call chain cannot drop permission_mode
// ---------------------------------------------------------------------------

function readRepo(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('CONTRACT: client source still implements set_mode + nested outcome + dialog (not silent cancel only)', () => {
  const src = readRepo('electron/acp/client.cjs');
  assert.match(src, /session\/set_mode/);
  assert.match(src, /bypassPermissions/);
  assert.match(src, /outcome:\s*\{\s*outcome:\s*['"]selected['"]/);
  assert.match(src, /askPermissionViaDialog/);
  // The original silent-cancel path: cancel without dialog when autoApprove is false.
  // Must not be the only path — dialog must still be referenced from request_permission.
  assert.match(src, /session\/request_permission/);
  // Flat shape must not be reintroduced as the result builder.
  assert.doesNotMatch(
    src,
    /return\s*\{\s*outcome:\s*['"]selected['"]\s*,\s*optionId/,
    'flat permission result shape reintroduced',
  );
});

test('CONTRACT: desktop does NOT advertise fs/terminal (forces mcp__acp__* and kills native Edit)', () => {
  // claude-code-acp: if clientCapabilities.fs.readTextFile, it disallows native
  // Read and only allows mcp__acp__Read via an injected MCP server. Same for
  // writeTextFile → Write/Edit. Desktop agents need native host tools.
  assert.equal(DESKTOP_CLIENT_CAPABILITIES.fs.readTextFile, false);
  assert.equal(DESKTOP_CLIENT_CAPABILITIES.fs.writeTextFile, false);
  assert.equal(DESKTOP_CLIENT_CAPABILITIES.terminal, false);

  const src = readRepo('electron/acp/client.cjs');
  // initialize must not hard-code readTextFile: true again.
  assert.doesNotMatch(
    src,
    /readTextFile:\s*true/,
    'readTextFile:true reintroduced — will force mcp__acp__Read and break native tools',
  );
  assert.doesNotMatch(
    src,
    /writeTextFile:\s*true/,
    'writeTextFile:true reintroduced — will disable native Write/Edit',
  );
  assert.match(src, /DESKTOP_CLIENT_CAPABILITIES/);
});

test('CONTRACT: host + main pass permissionMode into createAcpClient / start', () => {
  const host = readRepo('electron/acp/host.cjs');
  const main = readRepo('electron/main.cjs');
  assert.match(host, /permissionMode/);
  assert.match(host, /createAcpClient\s*\(/);
  assert.match(host, /permissionMode,/);
  assert.match(main, /acp:start/);
  assert.match(main, /permissionMode/);
  // Must not default unknown → yolo (that hid Ask failures behind full access).
  // After trim empty, only autoApprove===true may promote to yolo.
  assert.match(main, /autoApprove === true \? 'yolo' : 'default'/);
});

test('CONTRACT: Agents window Start ACP forwards agent.permission_mode (product spellings)', () => {
  const ui = readRepo('src/components/windows/AgentsWindowContent.tsx');
  // Both start and restart paths use shorthand `{ permissionMode, ... }`.
  const starts = ui.match(/^\s*permissionMode,\s*$/gm) || [];
  assert.ok(starts.length >= 2, `expected permissionMode passed to acp.start at least twice, got ${starts.length}`);
  assert.match(ui, /agent\.permission_mode\s*\|\|\s*['"]default['"]/);
  assert.match(ui, /const permissionMode = agent\.permission_mode/);
  // Radios use product values; autoApprove must match accept_edits not only acceptEdits.
  assert.match(ui, /value:\s*['"]accept_edits['"]/);
  assert.match(ui, /value:\s*['"]yolo['"]/);
  assert.match(ui, /value:\s*['"]default['"]/);
  assert.match(ui, /permissionMode === ['"]accept_edits['"]/);
  assert.doesNotMatch(
    ui,
    /permissionMode === ['"]acceptEdits['"]/,
    'UI must use product spelling accept_edits for autoApprove (not camelCase only)',
  );
});

test('CONTRACT: PERMISSION_MODE_OPTIONS is exactly the three product modes', () => {
  const ui = readRepo('src/components/windows/AgentsWindowContent.tsx');
  const block = ui.match(/const PERMISSION_MODE_OPTIONS[\s\S]*?^];/m);
  assert.ok(block, 'PERMISSION_MODE_OPTIONS missing');
  const values = [...block[0].matchAll(/value:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(values, ['default', 'accept_edits', 'yolo']);
});

test('CONTRACT: desktop-acp tests stay in npm test glob (top-level tests/*.test.cjs)', () => {
  // package.json "test" is tests/*.test.cjs only — a file moved to tests/acp/
  // would silently leave CI.
  const files = [
    'tests/desktop-acp-client.test.cjs',
    'tests/acp-permission-contract.test.cjs',
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `missing ${f}`);
    assert.match(f, /^tests\/[^/]+\.test\.cjs$/, `${f} must live at tests/*.test.cjs for npm test`);
  }
});
