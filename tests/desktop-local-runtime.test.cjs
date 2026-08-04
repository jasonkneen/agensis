'use strict';

// Desktop local runtime replaces the former ACP host.
// Start on this Mac must resolve the CLI binary, map runtimes, and never
// rewrite Vite origins onto the daemon WS path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveHttpBackendBase,
  normalizeRuntime,
  resolveAgensisBinary,
  CANDIDATES,
} = require('../electron/local-runtime/resolveBinary.cjs');
const { createAutostartStore } = require('../electron/local-runtime/autostart.cjs');
const supervisor = require('../electron/local-runtime/supervisor.cjs');

test('resolveHttpBackendBase rewrites Vite loopback to :3142', () => {
  assert.equal(resolveHttpBackendBase('http://127.0.0.1:5173'), 'http://127.0.0.1:3142');
  assert.equal(resolveHttpBackendBase('http://localhost:5173/'), 'http://127.0.0.1:3142');
  assert.equal(resolveHttpBackendBase('https://agensis-backend.fly.dev'), 'https://agensis-backend.fly.dev');
  assert.equal(resolveHttpBackendBase('http://127.0.0.1:3142'), 'http://127.0.0.1:3142');
  assert.equal(resolveHttpBackendBase(''), 'http://127.0.0.1:3142');
});

test('normalizeRuntime only accepts classic pins', () => {
  assert.equal(normalizeRuntime('claude'), 'claude');
  assert.equal(normalizeRuntime('Codex'), 'codex');
  assert.equal(normalizeRuntime('AMP'), 'amp');
  assert.equal(normalizeRuntime('grok'), '');
  assert.equal(normalizeRuntime('hermes'), '');
  assert.equal(normalizeRuntime(''), '');
});

test('listRuntimes reports full desktop catalog shapes', () => {
  const listed = supervisor.listRuntimes();
  assert.ok(listed.daemon);
  assert.ok(Array.isArray(listed.runtimes));
  const ids = listed.runtimes.map((r) => r.id);
  for (const need of ['claude', 'codex', 'amp', 'grok', 'hermes', 'omp', 'goose', 'cursor', 'opencode', 'kimi', 'openclaw']) {
    assert.ok(ids.includes(need), `missing runtime ${need}`);
  }
  for (const r of listed.runtimes) {
    assert.equal(typeof r.label, 'string');
    assert.equal(typeof r.available, 'boolean');
    assert.equal(typeof r.mode, 'string');
    assert.ok(['sdk', 'app-server', 'amp', 'acp', 'cli'].includes(r.mode), r.mode);
  }
});

test('buildConnectFlags: claude/codex force --no-acp; harnesses use --acp-harness', () => {
  const { buildConnectFlags } = require('../electron/local-runtime/runtimeCatalog.cjs');

  const claude = buildConnectFlags('claude');
  assert.ok(claude.args.includes('--no-acp'));
  assert.ok(claude.args.includes('--runtime'));
  assert.equal(claude.env.AGENSIS_ACP, '0');
  assert.equal(claude.classicRuntime, 'claude');

  const codex = buildConnectFlags('codex');
  assert.ok(codex.args.includes('--no-acp'));
  assert.deepEqual(
    codex.args.slice(codex.args.indexOf('--runtime'), codex.args.indexOf('--runtime') + 2),
    ['--runtime', 'codex'],
  );

  const hermes = buildConnectFlags('hermes');
  assert.ok(!hermes.args.includes('--no-acp'));
  assert.ok(hermes.args.includes('--acp-harness'));
  assert.equal(hermes.env.AGENSIS_ACP, '1');
  assert.equal(hermes.acpHarness, 'hermes');

  const grok = buildConnectFlags('grok');
  assert.equal(grok.acpHarness, 'grok');
  assert.equal(grok.env.AGENSIS_ACP_HARNESS, 'grok');

  const pi = buildConnectFlags('pi'); // alias → omp
  assert.equal(pi.def.id, 'omp');
  assert.ok(pi.args.includes('--coding-cmd'));
  assert.ok(pi.args.includes('omp'));
});

