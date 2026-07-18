// Build the publishable @agensis/agensis-agent bundle.
//
// The readable source lives in ../agensis-cli (the dev package). This script
// bundles its entry into ONE minified ESM file under bin/, so the published
// package ships no readable source. `ws` stays external (a normal runtime
// dependency), and the CLI version constant is stamped from this package.json
// so `agensis --version` matches the published version.
//
// Run with `npm run build` (also runs automatically on `npm pack` / publish via
// the prepack script). Requires esbuild (devDependency; also resolvable from the
// repo root node_modules).

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
const entry = join(here, '..', 'agensis-cli', 'bin', 'agensis.mjs');
const outfile = join(here, 'bin', 'agensis.mjs');

// The version literal baked into the dev source. We replace exactly this token
// with the published version (verified to be unique in the source).
const SOURCE_VERSION = '0.1.22';

const result = await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // ws and e2b stay external — normal runtime deps installed alongside the
  // published package. e2b in particular is a large SDK with its own transitive
  // deps that must not be inlined (only loaded when a sandbox agent runs).
  external: ['ws', 'e2b'],
  legalComments: 'none',
  write: false,
});

let code = result.outputFiles[0].text;

// Stamp the published version onto the bundled AGENSIS_CLI_VERSION constant.
const before = code.split(SOURCE_VERSION).length - 1;
if (before !== 1) {
  throw new Error(`Expected exactly one "${SOURCE_VERSION}" token to stamp, found ${before}. Aborting so the version isn't silently wrong.`);
}
code = code.replace(SOURCE_VERSION, pkg.version);

// Guarantee exactly one shebang at the very top (esbuild keeps the entry's, but
// minification ordering can vary — normalize it).
code = code.replace(/^#![^\n]*\n/, '');
code = `#!/usr/bin/env node\n${code}`;

await mkdir(dirname(outfile), { recursive: true });
await writeFile(outfile, code, 'utf8');
console.log(`[build] wrote ${outfile} — ${code.length} bytes, version ${pkg.version}`);
