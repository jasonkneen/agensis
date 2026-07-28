'use strict';
/**
 * Project discovery — works out what the host project is made of so the
 * palette can build itself.
 *
 * This editor is a drop-in for ANY project, so nothing here may be assumed:
 * not the framework, not the directory layout, not the import aliases. Every
 * answer is derived from files that are actually on disk. Anything missing or
 * malformed degrades to "not detected" rather than throwing — a discovery
 * failure must never take the editor down.
 *
 * Exports:
 *   discover(root) -> { root, framework, packageManager, aliases, libraries,
 *                       components, pages, uiDir, warnings }
 */

const fs = require('fs');
const path = require('path');

const MAX_SCAN_FILES = 400;
const MAX_WALK_DEPTH = 6;
const MAX_PAGE_DEPTH = 4;
const MAX_PAGES = 80;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.cache', 'vendor', '.turbo', '.output', 'public', 'static',
]);
const PAGE_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.cache', 'vendor', '.turbo', '.output',
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function decodeHtmlText(value) {
  function codePoint(raw, radix) {
    const point = parseInt(raw, radix);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point) : '\ufffd';
  }
  return String(value)
    .replace(/&#(\d+);/g, (_m, n) => codePoint(n, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => codePoint(n, 16))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_m, name) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    })[name.toLowerCase()]);
}

function readPageSource(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= 512 * 1024) return fs.readFileSync(file, 'utf8');
  } catch { /* unreadable files are not entry points */ }
  return '';
}