test('pickRuntimeId accepts harness ids and pi alias', () => {
  assert.equal(supervisor.pickRuntimeId({ runtime: 'hermes' }), 'hermes');
  assert.equal(supervisor.pickRuntimeId({ harnessId: 'grok' }), 'grok');
  assert.equal(supervisor.pickRuntimeId({ runtime: 'pi' }), 'omp');
  assert.equal(supervisor.pickRuntimeId({}), 'claude');
});

test('autostart store persists runtime (not harness) and migrates ACP files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-local-runtime-'));
  try {
    // Legacy ACP manifest + encrypted token map.
    fs.writeFileSync(
      path.join(dir, 'acp-autostart.json'),
      JSON.stringify({
        version: 1,
        openAtLogin: true,
        agents: [{
          agentId: 'a1',
          harnessId: 'hermes',
          workspaceId: 'w1',
          handle: 'hermes',
          name: 'Hermes',
          model: 'auto',
          baseUrl: 'http://127.0.0.1:3142',
          autoStart: true,
          savedAt: new Date().toISOString(),
        }],
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'acp-autostart.tokens'), JSON.stringify({}), 'utf8');

    const tokens = new Map();
    const store = createAutostartStore({
      userDataDir: dir,
      encrypt: (plain) => {
        tokens.set('last', plain);
        return Buffer.from(`enc:${plain}`, 'utf8');
      },
      decrypt: (buf) => {
        const s = buf.toString('utf8');
        return s.startsWith('enc:') ? s.slice(4) : null;
      },
    });

    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].agentId, 'a1');
    // Non-classic ACP harness id is preserved (hermes stays hermes).
    assert.equal(list[0].runtime, 'hermes');
    assert.equal(store.shouldOpenAtLogin(), true);

    const remembered = store.remember({
      agentId: 'a2',
      runtime: 'codex',
      workspaceId: 'w1',
      handle: 'codex',
      name: 'Codex',
      model: 'gpt-5',
      baseUrl: 'https://agensis-backend.fly.dev',
      permissionMode: 'default',
    }, 'aga_secret');
    assert.equal(remembered.saved, true);
    assert.equal(remembered.tokenStored, true);
    assert.equal(store.loadToken('a2'), 'aga_secret');

    const after = store.list();
    assert.equal(after.find((a) => a.agentId === 'a2')?.runtime, 'codex');

    store.forget('a2');
    assert.equal(store.loadToken('a2'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CANDIDATES include agensis and agensis-agent', () => {
  assert.deepEqual(CANDIDATES, ['agensis', 'agensis-agent']);
});

test('resolveAgensisBinary returns null or a usable shape', () => {
  const binary = resolveAgensisBinary({ pathEnv: '/nonexistent/bin' });
  // Either null or npx fallback — never a bare throw.
  if (binary) {
    assert.equal(typeof binary.command, 'string');
    assert.ok(Array.isArray(binary.argsPrefix));
  }
});

test('preload exposes localRuntime not acp', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron/preload.cjs'), 'utf8');
  assert.match(src, /localRuntime\s*:/);
  assert.doesNotMatch(src, /\bacp\s*:/);
  assert.match(src, /local-runtime:start/);
});

