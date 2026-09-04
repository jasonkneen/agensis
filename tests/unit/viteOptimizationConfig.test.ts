import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const source = fs.readFileSync(path.join(repoRoot, 'vite.config.ts'), 'utf8');

function optimizedDependencies(): string[] {
  const block = /optimizeDeps:\s*\{[\s\S]*?include:\s*\[([\s\S]*?)\]\s*,?[\s\S]*?\n\s*\}/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('Vite and Nitro build boundaries', () => {
  it('only warms package roots that the package actually exports', () => {
    const invalid: string[] = [];
    for (const specifier of optimizedDependencies()) {
      const name = packageName(specifier);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'),
      ) as { exports?: unknown };
      if (!manifest.exports || typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)) continue;
      const keys = Object.keys(manifest.exports);
      if (keys.some(key => key.startsWith('.')) && !keys.includes('.')) invalid.push(specifier);
    }
    expect(invalid).toEqual([]);
  });

  it('keeps Nitro out of dev and desktop while naming the SPA client entry', () => {
    expect(source).toContain("input: path.resolve(import.meta.dirname, 'index.html')");
    expect(source).toMatch(/command === 'build'\s*&&\s*!isDesktopBuild/);
    expect(source).toContain("preset: process.env.AGENSIS_NITRO_PRESET || 'netlify_static'");
    expect(source).toContain('renderer: false');
  });
});
