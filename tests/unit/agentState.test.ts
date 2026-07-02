import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveStateDir,
  statusFilePath,
  writeAgentMirror,
  writeHeartbeatFile,
  writeHeartbeatFileSync,
  readAgentStatus,
} from '../../agent/agensis-cli/src/state.mjs';

let home: string;
let config: {
  workspace: string;
  agent: string;
  homedir: string;
  name: string;
  handle: string;
  model: string;
  permissionMode: string;
  heartbeatMs: number;
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-state-'));
  config = {
    workspace: 'ws-123',
    agent: 'agent-abc',
    homedir: home,
    name: 'Coder',
    handle: 'coder',
    model: 'claude-opus-4-8',
    permissionMode: 'yolo',
    heartbeatMs: 15000,
  };
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('resolveStateDir / statusFilePath', () => {
  it('roots under ~/.agensis/<workspace>/<agent>/', () => {
    const dir = resolveStateDir(config);
    expect(dir).toBe(path.join(home, '.agensis', 'ws-123', 'agent-abc'));
    expect(statusFilePath(config)).toBe(path.join(dir, 'status.json'));
  });

  it('sanitizes path segments so a crafted id cannot escape the base dir', () => {
    const dir = resolveStateDir({ workspace: '../../etc', agent: 'a/b/../c', homedir: home });
    const base = path.join(home, '.agensis');
    expect(dir.startsWith(base + path.sep)).toBe(true);
    expect(dir.includes('..')).toBe(false);
    expect(path.relative(base, dir).split(path.sep).length).toBe(2);
  });

  it('falls back to placeholder segments when ids are empty', () => {
    const dir = resolveStateDir({ workspace: '', agent: '', homedir: home });
    expect(dir).toBe(path.join(home, '.agensis', 'workspace', 'agent'));
  });
});

describe('writeAgentMirror', () => {
  it('writes agent.json + soul.md from the server payload', async () => {
    const ok = await writeAgentMirror(config, {
      id: 'agent-abc',
      workspace_id: 'ws-123',
      name: 'Coder',
      handle: 'coder',
      model: 'claude-opus-4-8',
      permission_mode: 'yolo',
      description: 'Coding agent',
      soul: 'Be direct. Quantify.',
      system_prompt: 'You are Coder.',
      tools: ['a', 'b'],
      skills: ['x'],
      version: 3,
    });
    expect(ok).toBe(true);
    const dir = resolveStateDir(config);
    const agentJson = JSON.parse(await fs.readFile(path.join(dir, 'agent.json'), 'utf8'));
    expect(agentJson.handle).toBe('coder');
    expect(agentJson.model).toBe('claude-opus-4-8');
    expect(agentJson.permissionMode).toBe('yolo');
    expect(agentJson.tools).toEqual(['a', 'b']);
    expect(agentJson.version).toBe(3);
    const soul = await fs.readFile(path.join(dir, 'soul.md'), 'utf8');
    expect(soul).toBe('Be direct. Quantify.');
  });

  it('returns false on a non-object payload and writes nothing', async () => {
    expect(await writeAgentMirror(config, null)).toBe(false);
    await expect(fs.stat(path.join(resolveStateDir(config), 'agent.json'))).rejects.toThrow();
  });
});

describe('writeHeartbeatFile', () => {
  it('writes a fresh, parseable liveness snapshot', async () => {
    const before = Date.now();
    const ok = await writeHeartbeatFile(config, { busy: true, active: 1, queueSize: 2, connected: true });
    expect(ok).toBe(true);
    const beat = JSON.parse(await fs.readFile(path.join(resolveStateDir(config), 'heartbeat.json'), 'utf8'));
    expect(beat.status).toBe('busy');
    expect(beat.busy).toBe(true);
    expect(beat.active).toBe(1);
    expect(beat.queueSize).toBe(2);
    expect(beat.connected).toBe(true);
    expect(beat.handle).toBe('coder');
    expect(beat.pid).toBe(process.pid);
    expect(beat.ts).toBeGreaterThanOrEqual(before);
  });

  it('derives status online when not busy, and carries agentStatus when provided', async () => {
    await writeHeartbeatFile(config, { busy: false, connected: false, agentStatus: 'thinking', agentNote: 'planning' });
    const beat = JSON.parse(await fs.readFile(path.join(resolveStateDir(config), 'heartbeat.json'), 'utf8'));
    expect(beat.status).toBe('online');
    expect(beat.connected).toBe(false);
    expect(beat.agentStatus).toBe('thinking');
    expect(beat.agentNote).toBe('planning');
  });

  it('sync variant lands a stopped beat for shutdown', () => {
    const ok = writeHeartbeatFileSync(config, { status: 'stopped', connected: false });
    expect(ok).toBe(true);
  });
});

describe('readAgentStatus', () => {
  async function writeStatus(contents: string) {
    const dir = resolveStateDir(config);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'status.json'), contents);
  }

  it('returns null when the file is absent', async () => {
    expect(await readAgentStatus(config)).toBeNull();
  });

  it('reads status + note and clamps overlong fields', async () => {
    await writeStatus(JSON.stringify({ status: 'working', note: 'x'.repeat(1000) }));
    const status = await readAgentStatus(config);
    expect(status?.status).toBe('working');
    expect(status?.note?.length).toBe(400);
  });

  it('accepts message as an alias for note', async () => {
    await writeStatus(JSON.stringify({ message: 'refactoring the queue' }));
    expect((await readAgentStatus(config))?.note).toBe('refactoring the queue');
  });

  it('returns null on malformed JSON', async () => {
    await writeStatus('{ not json');
    expect(await readAgentStatus(config)).toBeNull();
  });

  it('returns null on a JSON array (not an object)', async () => {
    await writeStatus('["nope"]');
    expect(await readAgentStatus(config)).toBeNull();
  });

  it('returns null when neither status nor note is present', async () => {
    await writeStatus(JSON.stringify({ unrelated: true }));
    expect(await readAgentStatus(config)).toBeNull();
  });

  it('ignores an oversized status file', async () => {
    await writeStatus(JSON.stringify({ status: 'ok', pad: 'y'.repeat(9000) }));
    expect(await readAgentStatus(config)).toBeNull();
  });
});
