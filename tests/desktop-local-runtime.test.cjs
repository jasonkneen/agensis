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

test('desktop supervisor spawns daemons that outlive it, with no pipes to die on', () => {
  // Orphaned connect processes used to melt down (100% CPU) writing into pipes
  // nobody read, so they were bound to the supervisor pid and died with it —
  // which also dropped every agent on each restart and hot reload. The fix is
  // not to chain them to us but to remove the pipe: output goes to a file, the
  // daemon is detached, and the next launch adopts it (findAdoptable).
  const body = fs.readFileSync(
    path.join(__dirname, '../electron/local-runtime/supervisor.cjs'),
    'utf8',
  );
  assert.match(body, /detached:\s*true/);
  assert.match(body, /stdio:\s*\['ignore',\s*logFd,\s*logFd\]/);
  assert.match(body, /AGENSIS_SUPERVISOR_PID:\s*undefined/);
  assert.doesNotMatch(body, /stdio:\s*\[[^\]]*'pipe'/);
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

// ---- daemons outlive the desktop process ---------------------------------

function adoptFixture({ beatAgeMs = 1000, beatPid, sidecar = {}, status = 'online' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-adopt-'));
  const wanted = {
    workspaceId: 'ws-1', baseUrl: 'http://127.0.0.1:3142', runtime: 'claude',
    model: 'auto', permissionMode: 'default', cwd: '/work', tokenHash: 'abc',
  };
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'desktop-session.json'), JSON.stringify({ ...wanted, pid: process.pid, ...sidecar }));
  fs.writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({
    ts: now - beatAgeMs, status, pid: beatPid ?? process.pid,
  }));
  return { dir, wanted, now };
}

test('findAdoptable keeps a live, fresh, matching daemon', () => {
  const { dir, wanted, now } = adoptFixture();
  assert.equal(supervisor.findAdoptable(dir, wanted, now)?.pid, process.pid);
});

test('findAdoptable refuses anything doubtful', () => {
  const cases = {
    'a stale heartbeat': adoptFixture({ beatAgeMs: 5 * 60_000 }),
    'a heartbeat from another pid (pid reuse)': adoptFixture({ beatPid: process.pid + 1 }),
    'a dead pid': adoptFixture({ sidecar: { pid: 2 ** 22 + 12345 }, beatPid: 2 ** 22 + 12345 }),
    'a cleanly stopped daemon': adoptFixture({ status: 'stopped' }),
    'a rotated token': adoptFixture({ sidecar: { tokenHash: 'different' } }),
    'another backend': adoptFixture({ sidecar: { baseUrl: 'https://agensis-backend.fly.dev' } }),
    'another model': adoptFixture({ sidecar: { model: 'opus' } }),
  };
  for (const [label, { dir, wanted, now }] of Object.entries(cases)) {
    assert.equal(supervisor.findAdoptable(dir, wanted, now), null, label);
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-adopt-'));
  assert.equal(supervisor.findAdoptable(empty, {}, Date.now()), null, 'no sidecar');
});

test('stateDirFor matches the CLI layout and cannot escape ~/.agensis', () => {
  const home = '/home/u';
  assert.equal(supervisor.stateDirFor('ws-1', 'agent-9', home), path.join(home, '.agensis', 'ws-1', 'agent-9'));
  const evil = supervisor.stateDirFor('../..', '../etc/passwd', home);
  assert.ok(evil.startsWith(path.join(home, '.agensis') + path.sep), evil);
  assert.ok(!evil.split(path.sep).includes('..'));
});

test('releaseAll lets go without stopping anything', () => {
  assert.doesNotThrow(() => supervisor.releaseAll());
  assert.deepEqual(supervisor.listRunning(), []);
});

test('a daemon survives releaseAll and is adopted, not respawned, by the next start', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-bin-'));
  // A stand-in for the CLI: heartbeats into ~/.agensis/<ws>/<agent> like the real one.
  const fake = path.join(bin, 'agensis');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), path = require('path'), os = require('os');
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const dir = path.join(os.homedir(), '.agensis', arg('--workspace'), arg('--agent'));
fs.mkdirSync(dir, { recursive: true });
const beat = () => fs.writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({ ts: Date.now(), status: 'online', pid: process.pid }));
beat(); setInterval(beat, 200);
console.log('registered and online');
process.on('SIGTERM', () => process.exit(0));
`, { mode: 0o755 });

  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  const options = { agentId: 'agent-1', workspaceId: 'ws-1', token: 't', baseUrl: 'http://127.0.0.1:3142', runtime: 'claude', cwd: home };
  let pid;
  try {
    const first = await supervisor.start(options);
    assert.equal(first.adopted, undefined);
    pid = first.pid;
    await new Promise((r) => setTimeout(r, 700)); // let it heartbeat

    supervisor.releaseAll(); // what a hot reload / SIGTERM does
    process.kill(pid, 0); // still alive

    const second = await supervisor.start(options);
    assert.equal(second.adopted, true);
    assert.equal(second.pid, pid, 'same process, not a respawn');
    assert.equal(supervisor.status('agent-1').running, true);

    // Changed settings are not adopted: the old daemon is retired.
    supervisor.releaseAll();
    const third = await supervisor.start({ ...options, model: 'opus' });
    assert.notEqual(third.adopted, true);
    assert.notEqual(third.pid, pid);
    assert.throws(() => process.kill(pid, 0), 'old daemon was retired');
    pid = third.pid;
  } finally {
    await supervisor.stopAll();
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
  }
  assert.throws(() => process.kill(pid, 0), 'stopAll stops the daemon');
});
