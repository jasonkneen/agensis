import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Contract tests for the @agensis/ui workspace package (packages/ui).
//
// The app resolves that package through the `source` export condition, so
// nothing between here and the components is a build artifact — a broken
// export map or a barrel that forgot a file is a runtime failure with no
// compile step to catch it first. These deliberately live in tests/unit/ rather
// than a fourth vitest config: the glob, the setupFiles preload and the `source`
// condition are already right here, and CONTRIBUTING's test-glob trap is one
// runner's worth of rope shorter.

const repoRoot = process.cwd();
const pkgRoot = path.join(repoRoot, 'packages/ui');
const componentDir = path.join(pkgRoot, 'src/components/ui');

const read = (p: string) => fs.readFileSync(p, 'utf8');
const pkg = JSON.parse(read(path.join(pkgRoot, 'package.json'))) as {
  exports: Record<string, string | Record<string, string>>;
  files: string[];
  dependencies: Record<string, string>;
};

function componentNames(): string[] {
  return fs
    .readdirSync(componentDir)
    .filter(f => f.endsWith('.tsx'))
    .map(f => f.replace(/\.tsx$/, ''))
    .sort();
}

/** Import specifiers in real `import`/`export ... from` statements, comments excluded. */
function importSpecifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return [...withoutComments.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
}

function packageSourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  })(path.join(pkgRoot, 'src'));
  return out;
}

describe('@agensis/ui barrel', () => {
  it('re-exports every component module, and only modules that exist', () => {
    const barrel = read(path.join(pkgRoot, 'src/index.ts'));
    const exported = [...barrel.matchAll(/export \* from '\.\/components\/ui\/([^']+)'/g)]
      .map(m => m[1])
      .sort();

    // Both directions: a new component nobody added to the barrel is invisible
    // to `import { X } from '@agensis/ui'`, and a stale line is a hard resolve
    // error for every consumer of the barrel.
    expect(exported).toEqual(componentNames());
  });

  it('exports no duplicate symbol names across modules', () => {
    // `export *` silently drops a name exported by two modules rather than
    // erroring, so a collision removes a component from the barrel invisibly.
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const name of componentNames()) {
      const source = read(path.join(componentDir, `${name}.tsx`));
      const symbols = [
        ...[...source.matchAll(/^export (?:function|const|class) (\w+)/gm)].map(m => m[1]),
        ...[...source.matchAll(/^export \{([^}]+)\}/gm)]
          .flatMap(m => m[1].split(','))
          .map(s => s.trim().split(/\s+as\s+/).pop()!)
          .filter(Boolean),
      ];
      for (const symbol of symbols) {
        const owner = seen.get(symbol);
        if (owner && owner !== name) collisions.push(`${symbol}: ${owner} and ${name}`);
        else seen.set(symbol, name);
      }
    }
    expect(collisions).toEqual([]);
  });
});

describe('@agensis/ui package manifest', () => {
  it('points every export at a file that exists on disk', () => {
    // The package advertised ./theme, ./types and five stylesheets that were
    // never written. Nothing resolves them until a consumer tries, so only a
    // test that walks the map notices.
    const missing: string[] = [];
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const targets = typeof target === 'string' ? [target] : Object.values(target);
      for (const rel of targets) {
        // dist/* is produced by `npm run ui:build` and is not checked in; the
        // app never resolves it (every resolver is pinned to `source`).
        if (rel.startsWith('./dist/')) continue;
        const candidates = rel.includes('*')
          ? componentNames().map(n => rel.replace('*', n))
          : [rel];
        for (const candidate of candidates) {
          const full = path.join(pkgRoot, candidate);
          // `./lib/*` is a wildcard over lib/, not over component names.
          if (rel.startsWith('./src/lib/') && rel.includes('*')) continue;
          if (!fs.existsSync(full)) missing.push(`${subpath} -> ${candidate}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('ships every file it promises in `files`', () => {
    const missing = pkg.files
      .filter(f => f !== 'dist')
      .filter(f => !fs.existsSync(path.join(pkgRoot, f)));
    expect(missing).toEqual([]);
  });

  it('declares every package it imports, and imports every package it declares', () => {
    const imported = new Set<string>();
    for (const file of packageSourceFiles()) {
      for (const spec of importSpecifiers(read(file))) {
        if (spec.startsWith('.')) continue;
        const scoped = spec.startsWith('@');
        imported.add(spec.split('/').slice(0, scoped ? 2 : 1).join('/'));
      }
    }
    const declared = Object.keys(pkg.dependencies);
    // react/react-dom are peerDependencies by design.
    const runtime = [...imported].filter(name => name !== 'react' && name !== 'react-dom');

    expect(runtime.filter(name => !declared.includes(name))).toEqual([]);
    expect(declared.filter(name => !runtime.includes(name))).toEqual([]);
  });
});

describe('@agensis/ui isolation', () => {
  it('never imports the app alias or its own barrel', () => {
    // The package must stay liftable: an `@/` import would bind it to the app,
    // and importing its own barrel would make dialog -> button style edges
    // cyclic. index.ts mentions '@agensis/ui' in a comment, which is why this
    // strips comments before matching.
    const offenders: string[] = [];
    for (const file of packageSourceFiles()) {
      for (const spec of importSpecifiers(read(file))) {
        if (spec.startsWith('@/') || spec === '@agensis/ui' || spec.startsWith('@agensis/ui/')) {
          offenders.push(`${path.relative(repoRoot, file)}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the app free of re-export shims', () => {
    // The 57 `export * from '@agensis/ui/components/<x>'` files are gone; call
    // sites import the package directly. A new one would reintroduce the layer
    // that made "edit the component" mean editing a file that forwards
    // elsewhere — and `npx shadcn add` writes exactly such a file into this
    // directory without asking.
    const appUiDir = path.join(repoRoot, 'src/components/ui');
    const shims = fs
      .readdirSync(appUiDir)
      .filter(f => f.endsWith('.tsx'))
      .filter(f => /export \* from '@agensis\/ui\/components\//.test(read(path.join(appUiDir, f))));

    expect(shims).toEqual([]);
  });

  it('leaves sonner in the app, where its useTheme dependency lives', () => {
    // The one component that did NOT move: it imports @/hooks/useTheme, which
    // would drag an app dependency into a package that must stay liftable.
    const sonner = path.join(repoRoot, 'src/components/ui/sonner.tsx');
    expect(fs.existsSync(sonner)).toBe(true);
    expect(read(sonner)).toContain('@/hooks/useTheme');
    expect(fs.existsSync(path.join(componentDir, 'sonner.tsx'))).toBe(false);
  });
});

describe('@agensis/ui resolution', () => {
  it('resolves the deep lib import that the app uses for cn', async () => {
    // Proves the `source` export condition is wired in this runner: without it
    // this import falls through to ./dist/lib/utils.js, which does not exist.
    const { cn } = await import('@agensis/ui/lib/utils');
    expect(typeof cn).toBe('function');
    expect(cn('px-2', 'px-4')).toBe('px-4');
    const { cn: viaApp } = await import('@/lib/utils');
    expect(viaApp).toBe(cn);
  });
});
