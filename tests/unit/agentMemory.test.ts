import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  projectSlug,
  deriveMemoryRoot,
  enumerateMemoryFiles,
  readMemoryFile,
  resolveWithinRoot,
  snapshotMemory,
} from '../../agent/agensis-cli/src/memory.mjs';

let tmp: string;
let root: string;
let outsideFile: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-mem-'));
  root = path.join(tmp, 'memory');
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'MEMORY.md'), '# index\n- fact');
  await fs.writeFile(path.join(root, 'fact-one.md'), 'fact one body');
  await fs.writeFile(path.join(root, 'sub', 'nested.md'), 'nested body');
  await fs.writeFile(path.join(root, 'ignore.png'), 'not text');
  // A real file OUTSIDE the root, plus a symlink inside the root pointing at it.
  outsideFile = path.join(tmp, 'secret.txt');
  await fs.writeFile(outsideFile, 'TOP SECRET');
  try {
    await fs.symlink(outsideFile, path.join(root, 'escape.md'));
  } catch {
    /* symlinks may be unavailable on some CI; the explicit traversal test still covers it */
  }
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('projectSlug / deriveMemoryRoot', () => {
  it('slugs a cwd by replacing non-alphanumerics with dashes', () => {
    expect(projectSlug('/Users/jkneen/Documents/GitHub/agensis')).toBe(
      '-Users-jkneen-Documents-GitHub-agensis',
    );
  });

  it('derives the claude palace path from cwd', () => {
    const r = deriveMemoryRoot({ cwd: '/Users/jkneen/Documents/GitHub/agensis', homedir: '/home/x' });
    expect(r).toBe('/home/x/.claude/projects/-Users-jkneen-Documents-GitHub-agensis/memory');
  });

  it('honors an explicit absolute memory_dir override', () => {
    expect(deriveMemoryRoot({ cwd: '/whatever', memoryDir: '/custom/mem', homedir: '/home/x' })).toBe('/custom/mem');
  });

  it('expands a ~-relative memory_dir against homedir', () => {
    expect(deriveMemoryRoot({ memoryDir: '~/mem', homedir: '/home/x' })).toBe('/home/x/mem');
  });

  it('returns null with no cwd and no override', () => {
    expect(deriveMemoryRoot({ homedir: '/home/x' })).toBeNull();
  });
});

describe('enumerate + read', () => {
  it('lists markdown/text files, index first, skipping non-text and dotfiles', async () => {
    const files = await enumerateMemoryFiles(root);
    const paths = files.map((f) => f.path);
    expect(files[0].kind).toBe('index');
    expect(paths).toContain('MEMORY.md');
    expect(paths).toContain('fact-one.md');
    expect(paths).toContain(path.join('sub', 'nested.md'));
    expect(paths).not.toContain('ignore.png');
  });

  it('reads a file inside the root', async () => {
    const { content, byteSize } = await readMemoryFile(root, 'fact-one.md');
    expect(content).toBe('fact one body');
    expect(byteSize).toBe('fact one body'.length);
  });

  it('snapshots every file with content', async () => {
    const snap = await snapshotMemory(root);
    const byPath = Object.fromEntries(snap.map((f) => [f.path, f.content]));
    expect(byPath['MEMORY.md']).toContain('# index');
    expect(byPath['fact-one.md']).toBe('fact one body');
  });

  it('returns [] for a non-existent root', async () => {
    expect(await enumerateMemoryFiles(path.join(tmp, 'nope'))).toEqual([]);
  });
});

describe('security: allowlist', () => {
  it('rejects ../../etc/passwd traversal', async () => {
    await expect(readMemoryFile(root, '../../../../../../etc/passwd')).rejects.toThrow();
  });

  it('rejects an absolute path outside the root', async () => {
    await expect(readMemoryFile(root, outsideFile)).rejects.toThrow(/escapes memory root/);
  });

  it('rejects a symlink that points outside the root', async () => {
    // Only meaningful if the symlink got created in beforeAll.
    let linkExists = false;
    try {
      await fs.lstat(path.join(root, 'escape.md'));
      linkExists = true;
    } catch {
      /* skip */
    }
    if (linkExists) {
      await expect(readMemoryFile(root, 'escape.md')).rejects.toThrow(/escapes memory root/);
    }
  });

  it('resolveWithinRoot accepts a legit file and returns its real path', async () => {
    const realRootPath = await fs.realpath(root);
    const resolved = await resolveWithinRoot(realRootPath, 'fact-one.md');
    expect(resolved).toBe(path.join(realRootPath, 'fact-one.md'));
  });
});