test('main process wires local-runtime IPC channels', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron/main.cjs'), 'utf8');
  assert.match(src, /local-runtime:start/);
  assert.match(src, /local-runtime:stop/);
  assert.match(src, /local-runtime:status/);
  assert.match(src, /local-runtime\/supervisor\.cjs/);
  assert.doesNotMatch(src, /electron\/acp\//);
  assert.doesNotMatch(src, /require\('\.\/acp\//);
});

// Windows daemon spawn. resolveAgensisBinary resolves `agensis`/`npx` to the
// npm .cmd shim on Windows, which needs shell:true — and shell:true on Windows
// does no arg escaping of its own, so the supervisor must quote each arg.
const { quoteWindowsShellArg } = supervisor;

test('quoteWindowsShellArg leaves plain args untouched', () => {
  assert.equal(quoteWindowsShellArg('connect'), 'connect');
  assert.equal(quoteWindowsShellArg('--no-acp'), '--no-acp');
  assert.equal(quoteWindowsShellArg(''), '""');
});

test('quoteWindowsShellArg quotes args with spaces', () => {
  assert.equal(quoteWindowsShellArg('arg with spaces'), '"arg with spaces"');
  // --cwd and --name routinely carry spaces on Windows.
  assert.equal(quoteWindowsShellArg('C:\\Users\\a b\\proj'), '"C:\\Users\\a b\\proj"');
});

test('quoteWindowsShellArg doubles a trailing backslash run so it cannot escape the closing quote', () => {
  // The CRT command-line parser only treats backslashes as escapes when they
  // precede a quote, so an undoubled `proj\` would turn the closing quote into
  // a literal one and swallow the following args. A --cwd with a trailing
  // separator is the everyday way to hit this.
  assert.equal(quoteWindowsShellArg('C:\\Users\\a b\\proj\\'), '"C:\\Users\\a b\\proj\\\\"');
  assert.equal(quoteWindowsShellArg('a b\\\\'), '"a b\\\\\\\\"');
  // Interior backslashes are not before a quote, so they stay as-is.
  assert.equal(quoteWindowsShellArg('C:\\a b\\\\c'), '"C:\\a b\\\\c"');
});

test('quoteWindowsShellArg escapes double quotes', () => {
  assert.equal(quoteWindowsShellArg('say "hi"'), '"say ""hi"""');
});

test('quoteWindowsShellArg doubles a backslash run sitting in front of a quote', () => {
  // Same CRT escaping rule as the trailing case: an undoubled backslash before
  // a quote escapes it, so `a\"b` would lose the argument boundary and swallow
  // whatever follows. Verified by round-tripping through a real cmd.exe shim.
  assert.equal(quoteWindowsShellArg('a b\\"c'), '"a b\\\\""c"');
  // The quote stays "" rather than \": cmd.exe does not understand \", so it
  // would count the region as unquoted and run the metacharacter — `&calc`
  // here — as a command of its own.
  assert.equal(quoteWindowsShellArg('name\\"&calc'), '"name\\\\""&calc"');
});

test('quoteWindowsShellArg quotes cmd.exe metacharacters', () => {
  for (const meta of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a(b)']) {
    assert.equal(quoteWindowsShellArg(meta), `"${meta}"`, meta);
  }
});

test('quoteWindowsShellArg refuses literal percent signs rather than pass through an unsafe escape', () => {
  // cmd.exe expands %VAR% while parsing the command line even inside a
  // double-quoted argument, and the usual %% escape does not survive the
  // extra quoting layer Node's shell:true adds for `cmd /d /s /c "..."`
  // (verified empirically against a real cmd.exe: %%USERPROFILE%% still
  // expanded to the real path). Refuse rather than ship a broken escape.
  assert.throws(() => quoteWindowsShellArg('%USERPROFILE%'), /Refusing to pass "%"/);
  assert.throws(() => quoteWindowsShellArg('100%'), /Refusing to pass "%"/);
});

test('supervisor spawns .cmd/.bat shims through a shell, .exe directly', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'electron/local-runtime/supervisor.cjs'),
    'utf8',
  );
  // shell:true is gated on win32 AND a shim extension — never unconditional.
  assert.match(src, /process\.platform === 'win32' && \/\\.\(cmd\|bat\)\$\/i\.test\(binary\.command\)/);
  assert.match(src, /shell: needsShell/);
  assert.match(src, /windowsHide: true/);
  // Args must be quoted on the shell path.
  assert.match(src, /args\.map\(quoteWindowsShellArg\)/);
});
