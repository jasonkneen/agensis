/**
 * Loads optional, machine-local Vite dev plugins.
 *
 * Anything named `*.plugin.mjs` in scripts/local/ (a gitignored folder) is
 * imported and, if it exports a function, registered for `vite dev`. Nothing
 * there is tracked, so a checkout without that folder simply has no extras.
 * Each file's default or first function export returns a Vite plugin.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOCAL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'local');

export async function loadDevLocalPlugins() {
  if (!existsSync(LOCAL_DIR)) return [];
  const plugins = [];
  for (const name of readdirSync(LOCAL_DIR).filter(file => file.endsWith('.plugin.mjs')).sort()) {
    try {
      const mod = await import(pathToFileURL(join(LOCAL_DIR, name)).href);
      const factory = typeof mod.default === 'function' ? mod.default : Object.values(mod).find(value => typeof value === 'function');
      if (factory) plugins.push(factory());
    } catch (error) {
      console.warn(`[dev-local] ${name} failed to load:`, error instanceof Error ? error.message : error);
    }
  }
  return plugins;
}