function pageTitle(source, rel) {
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(source);
  if (match) {
    const title = decodeHtmlText(match[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    if (title) return title;
  }
  const base = path.basename(rel, path.extname(rel));
  const fallback = base.toLowerCase() === 'index' && path.dirname(rel) !== '.'
    ? path.basename(path.dirname(rel)) : base;
  return fallback.split(/[-_]+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ') || 'Page';
}

/** HTML entry points under the served root, for switching the editor's target. */
function discoverPages(rootDir) {
  const pages = [];
  function walk(dir, depth) {
    if (depth > MAX_PAGE_DEPTH || pages.length >= MAX_PAGES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (pages.length >= MAX_PAGES) return;
      if (entry.name.startsWith('.') || PAGE_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        const source = readPageSource(full);
        // Be conservative: fragments, email templates and test fixtures are
        // not navigable application targets just because their suffix is HTML.
        if (!/(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(source)) continue;
        const rel = path.relative(rootDir, full).split(path.sep).join('/');
        pages.push({ path: rel, title: pageTitle(source, rel) });
      }
    }
  }
  walk(rootDir, 0);
  return pages.sort((a, b) => {
    if (a.path === 'index.html' || a.path === 'index.htm') return -1;
    if (b.path === 'index.html' || b.path === 'index.htm') return 1;
    return a.path.localeCompare(b.path);
  });
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * The served root is often a subdirectory (./public, ./examples, ./src), so the
 * project manifest can live above it. Walk up until we find one.
 */
function findUp(startDir, filename, limit = 5) {
  let dir = path.resolve(startDir);
  for (let i = 0; i <= limit; i++) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Library catalog — how to RECOGNISE a library, not what it contains.
//
// Component lists are read from disk (see readRegistryDir), because shadcn-style
// libraries are copied into the project rather than imported from a package:
// the only truthful source for "what is available" is the directory itself.
// ---------------------------------------------------------------------------

const CATALOG = [
  {
    id: 'shadcn',
    label: 'shadcn/ui',
    // Any of these present ⇒ installed. Matched against dependency names.
    packages: ['shadcn', '@shadcn/react', 'shadcn-ui'],
    // Directory (relative to the resolved `ui` alias) holding the components.
    dirAlias: 'ui',
    kind: 'copied',
  },
  {
    id: 'radix',
    label: 'Radix UI',
    packages: ['radix-ui', '@radix-ui/react-slot'],
    packagePrefix: '@radix-ui/',
    kind: 'package',
  },
  {
    id: 'ai-elements',
    label: 'AI Elements',
    packages: ['ai-elements', '@ai-sdk/elements'],
    dirName: 'ai-elements',
    kind: 'copied',
  },
  {
    id: 'ai-sdk',
    label: 'AI SDK',
    packages: ['ai'],
    packagePrefix: '@ai-sdk/',
    kind: 'package',
    headless: true, // no visual components to place
  },
  {
    id: 'kibo',
    label: 'Kibo UI',
    packages: ['kibo-ui'],
    packagePrefix: '@kibo-ui/',
    dirName: 'kibo-ui',
    kind: 'copied',
  },
  { id: 'lucide', label: 'Lucide icons', packages: ['lucide-react'], kind: 'icons' },
  { id: 'sonner', label: 'Sonner', packages: ['sonner'], kind: 'package' },
  { id: 'cmdk', label: 'cmdk', packages: ['cmdk'], kind: 'package' },
  { id: 'vaul', label: 'Vaul', packages: ['vaul'], kind: 'package' },
  { id: 'motion', label: 'Motion', packages: ['framer-motion', 'motion'], kind: 'package' },
];

function detectFramework(deps) {
  if (deps.next) return 'next';
  if (deps.react || deps['react-dom']) return 'react';
  if (deps.vue) return 'vue';
  if (deps.svelte) return 'svelte';
  if (deps.astro) return 'astro';
  return 'html';
}

function detectPackageManager(dir) {
  if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Turn a shadcn-style alias ("@/components/ui") into a real directory.
 * tsconfig paths are the authority for what "@" means; fall back to the
 * conventional src/ then project root.
 */
function resolveAlias(projectDir, alias, tsPaths) {
  if (!alias) return null;
  for (const [pattern, targets] of Object.entries(tsPaths || {})) {
    const prefix = pattern.replace(/\*$/, '');
    if (alias.startsWith(prefix) && targets && targets.length) {
      const target = String(targets[0]).replace(/\*$/, '');
      const rest = alias.slice(prefix.length);
      const dir = path.resolve(projectDir, target, rest);
      if (isDir(dir)) return dir;
    }
  }
  const bare = alias.replace(/^@\//, '').replace(/^~\//, '');
  for (const base of ['src', '', 'app']) {
    const dir = path.resolve(projectDir, base, bare);
    if (isDir(dir)) return dir;
  }
  return null;
}

function tsconfigPaths(projectDir) {
  for (const name of ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json']) {
    const file = path.join(projectDir, name);
    const json = readJson(file);
    const paths = json && json.compilerOptions && json.compilerOptions.paths;
    if (paths) return paths;
  }
  return {};
}

/** kebab-case filename → PascalCase export name. */
function pascal(name) {
  return name.replace(/\.[jt]sx?$/, '')
    .split(/[-_.]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/** Component files sitting in one directory — the shadcn "copied in" pattern. */
function readRegistryDir(dir, importBase) {
  const out = [];
  if (!isDir(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(tsx|jsx)$/.test(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const base = entry.name.replace(/\.[jt]sx$/, '');
    out.push({
      name: pascal(base),
      file: base,
      importPath: importBase ? importBase + '/' + base : null,
      exports: readExports(path.join(dir, entry.name)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Named exports of a component file, read with a regex rather than a parser.
 *
 * Deliberate: this runs over hundreds of files to populate a palette, a wrong
 * answer costs one missing palette entry, and pulling in a JS parser purely for
 * this would be a heavy dependency for a drop-in tool. The JSX *editing* path
 * is where a real parser is required, and that is a separate concern.
 */
function readExports(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return []; }
  if (src.length > 400000) return [];
  const names = new Set();
  const re = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Z][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  const listRe = /export\s*\{([^}]*)\}/g;
  while ((m = listRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const asName = part.includes(' as ') ? part.split(' as ')[1] : part;
      const clean = (asName || '').trim();
      if (/^[A-Z][A-Za-z0-9_]*$/.test(clean)) names.add(clean);
    }
  }
  return Array.from(names);
}

/** Walk the project for component files outside the registry directories. */
function walkComponents(dir, projectDir, depth, acc, seenDirs) {
  if (depth > MAX_WALK_DEPTH || acc.length >= MAX_SCAN_FILES) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (acc.length >= MAX_SCAN_FILES) return;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (seenDirs.has(full)) continue;
      seenDirs.add(full);
      walkComponents(full, projectDir, depth + 1, acc, seenDirs);
    } else if (/\.(tsx|jsx)$/.test(entry.name) && /^[A-Z]/.test(entry.name)) {
      // PascalCase filename is the strongest cheap signal for "a component".
      const exports = readExports(full);
      if (!exports.length) continue;
      acc.push({
        name: pascal(entry.name),
        file: path.relative(projectDir, full),
        exports,
      });
    }
  }
}

function discover(root) {
  const warnings = [];
  const rootDir = path.resolve(root);

  const pkgFile = findUp(rootDir, 'package.json');
  const projectDir = pkgFile ? path.dirname(pkgFile) : rootDir;
  const pkg = pkgFile ? readJson(pkgFile) : null;
  if (pkgFile && !pkg) warnings.push('package.json found but could not be parsed');

  const deps = Object.assign({}, pkg && pkg.dependencies, pkg && pkg.devDependencies);
  const depNames = Object.keys(deps);
  const framework = detectFramework(deps);

  // shadcn's components.json is the authority for aliases when present.
  const cfgFile = findUp(rootDir, 'components.json');
  const cfg = cfgFile ? readJson(cfgFile) : null;
  if (cfgFile && !cfg) warnings.push('components.json found but could not be parsed');
  const aliases = (cfg && cfg.aliases) || {};
  const tsPaths = tsconfigPaths(projectDir);

  const uiAlias = aliases.ui || (aliases.components ? aliases.components + '/ui' : '@/components/ui');
  const uiDir = resolveAlias(projectDir, uiAlias, tsPaths);
  const componentsAlias = aliases.components || '@/components';
  const componentsDir = resolveAlias(projectDir, componentsAlias, tsPaths);

  const libraries = [];
  for (const entry of CATALOG) {
    const byName = (entry.packages || []).some((p) => Object.hasOwn(deps, p));
    const byPrefix = entry.packagePrefix
      ? depNames.some((d) => d.startsWith(entry.packagePrefix))
      : false;

    // A "copied" library may be present as files without any dependency at all
    // — that is the whole point of the shadcn model.
    let dir = null;
    if (entry.dirAlias === 'ui') dir = uiDir;
    else if (entry.dirName && componentsDir) {
      const candidate = path.join(componentsDir, entry.dirName);
      if (isDir(candidate)) dir = candidate;
    }

    const components = dir
      ? readRegistryDir(dir, dir === uiDir ? uiAlias : componentsAlias + '/' + entry.dirName)
      : [];
    const installed = byName || byPrefix || components.length > 0;
    if (!installed) continue;

    libraries.push({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      headless: !!entry.headless,
      dir: dir ? path.relative(projectDir, dir) : null,
      componentCount: components.length,
      components,
    });
  }

  // Project components that are not part of a detected registry directory.
  const registryDirs = new Set(libraries.map((l) => l.dir).filter(Boolean));
  const own = [];
  const scanRoots = [componentsDir, path.join(projectDir, 'src'), path.join(projectDir, 'app')]
    .filter((d) => d && isDir(d));
  const seen = new Set();
  for (const scanRoot of scanRoots) {
    if (seen.has(scanRoot)) continue;
    seen.add(scanRoot);
    walkComponents(scanRoot, projectDir, 0, own, seen);
  }
  const components = own
    .filter((c) => !Array.from(registryDirs).some((d) => c.file.startsWith(d + path.sep)))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    root: rootDir,
    projectDir,
    framework,
    packageManager: detectPackageManager(projectDir),
    typescript: !!(cfg && cfg.tsx) || fs.existsSync(path.join(projectDir, 'tsconfig.json')),
    aliases: { ui: uiAlias, components: componentsAlias },
    uiDir: uiDir ? path.relative(projectDir, uiDir) : null,
    libraries,
    components: components.slice(0, 200),
    pages: discoverPages(rootDir),
    warnings,
  };
}

module.exports = {
  discover,
  discoverPages,
  pascal,
  readExports,
  resolveAlias,
  findUp,
  CATALOG,
};
