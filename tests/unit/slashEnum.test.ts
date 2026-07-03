import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCommandEntries, detectSkillNames } from '../../agent/agensis-cli/src/slashEnum.mjs';

let home: string;
let cwd: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-slash-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-slash-cwd-'));

  // ~/.claude/commands
  const cmds = path.join(home, '.claude', 'commands');
  fs.mkdirSync(cmds, { recursive: true });
  fs.writeFileSync(path.join(cmds, 'debug.md'), '# debug');
  fs.writeFileSync(path.join(cmds, 'dispatch.md'), '# dispatch');
  fs.mkdirSync(path.join(cmds, '.hidden'), { recursive: true }); // dotdir → ignored
  fs.writeFileSync(path.join(cmds, '.hidden', 'secret.md'), '# secret');
  // namespaced folder → parent:child
  fs.mkdirSync(path.join(cmds, 'cascade'), { recursive: true });
  fs.writeFileSync(path.join(cmds, 'cascade', 'cascade-plan.md'), '# plan');
  fs.writeFileSync(path.join(cmds, 'cascade', 'cascade-exec.md'), '# exec');
  // symlinked command
  const realCmd = path.join(home, 'external-cmd.md');
  fs.writeFileSync(realCmd, '# external');
  fs.symlinkSync(realCmd, path.join(cmds, 'linked.md'));

  // ~/.claude/skills — a directory-style skill and a single-file skill
  const skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'agent-browser'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'agent-browser', 'SKILL.md'), '# skill');
  fs.writeFileSync(path.join(skills, 'quick.md'), '# quick');

  // project-scoped command
  const projCmds = path.join(cwd, '.claude', 'commands');
  fs.mkdirSync(projCmds, { recursive: true });
  fs.writeFileSync(path.join(projCmds, 'deploy.md'), '# deploy');
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('detectCommandEntries', () => {
  it('enumerates loose commands as parent-null', () => {
    const entries = detectCommandEntries({ home, cwd });
    expect(entries).toContainEqual({ name: 'debug', parent: null });
    expect(entries).toContainEqual({ name: 'dispatch', parent: null });
  });

  it('namespaces one-level subfolders as parent:child', () => {
    const entries = detectCommandEntries({ home, cwd });
    expect(entries).toContainEqual({ name: 'cascade-plan', parent: 'cascade' });
    expect(entries).toContainEqual({ name: 'cascade-exec', parent: 'cascade' });
  });

  it('follows symlinked .md commands', () => {
    const entries = detectCommandEntries({ home, cwd });
    expect(entries).toContainEqual({ name: 'linked', parent: null });
  });

  it('includes project-scoped commands', () => {
    const entries = detectCommandEntries({ home, cwd });
    expect(entries).toContainEqual({ name: 'deploy', parent: null });
  });

  it('ignores dotfiles and dotdirs', () => {
    const entries = detectCommandEntries({ home, cwd });
    expect(entries.some(e => e.name === 'secret')).toBe(false);
  });

  it('returns [] for a machine with no command dirs', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-empty-'));
    try {
      expect(detectCommandEntries({ home: empty, cwd: empty })).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('detectSkillNames', () => {
  it('detects directory-style AND single-file skills', () => {
    const names = detectSkillNames({ home, cwd });
    expect(names).toContain('agent-browser'); // directory
    expect(names).toContain('quick'); // single file
  });

  it('returns a sorted, deduped list', () => {
    const names = detectSkillNames({ home, cwd });
    expect([...names]).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });
});
