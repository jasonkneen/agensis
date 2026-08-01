'use strict';

// Local agent discovery — path resolution and well-known install dirs that
// make claude/codex/amp/grok (and the rest of the catalog) visible in a GUI app.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveCommandPath,
  commonBinaryDirs,
  detectLocalAgentCapabilities,
  detectSkillLibraries,
  LOCAL_AGENT_CLI_DEFINITIONS,
  isSafeNvmTag,
} = require('../shared/local-agent-discovery.cjs');

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-local-agents-'));
}

function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
}

test('LOCAL_AGENT_CLI_DEFINITIONS covers core and extended harnesses', () => {
  const ids = LOCAL_AGENT_CLI_DEFINITIONS.map(d => d.id);
  for (const id of [
    'goose', 'claude', 'codex',
    'cursor', 'omp', 'grok', 'opencode', 'kimi', 'amp', 'hermes', 'openclaw',
    'gemini', 'qwen', 'crush', 'aider',
  ]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  const claude = LOCAL_AGENT_CLI_DEFINITIONS.find(d => d.id === 'claude');
  assert.ok(claude.adapter_commands.includes('claude-agent-acp'));
  const amp = LOCAL_AGENT_CLI_DEFINITIONS.find(d => d.id === 'amp');
  assert.ok(amp.adapter_commands.includes('amp-acp'));
  assert.equal(amp.underlying_cli, 'amp');
  const hermes = LOCAL_AGENT_CLI_DEFINITIONS.find(d => d.id === 'hermes');
  assert.ok(hermes.commands.includes('hermes-acp'));
});

test('commonBinaryDirs includes Homebrew, nvm-friendly homes, and .grok/bin', () => {
  const home = '/tmp/fake-home-for-dirs';
  const dirs = commonBinaryDirs(home);
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.ok(dirs.includes('/usr/local/bin'));
  assert.ok(dirs.includes(path.join(home, '.local', 'bin')));
  assert.ok(dirs.includes(path.join(home, '.grok', 'bin')));
  assert.ok(dirs.includes(path.join(home, '.volta', 'bin')));
  assert.ok(dirs.includes(path.join(home, '.local', 'share', 'mise', 'shims')));
});

test('resolveCommandPath finds a binary under ~/.local/bin when PATH is empty', () => {
  const home = makeTempHome();
  try {
    const claude = path.join(home, '.local', 'bin', 'claude');
    writeExecutable(claude);
    const resolved = resolveCommandPath('claude', {
      home,
      pathEnv: '',
      skipLoginShell: true,
    });
    assert.equal(resolved, claude);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveCommandPath finds grok under ~/.grok/bin', () => {
  const home = makeTempHome();
  try {
    const grok = path.join(home, '.grok', 'bin', 'grok');
    writeExecutable(grok);
    const resolved = resolveCommandPath('grok', {
      home,
      pathEnv: '',
      skipLoginShell: true,
    });
    assert.equal(resolved, grok);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveCommandPath prefers process PATH over common dirs', () => {
  const home = makeTempHome();
  try {
    const pathDir = path.join(home, 'on-path');
    const commonDir = path.join(home, '.local', 'bin');
    const onPath = path.join(pathDir, 'codex');
    const inCommon = path.join(commonDir, 'codex');
    writeExecutable(onPath);
    writeExecutable(inCommon);
    const resolved = resolveCommandPath('codex', {
      home,
      pathEnv: pathDir,
      skipLoginShell: true,
    });
    assert.equal(resolved, onPath);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveCommandPath uses injected login-shell PATH when process PATH and common dirs miss', () => {
  // Use a unique binary name so a real Homebrew install cannot win first.
  const home = makeTempHome();
  try {
    const shellBin = path.join(home, 'shell-bin');
    const unique = path.join(shellBin, 'agensis-probe-cli-xyz');
    writeExecutable(unique);
    const resolved = resolveCommandPath('agensis-probe-cli-xyz', {
      home,
      pathEnv: '',
      loginShellPath: shellBin,
      skipLoginShell: false,
    });
    assert.equal(resolved, unique);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveCommandPath returns null for a missing command', () => {
  const resolved = resolveCommandPath('definitely-not-installed-xyz', {
    home: makeTempHome(),
    pathEnv: '',
    skipLoginShell: true,
  });
  assert.equal(resolved, null);
});

test('detectLocalAgentCapabilities reports available clis by path probe', async () => {
  const home = makeTempHome();
  try {
    writeExecutable(path.join(home, '.local', 'bin', 'claude'));
    writeExecutable(path.join(home, '.local', 'bin', 'codex'));
    writeExecutable(path.join(home, '.local', 'bin', 'amp'));
    writeExecutable(path.join(home, '.local', 'bin', 'hermes-acp'));
    writeExecutable(path.join(home, '.grok', 'bin', 'grok'));

    const caps = await detectLocalAgentCapabilities({
      home,
      pathEnv: '',
      skipLoginShell: true,
      workspacePath: home,
      cliDefinitions: [
        { id: 'claude', label: 'Claude Code', commands: ['claude'], adapter_commands: ['claude-agent-acp'] },
        { id: 'codex', label: 'Codex', commands: ['codex'], adapter_commands: ['codex-acp'] },
        { id: 'amp', label: 'Amp', commands: ['amp-acp', 'amp'], adapter_commands: ['amp-acp'], underlying_cli: 'amp' },
        { id: 'grok', label: 'Grok', commands: ['grok'] },
        { id: 'hermes', label: 'Hermes Agent', commands: ['hermes-acp', 'hermes'], adapter_commands: ['hermes-acp'] },
      ],
    });

    assert.equal(caps.source, 'local-desktop');
    assert.equal(caps.codexAppServer.available, true);
    const byId = Object.fromEntries(caps.clis.map(c => [c.id, c]));
    assert.equal(byId.claude.available, true);
    assert.equal(byId.codex.available, true);
    assert.equal(byId.amp.available, true);
    assert.equal(byId.grok.available, true);
    assert.equal(byId.hermes.available, true);
    assert.ok(byId.claude.path.endsWith(`${path.sep}claude`));
    assert.ok(byId.grok.path.includes(`${path.sep}.grok${path.sep}bin${path.sep}`));
    assert.ok(byId.hermes.path.endsWith(`${path.sep}hermes-acp`));
    assert.equal(byId.hermes.adapter?.path?.endsWith(`${path.sep}hermes-acp`), true);
    // amp vendor CLI present, adapter missing → still available via underlying
    assert.equal(byId.amp.underlying?.available, true);
    assert.equal(byId.amp.adapter?.path, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectSkillLibraries sees ~/.claude and ~/.codex under a fake home', () => {
  const home = makeTempHome();
  try {
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'foo.md'), '# foo\n');
    const libs = detectSkillLibraries(home, home);
    const claudeSkills = libs.find(l => l.id === 'claude-skills');
    const codexSkills = libs.find(l => l.id === 'codex-user-skills');
    assert.equal(claudeSkills?.available, true);
    assert.equal(claudeSkills?.count, 1);
    assert.equal(codexSkills?.available, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isSafeNvmTag rejects traversal', () => {
  assert.equal(isSafeNvmTag('v22.1.0'), true);
  assert.equal(isSafeNvmTag('lts/hydrogen'), true);
  assert.equal(isSafeNvmTag('../evil'), false);
  assert.equal(isSafeNvmTag('/abs'), false);
  assert.equal(isSafeNvmTag(''), false);
});
